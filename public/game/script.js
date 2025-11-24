// --- BRIDGE ---
window.startGame = startGame;
window.focus();

// --- CONFIG ---
const BOX_HEIGHT = 0.8;
const ORIGINAL_SIZE = 4.5;
const ZOOM = 18;
const SPEED_BASE = 0.12;
// We keep this ONLY for the visual sparkle, not for snapping physics
const PERFECTION_TOLERANCE = 0.1; 

// --- STATE ---
let scene, camera, renderer, world;
let stack = [];
let overhangs = [];
let particles = [];
let gameEnded = false;
let hue = 200;
let animationId;
let combo = 0;

const scoreEl = document.getElementById("score");
const menuEl = document.getElementById("menu");

init();

function init() {
    // 1. Physics
    world = new CANNON.World();
    world.gravity.set(0, -20, 0);
    world.broadphase = new CANNON.NaiveBroadphase();
    world.solver.iterations = 40;

    // 2. Scene
    scene = new THREE.Scene();

    // 3. Camera
    const aspect = window.innerWidth / window.innerHeight;
    const d = ZOOM;
    camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
    camera.position.set(4, 4, 4);
    camera.lookAt(0, 0, 0);

    // 4. Renderer
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById("world").appendChild(renderer.domElement);

    // 5. Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(20, 50, 20);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);

    resetGame();
    animate();
}

function resetGame() {
    stack.forEach(i => { scene.remove(i.mesh); world.remove(i.body); });
    overhangs.forEach(i => { scene.remove(i.mesh); world.remove(i.body); });
    particles.forEach(p => scene.remove(p.mesh));
    
    stack = [];
    overhangs = [];
    particles = [];
    
    gameEnded = false;
    hue = 215;
    combo = 0;
    scoreEl.innerText = "0";
    updateBackground();

    addLayer(0, 0, ORIGINAL_SIZE, ORIGINAL_SIZE);
    addLayer(-10, 0, ORIGINAL_SIZE, ORIGINAL_SIZE, "x");

    camera.position.y = 4;
    camera.lookAt(0, 0, 0);
}

function startGame() {
    if(gameEnded) resetGame();
    menuEl.style.opacity = "0";
    setTimeout(() => menuEl.style.display = "none", 300);
}

function addLayer(x, z, width, depth, direction) {
    const y = stack.length * BOX_HEIGHT;
    const color = new THREE.Color(`hsl(${hue}, 60%, 65%)`);
    
    const geometry = new THREE.BoxGeometry(width, BOX_HEIGHT, depth);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const shape = new CANNON.Box(new CANNON.Vec3(width/2, BOX_HEIGHT/2, depth/2));
    const body = new CANNON.Body({ mass: 0, shape });
    body.position.set(x, y, z);
    world.addBody(body);

    stack.push({ mesh, body, width, depth, direction });
}

function addOverhang(x, z, width, depth, color) {
    const y = (stack.length - 1) * BOX_HEIGHT;
    const geometry = new THREE.BoxGeometry(width, BOX_HEIGHT, depth);
    const material = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const shape = new CANNON.Box(new CANNON.Vec3(width/2, BOX_HEIGHT/2, depth/2));
    const body = new CANNON.Body({ mass: 5, shape });
    body.position.set(x, y, z);
    
    const rand = () => (Math.random() - 0.5) * 10;
    body.angularVelocity.set(rand(), rand(), rand()); 

    world.addBody(body);
    overhangs.push({ mesh, body });
}

function spawnParticles(x, y, z, color) {
    for (let i = 0; i < 20; i++) {
        const size = 0.2 + Math.random() * 0.3;
        const geometry = new THREE.BoxGeometry(size, size, size);
        const material = new THREE.MeshBasicMaterial({ color });
        const mesh = new THREE.Mesh(geometry, material);
        
        mesh.position.set(x + (Math.random() - 0.5), y, z + (Math.random() - 0.5));
        
        const velX = (Math.random() - 0.5) * 10;
        const velY = (Math.random() - 0.5) * 10;
        const velZ = (Math.random() - 0.5) * 10;

        scene.add(mesh);
        particles.push({ mesh, velX, velY, velZ, life: 1.0 });
    }
}

