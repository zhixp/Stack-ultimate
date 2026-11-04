import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RULES, StackSim } from '../../shared/stackCore.js';
import { ELEV, H, HH, R, T_BOT, T_TOP, TOWER_F, World, colorFor, damp, patch } from './World.js';

const SEA_FLOOR = -58; // debris below this is gone
const PLATEAU_R = 10.3;
// The swing seen from the 45° camera: its far corner sits this far sideways, and the
// near end of the swing is this much closer to the camera (perspective makes it bigger).
const SWING_SIDE = (RULES.TRAVEL + RULES.BASE_SIZE) * Math.SQRT1_2;
const SWING_NEAR = RULES.TRAVEL * Math.SQRT1_2;
const SWING_FILL = 0.96; // share of the half-width the swing may use
const MIN_PLAY_DIST = 52; // closest the camera gets on wide screens

/**
 * Three.js view of a Stack run.
 *
 * - The tower and the sliding block come straight from StackSim, the same
 *   rules the server replays, so what you see is exactly what gets scored.
 *   Only the drawing is scaled: a rules block is 1 high, a drawn floor is H.
 * - Movement is a function of time since the block spawned, never of frame
 *   count, so frame drops can't make a block jump.
 * - Everything around the tower (sky, weather, light, post) lives in World.
 */
