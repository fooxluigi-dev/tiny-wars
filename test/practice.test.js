// Practice mode: bot joins a solo room and takes its turn by firing.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
process.env.PORT = 0;
const REAL = require('../server.js');
const { WebSocket } = require('ws');

function open() {
  return new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${REAL.server.address().port}`);
    w.inbox = [];
    w.on('message', d => w.inbox.push(JSON.parse(d)));
    w.on('open', () => res(w));
    w.on('error', rej);
  });
}
const send = (w, o) => w.send(JSON.stringify(o));
async function waitFor(w, pred, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const hit = w.inbox.find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + JSON.stringify(w.inbox.slice(-6)));
    await new Promise(r => setTimeout(r, 25));
  }
}

after(() => {
  REAL.wss.close(); REAL.server.close();
  for (const room of REAL.rooms.values()) if (room.tick) clearInterval(room.tick);
});

test('practice: solo room starts immediately against BOT, bot fires on its turn', async () => {
  const a = await open();
  send(a, { t: 'practice', name: 'Luigi' });
  const room = await waitFor(a, m => m.t === 'room');
  assert.strictEqual(room.players.length, 2, 'bot fills team 1');
  assert.strictEqual(room.players[1].name, 'BOT');
  await waitFor(a, m => m.t === 'start', 4000, 'match starts without a second human');

  // burn the human turn; bot should then act on its own within ~2.2s + flight
  send(a, { t: 'endturn' });
  const turn1 = await waitFor(a, m => m.t === 'event' && m.evs.some(e => e.t === 'turn' && e.team === 1));
  const boom = await waitFor(a, m => m.t === 'event' && m.evs.some(e => e.t === 'boom'), 8000);
  assert.ok(boom, 'bot fired a real projectile');
  const back = await waitFor(a, m => m.t === 'event' && m.evs.some(e => e.t === 'turn' && e.team === 0), 8000);
  assert.ok(back, 'turn returns to human after bot shot');
  a.close();
});
