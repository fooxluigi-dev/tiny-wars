// Tiny Wars — server room management, validation, duplicate-action tests.
// Uses the exported room functions + a live WS pair against a random port.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocket } = require('ws');

// start an isolated server instance on an ephemeral port
process.env.PORT = 0;
let srv, port, base;
const REAL = require('../server.js');
const G = require('../shared/game');

function wsUrl() { return `ws://127.0.0.1:${port}`; }

function open() {
  return new Promise((res, rej) => {
    const w = new WebSocket(wsUrl());
    w.inbox = [];
    w.on('message', d => w.inbox.push(JSON.parse(d)));
    w.on('open', () => res(w));
    w.on('error', rej);
  });
}
const send = (w, o) => w.send(JSON.stringify(o));
async function waitFor(w, pred, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const hit = w.inbox.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for message: ' + JSON.stringify(w.inbox.slice(-6)));
    await new Promise(r => setTimeout(r, 25));
  }
}
function clear(w) { w.inbox.length = 0; }

before(async () => {
  if (!REAL.server.listening) {
    await new Promise(r => REAL.server.on('listening', r));
  }
  port = REAL.server.address().port;
});
after(() => {
  REAL.wss.close();
  REAL.server.close();
  for (const room of REAL.rooms.values()) if (room.tick) clearInterval(room.tick);
});

test('room: create → code issued, join → both present, match auto-starts', async () => {
  const a = await open();
  send(a, { t: 'create', name: 'Luigi' });
  const roomMsg = await waitFor(a, m => m.t === 'room');
  assert.match(roomMsg.code, /^[A-Z2-9]{5}$/);
  assert.strictEqual(roomMsg.you, 0);
  assert.ok(roomMsg.tok, 'creator gets a reconnect token');

  const b = await open();
  send(b, { t: 'join', code: roomMsg.code, name: 'Marco' });
  const joinMsg = await waitFor(b, m => m.t === 'room');
  assert.strictEqual(joinMsg.you, 1);

  const startA = await waitFor(a, m => m.t === 'start');
  assert.strictEqual(startA.state.players.length, 6, 'both clients get the same 6-player state');
  assert.strictEqual(startA.state._terrain.length, G.W, 'full terrain included at start');
  const startB = await waitFor(b, m => m.t === 'start');
  assert.deepStrictEqual(startB.state._terrain, startA.state._terrain, 'identical terrain both sides');
  assert.deepStrictEqual(startB.state.players, startA.state.players, 'identical spawns both sides');
  a.close(); b.close();
});

test('room: bad code and full room are rejected', async () => {
  const a = await open();
  clear(a);
  send(a, { t: 'join', code: 'ZZZZZ' });
  const e1 = await waitFor(a, m => m.t === 'err');
  assert.strictEqual(e1.m, 'no_room');

  const b = await open();
  send(b, { t: 'create', name: 'x' });
  const r = await waitFor(b, m => m.t === 'room');
  clear(b);
  const c1 = await open();
  const c2 = await open();
  send(c1, { t: 'join', code: r.code });
  await waitFor(c1, m => m.t === 'room');
  send(c2, { t: 'join', code: r.code });
  const e2 = await waitFor(c2, m => m.t === 'err');
  assert.strictEqual(e2.m, 'full');
  a.close(); b.close(); c1.close(); c2.close();
});

