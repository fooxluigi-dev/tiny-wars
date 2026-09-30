// Tiny Wars client: renders server snapshots, sends intents. Never simulates.
'use strict';
(() => {
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const $ = id => document.getElementById(id);
const W = 3200, H = 900;   // must match shared/game.js

// ---------- state ----------
let ws = null, myTeam = -1, roomCode = null, started = false, connected = false;
let S = null;              // latest server snapshot
let prev = null, lerpT = 0; // interpolation between snapshots
let terrain = null;         // Float64Array(W) — server is authority, we mirror it
let pendingCraters = [];
let booms = [];             // visual explosion effects
let particles = [];
let floaters = [];           // rising damage numbers
let projBorn = 0;            // client-side projectile age (no server field)
let trail = [];              // projectile smoke trail
let muted = localStorage.getItem('tw_mute') === '1';

// ---------- sound: synthesized WebAudio, zero asset files ----------
let actx = null, noiseBuf = null;
function initAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const n = Math.floor(actx.sampleRate * 0.5);
    noiseBuf = actx.createBuffer(1, n, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    actx.resume();
  } catch (e) { actx = null; }
}
function audioGesture() {   // iOS: create/resume inside a gesture (tap = pointerdown + click)
  if (!actx) initAudio();
  else if (actx.state === 'suspended') actx.resume();
}
document.addEventListener('pointerdown', audioGesture, true);
document.addEventListener('click', audioGesture, true);

function sfx(kind) {
  if (muted) return;
  if (!actx) initAudio();          // may start suspended; gesture listener resumes it
  if (!actx) return;
  try {
    if (actx.state === 'suspended') actx.resume();
    const tone = (type, f0, f1, dur, vol, delay = 0) => {
      const t0 = actx.currentTime + delay;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + dur);
    };
    const noise = (dur, vol, type, f) => {
      const t0 = actx.currentTime;
      const s = actx.createBufferSource(); s.buffer = noiseBuf;
      const flt = actx.createBiquadFilter(); flt.type = type; flt.frequency.value = f;
      const g = actx.createGain();
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      s.connect(flt).connect(g).connect(actx.destination); s.start(t0); s.stop(t0 + dur);
    };
    switch (kind) {
      case 'fire':   noise(0.28, 0.5, 'bandpass', 900); tone('sine', 300, 60, 0.3, 0.4); break;
      case 'boom':   noise(0.5, 0.6, 'lowpass', 500); tone('sine', 110, 35, 0.5, 0.6); break;
      case 'splash': noise(0.35, 0.4, 'highpass', 1400); tone('sine', 250, 90, 0.2, 0.15); break;
      case 'turn':   tone('sine', 660, 660, 0.12, 0.25); tone('sine', 880, 880, 0.15, 0.25, 0.09); break;
      case 'death':  tone('sawtooth', 220, 70, 0.45, 0.3); break;
      case 'win':    [523, 659, 784].forEach((f, i) => tone('square', f, f, 0.18, 0.18, i * 0.12)); break;
      case 'lose':   [330, 262].forEach((f, i) => tone('square', f, f, 0.25, 0.15, i * 0.16)); break;
    }
  } catch (e) {}
}
let weapon = 'bazooka';
let aim = { angle: 45, power: 60 };
let shakeT = 0, shakeMag = 0;
let deathFx = {};           // player index -> timestamp for death anim
let msgTimer = null;

const WEAPON_LIST = [
  ['bazooka', '🚀', 'Bazooka'], ['grenade', '💣', 'Grenade'], ['shotgun', '🎯', 'Shotgun'],
  ['dynamite', '🧨', 'Dynamite'], ['airstrike', '✈️', 'Airstrike'],
];

// ---------- sprites ----------
const sprites = [new Image(), new Image()];
sprites[0].src = 'assets/p1.png';
sprites[1].src = 'assets/p2.png';

// ---------- networking ----------
function connect(retryDelay = 800) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    connected = true; $('connBadge').style.display = 'none';
    while (outbox.length) ws.send(JSON.stringify(outbox.shift()));   // flush intents queued pre-open
    rejoin();
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    connected = false;
    outbox.length = 0;   // stale intents from a dead socket are meaningless
    if (started) $('connBadge').style.display = 'block';
    setTimeout(() => { connect(Math.min(retryDelay * 1.6, 6000)); rejoin(); }, retryDelay);
  };
  ws.onerror = () => ws.close();
}
const outbox = [];
function send(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  else outbox.push(o);          // not open yet (cold start) — flush on open
}

// after reconnect: get back into the same room
function rejoin() {
  const code = sessionStorage.getItem('tw_room'), tok = sessionStorage.getItem('tw_tok');
  if (code && tok) send({ t: 'rejoin', code, tok });
}

let myName = localStorage.getItem('tw_name') || ('Player ' + (Math.random() * 90 + 10 | 0));

