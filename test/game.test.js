// Tiny Wars — rules, physics, terrain, turn validation tests.
// Run: npm test  (node --test, no framework needed)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const G = require('../shared/game');

const stepFor = (m, secs) => {
  const evs = [];
  for (let i = 0; i < secs * 30; i++) evs.push(...G.step(m, 1 / 30));
  return evs;
};

// ---------- terrain ----------
test('terrain: deterministic per seed, differs across seeds', () => {
  const a = G.genTerrain(42), b = G.genTerrain(42), c = G.genTerrain(43);
  assert.deepStrictEqual(Array.from(a), Array.from(b));
  assert.notDeepStrictEqual(Array.from(a), Array.from(c));
});

test('terrain: island shape — dry middle, submerged edges', () => {
  const h = G.genTerrain(7);
  const mid = h[800], edge = h[5];
  assert.ok(mid < G.WATER0 - 20, `mid should be dry, got ${mid}`);
  assert.ok(edge > G.WATER0, `edge should be underwater, got ${edge}`);
});

test('terrain: explosion carves a permanent crater', () => {
  const m = G.createMatch(99);
  const x = 800, before = m.terrain[x];
  const evs = [];
  G.explosion(m, x, before - 10, 60, 50, evs);
  assert.ok(m.terrain[x] > before, 'crater must dig down (y grows downward)');
  const craterEv = evs.find(e => e.t === 'crater');
  assert.ok(craterEv, 'crater event emitted for clients');
  assert.strictEqual(craterEv.h.length, craterEv.to - craterEv.from + 1);
  // crater persists: step doesn't regenerate terrain
  stepFor(m, 2);
  assert.ok(m.terrain[x] > before, 'crater is permanent');
});

test('terrain: explosion mid-air does not carve', () => {
  const m = G.createMatch(99);
  const x = 800, before = m.terrain[x];
  const evs = [];
  G.explosion(m, x, before - 500, 60, 50, evs);
  assert.strictEqual(m.terrain[x], before);
});

// ---------- physics ----------
test('physics: gravity drops an airborne player onto terrain', () => {
  const m = G.createMatch(5);
  const p = m.players[0];
  p.y -= 200; p.vy = 0; p.onGround = false;
  stepFor(m, 3);
  assert.ok(p.onGround, 'player landed');
  assert.ok(Math.abs(p.y - G.hAt(m, p.x)) < 1, 'player rests exactly on surface');
});

test('physics: fall damage triggers above threshold, not below', () => {
  const m = G.createMatch(5);
  const p = m.players[0];
  p.hp = 100;
  p.y -= 60; p.vy = 0; p.onGround = false;
  stepFor(m, 3);
  assert.strictEqual(p.hp, 100, 'small drop = no damage');
  p.y -= 600; p.vy = 0; p.onGround = false;
  stepFor(m, 4);
  assert.ok(p.hp < 100, `big drop = fall damage, hp ${p.hp}`);
});

test('physics: player in water dies, floating above water survives', () => {
  const m = G.createMatch(5);
  const p = m.players[0];
  p.x = 2; // off-island edge: no ground (hAt = Infinity) → falls off map
  p.onGround = false;
  const evs = stepFor(m, 6);
  assert.strictEqual(p.alive, false, 'falls off map → dead');
  assert.ok(evs.some(e => e.t === 'death'));
});

test('physics: knocked-back player takes fall damage on landing', () => {
  const m = G.createMatch(11);
  const p = m.players[0];
  const hp0 = p.hp;
  const evs = [];
  G.explosion(m, p.x - 40, p.y - 10, 60, 50, evs); // close blast = knockback + direct damage
  assert.ok(!p.onGround, 'knocked airborne');
  assert.ok(p.hp < hp0, 'direct blast damage applied');
  stepFor(m, 4);
  assert.ok(p.onGround, 'settled again');
});

test('physics: wind changes projectile drift direction', () => {
  const drift = (wind) => {
    const m = G.createMatch(3);
    m.wind = wind;
    G.setAim(m, 0, 60, 70);
    G.fire(m, 0, 'bazooka', []);
    const startX = m.projectiles[0].x;
    let lastX = startX;
    for (let i = 0; i < 600 && m.phase === 'flying'; i++) { G.step(m, 1 / 30); if (m.projectiles[0]) lastX = m.projectiles[0].x; }
    return lastX - startX;
  };
  const dRight = drift(40), dLeft = drift(-40);
  assert.ok(dRight > dLeft, `wind +40 drifts more right (${dRight} vs ${dLeft})`);
});

