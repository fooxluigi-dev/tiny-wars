// Tiny Wars client: renders server snapshots, sends intents. Never simulates.
'use strict';
(() => {
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const $ = id => document.getElementById(id);
const W = 1600, H = 900;

// ---------- state ----------
let ws = null, myTeam = -1, roomCode = null, started = false, connected = false;
let S = null;              // latest server snapshot
let prev = null, lerpT = 0; // interpolation between snapshots
let terrain = null;         // Float64Array(W) — server is authority, we mirror it
let pendingCraters = [];
let booms = [];             // visual explosion effects
let particles = [];
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
      $('menu').style.display = 'none';
      $('winScreen').style.display = 'none';
      $('hud').style.display = 'flex';
      $('controls').style.display = 'flex';
      if (!m.resume) showMsg('⚔️ Battle starts!');
      break;
    }
    case 'state': {
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
    case 'boom':
      booms.push({ x: ev.x, y: ev.y, r: ev.r, t: 0 });
      shakeT = 0.35; shakeMag = Math.min(14, ev.r / 6);
      spawnParticles(ev.x, ev.y, ev.r);
      break;
    case 'hit':
      if (S) { const p = S.players[ev.p]; if (p) flashPlayer(ev.p); }
      break;
    case 'death':
      deathFx[ev.p] = performance.now();
      showMsg(ev.reason === 'drown' ? '🌊 Drowned!' : ev.reason === 'fell' ? '💀 Fell off!' : '☠️ Down!');
      break;
    case 'turn':
      showMsg(ev.team === myTeam ? '🎯 Your turn' : "⏳ Opponent's turn");
      break;
    case 'over':
      showWin(ev.winner);
      break;
  }
}

const flashes = {};
function flashPlayer(i) { flashes[i] = performance.now(); }

function spawnParticles(x, y, r) {
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2, v = 60 + Math.random() * r * 3;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80, t: 0, life: 0.5 + Math.random() * 0.5,
      c: Math.random() < 0.5 ? '#ffb347' : '#ff5252' });
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
  for (const id of ['leftBtn', 'rightBtn', 'jumpBtn', 'fireBtn', 'endBtn'])
    $(id).classList.toggle('disabled', !canAct);
  $('powerWrap').style.display = canAct ? '' : 'none';
  $('aimHint').style.display = canAct ? '' : 'none';
}

// ---------- controls ----------
function myActiveIdx() {
  return S ? S.act : -1;
}
function sendAim() { send({ t: 'aim', angle: aim.angle, power: aim.power }); }
function sendInput(move, jump) { send({ t: 'input', move, jump: !!jump }); }