function cutBox() {
    const top = stack[stack.length - 1];
    const prev = stack[stack.length - 2];
    const dir = top.direction;

    const delta = top.mesh.position[dir] - prev.mesh.position[dir];
    const size = dir === "x" ? top.width : top.depth;
    const diff = Math.abs(delta);
    const overlap = size - diff;

    if (overlap > 0) {
        // --- PURE SKILL LOGIC ---
        // No matter how close they are, we ALWAYS cut the box.
        // No snapping to center.
        
        const newW = dir === "x" ? overlap : top.width;
        const newD = dir === "z" ? overlap : top.depth;
        
        // Update Physics & Visuals (The Cut)
        top.width = newW;
        top.depth = newD;
        top.mesh.scale[dir] = overlap / size;
        top.mesh.position[dir] -= delta / 2;
        top.body.position[dir] -= delta / 2;

        // Spawn Debris (The excess part falls off)
        const shift = (overlap/2 + diff/2) * Math.sign(delta);
        const ox = dir === "x" ? top.mesh.position.x + shift : top.mesh.position.x;
        const oz = dir === "z" ? top.mesh.position.z + shift : top.mesh.position.z;
        const ow = dir === "x" ? diff : newW;
        const od = dir === "z" ? diff : newD;
        
        if(ow > 0.05 && od > 0.05) { // Only spawn if visible
            addOverhang(ox, oz, ow, od, top.mesh.material.color);
        }

        // --- VISUAL REWARD ONLY ---
        // If they were super precise, we show particles, but we DO NOT change the physics.
        if (diff < PERFECTION_TOLERANCE) {
            combo++;
            spawnParticles(top.mesh.position.x, top.mesh.position.y, top.mesh.position.z, top.mesh.material.color);
            document.body.style.background = "#fff"; // Flash
            setTimeout(updateBackground, 50);
        } else {
            combo = 0;
        }

        // Next Layer
        hue += 4;
        updateBackground();
        scoreEl.innerText = stack.length - 1;

        const nextDir = dir === "x" ? "z" : "x";
        const spawn = -12;
        const nx = nextDir === "x" ? spawn : top.mesh.position.x;
        const nz = nextDir === "z" ? spawn : top.mesh.position.z;

        addLayer(nx, nz, newW, newD, nextDir);
    } else {
        gameOver();
    }
}

function gameOver() {
    gameEnded = true;
    const top = stack[stack.length - 1];
    addOverhang(top.mesh.position.x, top.mesh.position.z, top.width, top.depth, top.mesh.material.color);
    scene.remove(top.mesh);
    world.remove(top.body);
    stack.pop();

    menuEl.style.display = "flex";
    setTimeout(() => menuEl.style.opacity = "1", 10);
    document.querySelector(".title").innerText = "GAME OVER";
    document.querySelector(".btn").innerText = "RETRY";

    const score = stack.length - 1;
    if(score > 0) {
        window.parent.postMessage({ type: "GAME_OVER", score }, "*");
    }
}

function updateBackground() {
    const h1 = hue % 360;
    const h2 = (hue + 40) % 360;
    document.body.style.background = `linear-gradient(180deg, hsl(${h1}, 50%, 80%) 0%, hsl(${h2}, 50%, 90%) 100%)`;
    scoreEl.style.color = `hsl(${h1}, 30%, 30%)`;
}

function animate() {
    requestAnimationFrame(animate);

    if (!gameEnded && menuEl.style.display === "none" && stack.length > 1) {
        const top = stack[stack.length - 1];
        const time = Date.now() * 0.0015;
        const range = 6;
        const pos = Math.sin(time) * range;
        
        if (top.direction === "x") {
            top.mesh.position.x = pos;
            top.body.position.x = pos;
        } else {
            top.mesh.position.z = pos;
            top.body.position.z = pos;
        }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= 0.02;
        p.mesh.position.x += p.velX * 0.05;
        p.mesh.position.y += p.velY * 0.05;
        p.mesh.position.z += p.velZ * 0.05;
        p.velY -= 0.5;
        p.mesh.rotation.x += 0.1;
        p.mesh.scale.setScalar(p.life);
        if (p.life <= 0) {
            scene.remove(p.mesh);
            particles.splice(i, 1);
        }
    }

    if(!gameEnded) {
        let targetY = stack.length * BOX_HEIGHT + 4;
        if(combo > 0) targetY += Math.sin(Date.now() * 0.1) * 0.05 * combo; 
        camera.position.y += (targetY - camera.position.y) * 0.05;
    }

    world.step(1/60);
    overhangs.forEach(o => {
        o.mesh.position.copy(o.body.position);
        o.mesh.quaternion.copy(o.body.quaternion);
    });

    renderer.render(scene, camera);
}

window.addEventListener("mousedown", (e) => {
    if(e.target.closest(".btn")) return;
    if(!gameEnded && menuEl.style.display === "none") cutBox();
});

window.addEventListener("keydown", (e) => {
    if(e.code === "Space") {
        e.preventDefault();
        if(!gameEnded && menuEl.style.display === "none") cutBox();
        else if(menuEl.style.display !== "none") startGame();
    }
});

window.addEventListener("resize", () => {
    const aspect = window.innerWidth / window.innerHeight;
    const d = ZOOM;
    camera.left = -d * aspect;
    camera.right = d * aspect;
    camera.top = d;
    camera.bottom = -d;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});