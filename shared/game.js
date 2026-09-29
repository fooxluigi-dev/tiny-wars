// Tiny Wars — shared game rules & physics. Server-authoritative: this file runs
// ONLY on the server (node). Clients receive snapshots, they never simulate.
'use strict';

const W = 3200, H = 900;       // 2× wider battlefield (2026-09 expansion)
const WATER0 = 740;            // starting water level (y, grows downward)
const GRAV = 1000;             // px/s^2
const WALK = 95;               // px/s
const JUMP = 370;              // px/s upward
const TURN_TIME = 30;          // seconds
const PROJ_SPEED_MAX = 1400;   // power 100 — flat 45° range ≈ 1960px > 1792px spawn gap

const WEAPONS = {
  bazooka:   { kind: 'rocket',  r: 60,  dmg: 50, wind: true },
  grenade:   { kind: 'grenade', r: 65,  dmg: 55, wind: true, fuse: 3 },
  shotgun:   { kind: 'hitscan', range: 560, dmg: 35, kb: 240 },
  dynamite:  { kind: 'mine',    r: 120, dmg: 85, fuse: 2.5 },
  airstrike: { kind: 'air',     r: 55,  dmg: 40, wind: true, count: 3 },
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Island terrain: heightmap, one height per column (y grows downward).
// Varied per seed: layered octaves + plateaus + valleys, with flat spawn shelves.
function smoothstep(a, b, x) { x = Math.max(0, Math.min(1, (x - a) / (b - a))); return x * x * (3 - 2 * x); }

function genTerrain(seed) {
  const rnd = mulberry32(seed);
  const h = new Float64Array(W);
  const oct = [
    [2 + rnd() * 3, 160 + rnd() * 70],    // broad hills
    [5 + rnd() * 5, 95 + rnd() * 60],     // medium relief
    [11 + rnd() * 9, 40 + rnd() * 35],    // rough ground
    [24 + rnd() * 16, 10 + rnd() * 8],    // detail
  ].map(([f, a]) => ({ f, a, ph: rnd() * 6.28 }));
  const feats = [];
  const nfeat = 3 + (rnd() * 3 | 0);
  for (let i = 0; i < nfeat; i++) feats.push({
    x: 0.14 + rnd() * 0.72,               // centre (fraction of W)
    w: 0.035 + rnd() * 0.105,             // half-width
    up: rnd() < 0.55,                     // plateau vs valley
    amt: 70 + rnd() * 70,
  });
  const spawns = [W * 0.22, W * 0.78];    // team shelves (see spawnPlayers)
  for (let x = 0; x < W; x++) {
    const t = x / (W - 1);
    const env = Math.pow(Math.sin(Math.PI * t), 0.5);   // 0 at shores, 1 center
    let rel = 190;
    for (const o of oct) rel += o.a * Math.sin(t * o.f * 6.28 + o.ph);
    rel *= 0.62;
    for (const ft of feats) {
      const d = Math.abs(t - ft.x) / ft.w;
      if (d >= 1) continue;
      const g = ft.up ? 1 - smoothstep(0.55, 1, d) : Math.pow(1 - d * d, 1.6);
      rel += (ft.up ? 1 : -1) * ft.amt * g;
    }
    let y = WATER0 + 60 - env * rel;
    // spawn shelves: gentle dry ground around both team spawns
    for (const sx of spawns) {
      const d = Math.abs(x - sx) / (W * 0.09);
      if (d < 1) y += ((WATER0 - 120) - y) * Math.pow(1 - d * d, 2);
    }
    h[x] = Math.max(120, Math.min(WATER0 + 40, y));
  }
  return h;
}

function hAt(m, x) {
  if (x < 0 || x >= W) return Infinity;   // fell off the map: no ground
  return m.terrain[Math.round(x)];
}

function spawnPlayers(m) {
  const spots = [];
  for (const team of [0, 1]) {
    const dir = team === 0 ? 1 : -1;
    let x = team === 0 ? Math.round(W * 0.22) : Math.round(W * 0.78);  // terrain spawn shelves
    for (let i = 0; i < 3; i++) {
      // scan inward until terrain is dry, above water and not too steep
      let tries = 0;
      while (tries++ < 300) {
        const gh = hAt(m, x);
        const steep = Math.abs(hAt(m, x + 10) - hAt(m, x - 10));
        if (isFinite(gh) && gh < WATER0 - 24 && steep < 22) break;
        x += dir * 6;
        if (x < 90 || x > W - 90) { x = team === 0 ? Math.round(W * 0.22) : Math.round(W * 0.78); }
      }
      spots.push({ team, x, y: hAt(m, x) });
      x += dir * 90;
    }
  }
  return spots.map((s, i) => ({
    i, team: s.team, x: s.x, y: s.y, vx: 0, vy: 0,
    hp: 100, alive: true, facing: s.team === 0 ? 1 : -1,
    onGround: true,
  }));
}

function createMatch(seed, opts = {}) {
  seed = seed == null ? (Math.random() * 2 ** 31) | 0 : seed | 0;
  const m = {
    seed,
    turnTime: opts.turnTime || TURN_TIME,
    sdRound: opts.sdRound || 10,       // sudden death after this many rounds
    terrain: genTerrain(seed),
    waterY: WATER0,
    players: [],
    projectiles: [],
    wind: 0,
    phase: 'aim',                      // aim | flying | over
    activeTeam: 0,
    activePtr: [-1, -1],               // per-team player pointer
    round: 1,
    winner: null,
    input: [{ move: 0, jump: false }, { move: 0, jump: false }],
    turnTimeLeft: 0,
  };
  m.players = spawnPlayers(m);
  m.turnTimeLeft = m.turnTime;
  rollWind(m);
  pickNext(m, 0);            // activate first player of team 0
  return m;
}

function rollWind(m) {
  m.wind = Math.round((Math.random() * 2 - 1) * 40);  // -40..40 px/s^2
}

// ---- actions (all validated; illegal ones return {err} and change nothing) ----

function teamList(m, team) {
  return m.players.filter(p => p.team === team);
}

// Ballistic solver: coarse grid + local refine. env = {terrain, wind, waterY}.
function trajMiss(env, src, dst, ang, pw) {
  const a = ang * Math.PI / 180;
  const dx = src.facing * Math.cos(a), dy = -Math.sin(a);
  const v = 200 + pw * (PROJ_SPEED_MAX - 200) / 100;
  let x = src.x + dx * 16, y = (src.y - 20) + dy * 16;
  let vx = dx * v, vy = dy * v;
  let best = Infinity;
  for (let t = 0; t < 8; t += 1 / 60) {
    vx += env.wind / 60;
    vy += GRAV / 60;
    x += vx / 60; y += vy / 60;
    const d = Math.hypot(x - dst.x, y - (dst.y - 14));
    if (d < best) best = d;
    if (y >= hAt(env, x) || y >= env.waterY || x < -40 || x > W + 40) break;
  }
  return best;
}

function solveShot(env, src, dst) {
  let best = { angle: 45, power: 70, score: Infinity };
  for (let ang = 10; ang <= 85; ang += 5)
    for (let pw = 35; pw <= 100; pw += 5) {
      const s = trajMiss(env, src, dst, ang, pw);
      if (s < best.score) best = { angle: ang, power: pw, score: s };
    }
  for (let ang = Math.max(5, best.angle - 4); ang <= Math.min(89, best.angle + 4); ang += 0.5)
    for (let pw = Math.max(5, best.power - 5); pw <= Math.min(100, best.power + 5); pw += 0.5) {
      const s = trajMiss(env, src, dst, ang, pw);
      if (s < best.score) best = { angle: ang, power: pw, score: s };
    }
  return best;
}

function activePlayer(m) {
  const list = teamList(m, m.activeTeam);
  const p = list[m.activePtr[m.activeTeam]];
  return p && p.alive ? p : null;
}

function pickNext(m, team) {
  const list = teamList(m, team);
  for (let n = 1; n <= list.length; n++) {
    const idx = (m.activePtr[team] + n) % list.length;
    if (list[idx].alive) { m.activePtr[team] = idx; return list[idx]; }
  }
  return null;
}

function beginTurn(m, events) {
  const found = pickNext(m, m.activeTeam);
  if (!found) { checkWin(m, events); return; }
  m.turnTimeLeft = m.turnTime;
  m.input[m.activeTeam] = { move: 0, jump: false };
  rollWind(m);
  if (m.activeTeam === 0) {
    m.round++;
    if (m.round > m.sdRound) {                       // sudden death: water rises
      m.waterY = Math.max(120, m.waterY - 8);
      if (m.round > m.sdRound + 10) {                // then everyone bleeds
        for (const p of m.players) if (p.alive) p.hp -= 10;
        checkWin(m, events);
      }
    }
  }
  events.push({ t: 'turn', team: m.activeTeam, player: found.i, round: m.round, wind: m.wind });
}

function endTurn(m, events) {
  if (m.phase === 'over') return;
  m.phase = 'aim';
  m.activeTeam = 1 - m.activeTeam;
  beginTurn(m, events);
}

function setInput(m, team, move, jump) {
  if (m.phase !== 'aim' || team !== m.activeTeam) return { err: 'not_your_turn' };
  if (![-1, 0, 1].includes(move)) return { err: 'bad_input' };
  m.input[team] = { move, jump: jump === true ? true : false };
  return { ok: 1 };
}

function setAim(m, team, angle, power) {
  if (m.phase !== 'aim' || team !== m.activeTeam) return { err: 'not_your_turn' };
  if (!isFinite(angle) || angle < 0 || angle > 90) return { err: 'bad_angle' };
  if (!isFinite(power) || power < 5 || power > 100) return { err: 'bad_power' };
  m.aim = m.aim || [{ angle: 45, power: 60 }, { angle: 45, power: 60 }];
  m.aim[team] = { angle, power };
  return { ok: 1 };
}

function aimOf(m, team) {
  return (m.aim && m.aim[team]) || { angle: 45, power: 60 };
}

function fire(m, team, weapon, events) {
  if (m.phase !== 'aim') return { err: 'not_ready' };
  if (team !== m.activeTeam) return { err: 'not_your_turn' };
  if (!WEAPONS[weapon]) return { err: 'bad_weapon' };
  const p = activePlayer(m);
  if (!p) return { err: 'no_player' };
  const { angle, power } = aimOf(m, team);
  const a = angle * Math.PI / 180;
  const dx = p.facing * Math.cos(a), dy = -Math.sin(a);
  const v = 200 + power * (PROJ_SPEED_MAX - 200) / 100;
  const mx = p.x + dx * 16, my = (p.y - 20) + dy * 16;
  const def = WEAPONS[weapon];

  if (def.kind === 'hitscan') {
    // march the ray; stops at terrain or first player (not the shooter)
    let hit = null, bx = mx, by = my;
    for (let d = 0; d < def.range; d += 3) {
      bx = mx + dx * d; by = my + dy * d;
      if (by >= hAt(m, bx)) break;
      for (const q of m.players) {
        if (!q.alive || q.i === p.i) continue;
        const cx = q.x, cy = q.y - 14;
        if ((bx - cx) ** 2 + (by - cy) ** 2 < 15 * 15) { hit = q; break; }
      }
      if (hit) break;
    }
    if (hit) {
      hit.hp -= def.dmg;
      hit.onGround = false;
      hit.vx += dx * def.kb; hit.vy += dy * def.kb - 120;
      events.push({ t: 'hit', p: hit.i, hp: Math.max(0, hit.hp) });
      checkWin(m, events);
    }
    endTurn(m, events);
    return { ok: 1, events };
  }

  if (def.kind === 'mine') {
    m.projectiles.push({ kind: 'mine', x: p.x, y: p.y - 6, vx: 0, vy: 0,
      fuse: def.fuse, r: def.r, dmg: def.dmg, team });
    m.phase = 'flying';
    return { ok: 1 };
  }

  if (def.kind === 'air') {
    const targetX = Math.max(20, Math.min(W - 20, p.x + p.facing * (power / 100) * 700));
    for (let i = 0; i < def.count; i++) {
      m.projectiles.push({ kind: 'bomb', x: targetX + i * 36 - 36, y: -40 - i * 55,
        vx: m.wind * 0.4, vy: 60, r: def.r, dmg: def.dmg, wind: true, team, delay: i * 0.35 });
    }
    m.phase = 'flying';
    return { ok: 1 };
  }

  // rocket / grenade
  m.projectiles.push({
    kind: def.kind, x: mx, y: my, vx: dx * v, vy: dy * v,
    fuse: def.fuse || 0, r: def.r, dmg: def.dmg, wind: def.wind,
    bounce: def.kind === 'grenade', team, settled: false,
  });
  m.phase = 'flying';
  return { ok: 1 };
}

function explosion(m, x, y, r, dmg, events) {
  // carve terrain
  const c0 = Math.max(0, Math.floor(x - r)), c1 = Math.min(W - 1, Math.ceil(x + r));
  let changed = false;
  for (let c = c0; c <= c1; c++) {
    const dy2 = r * r - (c - x) * (c - x);
    if (dy2 <= 0) continue;
    const bottom = Math.min(H, y + Math.sqrt(dy2));
    if (bottom > m.terrain[c]) { m.terrain[c] = bottom; changed = true; }
  }
  if (changed) events.push({ t: 'crater', from: c0, to: c1,
    h: Array.from(m.terrain.slice(c0, c1 + 1), v => Math.round(v)) });
  events.push({ t: 'boom', x: Math.round(x), y: Math.round(y), r });
  // damage + knockback
  for (const p of m.players) {
    if (!p.alive) continue;
    const d = Math.hypot(p.x - x, (p.y - 14) - y);
    if (d >= r) continue;
    const f = 1 - d / r;
    p.hp -= Math.round(dmg * f);
    p.onGround = false;
    const nx = d < 1 ? 0 : (p.x - x) / d, ny = d < 1 ? -1 : ((p.y - 14) - y) / d;
    p.vx += nx * 320 * f; p.vy += ny * 320 * f - 180 * f;
    events.push({ t: 'hit', p: p.i, hp: Math.max(0, p.hp) });
  }
  checkWin(m, events);
}

function checkWin(m, events) {
  if (m.phase === 'over') return;
  const alive = [0, 1].map(t => m.players.some(p => p.team === t && p.alive));
  if (!alive[0] || !alive[1]) {
    m.phase = 'over';
    m.winner = alive[0] && alive[1] ? -1 : (alive[0] ? 0 : 1);
    m.projectiles = [];
    events.push({ t: 'over', winner: m.winner });
  }
}

function kill(m, p, reason, events) {
  if (!p.alive) return;
  p.alive = false; p.hp = 0;
  events.push({ t: 'death', p: p.i, reason });
  checkWin(m, events);
}

function stepProjectiles(m, dt, events) {
  const sub = 4, sdt = dt / sub;
  for (let s = 0; s < sub; s++) {
    for (let i = m.projectiles.length - 1; i >= 0; i--) {
      const pr = m.projectiles[i];
      if (pr.delay > 0) { pr.delay -= sdt; continue; }
      if (pr.kind === 'mine') {
        pr.fuse -= sdt;
        if (pr.fuse <= 0) { m.projectiles.splice(i, 1); explosion(m, pr.x, pr.y, pr.r, pr.dmg, events); }
        continue;
      }
      if (pr.fuse) pr.fuse -= sdt;   // grenade fuse ticks while flying
      if (pr.wind) pr.vx += m.wind * sdt;
      pr.vy += GRAV * sdt;
      if (pr.kind === 'grenade' && pr.y > m.waterY) { pr.vx *= 0.94; pr.vy += -GRAV * 0.85 * sdt; }
      pr.x += pr.vx * sdt; pr.y += pr.vy * sdt;

      const inWater = pr.y >= m.waterY;
      const hitTerrain = pr.y >= hAt(m, pr.x);

      // direct hit on a player
      let hitP = null;
      for (const q of m.players) {
        if (!q.alive) continue;
        if ((pr.x - q.x) ** 2 + ((pr.y - (q.y - 14)) ** 2) < 16 * 16) { hitP = q; break; }
      }

      if (pr.kind === 'grenade') {
        if (pr.fuse <= 0) {
          m.projectiles.splice(i, 1);
          explosion(m, pr.x, Math.min(pr.y, hAt(m, pr.x)), pr.r, pr.dmg, events);
          continue;
        }
        if (inWater) {   // splash: grenade explodes at the surface like the rocket does
          m.projectiles.splice(i, 1);
          explosion(m, pr.x, Math.min(m.waterY, hAt(m, pr.x)), pr.r, pr.dmg, events);
          continue;
        }
        if (hitTerrain) {
          const gh = hAt(m, pr.x);
          pr.y = gh - 1;
          pr.vy = -pr.vy * 0.38;
          pr.vx = pr.vx * 0.6 + m.wind * 0.01;
          if (Math.abs(pr.vy) < 55 && Math.abs(pr.vx) < 45) { pr.vy = 0; pr.vx = 0; pr.settled = true; }
        }
        if (pr.x < -60 || pr.x > W + 60 || pr.y > H + 200) {   // never vanish silently
          m.projectiles.splice(i, 1);
          explosion(m, Math.max(20, Math.min(W - 20, pr.x)), Math.min(pr.y, m.waterY), pr.r, pr.dmg, events);
        }
        continue;
      }

      // rocket / bomb: explode on any contact
      if (hitTerrain || inWater || hitP || pr.x < -60 || pr.x > W + 60 || pr.y > H + 200) {
        m.projectiles.splice(i, 1);
        if (pr.x >= -20 && pr.x <= W + 20 && pr.y <= H + 20) {
          const ey = Math.min(pr.y, inWater ? m.waterY : hAt(m, pr.x));
          explosion(m, pr.x, ey, pr.r, pr.dmg, events);
        }
      }
    }
  }
}

function stepPlayers(m, dt, events) {
  // walking (active player, aim phase only)
  if (m.phase === 'aim') {
    const inp = m.input[m.activeTeam];
    const p = activePlayer(m);
    if (p && p.alive) {
      if (inp.jump && p.onGround) { p.vy = -JUMP; p.onGround = false; inp.jump = false; }
      if (inp.move !== 0 && p.onGround) {
        const nx = p.x + inp.move * WALK * dt;
        const gh = hAt(m, nx);
        const step = gh - p.y;
        if (step <= 14) { p.x = nx; p.y = Math.min(gh, p.y + Math.max(0, step)); p.facing = inp.move; }
        else if (step > 30) { p.x = nx; p.onGround = false; }  // walked off a cliff
        // step > 14 && <= 30: blocked by wall
      }
    }
  }
  // gravity / airborne for everyone (knocked players fly during any phase)
  for (const p of m.players) {
    if (!p.alive) continue;
    const gh = hAt(m, p.x);
    if (p.onGround) {
      if (!isFinite(gh) || p.y < gh - 0.5 || p.y > gh + 2) p.onGround = false;
      else { p.y = gh; p.vx = 0; }
    }
    if (!p.onGround) {
      p.vy += GRAV * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.35, dt);          // air drag
      const g = hAt(m, p.x);
      if (isFinite(g) && p.y >= g) {
        const impact = p.vy;
        p.y = g; p.vy = 0; p.vx = 0; p.onGround = true;
        if (impact > 450) {
          const dmg = Math.round((impact - 450) / 6);
          p.hp -= dmg;
          events.push({ t: 'hit', p: p.i, hp: Math.max(0, p.hp) });
          checkWin(m, events);
        }
      }
    }
    if (!p.alive) continue;
    if (p.hp <= 0) kill(m, p, 'wounds', events);          // covers ALL damage: bleed, shots, blasts, fall
    else if (p.y > m.waterY + 15) kill(m, p, 'drown', events);
    else if (p.y > H + 60 || p.x < -80 || p.x > W + 80) kill(m, p, 'fell', events);
  }
}