function holdBtn(id, onDown, onUp) {
  const el = $(id);
  const down = e => { e.preventDefault(); el.classList.add('on'); onDown(); };
  const up = e => { e.preventDefault(); el.classList.remove('on'); if (onUp) onUp(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}
holdBtn('leftBtn', () => sendInput(-1, false), () => sendInput(0, false));
holdBtn('rightBtn', () => sendInput(1, false), () => sendInput(0, false));
holdBtn('jumpBtn', () => sendInput(0, true));
holdBtn('angUp', () => aimUp(4), null);
holdBtn('angDn', () => aimUp(-4), null);
function aimUp(d) {
  aim.angle = Math.max(0, Math.min(90, aim.angle + d));
  sendAim(); updateAimUI();
}
$('power').addEventListener('input', e => { aim.power = +e.target.value; $('powerVal').textContent = aim.power; sendAim(); });
function updateAimUI() {
  $('aimHint').textContent = `Angle ${Math.round(aim.angle)}° · Power ${aim.power}`;
}

$('fireBtn').onclick = () => { send({ t: 'fire', weapon }); sendAim(); };
$('endBtn').onclick = () => send({ t: 'endturn' });

// weapon row
const wrow = $('weaponRow');
for (const [id, ico, label] of WEAPON_LIST) {
  const b = document.createElement('button');
  b.className = 'wbtn' + (id === weapon ? ' sel' : '');
  b.innerHTML = `<span class="ico">${ico}</span>${label}`;
  b.onclick = () => {
    weapon = id;
    for (const c of wrow.children) c.classList.remove('sel');
    b.classList.add('sel');
  };
  wrow.appendChild(b);
}

// keyboard (desktop)
const keys = {};
addEventListener('keydown', e => {
  if (e.repeat) return;
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'ArrowUp') { aimUp(4); e.preventDefault(); }
  if (e.key === 'ArrowDown') { aimUp(-4); e.preventDefault(); }
  if (e.key === ' ') { $('fireBtn').click(); e.preventDefault(); }
  if (e.key.toLowerCase() === 'e') send({ t: 'endturn' });
  if ('12345'.includes(e.key)) { const w = WEAPON_LIST[+e.key - 1]; if (w) wrow.children[+e.key - 1].click(); }
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
  if (e.key.toLowerCase() === 'q') { aim.power = Math.max(5, aim.power - 5); $('power').value = aim.power; $('powerVal').textContent = aim.power; sendAim(); }
  if (e.key.toLowerCase() === 'r') { aim.power = Math.min(100, aim.power + 5); $('power').value = aim.power; $('powerVal').textContent = aim.power; sendAim(); }
});
// tap on canvas to aim toward that point (mobile-friendly)
cv.addEventListener('pointerdown', e => {
  if (!S || S.phase !== 'aim' || S.team !== myTeam) return;
  const p = S.players[S.act];
  if (!p) return;
  const rect = cv.getBoundingClientRect();
  const wx = (e.clientX - rect.left) / rect.width * W;
  const wy = (e.clientY - rect.top) / rect.height * H;
  const dx = (wx - p.x) * p.facing, dy = (p.y - 16) - wy;
  if (dx <= 0) return;
  aim.angle = Math.max(0, Math.min(90, Math.atan2(dy, dx) * 180 / Math.PI));
  sendAim(); updateAimUI();
});

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
  const cw = cv.width, ch = cv.height;
  const scale = Math.min(cw / W, ch / H);
  let ox = (cw - W * scale) / 2, oy = (ch - H * scale) / 2;
  if (shakeT > 0) { ox += (Math.random() - .5) * shakeMag * scale; oy += (Math.random() - .5) * shakeMag * scale; }
  return { scale, ox, oy };
}

function draw() {
  requestAnimationFrame(draw);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // sky
  const g = ctx.createLinearGradient(0, 0, 0, cv.height);
  g.addColorStop(0, '#0d1430'); g.addColorStop(0.6, '#1a2a55'); g.addColorStop(1, '#2b4a7a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
  // stars
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  for (let i = 0; i < 40; i++) { const x = (i * 173.3 % 1) * cv.width, y = (i * 97.7 % 1) * cv.height * .5; ctx.fillRect(x, y, 1.5, 1.5); }

  if (!S || !terrain) return;
  const { scale, ox, oy } = worldToScreen();
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // terrain
  ctx.beginPath();
  ctx.moveTo(0, H + 200);
  for (let x = 0; x < W; x += 2) ctx.lineTo(x, terrain[x]);
  ctx.lineTo(W, H + 200);
  ctx.closePath();
  const tg = ctx.createLinearGradient(0, 0, 0, H);
  tg.addColorStop(0, '#3e7d4f'); tg.addColorStop(0.06, '#2f6340'); tg.addColorStop(0.15, '#6b4a2f'); tg.addColorStop(1, '#3a2a1c');
  ctx.fillStyle = tg; ctx.fill();
  ctx.strokeStyle = '#57a86a'; ctx.lineWidth = 3; ctx.stroke();

  // water
  const wy = S.water;
  const wg = ctx.createLinearGradient(0, wy, 0, H);
  wg.addColorStop(0, 'rgba(40,120,220,.75)'); wg.addColorStop(1, 'rgba(10,30,80,.9)');
  ctx.fillStyle = wg;
  const t = performance.now() / 1000;
  ctx.beginPath(); ctx.moveTo(0, H + 200);
  for (let x = 0; x <= W; x += 8) ctx.lineTo(x, wy + Math.sin(x / 60 + t * 2) * 3);
  ctx.lineTo(W, H + 200); ctx.closePath(); ctx.fill();

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
      if (isMine) {
        $('aimHint').textContent = `${Math.round(aim.angle)}° · PWR ${aim.power}`;
      }
    }
  }

  // players
  for (const p of S.players) drawPlayer(p);

  // projectiles
  for (const pr of S.proj) {
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

// periodic ping keeps proxies from dropping idle sockets
window.__terrHash = () => { if (!terrain) return null; let h = 0; for (let i = 0; i < terrain.length; i += 7) h = (h * 31 + Math.round(terrain[i])) | 0; return h; };
setInterval(() => send({ t: 'ping' }), 25000);
updateAimUI();
connect();
requestAnimationFrame(draw);
})();
