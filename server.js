// Tiny Wars server: static files + WebSocket rooms. Authoritative simulation.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./shared/game');

const PORT = process.env.PORT || 8787;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---- rooms ----
const rooms = new Map();   // code -> room

function makeCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusable chars
  for (;;) {
    let c = '';
    const b = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) c += alphabet[b[i] % alphabet.length];
    if (!rooms.has(c)) return c;
  }
}

function token() { return crypto.randomBytes(16).toString('hex'); }

function createRoom(opts = {}) {
  const code = makeCode();
  const room = {
    code, players: [],           // [{ws, team, name, connected, lastSeen}]
    match: null,
    created: Date.now(),
    cfg: {
      turnTime: clampNum(opts.turnTime, 10, 60, G.TURN_TIME),
      sdRound: clampNum(opts.sdRound, 3, 50, 10),
    },
    tick: null,
    lastAction: new Map(),       // team -> ms, naive duplicate-action guard
  };
  rooms.set(code, room);
  return room;
}

function clampNum(v, lo, hi, dflt) {
  v = Number(v);
  return isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;
}

function joinRoom(code, ws, name) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (!room) return { err: 'no_room' };
  if (room.players.length >= 2) return { err: 'full' };
  const team = room.players.length;
  const p = { ws, team, name: String(name || `Player ${team + 1}`).slice(0, 16),
    connected: true, lastSeen: Date.now(), tok: token() };
  room.players.push(p);
  return { room, player: p };
}

function rejoinRoom(code, tok, ws) {
  const room = rooms.get(String(code || '').toUpperCase().trim());
  if (!room) return { err: 'no_room' };
  const p = room.players.find(x => x.tok === tok);
  if (!p) return { err: 'bad_token' };
  p.ws = ws; p.connected = true; p.lastSeen = Date.now();
  return { room, player: p };
}

function send(obj) { if (this && this.readyState === 1) this.send(JSON.stringify(obj)); }

// ---- practice bot: ballistic solver + walks into range, zero tokens / no AI service ----
function botTick(room, m, now) {
  const bot = room.players.find(p => p.bot);
  if (!bot || m.phase !== 'aim' || m.activeTeam !== bot.team) { room.botDue = null; return; }
  if (!room.botDue) { room.botDue = now + 1600; return; }   // let the player see the turn change
  if (now < room.botDue) return;
  const src = G.activePlayer(m);
  const foes = m.players.filter(q => q.alive && q.team !== bot.team);
  if (!src || !foes.length) return;
  const dst = foes.reduce((a, b) =>
    Math.hypot(a.x - src.x, a.y - src.y) < Math.hypot(b.x - src.x, b.y - src.y) ? a : b);
  const solve = G.solveShot(m, src, dst);
  const turnKey = m.round + ':' + m.activeTeam;
  if (room.botWalkKey !== turnKey) { room.botWalkKey = turnKey; room.botWalks = 0; }
  if (solve.score > 130 && room.botWalks < 2) {
    // out of reach: walk toward the enemy (muzzle clears before turn ends)
    room.botWalks++;
    G.setInput(m, bot.team, dst.x > src.x ? 1 : -1, false);
    room.botDue = now + 1600;
    return;
  }
  room.botDue = null;
  G.setInput(m, bot.team, 0, false);
  // deliberately dumb: aim error so a human can win
  const angle = Math.max(5, Math.min(89, solve.angle + (Math.random() * 8 - 4)));
  const power = Math.max(5, Math.min(100, solve.power + (Math.random() * 12 - 6)));
  const evs = [];
  G.setAim(m, bot.team, angle, power);
  if (!G.fire(m, bot.team, 'bazooka', evs).err && evs.length) broadcast(room, { t: 'event', evs });
}

function broadcast(room, obj) { for (const p of room.players) send.call(p.ws, obj); }

