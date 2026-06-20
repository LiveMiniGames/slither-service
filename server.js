/**
 * Slither-style multiplayer game server.
 * Handles player connections, movement, growth, collisions, food, and round timing.
 * Broadcasts game state to all connected clients ~20 times per second.
 */
 
const WebSocket = require('ws');
const http = require('http');
 
const PORT = process.env.PORT || 8080;
 
// ── WORLD CONFIG ──────────────────────────────
const WORLD_RADIUS = 2200;        // circular play area radius (slither.io style)
const FOOD_COUNT = 300;           // pellets on the map at once
const TICK_RATE = 30;             // server updates per second (increased for smoothness)
const BASE_SPEED = 3.6;
const BOOST_SPEED = 6.5;
const TURN_RATE = 0.15;           // turning radius ~24px at base speed — kept wider than max snake thickness so curves stay visually clear instead of getting swallowed by a thick stroke
const SEGMENT_SPACING = 4;        // tighter spacing = smoother body curves through turns
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
  // Random point within the circular world (not just the bounding square)
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * (WORLD_RADIUS * 0.85); // keep spawns away from the very edge
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}
 
function spawnFood(n) {
  const foodColors = ['#f1c40f','#2ecc71','#e74c3c','#3498db','#e67e22','#9147ff','#1abc9c','#fd79a8'];
  for (let i = 0; i < n; i++) {
    const p = randPos();
    food.push({ id: nextFoodId++, x: p.x, y: p.y, value: FOOD_VALUE, color: foodColors[Math.floor(Math.random()*foodColors.length)] });
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
  const startSegCount = Math.max(20, Math.floor(STARTING_LENGTH * 2.2));
  for (let i = 0; i < startSegCount; i++) {
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
 
    // Circular world boundary — hitting the edge kills you, just like real slither.io.
    // Also catch NaN/Infinity here as a safety net: NaN > WORLD_RADIUS is always false in JS,
    // which would otherwise let a corrupted position silently pass through the wall undetected.
    const distFromCenter = Math.sqrt(newHead.x * newHead.x + newHead.y * newHead.y);
    if (!isFinite(distFromCenter) || distFromCenter > WORLD_RADIUS) {
      killPlayer(p);
      return;
    }
 
    // Boosting drops a trail of small food behind the snake (visual + real slither.io behavior)
    if (p.boosting && p.length > STARTING_LENGTH + 2) {
      const tail = p.segments[p.segments.length - 1];
      if (tail && Math.random() < 0.5) {
        food.push({ id: nextFoodId++, x: tail.x, y: tail.y, value: 1, color: p.color, isBoostTrail: true });
      }
    }
 
    p.segments.unshift(newHead);
    // More segments per length unit than before = smoother curves through turns.
    // (Previously 1 segment per length unit, which made short/young snakes look
    // jagged since they had very few points to draw a curve through.)
    const targetSegCount = Math.max(20, Math.floor(p.length * 2.2));
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
    if (seg) food.push({ id: nextFoodId++, x: seg.x + (Math.random()-0.5)*20, y: seg.y + (Math.random()-0.5)*20, value: 2, color: p.color });
  }
  broadcastTo(p.id, { type: 'died', score: Math.floor(p.score) });
}
 
function broadcastState() {
  const alive = Object.values(players).filter(p => p.alive);
  const leaderboard = [...alive].sort((a,b) => b.length - a.length).slice(0, 5)
    .map(p => ({ id: p.id, name: p.name, length: Math.floor(p.length), x: p.segments[0]?.x || 0, y: p.segments[0]?.y || 0 }));
 
  const payload = {
    type: 'state',
    players: alive.map(p => ({
      id: p.id, name: p.name, color: p.color,
      // Send every other segment once a snake gets long — keeps bandwidth/CPU stable
      // as more players join, without visibly changing how the snake looks
      segments: p.segments.length > 40 ? p.segments.filter((_, i) => i % 2 === 0) : p.segments,
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
    type: 'welcome', id, worldRadius: WORLD_RADIUS,
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
      // isFinite() rejects NaN and Infinity, unlike typeof === 'number' which lets them through.
      // A NaN angle here would propagate into the snake's position, which would then make the
      // wall-boundary check (distFromCenter > WORLD_RADIUS) silently always false for NaN,
      // letting a glitched snake pass through walls undetected.
      if (typeof data.angle === 'number' && isFinite(data.angle)) players[id].targetAngle = data.angle;
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
 