function handle(m) {
  window.__lastMsg = m.t;   // debug/E2E hook
  switch (m.t) {
    case 'room': {
      roomCode = m.code;
      if (m.you !== undefined) myTeam = m.you;
      if (m.tok) { sessionStorage.setItem('tw_room', m.code); sessionStorage.setItem('tw_tok', m.tok); }
      updateRoomUI(m);
      break;
    }
    case 'start': {
      S = m.state; prev = null;
      for (const p of S.players) p.facing = p.f;
      terrain = new Float64Array(S._terrain);
      started = true;
      cam.mode = 'follow'; cam.zoomUser = 1.8;    // fresh match: standard framing
      $('menu').style.display = 'none';
      $('winScreen').style.display = 'none';
      $('hud').style.display = 'flex';
      if (!m.resume) showMsg('⚔️ Battle starts!');
      break;
    }
    case 'state': {
      if (S && S.proj && !S.proj.length && m.s.proj.length) {
        if (cam.mode !== 'overview') cam.mode = 'follow';
        sfx('fire');
        projBorn = performance.now();
      }
      prev = S; S = m.s; lerpT = 0; window.__S = S;
      for (const p of S.players) p.facing = p.f;   // normalize server field
      if (!terrain && S._terrain) terrain = new Float64Array(S._terrain);
      if (S.phase === 'over' && started) showWin(S.winner);
      updateHUD();   // keep HUD truthful even when rAF is throttled (background tab)
      break;
    }
    case 'event':
      for (const ev of m.evs) onEvent(ev);
      window.__evCount = (window.__evCount||0) + 1;   // debug/E2E hook
      break;
    case 'err': if (m.m === 'no_room') { roomCode = null; started = false; showStatus('Room expired — create a new one'); } break;
    case 'pong': break;
  }
}

function onEvent(ev) {
  switch (ev.t) {
    case 'crater': {
      if (!terrain) break;
      for (let i = 0; i < ev.h.length; i++) terrain[ev.from + i] = ev.h[i];
      break;
    }
    case 'boom': {
      const wet = S && ev.y >= S.water - 4;
      booms.push({ x: ev.x, y: ev.y, r: ev.r, t: 0 });
      shakeT = 0.35; shakeMag = Math.min(14, ev.r / 6);
      spawnParticles(ev.x, ev.y, ev.r, wet);
      sfx(wet ? 'splash' : 'boom');
      break;
    }
    case 'hit':
      if (S) {
        const p = S.players[ev.p];
        if (p) {
          flashPlayer(ev.p);
          const dmg = p.hp - ev.hp;          // S still holds pre-hit hp (state arrives after event)
          if (dmg > 0) floaters.push({ x: p.x, y: p.y - 70, txt: '-' + dmg, t: 0 });
        }
      }
      break;
    case 'death':
      deathFx[ev.p] = performance.now();
      if (S && S.players[ev.p]) spawnPuff(S.players[ev.p].x, S.players[ev.p].y - 30);
      sfx('death');
      showMsg(ev.reason === 'drown' ? '🌊 Drowned!' : ev.reason === 'fell' ? '💀 Fell off!' : '☠️ Down!');
      break;
    case 'turn':
      if (cam.mode === 'manual') cam.mode = 'follow';
      if (ev.team === myTeam) sfx('turn');
      showMsg(ev.team === myTeam ? '🎯 Your turn' : "⏳ Opponent's turn");
      break;
    case 'over':
      sfx(ev.winner === myTeam ? 'win' : 'lose');
      showWin(ev.winner);
      break;
  }
}

const flashes = {};
function flashPlayer(i) { flashes[i] = performance.now(); }

function spawnParticles(x, y, r, wet) {
  const n = wet ? 14 : 22;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * r * 3;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80, t: 0, life: 0.5 + Math.random() * 0.5,
      c: wet ? (Math.random() < 0.5 ? '#9fd4ff' : '#4a9fe0')
             : (Math.random() < 0.5 ? '#ffb347' : '#ff5252') });
  }
}
function spawnPuff(x, y) {   // grey smoke cloud on death
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2, v = 30 + Math.random() * 70;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, t: 0, life: 0.7 + Math.random() * 0.5,
      c: Math.random() < 0.5 ? '#cfd6e4' : '#8a94ad' });
  }
}

// ---------- UI: menu / rooms ----------
function showStatus(html) { $('status').innerHTML = html; }

function updateRoomUI(m) {
  const names = m.players.map(p => p.name);
  if (m.players.length < 2 && !started) {
    showStatus(`Room <span class="code">${m.code}</span>\nShare this code — waiting for opponent…`);
  }
  if (m.players.length === 2) showStatus(`Both players in — good luck!`);
}

$('createBtn').onclick = () => {
  sessionStorage.removeItem('tw_room'); sessionStorage.removeItem('tw_tok');  // explicit action overrides rejoin
  myName = localStorage.getItem('tw_name') || myName;
  send({ t: 'create', name: myName, opts: { turnTime: +$('optTurn').value, sdRound: +$('optSD').value } });
  showStatus('Creating…');
};
$('joinBtn').onclick = doJoin;
$('practiceBtn').onclick = () => {
  sessionStorage.removeItem('tw_room'); sessionStorage.removeItem('tw_tok');
  myName = localStorage.getItem('tw_name') || myName;
  send({ t: 'practice', name: myName, opts: { turnTime: +$('optTurn').value, sdRound: +$('optSD').value } });
  showStatus('Starting practice…');
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
function doJoin() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) { showStatus('Enter the 5-letter room code'); return; }
  sessionStorage.removeItem('tw_room'); sessionStorage.removeItem('tw_tok');
  send({ t: 'join', code, name: myName });
  showStatus('Joining…');
}
// invite link: ?code=ABC12 auto-joins
const qs = new URLSearchParams(location.search);
if (qs.get('code') && qs.get('code').length === 5) {
  $('codeInput').value = qs.get('code').toUpperCase();
  setTimeout(() => doJoin(), 300);
}

