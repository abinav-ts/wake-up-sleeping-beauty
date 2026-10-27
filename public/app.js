'use strict';
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
let token = store.get('token');
let state = null;
let skew = 0; // server clock minus local clock

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ms) => {
  const d = new Date(ms), t = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const tmr = new Date(t.getTime() + 86400e3);
  if (sameDay(d, t)) return 'Today';
  if (sameDay(d, tmr)) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin('That token was rejected.'); throw new Error('unauthorized'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function showLogin(msg = '') {
  token = null; store.del('token');
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('ring').classList.add('hidden');
  $('loginErr').textContent = msg;
}

// ---------- rendering ----------

function render() {
  if (!state) return;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');

  const ringing = state.alarms.some((a) => a.status === 'ringing');
  $('ring').classList.toggle('hidden', !ringing);
  $('dial').classList.toggle('ringing', ringing);
  if (ringing) startBeeping(); else stopBeeping();

  const list = $('alarms');
  list.innerHTML = '';
  if (!state.alarms.length) list.innerHTML = '<p class="muted">No alarms yet.</p>';
  for (const a of state.alarms) {
    const row = document.createElement('div');
    row.className = 'alarm';
    const label = { scheduled: 'set', ringing: 'ringing', snoozed: 'snoozed', done: a.x_min != null ? `counted ${a.x_min.toFixed(1)} min` : 'done' }[a.status];
    row.innerHTML = `<div class="grow"><div class="t">${fmtTime(a.intended_ms)}</div><div class="d">${fmtDay(a.intended_ms)}</div></div>
      <span class="chip ${a.status}">${label}</span>`;
    if (a.status === 'scheduled') {
      const b = document.createElement('button');
      b.className = 'ghost small'; b.textContent = 'Delete';
      b.onclick = async () => { await api(`/api/alarms/${a.id}`, { method: 'DELETE' }); refresh(); };
      row.appendChild(b);
    }
    list.appendChild(row);
  }

  const c = state.chaos;
  if (c) {
    const pct = Math.min(100, (c.steps / c.goal) * 100);
    const left = c.ends_ms - (Date.now() + skew);
    const when = left > 0
      ? `Grace period ends ${fmtDay(c.ends_ms).toLowerCase()} at ${fmtTime(c.ends_ms)}.`
      : 'The grace period is over. Alarms from here on are fair game.';
    $('stepsBody').innerHTML = c.goal_met
      ? `<p class="ok"><b>Goal reached.</b> ${c.steps.toLocaleString()} steps. You are safe from the chaos.</p>`
      : `<div><b>${c.steps.toLocaleString()}</b> <span class="muted">/ ${c.goal.toLocaleString()} steps</span></div>
         <div class="bar"><i style="width:${pct}%"></i></div><p class="muted">${when} Last alarm counted ${c.x_min.toFixed(1)} min (after a 3 min grace).</p>`;
  }

  $('hook').textContent = `${location.origin}/api/steps?t=…`;
  updateNotifUi();
}

async function refresh() {
  if (!token) return;
  try {
    state = await api('/api/state');
    skew = state.now - Date.now();
    render();
  } catch (e) { /* login shown on 401; ignore transient network errors */ }
}

// ---------- in-page beeping while an alarm is ringing ----------

let audio, beepTimer;
function startBeeping() {
  if (beepTimer) return;
  const beep = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.4);
    } catch {}
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  };
  beep();
  beepTimer = setInterval(beep, 1000);
}
function stopBeeping() { clearInterval(beepTimer); beepTimer = null; }

// ---------- push ----------

const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function updateNotifUi() {
  const msg = $('notifMsg'), btn = $('notifBtn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    msg.textContent = isIos && !isStandalone
      ? 'On iPhone: tap Share → Add to Home Screen, then open the app from your Home Screen.'
      : 'This browser does not support push notifications.';
    btn.disabled = true;
    return;
  }
  if (state && state.subscribed && Notification.permission === 'granted') {
    msg.textContent = 'Notifications are on. The server pings you while an alarm rings.';
    btn.textContent = 'Re-register this device';
  } else {
    msg.textContent = 'Needed so the alarm can reach you when the app is closed.';
  }
}