function step(m, dt) {
  const events = [];
  if (m.phase === 'over') return events;
  if (m.phase === 'aim') {
    m.turnTimeLeft -= dt;
    if (m.turnTimeLeft <= 0) { m.turnTimeLeft = 0; endTurn(m, events); }
  }
  stepPlayers(m, dt, events);
  if (m.phase === 'flying') {
    stepProjectiles(m, dt, events);
    if (m.projectiles.length === 0 && m.phase === 'flying') endTurn(m, events);
  }
  return events;
}

function serialize(m, full) {
  const s = {
    seed: m.seed, phase: m.phase, winner: m.winner,
    team: m.activeTeam, round: m.round, wind: m.wind,
    water: Math.round(m.waterY), tl: Math.round(m.turnTimeLeft),
    sd: m.round > m.sdRound,
    act: (activePlayer(m) || {}).i ?? -1,
    players: m.players.map(p => ({
      i: p.i, t: p.team, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      hp: Math.max(0, p.hp), a: p.alive ? 1 : 0, f: p.facing,
    })),
    proj: m.projectiles.map(p => ({ k: p.kind, x: Math.round(p.x), y: Math.round(p.y) })),
    aim: m.aim ? m.aim.map(a => a) : undefined,
  };
  if (full) s._terrain = Array.from(m.terrain, v => Math.round(v));
  return s;
}

module.exports = {
  W, H, WATER0, WEAPONS, TURN_TIME, GRAV, PROJ_SPEED_MAX,
  mulberry32, genTerrain, hAt, createMatch, spawnPlayers,
  fire, setInput, setAim, step, endTurn, explosion, serialize, activePlayer, solveShot,
};
