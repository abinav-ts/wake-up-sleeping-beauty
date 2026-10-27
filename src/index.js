import {
  GOAL_STEPS, GRACE_MS, SNOOZE_MS, MAX_RING_MS,
  cryptoRng, planFire, ringMinutes,
} from './logic.js';
import { generateVapid, sendPush } from './push.js';

// Identity: every browser generates a random 128-bit id (32 hex chars) and sends it as `X-Device-Id`
// (or `?u=` for the Shortcut webhook). There is no login; the unguessable id is the key to that
// person's alarms. The limits below keep an open, signup-free service from being abused.
const MAX_USERS = 2000;
const MAX_NEW_USERS_PER_IP_HOUR = 20;
const MAX_OPEN_ALARMS = 25;
const MAX_SUBS_PER_USER = 5;
const MAX_ALARM_HORIZON_MS = 366 * 24 * 3600e3;
const INACTIVE_USER_MS = 90 * 24 * 3600e3;
const UID_RE = /^[0-9a-f]{32}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// ---------- storage ----------

const schemaReady = new WeakSet();
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS alarms (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL DEFAULT '',
      intended_ms INTEGER NOT NULL,
      fire_ms INTEGER NOT NULL,
      shifted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      ring_started_ms INTEGER,
      snooze_until_ms INTEGER,
      stopped_ms INTEGER,
      x_min REAL,
      created_ms INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS chaos_v2 (
      uid TEXT PRIMARY KEY,
      start_ms INTEGER NOT NULL,
      x_min REAL NOT NULL,
      goal_met INTEGER NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      steps_at_ms INTEGER
    )`),
    db.prepare("CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, uid TEXT NOT NULL DEFAULT '', json TEXT NOT NULL, created_ms INTEGER NOT NULL)"),
    db.prepare('CREATE TABLE IF NOT EXISTS signups (ip TEXT NOT NULL, ts INTEGER NOT NULL)'),
  ]);
  // v1 (single user, token auth) -> v2 (per-device ids): add the uid column to the old tables.
  // Legacy rows keep uid '' until their owner claims them (see /api/claim).
  if ((await getMeta(db, 'schema')) !== '2') {
    for (const t of ['alarms', 'subs']) {
      try {
        await db.prepare(`ALTER TABLE ${t} ADD COLUMN uid TEXT NOT NULL DEFAULT ''`).run();
      } catch { /* column already present (fresh install) */ }
    }
    await db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '2')").run();
  }
  await db.batch([
    db.prepare('CREATE INDEX IF NOT EXISTS alarms_uid ON alarms (uid, status)'),
    db.prepare('CREATE INDEX IF NOT EXISTS alarms_due ON alarms (status, fire_ms)'),
    db.prepare('CREATE INDEX IF NOT EXISTS subs_uid ON subs (uid)'),
    db.prepare('CREATE INDEX IF NOT EXISTS signups_ip ON signups (ip, ts)'),
  ]);
  schemaReady.add(db);
}

async function getMeta(db, k) {
  const r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}

async function getVapid(db) {
  let v = await getMeta(db, 'vapid');
  if (!v) {
    const fresh = JSON.stringify(await generateVapid());
    await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('vapid', fresh).run();
    v = await getMeta(db, 'vapid');
  }
  return JSON.parse(v);
}

const getChaos = (db, uid) => db.prepare('SELECT * FROM chaos_v2 WHERE uid = ?').bind(uid).first();

// ---------- identity ----------

function getUid(req, url) {
  const raw = (req.headers.get('x-device-id') || url.searchParams.get('u') || '').toLowerCase();
  return UID_RE.test(raw) ? raw : null;
}

async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Register the id on first sight (rate-limited per IP and capped overall); touch last_seen after.
async function ensureUser(db, req, uid, now) {
  const touched = await db.prepare('UPDATE users SET last_seen_ms = ? WHERE uid = ?').bind(now, uid).run();
  if (touched.meta.changes) return true;

  const ip = (await sha256Hex(req.headers.get('cf-connecting-ip') || 'unknown')).slice(0, 16);
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND ts > ?').bind(ip, now - 3600e3).first();
  if (recent.n >= MAX_NEW_USERS_PER_IP_HOUR) return false;
  const total = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (total.n >= MAX_USERS) return false;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO users (uid, created_ms, last_seen_ms) VALUES (?, ?, ?)').bind(uid, now, now),
    db.prepare('INSERT INTO signups (ip, ts) VALUES (?, ?)').bind(ip, now),
  ]);
  return true;
}

// Hourly: forget users who have not been seen for 90 days, and old signup-rate rows.
async function housekeeping(db, now) {
  const cutoff = now - INACTIVE_USER_MS;
  const stale = '(SELECT uid FROM users WHERE last_seen_ms < ?)';
  await db.batch([
    db.prepare(`DELETE FROM alarms WHERE uid IN ${stale}`).bind(cutoff),
    db.prepare(`DELETE FROM subs WHERE uid IN ${stale}`).bind(cutoff),
    db.prepare(`DELETE FROM chaos_v2 WHERE uid IN ${stale}`).bind(cutoff),
    db.prepare('DELETE FROM users WHERE last_seen_ms < ?').bind(cutoff),
    db.prepare('DELETE FROM signups WHERE ts < ?').bind(now - 24 * 3600e3),
  ]);
}

// One-time adoption of data created under the old single-user token. The owner's browser still
// holds the old token in localStorage and presents it once; the data is re-keyed to its new id.
async function constantTimeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function claimLegacy(db, uid) {
  const results = await db.batch([
    db.prepare("UPDATE alarms SET uid = ? WHERE uid = ''").bind(uid),
    db.prepare("UPDATE subs SET uid = ? WHERE uid = ''").bind(uid),
  ]);
  let chaosMoved = false;
  try {
    const old = await db.prepare('SELECT * FROM chaos WHERE id = 1').first();
    if (old) {
      await db
        .prepare('INSERT OR REPLACE INTO chaos_v2 (uid, start_ms, x_min, goal_met, steps, steps_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(uid, old.start_ms, old.x_min, old.goal_met, old.steps, old.steps_at_ms)
        .run();
      await db.prepare('DELETE FROM chaos WHERE id = 1').run();
      chaosMoved = true;
    }
  } catch { /* no legacy chaos table: fresh install */ }
  return { alarms: results[0].meta.changes, subs: results[1].meta.changes, chaos: chaosMoved };
}

// ---------- game logic against the DB ----------

// Re-roll the hidden fire time of every pending alarm of this user against their chaos state.
async function reassign(db, uid, chaos, now) {
  const { results } = await db
    .prepare("SELECT id, intended_ms FROM alarms WHERE uid = ? AND status = 'scheduled'")
    .bind(uid)
    .all();
  if (!results.length) return;
  await db.batch(
    results.map((r) => {
      const p = planFire(r.intended_ms, chaos, now, cryptoRng);
      return db
        .prepare("UPDATE alarms SET fire_ms = ?, shifted = ? WHERE id = ? AND status = 'scheduled'")
        .bind(p.fire_ms, p.shifted, r.id);
    }),
  );
}

// An alarm has been dismissed (or timed out): measure x and start a new 24h clock for its owner.
async function finishAlarm(db, alarm, stopMs) {
  const x = ringMinutes(alarm.ring_started_ms, stopMs);
  const res = await db
    .prepare("UPDATE alarms SET status = 'done', stopped_ms = ?, x_min = ? WHERE id = ? AND status IN ('ringing','snoozed')")
    .bind(stopMs, x, alarm.id)
    .run();
  if (!res.meta.changes) return;
  await db
    .prepare(
      `INSERT INTO chaos_v2 (uid, start_ms, x_min, goal_met, steps, steps_at_ms) VALUES (?, ?, ?, 0, 0, NULL)
       ON CONFLICT(uid) DO UPDATE SET start_ms = excluded.start_ms, x_min = excluded.x_min,
         goal_met = 0, steps = 0, steps_at_ms = NULL`,
    )
    .bind(alarm.uid, alarm.ring_started_ms, x)
    .run();
  await reassign(db, alarm.uid, await getChaos(db, alarm.uid), Date.now());
}

async function pushAll(env, uid, origin) {
  const db = env.DB;
  const { results } = await db.prepare('SELECT endpoint FROM subs WHERE uid = ?').bind(uid).all();
  if (!results.length) return 0;
  const vapid = await getVapid(db);
  const subject = origin || (await getMeta(db, 'origin')) || 'https://example.com';
  let ok = 0;
  await Promise.all(
    results.map(async ({ endpoint }) => {
      try {
        const status = await sendPush(endpoint, vapid, subject);
        if (status === 404 || status === 410) await db.prepare('DELETE FROM subs WHERE endpoint = ?').bind(endpoint).run();
        else if (status < 300) ok++;
        else console.error('push status', status, endpoint.slice(0, 40));
      } catch (e) {
        console.error('push failed', e);
      }
    }),
  );
  return ok;
}

const NUDGE_GAP_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ringingAlarms = (db) => db.prepare("SELECT * FROM alarms WHERE status = 'ringing' ORDER BY ring_started_ms").all();
const ringingUids = (rows) => [...new Set(rows.map((a) => a.uid))].filter(Boolean);

// Runs every minute (cron). Starts due alarms and nags with pushes until they are answered.
export async function tick(env, now = Date.now()) {
  const db = env.DB;
  await ensureSchema(db);
  if (new Date(now).getUTCMinutes() === 0) await housekeeping(db, now);

  await db
    .prepare("UPDATE alarms SET status = 'ringing', ring_started_ms = ? WHERE status = 'scheduled' AND fire_ms <= ?")
    .bind(now, now)
    .run();
  await db
    .prepare("UPDATE alarms SET status = 'ringing' WHERE status = 'snoozed' AND snooze_until_ms <= ?")
    .bind(now)
    .run();

  let { results } = await ringingAlarms(db);
  for (const a of results) {
    if (now - a.ring_started_ms >= MAX_RING_MS) await finishAlarm(db, a, a.ring_started_ms + MAX_RING_MS);
  }
  ({ results } = await ringingAlarms(db));
  const first = ringingUids(results);
  if (!first.length) return;

  const delivered = await Promise.all(first.map((uid) => pushAll(env, uid)));
  if (!delivered.some(Boolean)) return; // nobody to nudge
  await sleep(NUDGE_GAP_MS); // second nudge within the same minute, only for those still ringing
  ({ results } = await ringingAlarms(db));
  await Promise.all(ringingUids(results).map((uid) => pushAll(env, uid)));
}

// ---------- HTTP API ----------

async function handleApi(req, env, url) {
  const db = env.DB;
  const method = req.method;
  const path = url.pathname;
  await ensureSchema(db);

  const uid = getUid(req, url);
  if (!uid) return json({ error: 'missing or malformed device id' }, 401);
  const now = Date.now();
  if (!(await ensureUser(db, req, uid, now))) return json({ error: 'too many new devices right now, try again later' }, 429);
  await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('origin', url.origin).run();

  if (method === 'GET' && path === '/api/state') {
    const [alarms, chaos, subs, vapid] = await Promise.all([
      // fire_ms / shifted are deliberately never selected: the real time stays hidden.
      db
        .prepare(
          `SELECT id, intended_ms, status, x_min FROM alarms
           WHERE uid = ? AND (status != 'done' OR stopped_ms > ?) ORDER BY intended_ms`,
        )
        .bind(uid, now - 24 * 3600e3)
        .all(),
      getChaos(db, uid),
      db.prepare('SELECT COUNT(*) AS n FROM subs WHERE uid = ?').bind(uid).first(),
      getVapid(db),
    ]);
    return json({
      now,
      alarms: alarms.results,
      chaos: chaos && {
        start_ms: chaos.start_ms,
        ends_ms: chaos.start_ms + GRACE_MS,
        x_min: chaos.x_min,
        steps: chaos.steps,
        goal: GOAL_STEPS,
        goal_met: !!chaos.goal_met,
      },
      subscribed: subs.n > 0,
      vapid_public: vapid.pub,
    });
  }

  if (method === 'POST' && path === '/api/claim') {
    const body = await req.json().catch(() => ({}));
    if (!env.TOKEN || typeof body.token !== 'string' || !(await constantTimeEqual(body.token, env.TOKEN))) {
      return json({ error: 'nothing to claim' }, 404);
    }
    return json({ ok: true, ...(await claimLegacy(db, uid)) });
  }

  if (method === 'POST' && path === '/api/alarms') {
    const body = await req.json().catch(() => ({}));
    const intended = Math.floor(Number(body.intended_ms));
    if (!Number.isFinite(intended) || intended <= now) return json({ error: 'pick a time in the future' }, 400);
    if (intended > now + MAX_ALARM_HORIZON_MS) return json({ error: 'pick a time within the next year' }, 400);
    const open = await db.prepare("SELECT COUNT(*) AS n FROM alarms WHERE uid = ? AND status != 'done'").bind(uid).first();
    if (open.n >= MAX_OPEN_ALARMS) return json({ error: `at most ${MAX_OPEN_ALARMS} open alarms` }, 400);
    const plan = planFire(intended, await getChaos(db, uid), now, cryptoRng);
    const id = crypto.randomUUID();
    await db
      .prepare('INSERT INTO alarms (id, uid, intended_ms, fire_ms, shifted, status, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, uid, intended, plan.fire_ms, plan.shifted, 'scheduled', now)
      .run();
    return json({ id, intended_ms: intended, status: 'scheduled' });
  }

  const del = path.match(/^\/api\/alarms\/([\w-]+)$/);
  if (method === 'DELETE' && del) {
    await db.prepare("DELETE FROM alarms WHERE id = ? AND uid = ? AND status = 'scheduled'").bind(del[1], uid).run();
    return json({ ok: true });
  }

  const mine = async () =>
    (await db.prepare("SELECT * FROM alarms WHERE uid = ? AND status = 'ringing' ORDER BY ring_started_ms").bind(uid).all()).results;

  if (method === 'POST' && path === '/api/ring/stop') {
    const ringing = await mine();
    for (const a of ringing) await finishAlarm(db, a, now);
    return json({ stopped: ringing.length, x_min: ringing.length ? ringMinutes(ringing[0].ring_started_ms, now) : null });
  }

  if (method === 'POST' && path === '/api/ring/snooze') {
    const res = await db
      .prepare("UPDATE alarms SET status = 'snoozed', snooze_until_ms = ? WHERE uid = ? AND status = 'ringing'")
      .bind(now + SNOOZE_MS, uid)
      .run();
    return json({ snoozed: res.meta.changes, until_ms: now + SNOOZE_MS });
  }

  if (method === 'POST' && path === '/api/push/subscribe') {
    const sub = await req.json().catch(() => null);
    if (!sub || typeof sub.endpoint !== 'string') return json({ error: 'bad subscription' }, 400);
    const others = await db
      .prepare('SELECT COUNT(*) AS n FROM subs WHERE uid = ? AND endpoint != ?')
      .bind(uid, sub.endpoint)
      .first();
    if (others.n >= MAX_SUBS_PER_USER) return json({ error: 'too many registered devices' }, 400);
    await db
      .prepare('INSERT OR REPLACE INTO subs (endpoint, uid, json, created_ms) VALUES (?, ?, ?, ?)')
      .bind(sub.endpoint, uid, JSON.stringify(sub), now)
      .run();
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/api/push/test') {
    return json({ delivered: await pushAll(env, uid, url.origin) });
  }

  if (method === 'GET' && path === '/api/steps/since') {
    const chaos = await getChaos(db, uid);
    const since = chaos ? chaos.start_ms : now - GRACE_MS;
    return json({ since_ms: since, since_iso: new Date(since).toISOString(), goal: GOAL_STEPS });
  }

  if (method === 'POST' && path === '/api/steps') {
    let steps = url.searchParams.get('steps');
    if (steps === null) {
      const ct = req.headers.get('content-type') || '';
      const body = ct.includes('json') ? await req.json().catch(() => ({})) : Object.fromEntries(await req.formData().catch(() => []));
      steps = body.steps;
    }
    steps = Math.floor(Number(steps));
    if (!Number.isFinite(steps) || steps < 0) return json({ error: 'steps must be a non-negative number' }, 400);
    const chaos = await getChaos(db, uid);
    if (!chaos) return json({ ok: true, tracking: false });
    await db.prepare('UPDATE chaos_v2 SET steps = ?, steps_at_ms = ? WHERE uid = ?').bind(steps, now, uid).run();
    if (steps >= GOAL_STEPS && !chaos.goal_met) {
      await db.prepare('UPDATE chaos_v2 SET goal_met = 1 WHERE uid = ?').bind(uid).run();
      // Escape: pending alarms revert to their intended times (may be due immediately).
      await db
        .prepare("UPDATE alarms SET fire_ms = intended_ms, shifted = 0 WHERE uid = ? AND status = 'scheduled' AND shifted = 1")
        .bind(uid)
        .run();
    }
    return json({ ok: true, tracking: true, steps, goal_met: steps >= GOAL_STEPS || !!chaos.goal_met });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await handleApi(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};