async function enableNotifications() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { $('notifMsg').textContent = 'Permission denied. Enable notifications for this app in iOS Settings.'; return; }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(state.vapid_public) });
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
  await refresh();
}

// ---------- analog clock + chaos crown ----------

function buildDial() {
  const NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 60; i++) {
    const hr = i % 5 === 0, a = (i * 6 * Math.PI) / 180;
    const r1 = hr ? 80 : 88, r2 = 92;
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('class', hr ? 'tick hr' : 'tick');
    l.setAttribute('x1', (Math.sin(a) * r1).toFixed(2)); l.setAttribute('y1', (-Math.cos(a) * r1).toFixed(2));
    l.setAttribute('x2', (Math.sin(a) * r2).toFixed(2)); l.setAttribute('y2', (-Math.cos(a) * r2).toFixed(2));
    $('ticks').appendChild(l);
  }
}

let lastDigital = '';
function tickClock() {
  const d = new Date(Date.now() + skew);
  const s = d.getSeconds() + d.getMilliseconds() / 1000;
  const m = d.getMinutes() + s / 60;
  const h = (d.getHours() % 12) + m / 60;
  $('sHand').setAttribute('transform', `rotate(${s * 6})`);
  $('mHand').setAttribute('transform', `rotate(${m * 6})`);
  $('hHand').setAttribute('transform', `rotate(${h * 30})`);
  const txt = `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · ${fmtTime(d.getTime())}`;
  if (txt !== lastDigital) { $('digital').textContent = txt; lastDigital = txt; }
  requestAnimationFrame(tickClock);
}

// The Lorenz attractor (the "chaos butterfly"), integrated with RK4 and projected onto the x-z plane.
function buildChaos() {
  const sigma = 10, rho = 28, beta = 8 / 3, dt = 0.005;
  const f = ([x, y, z]) => [sigma * (y - x), x * (rho - z) - y, x * y - beta * z];
  const add = (a, b, k) => a.map((v, i) => v + b[i] * k);
  let p = [0.1, 0, 0];
  const pts = [];
  for (let i = 0; i < 13000; i++) {
    const k1 = f(p), k2 = f(add(p, k1, dt / 2)), k3 = f(add(p, k2, dt / 2)), k4 = f(add(p, k3, dt));
    p = p.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    if (i > 1000 && i % 2 === 0) pts.push([60 + p[0] * 2.5, 86 - p[2] * 1.75]);
  }
  $('chaos').firstElementChild.setAttribute('d', 'M' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L'));
}

// ---------- wiring ----------

function defaultWhen() {
  const d = new Date(Date.now() + 86400e3);
  d.setHours(7, 0, 0, 0);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

$('tokenBtn').onclick = () => {
  token = $('tokenInput').value.trim();
  if (!token) return;
  store.set('token', token);
  refresh();
};
$('addBtn').onclick = async () => {
  $('addErr').textContent = '';
  const v = $('when').value;
  if (!v) { $('addErr').textContent = 'Pick a date and time.'; return; }
  try {
    await api('/api/alarms', { method: 'POST', body: JSON.stringify({ intended_ms: new Date(v).getTime() }) });
    refresh();
  } catch (e) { $('addErr').textContent = e.message; }
};
$('stopBtn').onclick = async () => { await api('/api/ring/stop', { method: 'POST' }); stopBeeping(); refresh(); };
$('snoozeBtn').onclick = async () => { await api('/api/ring/snooze', { method: 'POST' }); stopBeeping(); refresh(); };
$('notifBtn').onclick = () => enableNotifications().catch((e) => { $('notifMsg').textContent = `Could not enable: ${e.message}`; });
$('testBtn').onclick = async () => {
  try {
    const r = await api('/api/push/test', { method: 'POST' });
    $('notifMsg').textContent = r.delivered ? `Sent to ${r.delivered} device(s).` : 'No subscribed device accepted the push.';
  } catch (e) { $('notifMsg').textContent = e.message; }
};
$('hook').onclick = () => {
  if (token && navigator.clipboard) navigator.clipboard.writeText(`${location.origin}/api/steps?t=${token}`).then(() => { $('hook').textContent = 'Copied (with your token).'; });
};

$('when').value = defaultWhen();
buildDial();
buildChaos();
requestAnimationFrame(tickClock);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 5000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

if (token) refresh(); else showLogin();