test('validation: actions from the wrong team / wrong phase are rejected', async () => {
  const a = await open(), b = await open();
  send(a, { t: 'create', name: 'A' });
  const r = await waitFor(a, m => m.t === 'room');
  send(b, { t: 'join', code: r.code, name: 'B' });
  await waitFor(a, m => m.t === 'start');
  await waitFor(b, m => m.t === 'start');

  clear(a); clear(b);
  // team 1 fires on team 0's turn
  send(b, { t: 'fire', weapon: 'bazooka', });
  const e1 = await waitFor(b, m => m.t === 'err');
  assert.strictEqual(e1.m, 'not_your_turn');
  // team 1 moves on team 0's turn
  send(b, { t: 'input', move: 1 });
  const e2 = await waitFor(b, m => m.t === 'err');
  assert.strictEqual(e2.m, 'not_your_turn');
  // bogus weapon from the right team
  clear(a);
  send(a, { t: 'fire', weapon: 'railgun' });
  const e3 = await waitFor(a, m => m.t === 'err');
  assert.strictEqual(e3.m, 'bad_weapon');
  // out-of-range aim
  clear(a);
  send(a, { t: 'aim', angle: 200, power: 50 });
  const e4 = await waitFor(a, m => m.t === 'err');
  assert.strictEqual(e4.m, 'bad_angle');
  a.close(); b.close();
});

test('duplicates: rapid double-fire results in exactly one projectile', async () => {
  const a = await open(), b = await open();
  send(a, { t: 'create', name: 'A' });
  const r = await waitFor(a, m => m.t === 'room');
  send(b, { t: 'join', code: r.code, name: 'B' });
  const st = await waitFor(a, m => m.t === 'start');
  await waitFor(b, m => m.t === 'start');
  clear(a);
  send(a, { t: 'aim', angle: 60, power: 70 });
  send(a, { t: 'fire', weapon: 'bazooka' });
  send(a, { t: 'fire', weapon: 'bazooka' });   // duplicate within 500ms window
  send(a, { t: 'fire', weapon: 'bazooka' });
  await waitFor(a, m => m.t === 'state' && m.s.phase === 'flying');
  const states = a.inbox.filter(m => m.t === 'state');
  const maxProj = Math.max(...states.map(s => s.s.proj.length));
  assert.strictEqual(maxProj, 1, `expected 1 projectile in flight, saw ${maxProj}`);
  a.close(); b.close();
});

test('reconnect: token rejoin restores state after socket drop', async () => {
  const a = await open(), b = await open();
  send(a, { t: 'create', name: 'A' });
  const r = await waitFor(a, m => m.t === 'room');
  send(b, { t: 'join', code: r.code, name: 'B' });
  await waitFor(a, m => m.t === 'start');
  await waitFor(b, m => m.t === 'start');

  // a "loses connection" mid-match
  a.close();
  await new Promise(r2 => setTimeout(r2, 300));
  // ...and comes back with its token
  const a2 = await open();
  send(a2, { t: 'rejoin', code: r.code, tok: r.tok });
  const back = await waitFor(a2, m => m.t === 'room');
  assert.strictEqual(back.you, 0, 'rejoined as team 0');
  const resume = await waitFor(a2, m => m.t === 'start');
  assert.ok(resume.resume, 'full state resent on resume');
  assert.strictEqual(resume.state.players.length, 6);
  assert.strictEqual(resume.state._terrain.length, G.W);
  // a2 can play again once it's their turn
  a2.close(); b.close();
});

test('reconnect: forged token rejected', async () => {
  const a = await open();
  send(a, { t: 'create', name: 'A' });
  const r = await waitFor(a, m => m.t === 'room');
  const evil = await open();
  send(evil, { t: 'rejoin', code: r.code, tok: 'deadbeef'.repeat(4) });
  const e = await waitFor(evil, m => m.t === 'err');
  assert.strictEqual(e.m, 'bad_token');
  a.close(); evil.close();
});

test('endturn: server rejects end-turn from the team that doesn\'t hold the turn', async () => {
  const a = await open(), b = await open();
  send(a, { t: 'create', name: 'A' });
  const r = await waitFor(a, m => m.t === 'room');
  send(b, { t: 'join', code: r.code, name: 'B' });
  await waitFor(a, m => m.t === 'start');
  await waitFor(b, m => m.t === 'start');
  clear(b);
  send(b, { t: 'endturn' });
  const e = await waitFor(b, m => m.t === 'err');
  assert.strictEqual(e.m, 'not_your_turn');
  // the team that DOES hold it may end it
  clear(a);
  send(a, { t: 'endturn' });
  const st = await waitFor(a, m => m.t === 'state' && m.s.team === 1);
  assert.strictEqual(st.s.team, 1, 'turn passed to team 1');
  a.close(); b.close();
});