$('rematchBtn').onclick = () => { send({ t: 'rematch' }); $('winScreen').style.display = 'none'; };
$('leaveBtn').onclick = () => location.href = location.pathname;

function showWin(winner) {
  const t = $('winTitle');
  if (winner === -1) { t.textContent = '🤝 DRAW'; t.className = ''; }
  else { t.textContent = winner === myTeam ? '🏆 VICTORY!' : '💀 DEFEAT'; t.className = winner === 0 ? 'win0' : 'win1'; }
  $('winSub').textContent = winner === myTeam ? 'You wiped out the enemy squad.' : 'Your squad was wiped out.';
  $('winScreen').style.display = 'flex';
  $('rematchBtn').style.display = '';   // server accepts rematch from either player
  if (winner !== myTeam) showMsg('💀 DEFEAT');
}

function showMsg(text) {
  const el = $('bigMsg');
  el.textContent = text; el.classList.add('show');
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- HUD ----------
function updateHUD() {
  if (!S) return;
  const mine = S.team === myTeam;
  $('turnInfo').textContent = S.phase === 'over' ? 'GAME OVER'
    : (mine ? '▶ YOUR TURN' : '● OPPONENT TURN') + ` · Round ${S.round}` + (S.sd ? ' · SD' : '');
  const tl = $('timer');
  tl.textContent = Math.ceil(S.tl);
  tl.className = S.tl <= 5 && mine ? 'low' : '';
  const wb = $('windBox');
  wb.className = 'wind ' + (S.wind >= 0 ? 'right' : 'left');
  $('windVal').textContent = Math.abs(S.wind);
  for (const t of [0, 1]) {
    const alive = S.players.filter(p => p.t === t);
    const hp = alive.reduce((a, p) => a + (p.a ? p.hp : 0), 0);
    $('h' + t).textContent = hp;
    $('b' + t).style.width = (hp / (alive.length * 100) * 100) + '%';
    const nm = S.players.find(p => p.t === t);
    $('n' + t).textContent = nm ? (t === myTeam ? 'YOU' : 'FOE') : '';
  }
  const canAct = mine && S.phase === 'aim' && connected;
  canActNow = canAct;
  $('endBtn').classList.toggle('disabled', !canAct);
  refreshChip();
}

// ---------- controls ----------
function myActiveIdx() {
  return S ? S.act : -1;
}
function sendAim() { send({ t: 'aim', angle: aim.angle, power: aim.power }); }
function sendInput(move, jump) { send({ t: 'input', move, jump: !!jump }); }

function aimUp(d) {
  aim.angle = Math.max(0, Math.min(90, aim.angle + d));
  sendAim(); updateAimUI();
}
function refreshChip() {   // one status chip: weapon + aim, tappable = weapon inventory
  const el = $('aimHint');
  if (!started) { el.style.display = 'none'; return; }
  const wl = WEAPON_LIST.find(w => w[0] === weapon) || WEAPON_LIST[0];
  el.style.display = 'block';
  el.textContent = (canActNow
    ? `${wl[1]} ${wl[2]} · ${Math.round(aim.angle)}° · PWR ${aim.power}`
    : `${wl[1]} ${wl[2]}`) + ' ▾';
}
function updateAimUI() {
  fjoyKnob.textContent = `${Math.round(aim.angle)}°`;
  refreshChip();
}
function sendFire() {
  if (!canActNow) return;
  send({ t: 'fire', weapon }); sendAim();
}

// ---------- 2-thumb touch zones (pointerType touch only; desktop keeps keyboard+mouse) ----------
// zones: top 40% = camera pan | bottom-left = floating aim/walk stick | bottom-right = drag power / tap fire
const joy = { held: false, ptr: null, rate: 0, walk: 0, x0: 0, y0: 0, t0: 0, fx: 0, fy: 0 };
const fjoy = $('fjoy'), fjoyKnob = $('fjoyKnob'), powTip = $('powTip');
const STICK_R = 66, TAP_PX = 16, TAP_MS = 300;

function zoneOf(e) {
  if (e.pointerType === 'mouse') return 'pan';            // desktop mouse always pans
  if (!canActNow) return 'pan';
  const r = cv.getBoundingClientRect();
  if (e.clientY - r.top < r.height * 0.40) return 'pan';  // top strip = camera
  return (e.clientX - r.left) < r.width / 2 ? 'stick' : 'power';
}

function stickDown(e) {
  joy.held = true; joy.ptr = e.pointerId; joy.rate = 0; joy.walk = 0;
  joy.x0 = e.clientX; joy.y0 = e.clientY; joy.t0 = performance.now();
  joy.fx = e.clientX; joy.fy = e.clientY;
  const r = cv.getBoundingClientRect();
  fjoy.style.left = (e.clientX - r.left) + 'px';
  fjoy.style.top = (e.clientY - r.top) + 'px';
  fjoy.style.display = 'block';
  fjoyKnob.style.transform = 'translate(-50%,-50%)';
  updateAimUI();
}
function stickMove(e) {
  joy.fx = e.clientX; joy.fy = e.clientY;
  const dx = e.clientX - joy.x0, dy = e.clientY - joy.y0;
  const off = Math.max(-1, Math.min(1, -dy / STICK_R));   // up = +
  joy.rate = Math.sign(off) * off * off * 45;             // quadratic: micro = fine aim, full = 45°/s
  fjoyKnob.style.transform =
    `translate(calc(-50% + ${(dx * .5).toFixed(1)}px), calc(-50% + ${(-off * STICK_R * .7).toFixed(1)}px))`;
  const walk = dx > STICK_R * 0.35 ? 1 : dx < -STICK_R * 0.35 ? -1 : 0;   // deadzone
  if (walk !== joy.walk) { joy.walk = walk; sendInput(walk, false); }
}
function stickUp(e) {
  const dt = performance.now() - joy.t0;
  const dy = e.clientY - joy.y0;
  joy.held = false; joy.ptr = null; joy.rate = 0;
  if (joy.walk) { joy.walk = 0; sendInput(0, false); }
  fjoy.style.display = 'none';
  sendAimThrottled(true);                                 // flush final angle
  if (!canActNow) return;
  const wasTap = Math.hypot(e.clientX - joy.x0, dy) < TAP_PX && dt < TAP_MS;
  if (wasTap || (dy < -60 && dt < 250)) sendInput(0, true);   // quick tap or up-flick = jump
}

let powDrag = null;   // {ptr, y0, p0}
function powerDown(e) {
  powDrag = { ptr: e.pointerId, x0: e.clientX, y0: e.clientY, p0: aim.power, t0: performance.now() };
  powTip.style.display = 'block';
  placePowTip(e);
}
function placePowTip(e) {
  const r = cv.getBoundingClientRect();
  powTip.style.left = (e.clientX - r.left) + 'px';
  powTip.style.top = (e.clientY - r.top - 58) + 'px';
  powTip.textContent = 'PWR ' + aim.power;
}
function powerMove(e) {
  if (!canActNow) return;
  const p = Math.max(5, Math.min(100, Math.round(powDrag.p0 + (powDrag.y0 - e.clientY) * 0.55)));  // up = more power
  if (p !== aim.power) { aim.power = p; sendAimThrottled(); refreshChip(); }
  placePowTip(e);
}
function powerUp(e) {
  powDrag = null;
  powTip.style.display = 'none';
  sendFire();                                             // release = fire (drag sets power first)
}

let lastAimSend = 0;
function sendAimThrottled(force) {
  const n = performance.now();
  if (force || n - lastAimSend > 100) { lastAimSend = n; sendAim(); }
}
function aimStep(delta) {
  if (!canActNow) return;
  const a = Math.max(0, Math.min(90, aim.angle + delta));
  if (a === aim.angle) return;
  aim.angle = a; sendAimThrottled(); updateAimUI();
}

$('endBtn').onclick = () => send({ t: 'endturn' });

// ---------- weapon inventory: one HUD button opens a large touch panel ----------
let canActNow = false;                 // set by updateHUD each frame
const wpanel = $('wpanel'), wgrid = $('wgrid'), wreason = $('wreason');
const wtiles = {};
for (const [id, ico, label] of WEAPON_LIST) {
  const t = document.createElement('button');
  t.className = 'wtile';
  t.innerHTML = `<span class="ico">${ico}</span><span>${label}</span><span class="ammo">∞ ammo</span>`;
  t.onclick = () => {
    if (!canActNow) { wreason.textContent = '🔒 You can only pick weapons on your turn'; return; }
    weapon = id;
    refreshWeapons();
    wpanel.classList.remove('open');   // auto-close after selecting
  };
  wgrid.appendChild(t);
  wtiles[id] = t;
}
function refreshWeapons() {
  refreshChip();
  for (const [id] of WEAPON_LIST) {
    wtiles[id].classList.toggle('sel', id === weapon);
    wtiles[id].classList.toggle('off', !canActNow);
  }
  wreason.textContent = canActNow ? '' : '🔒 Weapons lock while it is not your turn';
}
$('aimHint').onclick = () => { refreshWeapons(); wpanel.classList.add('open'); };
$('wclose').onclick = () => wpanel.classList.remove('open');

function selectWeapon(id) {
  if (!WEAPON_LIST.find(w => w[0] === id)) return;
  if (!canActNow) return;
  weapon = id; refreshWeapons();
}

// keyboard (desktop)
const keys = {};
addEventListener('keydown', e => {
  if (e.repeat) return;
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'ArrowUp') { aimUp(3); e.preventDefault(); }
  if (e.key === 'ArrowDown') { aimUp(-3); e.preventDefault(); }   // tap kick; hold = continuous in draw()
  if (e.key === ' ') { sendFire(); e.preventDefault(); }
  if (e.key.toLowerCase() === 'e') send({ t: 'endturn' });
  if ('12345'.includes(e.key)) { const w = WEAPON_LIST[+e.key - 1]; if (w) selectWeapon(w[0]); }
  syncKeys();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; syncKeys(); });
