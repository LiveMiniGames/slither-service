/**
 * Slither-style multiplayer game server.
 * Handles player connections, movement, growth, collisions, food, and round timing.
 * Broadcasts game state to all connected clients ~20 times per second.
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ── WORLD CONFIG ──────────────────────────────
const WORLD_SIZE = 4000;          // width & height of the play area
const FOOD_COUNT = 300;           // pellets on the map at once
const TICK_RATE = 20;             // server updates per second
const BASE_SPEED = 3.2;
const BOOST_SPEED = 5.5;
const TURN_RATE = 0.12;           // how fast snakes can turn
const SEGMENT_SPACING = 6;
const STARTING_LENGTH = 12;
const FOOD_VALUE = 1;             // length gained per food eaten
const KILL_FOOD_MULTIPLIER = 0.5; // fraction of dead snake's length that becomes food

// ── STATE ──────────────────────────────────────
let players = {};      // id -> player object
let food = [];         // { x, y, id, value }
let nextFoodId = 0;
let roundActive = false;
let roundEndTime = null;   // timestamp ms, or null for unlimited
let roundDurationMs = null;
let leaderboardHistory = []; // past round winners

function randPos() {
  return {
    x: Math.random() * WORLD_SIZE - WORLD_SIZE / 2,
    y: Math.random() * WORLD_SIZE - WORLD_SIZE / 2
  };
}

function spawnFood(n) {
  for (let i = 0; i < n; i++) {
    const p = randPos();
    food.push({ id: nextFoodId++, x: p.x, y: p.y, value: FOOD_VALUE });
  }
}
spawnFood(FOOD_COUNT);

function makeSnakeColor() {
  const colors = ['#9147ff','#2ecc71','#e74c3c','#f1c40f','#3498db','#e67e22','#1abc9c','#e84393','#00cec9','#fd79a8'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function spawnPlayer(id, name) {
  const p = randPos();
  const angle = Math.random() * Math.PI * 2;
  const segments = [];
  for (let i = 0; i < STARTING_LENGTH; i++) {
    segments.push({ x: p.x - Math.cos(angle) * i * SEGMENT_SPACING, y: p.y - Math.sin(angle) * i * SEGMENT_SPACING });
  }
  return {
    id,
    name: name || 'Player',
    segments,
    angle,
    targetAngle: angle,
    speed: BASE_SPEED,
    boosting: false,
    alive: true,
    color: makeSnakeColor(),
    length: STARTING_LENGTH,
    score: 0,
    spawnedAt: Date.now()
  };
}

// ── GAME LOOP ────────────────────────────────────
function tick() {
  const now = Date.now();

  // Check round timer
  if (roundActive && roundEndTime && now >= roundEndTime) {
    endRound();
  }

  Object.values(players).forEach(p => {
    if (!p.alive) return;

    // Smooth turning toward target angle
    let diff = p.targetAngle - p.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    p.angle += Math.max(-TURN_RATE, Math.min(TURN_RATE, diff));

    const speed = p.boosting && p.length > STARTING_LENGTH + 2 ? BOOST_SPEED : BASE_SPEED;
    if (p.boosting && p.length > STARTING_LENGTH + 2) {
      // Boosting costs length slowly
      p.length = Math.max(STARTING_LENGTH, p.length - 0.05);
    }

    const head = p.segments[0];
    const newHead = {
      x: head.x + Math.cos(p.angle) * speed,
      y: head.y + Math.sin(p.angle) * speed
    };

    // World boundary wraps around (easier than hard walls for casual play)
    if (newHead.x > WORLD_SIZE / 2) newHead.x = -WORLD_SIZE / 2;
    if (newHead.x < -WORLD_SIZE / 2) newHead.x = WORLD_SIZE / 2;
    if (newHead.y > WORLD_SIZE / 2) newHead.y = -WORLD_SIZE / 2;
    if (newHead.y < -WORLD_SIZE / 2) newHead.y = WORLD_SIZE / 2;

    p.segments.unshift(newHead);
    const targetSegCount = Math.floor(p.length);
    while (p.segments.length > targetSegCount) p.segments.pop();
  });

  // Food collision
  Object.values(players).forEach(p => {
    if (!p.alive) return;
    const head = p.segments[0];
    food = food.filter(f => {
      const dx = head.x - f.x, dy = head.y - f.y;
      if (dx * dx + dy * dy < 18 * 18) {
        p.length += f.value;
        p.score += f.value;
        return false;
      }
      return true;
    });
  });

  // Replenish food
  if (food.length < FOOD_COUNT) {
    spawnFood(Math.min(5, FOOD_COUNT - food.length));
  }

  // Snake-vs-snake collision (head touches any other snake's body = death)
  const alivePlayers = Object.values(players).filter(p => p.alive);
  alivePlayers.forEach(p => {
    const head = p.segments[0];
    alivePlayers.forEach(other => {
      if (other.id === p.id) return;
      // Skip own recent segments check, check other's body
      for (let i = 2; i < other.segments.length; i += 2) { // every other segment for perf
        const seg = other.segments[i];
        const dx = head.x - seg.x, dy = head.y - seg.y;
        if (dx * dx + dy * dy < 14 * 14) {
          killPlayer(p);
        }
      }
    });
  });

  broadcastState();
}

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  // Drop food where the snake died
  const dropCount = Math.min(40, Math.floor(p.length * KILL_FOOD_MULTIPLIER));
  for (let i = 0; i < dropCount; i++) {
    const seg = p.segments[Math.floor((i / dropCount) * p.segments.length)];
    if (seg) food.push({ id: nextFoodId++, x: seg.x + (Math.random()-0.5)*20, y: seg.y + (Math.random()-0.5)*20, value: 2 });
  }
  broadcastTo(p.id, { type: 'died', score: Math.floor(p.score) });
}

function broadcastState() {
  const alive = Object.values(players).filter(p => p.alive);
  const leaderboard = [...alive].sort((a,b) => b.length - a.length).slice(0, 10)
    .map(p => ({ id: p.id, name: p.name, length: Math.floor(p.length) }));

  const payload = {
    type: 'state',
    players: alive.map(p => ({
      id: p.id, name: p.name, color: p.color,
      segments: p.segments.filter((_, i) => i % 1 === 0), // could thin for perf if needed
      length: Math.floor(p.length)
    })),
    food: food,
    leaderboard,
    roundActive,
    roundEndTime,
    playerCount: alive.length
  };
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function broadcastTo(playerId, data) {
  const client = clientsById[playerId];
  if (client && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function startRound(durationMinutes) {
  roundActive = true;
  roundDurationMs = durationMinutes ? durationMinutes * 60 * 1000 : null;
  roundEndTime = roundDurationMs ? Date.now() + roundDurationMs : null;
  // Respawn everyone fresh
  Object.keys(players).forEach(id => {
    players[id] = spawnPlayer(id, players[id].name);
  });
  broadcastAll({ type: 'round-start', roundEndTime, unlimited: !durationMinutes });
}

function endRound() {
  const alive = Object.values(players).filter(p => p.alive);
  const winner = [...alive].sort((a,b) => b.length - a.length)[0];
  roundActive = false;
  roundEndTime = null;
  if (winner) {
    leaderboardHistory.unshift({ name: winner.name, length: Math.floor(winner.length), time: Date.now() });
    leaderboardHistory = leaderboardHistory.slice(0, 20);
  }
  broadcastAll({ type: 'round-end', winner: winner ? { name: winner.name, length: Math.floor(winner.length) } : null });
}

// ── WEBSOCKET SERVER ────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', players: Object.keys(players).length, roundActive }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Slither game server running');
});

const wss = new WebSocket.Server({ server });
const clientsById = {};
let nextId = 1;

wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  clientsById[id] = ws;
  ws.playerId = id;
  ws.isHost = false;

  ws.send(JSON.stringify({
    type: 'welcome', id, worldSize: WORLD_SIZE,
    roundActive, roundEndTime,
    leaderboardHistory
  }));

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }

    if (data.type === 'join') {
      players[id] = spawnPlayer(id, (data.name || 'Player').slice(0, 20));
      if (data.hostKey === HOST_KEY) ws.isHost = true;
    }

    if (data.type === 'input' && players[id]) {
      if (typeof data.angle === 'number') players[id].targetAngle = data.angle;
      players[id].boosting = !!data.boosting;
    }

    if (data.type === 'host-start-round' && ws.isHost) {
      startRound(data.minutes || null);
    }

    if (data.type === 'host-end-round' && ws.isHost) {
      endRound();
    }

    if (data.type === 'host-auth' && data.hostKey === HOST_KEY) {
      ws.isHost = true;
      ws.send(JSON.stringify({ type: 'host-confirmed' }));
    }
  });

  ws.on('close', () => {
    delete players[id];
    delete clientsById[id];
  });
});

// Simple host key so only the streamer can control round start/stop
// (set via Railway environment variable, falls back to a default for convenience)
const HOST_KEY = process.env.HOST_KEY || 'fwhaydo-host-2026';

setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`[Slither] Server running on port ${PORT}`);
  console.log(`[Slither] Host key: ${HOST_KEY}`);
});