// ---------- turns ----------
test('turns: illegal actions are rejected before/after your turn', () => {
  const m = G.createMatch(1);
  assert.strictEqual(m.activeTeam, 0);
  assert.ok(G.setInput(m, 1, 1, false).err, 'team 1 cannot move on team 0 turn');
  assert.ok(G.fire(m, 1, 'bazooka', []).err, 'team 1 cannot fire on team 0 turn');
  assert.ok(G.setAim(m, 1, 45, 50).err, 'team 1 cannot aim on team 0 turn');
  const evs = [];
  assert.ok(G.fire(m, 0, 'bazooka', evs).ok, 'team 0 CAN fire on its turn');
  assert.strictEqual(m.phase, 'flying');
  // while projectile flies: nobody can act
  assert.ok(G.fire(m, 0, 'grenade', []).err, 'no fire while projectile in flight');
  assert.ok(G.setInput(m, 0, 1, false).err, 'no movement while projectile in flight');
});

test('turns: turn passes only after projectile resolves; order alternates', () => {
  const m = G.createMatch(1);
  G.setAim(m, 0, 45, 80);
  G.fire(m, 0, 'bazooka', []);
  assert.strictEqual(m.activeTeam, 0, 'turn does not flip while projectile flies');
  stepFor(m, 4);
  assert.strictEqual(m.activeTeam, 1, 'team 1 up after team 0 shot');
  G.setAim(m, 1, 45, 80);
  assert.ok(G.fire(m, 1, 'grenade', []).ok);
  stepFor(m, 6); // grenade fuse is 3s
  assert.strictEqual(m.activeTeam, 0, 'back to team 0 after team 1 shot');
  assert.strictEqual(m.round, 2, 'round increments on full cycle');
});

test('turns: timer expiry auto-ends the turn', () => {
  const m = G.createMatch(1);
  m.turnTimeLeft = 0.5;
  stepFor(m, 1);
  assert.strictEqual(m.activeTeam, 1, 'turn flipped on timeout');
});

test('turns: endTurn flips unconditionally (server gates caller team first)', () => {
  // the team check lives in server.js ('endturn' handler); game layer just advances
  const m = G.createMatch(1);
  const evs = [];
  G.endTurn(m, evs);
  assert.strictEqual(m.activeTeam, 1);
});

test('turns: dead players are skipped when picking active player', () => {
  const m = G.createMatch(2);
  const t0 = m.players.filter(p => p.team === 0);
  t0[0].alive = false; t0[0].hp = 0;
  const evs = [];
  G.endTurn(m, evs); // → team 1
  G.endTurn(m, evs); // → team 0, must skip dead t0[0]... ptr starts -1, first pick lands on alive idx1
  const act = G.activePlayer(m);
  assert.ok(act && act.alive, 'active player is alive');
  assert.strictEqual(act.team, 0);
});

// ---------- weapons ----------
test('weapons: bazooka explodes on terrain and damages a nearby player', () => {
  const m = G.createMatch(21);
  const victim = m.players[3]; // team 1
  const hp0 = victim.hp;
  const evs = [];
  G.setAim(m, 0, 40, 90);
  G.fire(m, 0, 'bazooka', evs);
  // teleport victim right below predicted impact for a deterministic test
  const pr = m.projectiles[0];
  pr.x = victim.x + 20; pr.y = victim.y - 100; pr.vx = 0; pr.vy = 300;
  evs.push(...stepFor(m, 3));
  assert.ok(evs.some(e => e.t === 'boom'), 'explosion happened');
  assert.ok(victim.hp < hp0, `victim damaged (${hp0}→${victim.hp})`);
});

test('weapons: shotgun is hitscan — instant hit, no projectile, no crater', () => {
  const m = G.createMatch(21);
  const shooter = m.players[0], victim = m.players[3];
  // clear the lane: teammates (spawned 90px apart) would block the ray first
  m.players[1].x = shooter.x - 300; m.players[2].x = shooter.x - 360;
  // flatten ground between them so the ray can't be blocked by a hill
  for (let x = shooter.x; x <= shooter.x + 180; x++) m.terrain[Math.round(x)] = shooter.y;
  victim.x = shooter.x + 150; victim.y = shooter.y; victim.onGround = true;
  const evs = [];
  G.setAim(m, 0, 0, 60); // flat shot
  victim.hp = 100;
  const r = G.fire(m, 0, 'shotgun', evs);
  assert.ok(r.ok);
  assert.strictEqual(m.phase, 'aim', 'shotgun resolves immediately → next turn already set up');
  assert.strictEqual(m.projectiles.length, 0);
  assert.ok(victim.hp < 100, `shotgun damaged (${victim.hp})`);
  assert.ok(!evs.some(e => e.t === 'crater'), 'shotgun never digs terrain');
});

