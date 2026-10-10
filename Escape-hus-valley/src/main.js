import * as THREE from 'three';

// --- CONFIGURATION ---
const WS_URL = import.meta.env.VITE_WS_URL || (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host;
const LANES = [-3, 0, 3];

// --- APP STATE ---
const state = {
    myId: null,
    roomCode: null,
    isHost: false,
    gameState: 'MENU',
    players: {},
    gameSim: {},
    localLaneIdx: 1,
    cameraShake: 0
};

// --- DOM ELEMENTS ---
const uiMain = document.getElementById('ui-main');
const uiLobby = document.getElementById('ui-lobby');
const uiHud = document.getElementById('ui-hud');
const uiResults = document.getElementById('ui-results');
const inputName = document.getElementById('player-name');
const statusTxt = document.getElementById('connection-status');
const rosterList = document.getElementById('roster-list');

// --- NETWORKING ---
let ws;
function connectWS() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { statusTxt.innerText = "Connected to Server"; statusTxt.style.color = "#00ffcc"; };
    ws.onclose = () => { statusTxt.innerText = "Disconnected. Refresh to reconnect."; statusTxt.style.color = "#ff3366"; };
    ws.onmessage = (msg) => handleNetworkMessage(JSON.parse(msg.data));
}

function handleNetworkMessage(data) {
    switch(data.type) {
        case 'CONNECTED': state.myId = data.id; break;
        case 'ROOM_CREATED':
            state.isHost = true; state.roomCode = data.code;
            document.getElementById('btn-start').classList.remove('hidden');
            showUI(uiLobby); document.getElementById('lobby-code').innerText = data.code;
            break;
        case 'JOINED_ROOM':
            state.isHost = false; state.roomCode = data.code;
            showUI(uiLobby); document.getElementById('lobby-code').innerText = data.code;
            break;
        case 'ROSTER_UPDATE':
            state.players = data.players;
            if (data.host === state.myId) { state.isHost = true; document.getElementById('btn-start').classList.remove('hidden'); }
            updateRosterUI();
            if (state.gameState === 'RESULTS') { showUI(uiLobby); state.gameState = 'LOBBY'; }
            break;
        case 'MATCH_START':
            state.gameState = 'PLAYING'; state.gameSim = data.state;
            init3DWorld(); showUI(uiHud);
            document.getElementById('role-display').innerText = state.gameSim[state.myId].role.toUpperCase();
            document.getElementById('role-display').style.color = state.gameSim[state.myId].role === 'runner' ? '#00ffcc' : '#ff3366';
            break;
        case 'STATE_UPDATE':
            state.gameSim = data.state;
            document.getElementById('time-display').innerText = (data.time / 1000).toFixed(1) + "s";
            if (state.gameSim[state.myId]) document.getElementById('stamina-bar').style.width = state.gameSim[state.myId].stamina + "%";
            break;
        case 'CATCH_EVENT':
            if (data.caught === state.myId) state.cameraShake = 1.0; // Trigger violent shake if you are caught
            createCatchEffect(data.caught);
            break;
        case 'MATCH_END':
            state.gameState = 'RESULTS'; showUI(uiResults);
            document.getElementById('result-title').innerText = data.result.replace('_', ' ');
            document.getElementById('result-title').style.color = data.result.includes('RUNNER') ? '#00ffcc' : '#ff3366';
            cleanup3DWorld();
            break;
        case 'ERROR': alert(data.message); break;
    }
}

// --- UI LOGIC ---
function showUI(element) {
    [uiMain, uiLobby, uiHud, uiResults].forEach(el => el.classList.add('hidden'));
    element.classList.remove('hidden');
}