function syncKeys() {
  const l = keys['a'] || keys['arrowleft'], r = keys['d'] || keys['arrowright'];
  if (l && !r) sendInput(-1, false);
  else if (r && !l) sendInput(1, false);
  else sendInput(0, false);
  if (keys['w'] || keys['arrowup'] === keys['shift']) {}
}
addEventListener('keydown', e => { if (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 'f') sendInput(0, true); });
// hold Q/E to change power on desktop
addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'q') { aim.power = Math.max(5, aim.power - 5); sendAim(); refreshChip(); }
  if (e.key.toLowerCase() === 'r') { aim.power = Math.min(100, aim.power + 5); sendAim(); refreshChip(); }
});
// ---------- camera (render-only: never touches physics or server state) ----------
// mode: follow (auto-track active/projectile) | manual (user dragged) | overview (whole map)
const cam = { x: W / 2, y: H / 2, zoom: 1.8, zoomUser: 1.8, mode: 'follow' };
const ZOOM_MIN = 1, ZOOM_MAX = 6;   // 1 = fits whole map, 6 = close-up

function fitScale() {
  const cw = cv.width, ch = cv.height;
  return Math.min(cw / W, ch / H);
}
function viewSize() {   // visible world size at current zoom
  const s = fitScale() * (cam.mode === 'overview' ? 1 : cam.zoomUser);
  return { s, w: cv.width / s, h: cv.height / s };
}
function clampCam() {
  const { w, h } = viewSize();
  cam.x = w >= W ? W / 2 : Math.max(w / 2, Math.min(W - w / 2, cam.x));
  cam.y = h >= H ? H / 2 : Math.max(h / 2, Math.min(H - h / 2, cam.y));
}
function camTarget() {
  if (cam.mode === 'overview') return { x: W / 2, y: H / 2 };
  const { h } = viewSize();
  if (S && S.proj && S.proj.length) return { x: S.proj[0].x, y: S.proj[0].y - h * 0.06 };
  if (S && S.act >= 0 && S.players[S.act]) { const p = S.players[S.act]; return { x: p.x, y: p.y - h * 0.15 }; }
  return null;
}
function camFrame(dt) {
  if (cam.mode !== 'manual') {
    const t = camTarget();
    if (t) {
      const k = Math.min(1, dt * 5);
      cam.x += (t.x - cam.x) * k;
      cam.y += (t.y - cam.y) * k;
    }
  }
  clampCam();
}
function screenToWorld(sx, sy) {
  const { s } = viewSize();
  const ox = cv.width / 2 - cam.x * s, oy = cv.height / 2 - cam.y * s;
  return { x: (sx - ox) / s, y: (sy - oy) / s };
}
function zoomAt(factor, sx, sy) {
  if (cam.mode === 'overview') { cam.mode = 'manual'; }
  const before = screenToWorld(sx, sy);
  cam.zoomUser = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoomUser * factor));
  const { s } = viewSize();
  cam.x = before.x - (sx - cv.width / 2) / s;
  cam.y = before.y - (sy - cv.height / 2) / s;
  clampCam();
}