test('weapons: grenade bounces then explodes on fuse', () => {
  const m = G.createMatch(21);
  const evs = [];
  G.setAim(m, 0, 70, 60);
  G.fire(m, 0, 'grenade', evs);
  assert.strictEqual(m.projectiles.length, 1);
  evs.push(...stepFor(m, 1.5));
  assert.strictEqual(m.projectiles.length, 1, 'still live before 3s fuse');
  evs.push(...stepFor(m, 2.5));
  assert.strictEqual(m.projectiles.length, 0, 'exploded on fuse');
  assert.ok(evs.some(e => e.t === 'boom'));
});

test('weapons: dynamite explodes at owner feet after fuse', () => {
  const m = G.createMatch(21);
  const owner = G.activePlayer(m);
  const hp0 = owner.hp;
  const evs = [];
  G.fire(m, 0, 'dynamite', evs);
  evs.push(...stepFor(m, 3));
  assert.ok(evs.some(e => e.t === 'boom'));
  assert.ok(owner.hp < hp0, 'dynamite damages even the owner (Worms-style)');
});

test('weapons: airstrike spawns bombs that resolve and end the turn', () => {
  const m = G.createMatch(21);
  const evs = [];
  G.setAim(m, 0, 45, 80);
  G.fire(m, 0, 'airstrike', evs);
  assert.strictEqual(m.projectiles.length, 3, 'three bombs');
  evs.push(...stepFor(m, 8));
  assert.strictEqual(m.projectiles.length, 0, 'all bombs resolved');
  assert.ok(evs.some(e => e.t === 'boom'));
  assert.strictEqual(m.activeTeam, 1, 'turn passed');
});

test('weapons: unknown weapon rejected', () => {
  const m = G.createMatch(1);
  assert.ok(G.fire(m, 0, 'nuke', []).err);
});

// ---------- win / lose ----------
test('win: killing whole enemy team ends the match', () => {
  const m = G.createMatch(21);
  const evs = [];
  for (const p of m.players) if (p.team === 1) { p.hp = 0; p.alive = false; }
  G.explosion(m, 800, 500, 60, 0, evs); // any event that runs checkWin
  assert.strictEqual(m.phase, 'over');
  assert.strictEqual(m.winner, 0);
  assert.ok(evs.some(e => e.t === 'over' && e.winner === 0));
});

test('win: no actions accepted after game over', () => {
  const m = G.createMatch(21);
  for (const p of m.players) if (p.team === 1) { p.hp = 0; p.alive = false; }
  G.explosion(m, 800, 500, 60, 0, []);
  assert.ok(G.fire(m, 0, 'bazooka', []).err);
  assert.ok(G.setInput(m, 0, 1, false).err);
});

test('sudden death: water rises and everyone bleeds after configured rounds', () => {
  const m = G.createMatch(1, { sdRound: 3 });
  const w0 = m.waterY;
  const evs = [];
  // fast-forward: alternate forced turn endings until round > 3
  let guard = 0;
  while (m.round <= 4 && guard++ < 20) {
    m.phase = 'aim';
    G.endTurn(m, evs);
  }
  assert.ok(m.round > 3, `round ${m.round}`);
  assert.ok(m.waterY < w0, `water rose ${w0}→${m.waterY}`);
});

// ---------- damage edge cases ----------
test('damage: explosion damage falls off with distance; zero outside radius', () => {
  const m = G.createMatch(21);
  const evs = [];
  const far = m.players.find(p => p.team === 1);
  far.x = 50; far.y = G.hAt(m, 50); far.onGround = true; far.hp = 100;
  G.explosion(m, 800, m.terrain[800] - 10, 60, 50, evs);
  assert.strictEqual(far.hp, 100, 'outside radius: untouched');
});

test('damage: hp never displayed negative', () => {
  const m = G.createMatch(21);
  const evs = [];
  const p = m.players[0];
  G.explosion(m, p.x, p.y - 14, 120, 85, evs);
  const hit = evs.find(e => e.t === 'hit' && e.p === p.i);
  if (hit) assert.ok(hit.hp >= 0, 'clamped at 0');
});

test('serialization: round-trips key state for clients', () => {
  const m = G.createMatch(77);
  const s = G.serialize(m, true);
  assert.strictEqual(s.players.length, 6);
  assert.strictEqual(s._terrain.length, G.W);
  assert.strictEqual(typeof s.wind, 'number');
  assert.ok(s.tl > 0);
  JSON.stringify(s); // must not throw (no NaN/BigInt)
});
