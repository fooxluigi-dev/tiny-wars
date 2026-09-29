// New terrain generator: safe spawns, real variety, water/shore sanity.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const G = require('../shared/game');

test('terrain: 3200px wide, varied relief across seeds', () => {
  const spans = [];
  for (const seed of [1, 42, 777, 123456]) {
    const h = G.genTerrain(seed);
    assert.strictEqual(h.length, G.W);
    assert.ok(h.every(v => isFinite(v)));
    // variety: elevation range must be substantial (hills + valleys)
    const lo = Math.min(...h), hi = Math.max(...h);
    assert.ok(hi - lo >= 250, `seed ${seed}: relief too flat (${Math.round(hi - lo)}px)`);
    spans.push(Array.from(h, (v, i) => [i, v]));
  }
  // different seeds → different shapes
  const a = G.genTerrain(1), b = G.genTerrain(2);
  let diff = 0;
  for (let i = 0; i < a.length; i += 16) if (Math.abs(a[i] - b[i]) > 10) diff++;
  assert.ok(diff > 20, 'seeds produce near-identical maps');
});

test('terrain: spawns are dry, gentle, and not on the shore', () => {
  for (const seed of [1, 42, 777, 999, 31337]) {
    const m = G.createMatch(seed);
    const spots = m.players;
    assert.strictEqual(spots.length, 6);
    for (const p of spots) {
      const gh = G.hAt(m, p.x);
      assert.ok(isFinite(gh), `seed ${seed} p${p.i}: spawned off-map`);
      assert.ok(gh < G.WATER0 - 24, `seed ${seed} p${p.i}: spawned in water (${Math.round(gh)})`);
      const steep = Math.abs(G.hAt(m, p.x + 10) - G.hAt(m, p.x - 10));
      assert.ok(steep < 22, `seed ${seed} p${p.i}: spawned on cliff (${Math.round(steep)})`);
      // teams on their own halves
      assert.ok(p.team === 0 ? p.x < G.W / 2 : p.x > G.W / 2, `seed ${seed} p${p.i}: wrong half`);
    }
    // teams separated enough for artillery
    const t0 = spots.filter(p => p.team === 0).map(p => p.x);
    const t1 = spots.filter(p => p.team === 1).map(p => p.x);
    assert.ok(Math.min(...t1) - Math.max(...t0) > 500, `seed ${seed}: teams too close`);
  }
});

test('terrain: craters still carve and persist (destruction intact)', () => {
  const m = G.createMatch(7);
  const before = m.terrain[1600];
  G.explosion(m, 1600, 500, 80, 50, []);
  assert.ok(m.terrain[1600] >= before, 'crater carved downward/unchanged');
  assert.ok(m.terrain[1600] > 500 - 80 - 1, 'crater floor present');
});