function updateRosterUI() {
    rosterList.innerHTML = '';
    Object.values(state.players).forEach(p => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${p.name} ${p.id === state.myId ? '(You)' : ''}</span> 
                        <span class="role-badge ${p.role}" onclick="toggleRole('${p.id}')">${p.role}</span>`;
        rosterList.appendChild(li);
    });
}

window.toggleRole = (id) => {
    if (state.isHost) {
        const newRole = state.players[id].role === 'runner' ? 'chaser' : 'runner';
        ws.send(JSON.stringify({ type: 'SET_ROLE', targetId: id, role: newRole }));
    }
};

// --- BUTTON LISTENERS ---
document.getElementById('btn-create').onclick = () => ws.send(JSON.stringify({ type: 'CREATE_ROOM', name: inputName.value || 'Player' }));
document.getElementById('btn-join').onclick = () => {
    const code = document.getElementById('room-code-input').value;
    if(code.length === 4) ws.send(JSON.stringify({ type: 'JOIN_ROOM', code, name: inputName.value || 'Player' }));
};
document.getElementById('btn-start').onclick = () => ws.send(JSON.stringify({ type: 'START_MATCH' }));

// --- INPUT HANDLING ---
const keys = { sprint: false };
window.addEventListener('keydown', (e) => {
    if (state.gameState !== 'PLAYING' || !state.gameSim[state.myId] || state.gameSim[state.myId].caught) return;
    if (e.key === 'a' || e.key === 'ArrowLeft') changeLane(-1);
    if (e.key === 'd' || e.key === 'ArrowRight') changeLane(1);
    if (e.key === 'Shift') sendInput({ sprint: true });
});
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') sendInput({ sprint: false }); });

document.getElementById('btn-left').ontouchstart = () => changeLane(-1);
document.getElementById('btn-right').ontouchstart = () => changeLane(1);
document.getElementById('btn-jump').ontouchstart = () => sendInput({ sprint: true }); // Mobile sprint mapping for now
document.getElementById('btn-jump').ontouchend = () => sendInput({ sprint: false });

function changeLane(dir) {
    state.localLaneIdx = Math.max(0, Math.min(2, state.localLaneIdx + dir));
    sendInput({ lane: state.localLaneIdx });
}
function sendInput(data) { ws.send(JSON.stringify({ type: 'INPUT', ...data })); }

// --- PROCEDURAL CHARACTER SYSTEM ---
class ProceduralCharacter {
    constructor(role) {
        this.group = new THREE.Group();
        this.color = role === 'runner' ? 0x00ffcc : 0xff3366;
        
        // Shared materials (Performance optimization)
        const bodyMat = new THREE.MeshStandardMaterial({ 
            color: 0x111111, roughness: 0.5, metalness: 0.8 
        });
        const accentMat = new THREE.MeshStandardMaterial({ 
            color: this.color, emissive: this.color, emissiveIntensity: 0.8 
        });

        // Geometries
        const headGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
        const torsoGeo = new THREE.BoxGeometry(0.8, 1.2, 0.5);
        const limbGeo = new THREE.BoxGeometry(0.25, 1.0, 0.25);

        this.head = new THREE.Mesh(headGeo, accentMat);
        this.head.position.y = 1.6;
        this.head.castShadow = true;

        this.torso = new THREE.Mesh(torsoGeo, bodyMat);
        this.torso.position.y = 0.8;
        this.torso.castShadow = true;

        this.leftArm = new THREE.Mesh(limbGeo, accentMat);
        this.leftArm.position.set(-0.6, 1.0, 0);
        this.rightArm = new THREE.Mesh(limbGeo, accentMat);
        this.rightArm.position.set(0.6, 1.0, 0);

        this.leftLeg = new THREE.Mesh(limbGeo, bodyMat);
        this.leftLeg.position.set(-0.25, 0.5, 0);
        this.rightLeg = new THREE.Mesh(limbGeo, bodyMat);
        this.rightLeg.position.set(0.25, 0.5, 0);

        this.group.add(this.head, this.torso, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
        this.runCycle = 0;
    }

    animate(speedMultiplier, isCaught, targetX) {
        if (isCaught) {
            this.group.rotation.x = THREE.MathUtils.lerp(this.group.rotation.x, -Math.PI / 2, 0.1);
            this.group.position.y = THREE.MathUtils.lerp(this.group.position.y, -0.4, 0.1);
            return;
        }

        // Run cycle using Sine waves
        this.runCycle += 0.15 * speedMultiplier;
        const armSwing = Math.sin(this.runCycle) * 0.8;
        const legSwing = Math.cos(this.runCycle) * 0.8;
        const bounce = Math.abs(Math.sin(this.runCycle * 2)) * 0.2;

        this.leftArm.rotation.x = -armSwing;
        this.rightArm.rotation.x = armSwing;
        this.leftLeg.rotation.x = legSwing;
        this.rightLeg.rotation.x = -legSwing;

        this.group.position.y = bounce;

        // Dynamic Leaning when switching lanes
        const turnTilt = (this.group.position.x - targetX) * 0.5;
        this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, turnTilt, 0.2);
        this.group.rotation.y = THREE.MathUtils.lerp(this.group.rotation.y, turnTilt * 0.5, 0.2);
    }
}

// --- THREE.JS ENGINE ---
const container = document.getElementById('game-container');
let scene, camera, renderer, clock;
let playerModels = {};
let speedParticles;

function init3DWorld() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020204);
    scene.fog = new THREE.FogExp2(0x020204, 0.04); // Dense atmospheric fog

    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 200);
    
    // Performance limit pixel ratio for mobile
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); 
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap; // Cheaper shadows
    container.appendChild(renderer.domElement);
    clock = new THREE.Clock();

    // Cinematic Lighting
    const ambient = new THREE.AmbientLight(0x202040, 2.0);
    scene.add(ambient);
    const pointLight = new THREE.PointLight(0x00ffcc, 5, 50);
    pointLight.position.set(0, 10, 0);
    scene.add(pointLight);

    // Stylized Synthwave Grid Floor
    const gridGeo = new THREE.PlaneGeometry(200, 400, 20, 40);
    const gridMat = new THREE.MeshBasicMaterial({ color: 0x222244, wireframe: true, transparent: true, opacity: 0.3 });
    const grid = new THREE.Mesh(gridGeo, gridMat);
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = 0;
    scene.add(grid);
    scene.userData.grid = grid; // Save for animation

    // Initialize Speed Particles (Instanced Mesh for high performance)
    const particleGeo = new THREE.BoxGeometry(0.1, 0.1, 4.0);
    const particleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
    speedParticles = new THREE.InstancedMesh(particleGeo, particleMat, 100);
    const dummy = new THREE.Object3D();
    for(let i=0; i<100; i++) {
        dummy.position.set((Math.random() - 0.5) * 40, Math.random() * 10, (Math.random() - 0.5) * 100);
        dummy.updateMatrix();
        speedParticles.setMatrixAt(i, dummy.matrix);
    }
    scene.add(speedParticles);

    // Spawn Characters
    Object.values(state.gameSim).forEach(p => {
        const char = new ProceduralCharacter(p.role);
        char.group.position.set(LANES[1], 0, p.z);
        scene.add(char.group);
        playerModels[p.id] = char;
    });

    renderer.setAnimationLoop(renderLoop);
}

function createCatchEffect(targetId) {
    const char = playerModels[targetId];
    if (!char) return;
    
    // Turn character grey
    char.head.material.color.setHex(0x333333);
    char.head.material.emissiveIntensity = 0;
}

function renderLoop() {
    const dt = clock.getDelta();
    const time = Date.now();

    // Move Floor to simulate infinite speed
    const mySim = state.gameSim[state.myId];
    if (scene.userData.grid && mySim) {
        scene.userData.grid.position.z = mySim.z - (mySim.z % 10);
    }

    // Animate Speed Particles
    const dummy = new THREE.Object3D();
    const speed = mySim && mySim.isSprinting ? 2.0 : 1.0;
    for(let i=0; i<100; i++) {
        speedParticles.getMatrixAt(i, dummy.matrix);
        dummy.position.setFromMatrixPosition(dummy.matrix);
        dummy.position.z -= speed;
        if (mySim && dummy.position.z < mySim.z - 20) {
            dummy.position.z = mySim.z + 80;
            dummy.position.x = (Math.random() - 0.5) * 40;
        }
        dummy.updateMatrix();
        speedParticles.setMatrixAt(i, dummy.matrix);
    }
    speedParticles.instanceMatrix.needsUpdate = true;

    // Interpolate remote state and animate characters
    Object.values(state.gameSim).forEach(serverP => {
        const char = playerModels[serverP.id];
        if(char) {
            char.group.position.x = THREE.MathUtils.lerp(char.group.position.x, serverP.lane, 0.15);
            char.group.position.z = THREE.MathUtils.lerp(char.group.position.z, serverP.z, 0.3);
            
            const speedMult = (serverP.isSprinting && serverP.stamina > 0) ? 1.5 : 1.0;
            char.animate(speedMult, serverP.caught, serverP.lane);
        }
    });

    // Camera Logic
    if(mySim && playerModels[state.myId]) {
        const myMesh = playerModels[state.myId].group;
        
        // FOV shifting based on sprint state
        const targetFOV = (mySim.isSprinting && mySim.stamina > 0) ? 90 : 75;
        camera.fov = THREE.MathUtils.lerp(camera.fov, targetFOV, 0.1);
        camera.updateProjectionMatrix();

        // Smooth camera follow
        camera.position.x = THREE.MathUtils.lerp(camera.position.x, myMesh.position.x * 0.4, 0.1);
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, 4, 0.1);
        
        const camZOffset = mySim.role === 'chaser' ? -7 : -5; 
        camera.position.z = THREE.MathUtils.lerp(camera.position.z, myMesh.position.z + camZOffset, 0.2);
        
        const lookTarget = new THREE.Vector3(myMesh.position.x * 0.2, 1, myMesh.position.z + 10);
        camera.lookAt(lookTarget);

        // Screen Shake Effect
        if (state.cameraShake > 0) {
            camera.position.x += (Math.random() - 0.5) * state.cameraShake;
            camera.position.y += (Math.random() - 0.5) * state.cameraShake;
            state.cameraShake -= 0.05; // Fade out shake
        }
    }

    renderer.render(scene, camera);
}

function cleanup3DWorld() {
    if (renderer) renderer.setAnimationLoop(null);
    if (container.firstChild) container.removeChild(renderer.domElement);
    playerModels = {};
}

// Window resize handling
window.addEventListener('resize', () => {
    if(camera && renderer) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
});

// Init
connectWS();
