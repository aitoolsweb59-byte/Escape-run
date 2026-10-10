import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200);
        res.end('OK');
    }
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

// Game Constants
const TICK_RATE = 1000 / 20; // 20 updates per second
const RUN_SPEED = 15; // units per second
const SPRINT_SPEED = 25;
const CATCH_DISTANCE = 3.5;
const LANES = [-3, 0, 3]; // X coordinates for Left, Center, Right
const MATCH_DURATION = 60000; // 60 seconds

function generateRoomCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms.has(code));
    return code;
}

wss.on('connection', (ws) => {
    let currentRoom = null;
    let playerId = Math.random().toString(36).substr(2, 9);
    
    ws.send(JSON.stringify({ type: 'CONNECTED', id: playerId }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, playerId, data, currentRoom);
        } catch (e) {
            console.error("Invalid message format");
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            delete room.players[playerId];
            if (Object.keys(room.players).length === 0) {
                clearInterval(room.gameLoop);
                rooms.delete(currentRoom);
            } else {
                if (room.host === playerId) room.host = Object.keys(room.players)[0];
                broadcast(room, { type: 'ROSTER_UPDATE', players: room.players, host: room.host });
            }
        }
    });

    function handleMessage(ws, id, data, roomCode) {
        switch (data.type) {
            case 'CREATE_ROOM':
                const newCode = generateRoomCode();
                currentRoom = newCode;
                rooms.set(newCode, {
                    code: newCode,
                    host: id,
                    state: 'LOBBY',
                    players: { [id]: { id, name: data.name || 'Player', role: 'runner', ready: false } },
                    gameState: {},
                    gameLoop: null
                });
                ws.send(JSON.stringify({ type: 'ROOM_CREATED', code: newCode }));
                break;

            case 'JOIN_ROOM':
                const code = data.code;
                if (rooms.has(code) && rooms.get(code).state === 'LOBBY') {
                    const room = rooms.get(code);
                    if (Object.keys(room.players).length >= 8) return ws.send(JSON.stringify({ type: 'ERROR', message: 'Room full' }));
                    currentRoom = code;
                    room.players[id] = { id, name: data.name || 'Player', role: 'chaser', ready: false };
                    ws.send(JSON.stringify({ type: 'JOINED_ROOM', code }));
                    broadcast(room, { type: 'ROSTER_UPDATE', players: room.players, host: room.host });
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid or active room' }));
                }
                break;

            case 'SET_ROLE':
                if (roomCode && rooms.has(roomCode)) {
                    const room = rooms.get(roomCode);
                    if (room.host === id && room.players[data.targetId]) {
                        room.players[data.targetId].role = data.role;
                        broadcast(room, { type: 'ROSTER_UPDATE', players: room.players, host: room.host });
                    }
                }
                break;

            case 'START_MATCH':
                if (roomCode && rooms.has(roomCode)) {
                    const room = rooms.get(roomCode);
                    if (room.host === id && room.state === 'LOBBY') {
                        startMatch(room);
                    }
                }
                break;

            case 'INPUT':
                if (roomCode && rooms.has(roomCode)) {
                    const room = rooms.get(roomCode);
                    if (room.state === 'PLAYING' && room.gameState[id]) {
                        // Validate inputs
                        const pState = room.gameState[id];
                        if (data.lane !== undefined && data.lane >= 0 && data.lane <= 2) pState.lane = LANES[data.lane];
                        if (data.sprint !== undefined) pState.isSprinting = data.sprint;
                        if (data.slide) pState.isSliding = true; // Simplified for MVP
                        if (data.jump) pState.isJumping = true;
                    }
                }
                break;
        }
    }
});

function startMatch(room) {
    room.state = 'PLAYING';
    room.gameState = {};
    
    // Initialize authoritative state
    let runnerZ = 0;
    let chaserZ = -15; // Chasers start behind
    
    for (const [id, player] of Object.entries(room.players)) {
        room.gameState[id] = {
            id,
            role: player.role,
            lane: LANES[1], // Center
            z: player.role === 'runner' ? runnerZ : chaserZ,
            isSprinting: false,
            stamina: 100,
            caught: false
        };
        if (player.role === 'chaser') chaserZ -= 5;
    }

    const endTime = Date.now() + MATCH_DURATION;
    broadcast(room, { type: 'MATCH_START', duration: MATCH_DURATION, state: room.gameState });

    room.gameLoop = setInterval(() => {
        simulateGame(room, endTime);
    }, TICK_RATE);
}

function simulateGame(room, endTime) {
    let runnersAlive = false;

    // Movement Physics
    for (const p of Object.values(room.gameState)) {
        if (p.caught) continue;
        
        let speed = p.isSprinting && p.stamina > 0 ? SPRINT_SPEED : RUN_SPEED;
        if (p.isSprinting && p.stamina > 0) p.stamina -= 2;
        else if (p.stamina < 100) p.stamina += 1;

        p.z += speed * (TICK_RATE / 1000);
        
        if (p.role === 'runner') runnersAlive = true;
    }

    // Catch Collision Detection (Server Authoritative)
    const runners = Object.values(room.gameState).filter(p => p.role === 'runner' && !p.caught);
    const chasers = Object.values(room.gameState).filter(p => p.role === 'chaser');

    for (const chaser of chasers) {
        for (const runner of runners) {
            // Check distance (Z and X lanes)
            const dz = Math.abs(chaser.z - runner.z);
            const dx = Math.abs(chaser.lane - runner.lane);
            if (dz < CATCH_DISTANCE && dx < 1) { // Close enough and in same lane
                runner.caught = true;
                runnersAlive = false;
                broadcast(room, { type: 'CATCH_EVENT', catcher: chaser.id, caught: runner.id });
            }
        }
    }

    // Win Conditions
    const timeLeft = endTime - Date.now();
    if (!runnersAlive) {
        endMatch(room, 'CHASERS_WIN');
    } else if (timeLeft <= 0) {
        endMatch(room, 'RUNNERS_WIN');
    } else {
        broadcast(room, { type: 'STATE_UPDATE', state: room.gameState, time: timeLeft });
    }
}

function endMatch(room, result) {
    clearInterval(room.gameLoop);
    room.state = 'RESULTS';
    broadcast(room, { type: 'MATCH_END', result });
    
    // Auto-return to lobby after 5 seconds
    setTimeout(() => {
        room.state = 'LOBBY';
        broadcast(room, { type: 'ROSTER_UPDATE', players: room.players, host: room.host });
    }, 5000);
}

function broadcast(room, payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach(client => {
        // Simple broadcast to all connected. In production, map clients to room ids.
        client.send(msg);
    });
}

server.listen(PORT, () => console.log(`Escape Hus Valley Multi-Server running on port ${PORT}`));