function roomInfo(room) {
  return { t: 'room', code: room.code, cfg: room.cfg,
    players: room.players.map(p => ({ team: p.team, name: p.name, connected: p.connected })),
    started: !!room.match };
}

function startMatch(room, seed) {
  room.match = G.createMatch(seed, room.cfg);
  broadcast(room, { t: 'start', state: G.serialize(room.match, true) });
  broadcast(room, roomInfo(room));
  if (!room.tick) {
    room.tick = setInterval(() => tickRoom(room), 1000 / 30);
    room.tick.unref();   // server.listen keeps the process alive, not this timer
  }
}

function tickRoom(room) {
  const m = room.match;
  if (!m) return;
  // forfeit: a disconnected player burns their own turn timer fast, and if
  // they stay gone past 90s the match ends.
  // ponytail: fixed 90s forfeit; per-room configurable if it ever matters
  for (const p of room.players) {
    if (!p.connected && Date.now() - p.lastSeen > 90000 && m.phase !== 'over') {
      m.phase = 'over';
      m.winner = 1 - p.team;
      broadcast(room, { t: 'event', evs: [{ t: 'over', winner: m.winner, why: 'forfeit' }] });
    }
  }
  const evs = G.step(m, 1 / 30);
  botTick(room, m, Date.now());
  if (evs.length) broadcast(room, { t: 'event', evs });
  broadcast(room, { t: 'state', s: G.serialize(m) });
  // reap dead rooms (match over + both gone, or empty room > 30 min)
  const anyConn = room.players.some(p => p.connected && !p.bot);
  if (!anyConn && (m.phase === 'over' || Date.now() - room.created > 30 * 60e3)) {
    clearInterval(room.tick);
    rooms.delete(room.code);
  }
  if (!room.players.length) { clearInterval(room.tick); rooms.delete(room.code); }
}