test('match: full scripted match reaches game over with a winner', async () => {
  const a = await open(), b = await open();
  try {
  send(a, { t: 'create', name: 'A', opts: { turnTime: 10, sdRound: 3 } });
  const r = await waitFor(a, m => m.t === 'room');
  // pinned seed rides the join (that's where startMatch fires); match-flow test,
  // not a seed lottery — seed variety is terrain.test.js's job. 12345: solver
  // bots finish in ~30s.
  send(b, { t: 'join', code: r.code, name: 'B', seed: 12345 });
  const sa = await waitFor(a, m => m.t === 'start');
  await waitFor(b, m => m.t === 'start');
  const env = { terrain: Float64Array.from(sa.state._terrain), wind: 0, waterY: 740 };

  // solver-driven loop: walk into range when needed, otherwise aim + fire,
  // until either socket sees the 'over' event.
  const deadline = Date.now() + 150000;
  let over = null, lastWalkKey = '', walksThisTurn = 0;
  const all = () => a.inbox.concat(b.inbox);
  while (!over && Date.now() < deadline) {
    const msgs = all();
    const seen = msgs.find(m => m.t === 'event' && m.evs.some(e => e.t === 'over'));
    if (seen) { over = seen; break; }
    // keep solver terrain fresh: apply every crater the server broadcast (mirrors the client)
    for (const msg of msgs) {
      if (msg.t !== 'event') continue;
      for (const ev of msg.evs) {
        if (ev.t !== 'crater' || ev.done) continue;
        for (let i = 0; i < ev.h.length; i++) env.terrain[ev.from + i] = ev.h[i];
        ev.done = true;   // idempotent across the shared inbox
      }
    }
    const last = msgs.reverse().find(m => m.t === 'state');
    if (last && last.s.phase === 'aim') {
      const s = last.s;
      env.wind = s.wind; env.waterY = s.water;
      const srcP = s.players[s.act];
      const foes = s.players.filter(p => p.t !== s.team && p.a);
      if (srcP && foes.length) {
        const dst = foes.reduce((x, y) =>
          Math.hypot(y.x - srcP.x, y.y - srcP.y) < Math.hypot(x.x - srcP.x, x.y - srcP.y) ? y : x);
        const solve = G.solveShot(env,
          { x: srcP.x, y: srcP.y, facing: srcP.f },
          { x: dst.x, y: dst.y });
        const holder = s.team === 0 ? a : b;
        const turnKey = s.round + ':' + s.team;
        if (turnKey !== lastWalkKey) { lastWalkKey = turnKey; walksThisTurn = 0; }
        if (solve.score > 100 && walksThisTurn < 2) {
          // out of reach: march toward the enemy (max 2 walks, then fire regardless)
          walksThisTurn++;
          send(holder, { t: 'input', move: dst.x > srcP.x ? 1 : -1 });
          await new Promise(res => setTimeout(res, 700));
          send(holder, { t: 'input', move: 0 });
        } else {
          send(holder, { t: 'aim', angle: solve.angle, power: solve.power });
          send(holder, { t: 'fire', weapon: 'bazooka' });
          await new Promise(res => setTimeout(res, 400));
        }
      }
    } else {
      await new Promise(res => setTimeout(res, 200));
    }
  }
  assert.ok(over, 'match reached game over within 150s');
  const winner = over.evs.find(e => e.t === 'over').winner;
  assert.ok(winner === 0 || winner === 1, `valid winner: ${winner}`);
  } finally { a.close(); b.close(); }   // leak on failure would hang the test runner
});