export class StackScene {
  constructor(container, { onDrop, onEnd, onWorld } = {}) {
    this.container = container;
    this.onDrop = onDrop;
    this.onEnd = onEnd;
    this.onWorld = onWorld;

    const small = Math.min(window.innerWidth, window.innerHeight) < 700;
    this.dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'stack-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 4000);

    // ?t=0..1 (0 = midnight) and ?wx=clear|rain|snow|storm pin the look, handy for screenshots.
    const qs = new URLSearchParams(window.location.search);
    this.world = new World({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      small,
      time: qs.has('t') ? Number(qs.get('t')) : undefined,
      weather: qs.get('wx') || undefined,
    });

    this.blockMats = new Map();
    this.blocks = [];
    this.debris = [];
    this.ripples = [];
    this.squash = [];
    this.moving = null;
    this.sim = new StackSim();
    this.state = 'idle'; // idle | running | over
    this.clicks = [];
    this.t0 = 0;

    this.aspect = 1;
    this.shift = { x: 0, y: 0 };
    this.shiftTarget = { x: 0, y: 0 };
    this.camY = 14;
    this.camPsi = Math.PI / 4;
    this.camD = this.#playDist() * 2.6;
    this.clock = 0;
    this.last = performance.now();
    this.lastInfo = { ink: '', icon: '', minutes: -1, night: null };

    this.#addBlock(this.sim.layers[0], 0);
    this.#resize();
    this.resizeRaf = 0;
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => this.#resize());
    });
    this.resizeObserver.observe(container);
    this.renderer.setAnimationLoop((t) => this.#frame(t));

    if (import.meta.env.DEV) window.__stack = this;
  }

  // ------------------------------------------------------------------ public

  /** Begins a new run. The run clock starts now. */
  start() {
    this.#clearTower();
    this.sim = new StackSim();
    this.#addBlock(this.sim.layers[0], 0);
    this.clicks = [];
    this.state = 'running';
    this.t0 = performance.now();
    this.#spawnMoving();
  }

  /** Back to the idle view without scoring anything. */
  stop() {
    if (this.state === 'running' && this.moving) {
      const m = this.sim.movingAt(Math.round(performance.now() - this.t0));
      this.#removeMesh(this.moving);
      this.moving = null;
      this.#spawnDebris({ ...m, direction: Math.sign(m.offset) || 1 }, m.level, 4);
    }
    this.state = 'idle';
  }

  /** Player input. Ignored unless a run is live. */
  drop() {
    if (this.state !== 'running' || !this.moving) return;
    const t = Math.round(performance.now() - this.t0);
    const last = this.clicks.length ? this.clicks[this.clicks.length - 1] : -Infinity;
    // Same limits the server enforces: never record a click it would reject.
    if (t - last < RULES.MIN_CLICK_GAP_MS || t > RULES.MAX_RUN_MS || this.clicks.length >= RULES.MAX_CLICKS) return;

    const res = this.sim.drop(t);
    this.clicks.push(t);
    this.#removeMesh(this.moving);
    this.moving = null;

    if (res.type === 'miss') {
      this.#spawnDebris({ ...res.debris, direction: Math.sign(res.debris.offset) || 1 }, res.level, 4);
      this.state = 'over';
      this.onDrop?.({ type: 'miss', score: this.sim.score, combo: 0 });
      this.onEnd?.({ clicks: [...this.clicks], score: this.sim.score, perfects: this.sim.perfects });
      return;
    }

    const m = this.#addBlock(res.placed, res.level);
    this.squash.push({ m, age: 0 });
    if (res.debris) this.#spawnDebris(res.debris, res.level, 1.8);
    if (res.type === 'perfect') this.#ripple(res.placed, res.level);
    this.onDrop?.({ type: res.type, score: this.sim.score, combo: this.sim.combo });
    this.#spawnMoving();
  }

  /** Slides the scene on screen (fractions of the viewport) to make room for panels. +x right, -y up. */
  setShift(x, y) {
    this.shiftTarget = { x, y };
  }

  /** Preview controls: jump the clock (0..1) or pin the weather ('auto' frees it). */
  setTime(t) {
    this.world.jumpTo(t);
  }

  setWeather(name) {
    this.world.setWeather(name);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    cancelAnimationFrame(this.resizeRaf);
    this.resizeObserver.disconnect();
    this.#clearTower();
    for (const m of this.blockMats.values()) m.dispose();
    this.blockMats.clear();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (import.meta.env.DEV && window.__stack === this) delete window.__stack;
  }

  // ----------------------------------------------------------------- blocks

  #blockMat(level) {
    let mat = this.blockMats.get(level);
    if (!mat) {
      mat = patch(new THREE.MeshStandardMaterial({ color: colorFor(level), roughness: 0.6 }), 'block');
      this.blockMats.set(level, mat);
    }
    return mat;
  }

  #mesh(w, d, level) {
    const geo = new RoundedBoxGeometry(w, H, d, 3, Math.min(0.3, w / 4, d / 4));
    const m = new THREE.Mesh(geo, this.#blockMat(level));
    m.castShadow = true;
    m.receiveShadow = true;
    this.scene.add(m);
    return m;
  }

  #addBlock(layer, level) {
    const m = this.#mesh(layer.w, layer.d, level);
    m.position.set(layer.x, level * H, layer.z);
    this.blocks[level] = m;
    return m;
  }

  #spawnMoving() {
    const top = this.sim.top;
    this.moving = this.#mesh(top.w, top.d, this.sim.level);
    this.#placeMoving(performance.now());
  }

  #placeMoving(now) {
    const m = this.sim.movingAt(Math.round(now - this.t0));
    this.moving.position.set(m.x, m.level * H, m.z);
  }

  /** Shared materials stay cached; only the geometry belongs to the mesh. */
  #removeMesh(m) {
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
  }

  #clearTower() {
    for (const b of this.blocks) this.#removeMesh(b);
    for (const d of this.debris) this.#removeMesh(d.m);
    for (const r of this.ripples) {
      this.scene.remove(r.m);
      r.m.geometry.dispose();
      r.m.material.dispose();
    }
    this.#removeMesh(this.moving);
    this.blocks = [];
    this.debris = [];
    this.ripples = [];
    this.squash = [];
    this.moving = null;
  }

  // ----------------------------------------------------------------- debris

  /** A cut piece is thrown off the edge it was cut from, tumbles, and lands on any ledge below. */
  #spawnDebris(d, level, push) {
    const m = this.#mesh(d.w, d.d, level);
    m.receiveShadow = false;
    m.position.set(d.x, level * H, d.z);
    const s = d.direction || 1;
    const vel = d.axis === 'x' ? new THREE.Vector3(s * push, 0.6, 0) : new THREE.Vector3(0, 0.6, s * push);
    const spin = d.axis === 'x' ? new THREE.Vector3(0, 0, -s * 2.6) : new THREE.Vector3(s * 2.6, 0, 0);
    this.debris.push({ m, vel, spin, level, landed: 0, age: 0 });
  }

  #groundUnder(x, z, maxLevel) {
    const layers = this.sim.layers;
    for (let i = Math.min(maxLevel, layers.length - 1); i >= 0; i--) {
      const l = layers[i];
      if (Math.abs(x - l.x) < l.w / 2 && Math.abs(z - l.z) < l.d / 2) return i * H + HH;
    }
    return Math.hypot(x, z) < PLATEAU_R ? -HH : -Infinity;
  }

  #updateDebris(dt) {
    const quarter = Math.PI / 2;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const p = this.debris[i];
      const pos = p.m.position;
      p.age += dt;
      if (!p.landed) {
        p.vel.y -= 30 * dt;
        pos.addScaledVector(p.vel, dt);
        p.m.rotation.x += p.spin.x * dt;
        p.m.rotation.z += p.spin.z * dt;
        const g = this.#groundUnder(pos.x, pos.z, p.level - 1);
        if (pos.y - HH * 0.8 < g && p.vel.y < 0 && pos.y > g - 2) {
          pos.y = g + HH;
          p.landed = p.age;
        }
      } else {
        p.m.rotation.x = damp(p.m.rotation.x, Math.round(p.m.rotation.x / quarter) * quarter, 10, dt);
        p.m.rotation.z = damp(p.m.rotation.z, Math.round(p.m.rotation.z / quarter) * quarter, 10, dt);
        if (p.age - p.landed > 2.2) p.m.scale.multiplyScalar(Math.max(0, 1 - dt * 4));
      }
      if (pos.y < SEA_FLOOR || p.m.scale.x < 0.05) {
        this.#removeMesh(p.m);
        this.debris.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- effects

  #ripple(l, level) {
    const rect = (w, d) => {
      const s = new THREE.Shape();
      s.moveTo(-w / 2, -d / 2);
      s.lineTo(w / 2, -d / 2);
      s.lineTo(w / 2, d / 2);
      s.lineTo(-w / 2, d / 2);
      s.closePath();
      return s;
    };
    const outer = rect(l.w + 0.7, l.d + 0.7);
    outer.holes.push(rect(l.w + 0.3, l.d + 0.3));
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 2.1, 1.9),
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.Mesh(new THREE.ShapeGeometry(outer), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(l.x, level * H - HH + 0.03, l.z);
    this.scene.add(m);
    this.ripples.push({ m, age: 0 });
  }

  #updateFx(dt) {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const k = r.age / 0.8;
      r.m.scale.setScalar(1 + k * 0.22);
      r.m.material.opacity = Math.max(0, 1 - k) * 0.85;
      if (k >= 1) {
        this.scene.remove(r.m);
        r.m.geometry.dispose();
        r.m.material.dispose();
        this.ripples.splice(i, 1);
      }
    }
    for (let i = this.squash.length - 1; i >= 0; i--) {
      const s = this.squash[i];
      s.age += dt;
      const k = Math.min(1, s.age / 0.35);
      s.m.scale.y = 1 - 0.07 * Math.exp(-k * 5) * Math.cos(k * 9);
      if (k >= 1) {
        s.m.scale.y = 1;
        this.squash.splice(i, 1);
      }
    }
  }

  // ----------------------------------------------------------------- camera

  /** Far enough that the whole swing stays on screen, however narrow the screen. */
  #playDist() {
    const halfWidth = R * 0.5 * this.aspect * SWING_FILL; // tan of the half field of view
    return Math.max(MIN_PLAY_DIST, (SWING_NEAR + SWING_SIDE / halfWidth) / Math.cos(ELEV));
  }

  /** Distance at which a tower `top` high fits between the horizon line and the bottom edge. */
  #fitDist(top) {
    return ((top + H) / (-T_BOT * Math.cos(ELEV) - Math.sin(ELEV))) * 1.2;
  }

  /**
   * Off-axis projection: the camera looks level at the horizon and the frustum
   * is shifted down, so the tower top sits at TOWER_F and verticals stay
   * vertical. Panel shifts slide the frustum instead of turning the camera.
   */
  #project() {
    const n = this.camera.near;
    const hT = R * 0.5 * this.aspect;
    const sx = this.shift.x * 2 * hT;
    const sy = this.shift.y * R;
    this.camera.projectionMatrix.makePerspective(n * (-hT - sx), n * (hT - sx), n * (T_TOP + sy), n * (T_BOT + sy), n, this.camera.far);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  #resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.aspect = w / h;
    this.renderer.setSize(w, h, false);
    this.world.setSize(w, h, this.dpr, TOWER_F - this.shift.y);
    this.#project();
  }

  // ------------------------------------------------------------------ frame

  #frame(now) {
    const rawDt = Math.max(0, (now - this.last) / 1000);
    const dt = Math.min(0.05, rawDt);
    this.last = now;
    this.clock += dt;

    if (this.state === 'running' && this.moving) this.#placeMoving(now);

    // camera rig
    const sim = this.sim;
    const top = (this.state === 'running' ? sim.level : sim.layers.length - 1) * H;
    let tY = top;
    let tD = this.#playDist();
    let tPsi = Math.PI / 4;
    let rate = 2.6;
    if (this.state === 'idle') {
      tY = Math.max(10, top);
      tD = Math.max(this.#playDist() * 2.4, this.#fitDist(top) * 1.1);
      tPsi = Math.PI / 4 + Math.sin(this.clock * 0.06) * 0.35;
      rate = 0.6;
    } else if (this.state === 'over') {
      tD = Math.max(this.#playDist() * 1.15, this.#fitDist(top));
    }
    this.camY = damp(this.camY, tY, rate, dt);
    this.camD = damp(this.camD, tD, this.state === 'idle' ? 0.4 : 1.6, dt);
    this.camPsi = damp(this.camPsi, tPsi, this.state === 'idle' ? 0.5 : 1.5, dt);
    const hx = Math.cos(this.camPsi);
    const hz = Math.sin(this.camPsi);
    this.camera.position.set(hx * this.camD * Math.cos(ELEV), this.camY + this.camD * Math.sin(ELEV), hz * this.camD * Math.cos(ELEV));
    this.camera.lookAt(this.camera.position.x - hx, this.camera.position.y, this.camera.position.z - hz);

    const k = 1 - Math.exp(-5 * dt);
    const sx = this.shift.x + (this.shiftTarget.x - this.shift.x) * k;
    const sy = this.shift.y + (this.shiftTarget.y - this.shift.y) * k;
    if (Math.abs(sx - this.shift.x) > 1e-5 || Math.abs(sy - this.shift.y) > 1e-5) {
      this.shift = { x: sx, y: sy };
      this.#project();
      this.world.setFocus(TOWER_F - sy);
    }

    const info = this.world.update(dt, now, Math.min(0.5, rawDt), { y: this.camY, psi: this.camPsi, dist: this.camD, score: sim.score });
    const li = this.lastInfo;
    if (info.ink !== li.ink || info.icon !== li.icon || info.minutes !== li.minutes || info.night !== li.night) {
      Object.assign(li, info);
      this.onWorld?.(info);
    }

    this.#updateDebris(dt);
    this.#updateFx(dt);
    this.world.render(dt);
  }
}