// pointer gestures: 1 finger/mouse = pan (manual), 2 = pinch zoom; wheel = zoom
const ptrs = new Map();
let drag0 = null, pinch0 = 0, pinchZ0 = 1;
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  const zone = zoneOf(e);
  if (zone === 'stick') { stickDown(e); return; }
  if (zone === 'power') { powerDown(e); return; }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) drag0 = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    pinchZ0 = cam.zoomUser;
    drag0 = null;
  }
});
cv.addEventListener('pointermove', e => {
  if (joy.held && e.pointerId === joy.ptr) { stickMove(e); return; }
  if (powDrag && e.pointerId === powDrag.ptr) { powerMove(e); return; }
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const rect = cv.getBoundingClientRect();
  if (ptrs.size >= 2) {           // pinch: zoom around midpoint
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    const target = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchZ0 * d / pinch0));
    zoomAt(target / (cam.mode === 'overview' ? 1 : cam.zoomUser), mid.x, mid.y);
    return;
  }
  if (drag0 && cam.mode !== 'overview') {
    const dx = e.clientX - drag0.x, dy = e.clientY - drag0.y;
    if (Math.hypot(dx, dy) > 6) {
      const { s } = viewSize();
      cam.mode = 'manual';
      cam.x = drag0.cx - dx / s;
      cam.y = drag0.cy - dy / s;
      clampCam();
    }
  }
});
function ptrUp(e) {
  if (joy.held && e.pointerId === joy.ptr) { stickUp(e); return; }
  if (powDrag && e.pointerId === powDrag.ptr) { powerUp(e); return; }
  ptrs.delete(e.pointerId);
  if (ptrs.size === 0) drag0 = null;
}
cv.addEventListener('pointerup', ptrUp);
cv.addEventListener('pointercancel', ptrUp);
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = cv.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

$('camOverview').onclick = () => { cam.mode = 'overview'; };
$('muteBtn').onclick = () => {
  muted = !muted;
  localStorage.setItem('tw_mute', muted ? '1' : '0');
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
  if (!muted) { initAudio(); sfx('turn'); }
};
$('muteBtn').textContent = muted ? '🔇' : '🔊';

// ---------- rendering ----------
function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr;
}
addEventListener('resize', resize); resize();

function lerpSnap() {
  if (!prev || !S) return S;
  return S; // ponytail: direct latest-snapshot render, interpolation only if 30Hz feels choppy
}