// ---- websocket ----
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null, me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== 'object' || !msg) return;
    const now = Date.now();

    if (msg.t === 'create' || msg.t === 'join' || msg.t === 'practice') {
      // explicit action: detach from any auto-rejoined room first
      if (room) {
        if (me) { me.connected = false; me.lastSeen = Date.now(); }
        broadcast(room, roomInfo(room));
        room = null; me = null;
      }
    }

    if (msg.t === 'create') {
      room = createRoom(msg.opts);
      const j = joinRoom(room.code, ws, msg.name);
      me = j.player;
      send.call(ws, { t: 'room', code: room.code, cfg: room.cfg, you: me.team, tok: me.tok,
        players: room.players.map(p => ({ team: p.team, name: p.name, connected: p.connected })), started: false });
      return;
    }

    if (msg.t === 'practice') {
      room = createRoom(msg.opts);
      me = joinRoom(room.code, ws, msg.name).player;
      // dummy opponent: no ws (broadcast skips it), random tok so rejoin can't claim the slot
      room.players.push({ ws: null, team: 1, name: 'BOT', bot: true, connected: true,
        lastSeen: Date.now(), tok: token() });
      send.call(ws, { t: 'room', code: room.code, cfg: room.cfg, you: me.team, tok: me.tok,
        players: room.players.map(p => ({ team: p.team, name: p.name, connected: p.connected })), started: false });
      startMatch(room, msg.seed);
      return;
    }

    if (msg.t === 'rejoin') {
      if (room) return send.call(ws, { t: 'err', m: 'already' });
      const j = rejoinRoom(msg.code, msg.tok, ws);
      if (j.err) return send.call(ws, { t: 'err', m: j.err });
      room = j.room; me = j.player;
      send.call(ws, { t: 'room', code: room.code, cfg: room.cfg, you: me.team, tok: me.tok,
        players: room.players.map(p => ({ team: p.team, name: p.name, connected: p.connected })), started: !!room.match });
      broadcast(room, roomInfo(room));
      // restore: full state incl. terrain so a reconnecting client rebuilds everything
      if (room.match) send.call(ws, { t: 'start', state: G.serialize(room.match, true), resume: true });
      return;
    }

    if (msg.t === 'join') {
      const j = joinRoom(msg.code, ws, msg.name);
      if (j.err) return send.call(ws, { t: 'err', m: j.err });
      room = j.room; me = j.player;
      send.call(ws, { t: 'room', code: room.code, cfg: room.cfg, you: me.team, tok: me.tok,
        players: room.players.map(p => ({ team: p.team, name: p.name, connected: p.connected })), started: !!room.match });
      broadcast(room, roomInfo(room));
      if (room.players.length === 2 && !room.match && msg.autostart !== false) startMatch(room, msg.seed);
      return;
    }

    // from here on: must be in a room
    if (!room || !me) return send.call(ws, { t: 'err', m: 'no_room' });
    me.lastSeen = now;
    const m = room.match;

    switch (msg.t) {
      case 'start':
        if (me.team !== 0) return send.call(ws, { t: 'err', m: 'only_creator' });
        if (room.match) return send.call(ws, { t: 'err', m: 'started' });
        startMatch(room, msg.seed);
        break;
      case 'rematch':
        if (!m || m.phase !== 'over') return send.call(ws, { t: 'err', m: 'not_over' });
        startMatch(room, msg.seed != null ? msg.seed : (Math.random() * 2 ** 31) | 0);
        break;
      case 'input': {
        if (!m) break;
        // duplicate/late guard: same payload within 80ms is a retransmit
        const key = `${msg.move}|${msg.jump ? 1 : 0}`;
        const k2 = me.team + ':' + key;
        if (room.lastAction.get(k2) && now - room.lastAction.get(k2) < 80) break;
        room.lastAction.set(k2, now);
        const r = G.setInput(m, me.team, msg.move, msg.jump);
        if (r.err) send.call(ws, { t: 'err', m: r.err });
        break;
      }
      case 'aim': {
        if (!m) break;
        const k2 = me.team + ':aim:' + Math.round(Number(msg.angle)) + ':' + Math.round(Number(msg.power));
        if (room.lastAction.get(k2) && now - room.lastAction.get(k2) < 80) break;
        room.lastAction.set(k2, now);
        const r = G.setAim(m, me.team, Number(msg.angle), Number(msg.power));
        if (r.err) send.call(ws, { t: 'err', m: r.err });
        break;
      }
      case 'fire': {
        if (!m) break;
        const k2 = me.team + ':fire';
        if (room.lastAction.get(k2) && now - room.lastAction.get(k2) < 500) break;
        room.lastAction.set(k2, now);
        const evs = [];
        const r = G.fire(m, me.team, String(msg.weapon), evs);
        if (r.err) { send.call(ws, { t: 'err', m: r.err }); break; }
        if (evs.length) broadcast(room, { t: 'event', evs });
        break;
      }
      case 'endturn': {
        if (!m) break;
        const k2 = me.team + ':end';
        if (room.lastAction.get(k2) && now - room.lastAction.get(k2) < 500) break;
        room.lastAction.set(k2, now);
        if (m.phase !== 'aim' || m.activeTeam !== me.team) {
          send.call(ws, { t: 'err', m: 'not_your_turn' }); break;
        }
        const evs = [];
        G.endTurn(m, evs);
        broadcast(room, { t: 'event', evs });
        break;
      }
      case 'ping':
        send.call(ws, { t: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (me) { me.connected = false; me.lastSeen = Date.now(); }
    if (room) broadcast(room, roomInfo(room));
  });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`Tiny Wars on http://localhost:${server.address().port}`));

// sweep rooms that never started (tick only runs once a match exists)
setInterval(() => {
  for (const [code, room] of rooms) {
    if (!room.match && Date.now() - room.created > 30 * 60e3) rooms.delete(code);
  }
}, 60e3).unref();

module.exports = { createRoom, joinRoom, rejoinRoom, rooms, makeCode, server, wss };
