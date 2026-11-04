import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RULES, StackSim } from '../../shared/stackCore.js';

const H = RULES.BLOCK_HEIGHT;
const BASE_COLUMN = 140; // the base block runs down past the bottom of any screen
const MIN_HALF_WIDTH = 14; // keep the full swing on screen on narrow phones
const GRAVITY = 42;
const TIP_ACCEL = 9; // how fast a cut piece rolls over the edge (rad/s²)
const MAX_TIP = 1.45;
const LEVELS_PER_KEY = 10; // colour drifts to the next palette key every N levels

// Hand-picked keys; levels blend between them so the tower reads as one gradient.
const PALETTE = ['#6fa8f5', '#8b8cf3', '#b88aea', '#ec8ab6', '#f59f86', '#f3c26e', '#93d49a', '#5ec8c4'].map(
  (hex) => new THREE.Color(hex),
);

/**
 * Three.js view of a Stack run.
 *
 * - The tower and the sliding block come straight from StackSim, the same
 *   rules the server replays, so what you see is exactly what gets scored.
 * - Movement is a function of time since the block spawned, never of frame
 *   count or Date.now(), so speed changes can't make a block jump.
 * - Falling pieces are animated, not simulated: they tip over the edge they
 *   were cut from, never pass through the tower, and are cleaned up.
 */
export class StackScene {
  constructor(container, { onDrop, onEnd, onTheme } = {}) {
    this.container = container;
    this.onDrop = onDrop;
    this.onEnd = onEnd;
    this.onTheme = onTheme;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'stack-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Generous near/far: an orthographic camera never clips the tower.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
    this.camTarget = new THREE.Vector3();
    this.camY = 0;
    this.zoom = 1;
    this.zoomTarget = 1;
    this.shift = { x: 0, y: 0 };
    this.shiftTarget = { x: 0, y: 0 };

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a93b8, 1.25);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 1;
    sc.far = 120;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(30, 10, -10);
    this.scene.add(fill);

    this.blocks = [];
    this.debris = [];
    this.effects = [];
    this.moving = null;
    this.sim = null;
    this.state = 'idle'; // idle | running | over
    this.clicks = [];
    this.paletteStart = 0;
    this.clock = new THREE.Clock();
    this.idleTime = 0;
    this.resizeRaf = 0;