function worldToScreen() {
  const { s } = viewSize();
  const scale = s;
  let ox = cv.width / 2 - cam.x * scale, oy = cv.height / 2 - cam.y * scale;
  if (shakeT > 0) { ox += (Math.random() - .5) * shakeMag * 2; oy += (Math.random() - .5) * shakeMag * 2; }
  return { scale, ox, oy };
}

function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  const dt = Math.min(0.1, (now - (draw.t || now)) / 1000); draw.t = now;
  if (started) {
    camFrame(dt);
    // continuous aiming: joystick held, or arrow keys held (desktop equivalent)
    let rate = joy.held ? joy.rate : 0;
    if (!joy.held && keys['arrowup']) rate = 28;
    if (!joy.held && keys['arrowdown']) rate = -28;
    if (rate && canActNow) aimStep(rate * dt);
  }
  const dpr = Math.min(devicePixelRatio || 1, 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // sky
  const g = ctx.createLinearGradient(0, 0, 0, cv.height);
  g.addColorStop(0, '#0d1430'); g.addColorStop(0.6, '#1a2a55'); g.addColorStop(1, '#2b4a7a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
  // stars
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  for (let i = 0; i < 40; i++) { const x = (i * 173.3 % 1) * cv.width, y = (i * 97.7 % 1) * cv.height * .5; ctx.fillRect(x, y, 1.5, 1.5); }
  // moon + glow
  const mx = cv.width * 0.78, my = cv.height * 0.16;
  const mg = ctx.createRadialGradient(mx, my, 0, mx, my, 70);
  mg.addColorStop(0, 'rgba(225,235,255,.45)'); mg.addColorStop(1, 'rgba(225,235,255,0)');
  ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, 70, 0, 7); ctx.fill();
  ctx.fillStyle = '#e8eeff'; ctx.beginPath(); ctx.arc(mx, my, 15, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(190,200,230,.55)';
  ctx.beginPath(); ctx.arc(mx - 5, my - 3, 3, 0, 7); ctx.arc(mx + 6, my + 5, 4, 0, 7); ctx.arc(mx + 1, my - 7, 2, 0, 7); ctx.fill();
  // parallax clouds (drift with camera, slow self-drift)
  ctx.fillStyle = 'rgba(255,255,255,.07)';
  const drift = performance.now() * 0.006;
  for (let i = 0; i < 5; i++) {
    const cw = 150 + i * 45;
    const span = cv.width + 500;
    const cx = (((i * 613 + drift - cam.x * 0.15) % span) + span) % span - 250;
    const cy = cv.height * (0.08 + (i * 37 % 4) * 0.11);
    ctx.beginPath();
    ctx.ellipse(cx, cy, cw * 0.5, 15 + i * 3, 0, 0, 7);
    ctx.ellipse(cx + cw * 0.26, cy - 7, cw * 0.3, 12, 0, 0, 7);
    ctx.ellipse(cx - cw * 0.3, cy + 4, cw * 0.24, 10, 0, 0, 7);
    ctx.fill();
  }
  // horizon glow above the skyline
  const hg = ctx.createLinearGradient(0, cv.height * 0.55, 0, cv.height);
  hg.addColorStop(0, 'rgba(120,160,220,0)'); hg.addColorStop(1, 'rgba(120,160,220,.22)');
  ctx.fillStyle = hg; ctx.fillRect(0, cv.height * 0.55, cv.width, cv.height * 0.45);

  if (!S || !terrain) return;
  const { scale, ox, oy } = worldToScreen();
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // terrain (cull to visible columns for iPhone perf on the 3200px map)
  const vx0 = Math.max(0, Math.floor((-ox / scale) / 2) * 2 - 4);
  const vx1 = Math.min(W, Math.ceil(((cv.width - ox) / scale) / 2) * 2 + 4);
  ctx.beginPath();
  ctx.moveTo(vx0, H + 200);
  for (let x = vx0; x <= vx1; x += 2) ctx.lineTo(x, terrain[Math.min(x, W - 1)]);
  ctx.lineTo(vx1, H + 200);
  ctx.closePath();
  const tg = ctx.createLinearGradient(0, 0, 0, H);
  tg.addColorStop(0, '#6b4a2f'); tg.addColorStop(0.55, '#5a3f28'); tg.addColorStop(1, '#3a2a1c');
  ctx.fillStyle = tg; ctx.fill();
  // rock/soil strata, clipped to the island silhouette
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,.13)';
  for (let y = 170; y < H; y += 46) ctx.fillRect(vx0, y, vx1 - vx0, 15);
  ctx.fillStyle = 'rgba(255,225,190,.05)';
  for (let y = 193; y < H; y += 46) ctx.fillRect(vx0, y, vx1 - vx0, 8);
  ctx.restore();
  // grass cap: only above the waterline (bright green under translucent water looks wrong)
  const wl = S.water - 2;
  ctx.lineJoin = 'round';
  for (const [lw, col] of [[11, '#3f8f4f'], [6, '#57ac63']]) {
    ctx.beginPath();
    let on = false;
    for (let x = vx0; x <= vx1; x += 2) {
      const y = terrain[Math.min(x, W - 1)];
      if (y < wl) { on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true; }
      else on = false;
    }
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
  }
  // grass tufts poking above the surface (also above waterline)
  ctx.strokeStyle = '#6bc574'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath();
  for (let x = vx0 + 6; x <= vx1; x += 13) {
    const gy = terrain[Math.min(x, W - 1)];
    if (gy >= wl) continue;
    const len = 5 + (x * 7919 % 6);
    ctx.moveTo(x, gy + 3);
    ctx.lineTo(x + ((x >> 3) & 1 ? 2 : -2), gy - len);
  }
  ctx.stroke();
  ctx.lineCap = 'butt';

  // water
  const wy = S.water;
  const wg = ctx.createLinearGradient(0, wy, 0, H);
  wg.addColorStop(0, 'rgba(40,120,220,.75)'); wg.addColorStop(1, 'rgba(10,30,80,.9)');
  ctx.fillStyle = wg;
  const t = performance.now() / 1000;
  ctx.beginPath(); ctx.moveTo(vx0, H + 200);
  for (let x = vx0; x <= vx1; x += 8) ctx.lineTo(x, wy + Math.sin(x / 60 + t * 2) * 3);
  ctx.lineTo(vx1, H + 200); ctx.closePath(); ctx.fill();
  // crest highlight
  ctx.beginPath();
  for (let x = vx0; x <= vx1; x += 8) { const y = wy + Math.sin(x / 60 + t * 2) * 3; x === vx0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.strokeStyle = 'rgba(160,220,255,.45)'; ctx.lineWidth = 2; ctx.stroke();

  // trajectory preview: dotted arc using the same physics constants as the server
  if (S.phase === 'aim') {
    const p0 = S.players[S.act];
    const isMine = p0 && p0.a && p0.t === myTeam;
    if (isMine) {
      const a = aim.angle * Math.PI / 180;
      const dx = p0.facing * Math.cos(a), dy = -Math.sin(a);
      const v = 200 + aim.power * (1400 - 200) / 100;   // matches PROJ_SPEED_MAX
      let px = p0.x + dx * 16, py = (p0.y - 20) + dy * 16, vx = dx * v, vy = dy * v;
      ctx.save();
      ctx.fillStyle = 'rgba(255,214,102,.75)';
      if (weapon === 'bazooka' || weapon === 'grenade') {   // arc weapons only
        for (let i = 0; i < 300; i++) {
          if (S.wind) vx += S.wind / 60;
          vy += 1000 / 60;
          px += vx / 60; py += vy / 60;
          if (i % 9 === 0) ctx.fillRect(px - 2, py - 2, 4, 4);
          if (py >= (terrain[Math.round(px)] ?? 1e9) || py >= S.water || px < 0 || px > W) break;
        }
      } else if (weapon === 'shotgun') {
        for (let d = 20; d < 560; d += 14) {
          const qx = p0.x + dx * d, qy = (p0.y - 20) + dy * d;
          if (qy >= (terrain[Math.round(qx)] ?? 1e9)) break;
          ctx.fillRect(qx - 2, qy - 2, 4, 4);
        }
      }
      ctx.restore();
    }
  }

  // aim indicator for active player
  if (S.phase === 'aim') {
    const p = S.players[S.act];
    if (p && p.a) {
      const isMine = p.t === myTeam;
      const a = (isMine ? aim.angle : (S.aim && S.aim[p.t] ? S.aim[p.t].angle : 45)) * Math.PI / 180;
      const pw = (isMine ? aim.power : (S.aim && S.aim[p.t] ? S.aim[p.t].power : 60));
      const dx = p.facing * Math.cos(a), dy = -Math.sin(a);
      const len = 34 + pw * 0.6;
      ctx.save();
      ctx.strokeStyle = isMine ? 'rgba(255,214,102,.95)' : 'rgba(255,255,255,.4)';
      ctx.lineWidth = 3; ctx.setLineDash([7, 6]);
      ctx.beginPath(); ctx.moveTo(p.x + dx * 18, p.y - 16 + dy * 18);
      ctx.lineTo(p.x + dx * len, p.y - 16 + dy * len); ctx.stroke();
      // arrowhead
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      const ax = p.x + dx * len, ay = p.y - 16 + dy * len;
      ctx.beginPath();
      ctx.moveTo(ax + dx * 9, ay + dy * 9);
      ctx.lineTo(ax - dy * 5, ay + dx * 5);
      ctx.lineTo(ax + dy * 5, ay - dx * 5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      // aim readout lives in the status chip (refreshChip)
    }
  }

  // players
  for (const p of S.players) drawPlayer(p);

  // projectile smoke trail
  for (const pr of S.proj) trail.push({ x: pr.x, y: pr.y, t: 0 });
  while (trail.length > 90) trail.shift();
  for (let i = trail.length - 1; i >= 0; i--) {
    const q = trail[i]; q.t += 0.016;
    if (q.t > 0.45) { trail.splice(i, 1); continue; }
    ctx.globalAlpha = 0.35 * (1 - q.t / 0.45);
    ctx.fillStyle = '#cfd6e4';
    ctx.beginPath(); ctx.arc(q.x, q.y, 3 + q.t * 8, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // projectiles + muzzle flash ring
  for (const pr of S.proj) {
    const age = (performance.now() - projBorn) / 1000;
    if (age < 0.1) {              // young projectile: brief flash at its position
      ctx.globalAlpha = 1 - age * 10;
      const fg = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, 26);
      fg.addColorStop(0, '#fff3c4'); fg.addColorStop(1, 'rgba(255,160,60,0)');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(pr.x, pr.y, 26, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.fillStyle = pr.k === 'mine' ? '#d84315' : pr.k === 'bomb' ? '#37474f' : '#263238';
    ctx.beginPath();
    if (pr.k === 'mine') { ctx.arc(pr.x, pr.y - 4, 7, 0, 7); }
    else if (pr.k === 'bomb') { ctx.arc(pr.x, pr.y, 8, 0, 7); }
    else { ctx.arc(pr.x, pr.y, 5, 0, 7); }
    ctx.fill();
    ctx.strokeStyle = '#ff8a65'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  // explosions
  for (let i = booms.length - 1; i >= 0; i--) {
    const b = booms[i]; b.t += 0.025;
    if (b.t > 1) { booms.splice(i, 1); continue; }
    const r = b.r * (0.4 + b.t * 0.9);
    ctx.globalAlpha = 1 - b.t;
    const bg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
    bg.addColorStop(0, '#fff7cc'); bg.addColorStop(0.4, '#ffb347'); bg.addColorStop(1, 'rgba(255,60,30,0)');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }
  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i]; pt.t += 0.016;
    if (pt.t > pt.life) { particles.splice(i, 1); continue; }
    pt.x += pt.vx * 0.016; pt.y += pt.vy * 0.016; pt.vy += 600 * 0.016;
    ctx.globalAlpha = 1 - pt.t / pt.life;
    ctx.fillStyle = pt.c;
    ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    ctx.globalAlpha = 1;
  }

  // rising damage numbers
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.t += 0.016;
    if (f.t > 0.9) { floaters.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - f.t / 0.9;
    ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5252';
    ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 3;
    ctx.strokeText(f.txt, f.x, f.y - f.t * 46);
    ctx.fillText(f.txt, f.x, f.y - f.t * 46);
    ctx.globalAlpha = 1;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (shakeT > 0) shakeT -= 0.016;

  updateHUD();
}

const SPRITE_H = 64;
function drawPlayer(p) {
  const img = sprites[p.t];
  const active = p.i === S.act && S.phase !== 'over';
  ctx.save();
  if (!p.a) {
    // death anim: fade + fall over
    const dt = deathFx[p.i] ? (performance.now() - deathFx[p.i]) / 1000 : 5;
    if (dt < 1.2) {
      ctx.globalAlpha = 1 - dt / 1.2;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.facing * dt * 1.5);
      drawSprite(img, 0, 0, p.facing, 1 - dt * 0.3);
    }
    ctx.restore(); return;
  }
  // active marker
  if (active && S.phase === 'aim') {
    ctx.fillStyle = 'rgba(255,214,102,.9)';
    const bob = Math.sin(performance.now() / 200) * 4;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - SPRITE_H - 14 + bob);
    ctx.lineTo(p.x - 7, p.y - SPRITE_H - 26 + bob);
    ctx.lineTo(p.x + 7, p.y - SPRITE_H - 26 + bob);
    ctx.closePath(); ctx.fill();
  }
  // hurt flash
  const fl = flashes[p.i];
  const flash = fl && performance.now() - fl < 300;
  // walking bob
  const moving = active && S.phase === 'aim';
  const bob = moving ? Math.abs(Math.sin(performance.now() / 120)) * 3 : 0;

  ctx.translate(p.x, p.y - bob);
  if (flash) { ctx.globalAlpha = 0.5 + Math.sin(performance.now() / 40) * 0.4; }
  drawSprite(img, 0, 0, p.facing, 1);
  ctx.globalAlpha = 1;
  ctx.restore();

  // health bar above head
  const bw = 44, bh = 6, bx = p.x - bw / 2, by = p.y - SPRITE_H - 10;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
  ctx.fillStyle = p.t === 0 ? '#4dd2ff' : '#ff8a65';
  ctx.fillRect(bx, by, bw * p.hp / 100, bh);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(p.hp, p.x, by - 4);
}

function drawSprite(img, x, y, facing, scale) {
  if (!img.complete || !img.naturalWidth) {
    ctx.fillStyle = '#ccc'; ctx.fillRect(x - 14 * scale, y - SPRITE_H * scale, 28 * scale, SPRITE_H * scale);
    return;
  }
  const h = SPRITE_H * scale, w = h * img.naturalWidth / img.naturalHeight;
  ctx.save();
  ctx.translate(x, y);
  if (facing < 0) ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, -h, w, h);
  ctx.restore();
}

window.__cam = cam;   // E2E hook: camera is render-only state
// periodic ping keeps proxies from dropping idle sockets
window.__terrHash = () => { if (!terrain) return null; let h = 0; for (let i = 0; i < terrain.length; i += 7) h = (h * 31 + Math.round(terrain[i])) | 0; return h; };
setInterval(() => send({ t: 'ping' }), 25000);
updateAimUI();
refreshWeapons();
window.__dbg = { get sfx() { return sfx; }, get actx() { return actx; }, get floaters() { return floaters; },
  get trail() { return trail; }, get muted() { return muted; } };   // E2E hook
connect();
requestAnimationFrame(draw);
})();