    this.#buildTower(new StackSim());
    this.#resize();
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => this.#resize());
    });
    this.resizeObserver.observe(container);
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ------------------------------------------------------------------ public

  /** Begins a new run. The run clock starts now. */
  start() {
    this.paletteStart = Math.floor(Math.random() * PALETTE.length) * LEVELS_PER_KEY;
    this.#buildTower(new StackSim());
    this.clicks = [];
    this.state = 'running';
    this.zoomTarget = 1;
    this.t0 = performance.now();
    this.#spawnMoving();
  }

  /** Back to the idle view without scoring anything. */
  stop() {
    if (this.state === 'running' && this.moving) {
      const m = this.sim.movingAt(performance.now() - this.t0);
      const dir = Math.sign(m.offset) || 1;
      const size = m.axis === 'x' ? m.w : m.d;
      const centre = m.axis === 'x' ? m.x : m.z;
      this.#fall(this.moving, { axis: m.axis, dir, level: m.level, innerEdge: centre - (dir * size) / 2 });
      this.moving = null;
    }
    this.state = 'idle';
  }

  /** Player input. Ignored unless a run is live. */
  drop() {
    if (this.state !== 'running' || !this.sim) return;
    const t = Math.round(performance.now() - this.t0);
    const last = this.clicks.length ? this.clicks[this.clicks.length - 1] : -Infinity;
    // Same limits the server enforces: never record a click it would reject.
    if (t - last < RULES.MIN_CLICK_GAP_MS || t > RULES.MAX_RUN_MS || this.clicks.length >= RULES.MAX_CLICKS) return;

    const result = this.sim.drop(t);
    this.clicks.push(t);
    const mesh = this.moving;
    this.moving = null;

    if (result.type === 'miss') {
      const m = result.debris;
      const dir = Math.sign(m.offset) || 1;
      const size = m.axis === 'x' ? m.w : m.d;
      const centre = m.axis === 'x' ? m.x : m.z;
      // Snap the mesh to the exact dropped position before it falls.
      mesh.position.set(m.x, m.level * H, m.z);
      this.#fall(mesh, { axis: m.axis, dir, level: m.level, innerEdge: centre - (dir * size) / 2 });
      this.state = 'over';
      this.#frameTower();
      this.onDrop?.({ type: 'miss', score: this.sim.score, combo: 0 });
      this.onEnd?.({ clicks: [...this.clicks], score: this.sim.score, perfects: this.sim.perfects });
      return;
    }

    this.#disposeMesh(mesh);
    const placed = this.#addBlock(result.placed, result.level, true);

    if (result.debris) {
      const d = result.debris;
      const piece = this.#makeBlock(d.w, d.d, result.level);
      piece.position.set(d.x, result.level * H, d.z);
      const p = result.placed;
      const placedCentre = d.axis === 'x' ? p.x : p.z;
      const placedSize = d.axis === 'x' ? p.w : p.d;
      this.#fall(piece, {
        axis: d.axis,
        dir: d.direction,
        level: result.level,
        innerEdge: placedCentre + (d.direction * placedSize) / 2,
      });
    }

    if (result.type === 'perfect') this.#perfect(placed, this.sim.combo);
    this.onDrop?.({ type: result.type, score: this.sim.score, combo: this.sim.combo });
    this.#spawnMoving();
  }

  /** Slides the tower on screen (fractions of the viewport) to make room for panels. */
  setShift(x, y) {
    this.shiftTarget = { x, y };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    cancelAnimationFrame(this.resizeRaf);
    this.resizeObserver.disconnect();
    this.#clearAll();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------- colours

  #color(level) {
    const k = (this.paletteStart + level) / LEVELS_PER_KEY;
    const i = Math.floor(k);
    const a = PALETTE[i % PALETTE.length];
    const b = PALETTE[(i + 1) % PALETTE.length];
    const t = k - i;
    // smoothstep keeps each key colour on screen a little longer
    return a.clone().lerp(b, t * t * (3 - 2 * t));
  }

  #applyTheme() {
    const level = this.sim ? this.sim.level : 0;
    const c = this.#color(level);
    const hsl = {};
    c.getHSL(hsl);
    this.hemi.groundColor.setHSL(hsl.h, 0.35, 0.5);
    // The page derives its background and HUD ink (light and dark) from these.
    this.onTheme?.({ h: Math.round(hsl.h * 360), s: Math.round(Math.min(0.8, hsl.s) * 100) });
  }

  // ----------------------------------------------------------------- blocks

  #makeBlock(w, d, level) {
    const radius = Math.min(0.12, w / 5, d / 5);
    const geo = new RoundedBoxGeometry(w, H, d, 3, Math.max(0.002, radius));
    const mat = new THREE.MeshStandardMaterial({ color: this.#color(level), roughness: 0.5, metalness: 0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** The base: a tall column whose colour fades into the background below. */
  #makeColumn(w, d) {
    const geo = new RoundedBoxGeometry(w, BASE_COLUMN, d, 3, 0.12);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // fade over the top ~30 units, flat below that
      const depth = Math.min(1, (BASE_COLUMN / 2 - pos.getY(i)) / 30);
      const k = 1 - 0.42 * Math.pow(depth, 0.8);
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({ color: this.#color(0), roughness: 0.55, vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  #addBlock(layer, level, settle) {
    let mesh;
    if (level === 0) {
      mesh = this.#makeColumn(layer.w, layer.d);
      mesh.position.set(layer.x, H / 2 - BASE_COLUMN / 2, layer.z);
    } else {
      mesh = this.#makeBlock(layer.w, layer.d, level);
      mesh.position.set(layer.x, level * H, layer.z);
      if (settle) mesh.userData.settle = 1;
    }
    this.scene.add(mesh);
    this.blocks[level] = mesh;
    return mesh;
  }

  #clearAll() {
    for (const m of this.blocks) this.#disposeMesh(m);
    for (const d of this.debris) this.#disposeMesh(d.mesh, d.group);
    for (const e of this.effects) this.#disposeMesh(e.mesh);
    this.#disposeMesh(this.moving);
    this.blocks = [];
    this.debris = [];
    this.effects = [];
    this.moving = null;
  }

  #buildTower(sim) {
    this.#clearAll();
    this.sim = sim;
    sim.layers.forEach((layer, i) => this.#addBlock(layer, i, false));
    this.camY = sim.score * H;
    this.#applyTheme();
  }

  #spawnMoving() {
    const m = this.sim.movingAt(Math.round(performance.now() - this.t0));
    this.moving = this.#makeBlock(m.w, m.d, m.level);
    this.moving.position.set(m.x, m.level * H, m.z);
    this.scene.add(this.moving);
    this.#applyTheme();
  }

  // ----------------------------------------------------------------- debris

  /**
   * A falling piece hangs from a pivot on its inner bottom edge (the side that
   * touched the tower). It rolls outward over that edge while falling, and the
   * pivot is pushed out past any wider ledge below, so it never cuts through
   * the tower.
   */
  #fall(mesh, { axis, dir, level, innerEdge }) {
    if (!mesh) return;
    const group = new THREE.Group();
    group.position.set(
      axis === 'x' ? innerEdge : mesh.position.x,
      level * H - H / 2,
      axis === 'z' ? innerEdge : mesh.position.z,
    );
    mesh.position.sub(group.position);
    group.add(mesh);
    this.scene.add(group);
    this.debris.push({ group, mesh, axis, dir, level, vy: 0, angle: 0, av: 0.6, drift: 0.8, life: 0 });
  }

  #ledgeExtent(y, level, axis, dir) {
    const layers = this.sim.layers;
    // Highest layer whose top is at or above y, below the piece's own level.
    let idx = Math.floor((y + H / 2) / H);
    idx = Math.max(0, Math.min(idx, level - 1, layers.length - 1));
    let extent = -Infinity * dir;
    // Check that layer and the one above (the piece may straddle both).
    for (let i = idx; i <= Math.min(idx + 1, level - 1, layers.length - 1); i++) {
      const l = layers[i];
      const e = axis === 'x' ? l.x + (dir * l.w) / 2 : l.z + (dir * l.d) / 2;
      extent = dir > 0 ? Math.max(extent, e) : Math.min(extent, e);
    }
    return extent;
  }

  #updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life += dt;
      d.vy -= GRAVITY * dt;
      d.group.position.y += d.vy * dt;

      d.av += TIP_ACCEL * dt;
      d.angle = Math.min(MAX_TIP, d.angle + d.av * dt);
      if (d.axis === 'x') d.group.rotation.z = -d.dir * d.angle;
      else d.group.rotation.x = d.dir * d.angle;

      // drift outward, and never inside a ledge
      const key = d.axis === 'x' ? 'x' : 'z';
      d.group.position[key] += d.dir * d.drift * dt;
      if (this.sim) {
        const edge = this.#ledgeExtent(d.group.position.y, d.level, d.axis, d.dir);
        if (Number.isFinite(edge)) {
          d.group.position[key] = d.dir > 0 ? Math.max(d.group.position[key], edge) : Math.min(d.group.position[key], edge);
        }
      }

      if (d.life > 3.5 || d.group.position.y < this.camY - 60) {
        this.#disposeMesh(d.mesh, d.group);
        this.debris.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- effects

  #perfect(block, combo) {
    const { width, depth } = block.geometry.parameters;
    const pad = 0.3;
    const shape = new THREE.Shape();
    const ow = width / 2 + pad;
    const od = depth / 2 + pad;
    shape.moveTo(-ow, -od);
    shape.lineTo(ow, -od);
    shape.lineTo(ow, od);
    shape.lineTo(-ow, od);
    shape.lineTo(-ow, -od);
    const hole = new THREE.Path();
    const iw = width / 2 + 0.06;
    const id = depth / 2 + 0.06;
    hole.moveTo(-iw, -id);
    hole.lineTo(-iw, id);
    hole.lineTo(iw, id);
    hole.lineTo(iw, -id);
    hole.lineTo(-iw, -id);
    shape.holes.push(hole);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(block.position.x, block.position.y - H / 2 + 0.02, block.position.z);
    this.scene.add(ring);
    this.effects.push({ mesh: ring, life: 0, grow: 0.22 + Math.min(combo, 6) * 0.05 });

    // brief glow on the block itself
    block.material.emissive = new THREE.Color(0xffffff);
    block.userData.glow = 0.55;
  }

  #updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life += dt / 0.65;
      const k = 1 + e.grow * Math.sqrt(Math.min(1, e.life));
      e.mesh.scale.set(k, 1, k);
      e.mesh.material.opacity = 0.95 * Math.max(0, 1 - e.life);
      if (e.life >= 1) {
        this.#disposeMesh(e.mesh);
        this.effects.splice(i, 1);
      }
    }
    // settle + glow on the newest few blocks only
    for (let i = Math.max(1, this.blocks.length - 3); i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (!b) continue;
      if (b.userData.settle) {
        b.userData.settle = Math.max(0, b.userData.settle - dt * 8);
        const s = b.userData.settle;
        b.position.y = i * H + s * s * 0.22;
      }
      if (b.userData.glow) {
        b.userData.glow = Math.max(0, b.userData.glow - dt * 1.8);
        b.material.emissiveIntensity = b.userData.glow;
      }
    }
  }

  // ----------------------------------------------------------------- camera

  #frameTower() {
    const height = this.sim.score * H + 6;
    const halfH = this.#halfHeight();
    this.zoomTarget = Math.min(1, halfH / Math.max(halfH, height * 0.62));
  }

  #halfHeight() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    return Math.max(15, MIN_HALF_WIDTH / (w / h));
  }

  #resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const halfH = this.#halfHeight();
    const aspect = w / h;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    if (this.state === 'over') this.#frameTower();
  }

  #disposeMesh(mesh, group) {
    if (mesh) {
      mesh.parent?.remove(mesh);
      mesh.geometry?.dispose();
      mesh.material?.dispose();
    }
    if (group) this.scene.remove(group);
  }

  // ------------------------------------------------------------------ frame

  #frame() {
    // Cosmetic animation only; the sliding block always uses the real clock.
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const sim = this.sim;

    if (this.state === 'running' && this.moving && sim) {
      const m = sim.movingAt(performance.now() - this.t0);
      this.moving.position.set(m.x, m.level * H, m.z);
    }

    this.#updateDebris(dt);
    this.#updateEffects(dt);

    const top = sim ? sim.score * H : 0;
    const targetY = this.state === 'over' ? (top + 2) * 0.5 : top + 2;
    this.camY += (targetY - this.camY) * Math.min(1, dt * 4);
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 3);

    const k = Math.min(1, dt * 5);
    this.shift.x += (this.shiftTarget.x - this.shift.x) * k;
    this.shift.y += (this.shiftTarget.y - this.shift.y) * k;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const view = this.camera.view;
    const ox = -this.shift.x * w;
    const oy = -this.shift.y * h;
    if (!view || Math.abs(view.offsetX - ox) > 0.1 || Math.abs(view.offsetY - oy) > 0.1 || view.fullWidth !== w || view.fullHeight !== h) {
      this.camera.setViewOffset(w, h, ox, oy, w, h);
    }
    if (Math.abs(this.camera.zoom - this.zoom) > 1e-4) {
      this.camera.zoom = this.zoom;
      this.camera.updateProjectionMatrix();
    }

    // Fixed isometric angle while playing; a slow sway in the lobby.
    this.idleTime += dt;
    const sway = this.state === 'idle' ? Math.sin(this.idleTime * 0.35) * 0.16 : 0;
    const az = Math.PI / 4 + sway;
    const dist = 60;
    this.camTarget.set(0, this.camY, 0);
    this.camera.position.set(Math.sin(az) * dist, this.camY + dist * 0.82, Math.cos(az) * dist);
    this.camera.lookAt(this.camTarget);

    // The shadow box rides with the camera so shadows never vanish up high.
    this.sun.position.set(-14, this.camY + 34, 20);
    this.sun.target.position.set(0, this.camY - 4, 0);

    this.renderer.render(this.scene, this.camera);
  }
}
