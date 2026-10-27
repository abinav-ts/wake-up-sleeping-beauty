import {
  GOAL_STEPS, GRACE_MS, SNOOZE_MS, MAX_RING_MS,
  cryptoRng, planFire, ringMinutes,
} from './logic.js';
import { generateVapid, sendPush } from './push.js';

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
    db.prepare(`CREATE TABLE IF NOT EXISTS alarms (
      id TEXT PRIMARY KEY,
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
    db.prepare(`CREATE TABLE IF NOT EXISTS chaos (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      start_ms INTEGER NOT NULL,
      x_min REAL NOT NULL,
      goal_met INTEGER NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      steps_at_ms INTEGER
    )`),
    db.prepare('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, created_ms INTEGER NOT NULL)'),
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

const getChaos = (db) => db.prepare('SELECT * FROM chaos WHERE id = 1').first();

// ---------- auth ----------

async function authed(req, env, url) {
  if (!env.TOKEN) return false;
  const given =
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(env.TOKEN)]);
  let diff = 0; // constant-time compare of the two SHA-256 digests
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- game logic against the DB ----------

// Re-roll the hidden fire time of every pending alarm against the given chaos state.
async function reassign(db, chaos, now) {
  const { results } = await db.prepare("SELECT id, intended_ms FROM alarms WHERE status = 'scheduled'").all();
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

// An alarm has been dismissed (or timed out): measure x and start a new 24h clock.
async function finishAlarm(db, alarm, stopMs) {
  const x = ringMinutes(alarm.ring_started_ms, stopMs);
  const res = await db
    .prepare("UPDATE alarms SET status = 'done', stopped_ms = ?, x_min = ? WHERE id = ? AND status IN ('ringing','snoozed')")
    .bind(stopMs, x, alarm.id)
    .run();
  if (!res.meta.changes) return;
  await db
    .prepare(
      `INSERT INTO chaos (id, start_ms, x_min, goal_met, steps, steps_at_ms) VALUES (1, ?, ?, 0, 0, NULL)
       ON CONFLICT(id) DO UPDATE SET start_ms = excluded.start_ms, x_min = excluded.x_min,
         goal_met = 0, steps = 0, steps_at_ms = NULL`,
    )
    .bind(alarm.ring_started_ms, x)
    .run();
  await reassign(db, await getChaos(db), Date.now());
}

async function pushAll(env, origin) {
  const db = env.DB;
  const { results } = await db.prepare('SELECT endpoint FROM subs').all();
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

// Runs every minute (cron). Starts due alarms and nags with pushes until they are answered.
export async function tick(env, now = Date.now()) {
  const db = env.DB;
  await ensureSchema(db);

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
  if (!results.length) return;

  if (!(await pushAll(env))) return; // nobody to nudge
  await sleep(NUDGE_GAP_MS); // second nudge within the same minute
  ({ results } = await ringingAlarms(db));
  if (results.length) await pushAll(env);
}

// ---------- HTTP API ----------

async function handleApi(req, env, url) {
  const db = env.DB;
  const method = req.method;
  const path = url.pathname;
  await ensureSchema(db);
  if (!(await authed(req, env, url))) return json({ error: 'unauthorized' }, 401);
  const now = Date.now();
  await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('origin', url.origin).run();

  if (method === 'GET' && path === '/api/state') {
    const [alarms, chaos, subs, vapid] = await Promise.all([
      // fire_ms / shifted are deliberately never selected: the real time stays hidden.
      db
        .prepare(
          `SELECT id, intended_ms, status, x_min FROM alarms
           WHERE status != 'done' OR stopped_ms > ? ORDER BY intended_ms`,
        )
        .bind(now - 24 * 3600e3)
        .all(),
      getChaos(db),
      db.prepare('SELECT COUNT(*) AS n FROM subs').first(),
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

  if (method === 'POST' && path === '/api/alarms') {
    const body = await req.json().catch(() => ({}));
    const intended = Math.floor(Number(body.intended_ms));
    if (!Number.isFinite(intended) || intended <= now) return json({ error: 'pick a time in the future' }, 400);
    const plan = planFire(intended, await getChaos(db), now, cryptoRng);
    const id = crypto.randomUUID();
    await db
      .prepare('INSERT INTO alarms (id, intended_ms, fire_ms, shifted, status, created_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, intended, plan.fire_ms, plan.shifted, 'scheduled', now)
      .run();
    return json({ id, intended_ms: intended, status: 'scheduled' });
  }

  const del = path.match(/^\/api\/alarms\/([\w-]+)$/);
  if (method === 'DELETE' && del) {
    await db.prepare("DELETE FROM alarms WHERE id = ? AND status = 'scheduled'").bind(del[1]).run();
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/api/ring/stop') {
    const { results } = await ringingAlarms(db);
    for (const a of results) await finishAlarm(db, a, now);
    return json({ stopped: results.length, x_min: results.length ? ringMinutes(results[0].ring_started_ms, now) : null });
  }

  if (method === 'POST' && path === '/api/ring/snooze') {
    const res = await db
      .prepare("UPDATE alarms SET status = 'snoozed', snooze_until_ms = ? WHERE status = 'ringing'")
      .bind(now + SNOOZE_MS)
      .run();
    return json({ snoozed: res.meta.changes, until_ms: now + SNOOZE_MS });
  }

  if (method === 'POST' && path === '/api/push/subscribe') {
    const sub = await req.json().catch(() => null);
    if (!sub || typeof sub.endpoint !== 'string') return json({ error: 'bad subscription' }, 400);
    await db
      .prepare('INSERT OR REPLACE INTO subs (endpoint, json, created_ms) VALUES (?, ?, ?)')
      .bind(sub.endpoint, JSON.stringify(sub), now)
      .run();
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/api/push/test') {
    return json({ delivered: await pushAll(env, url.origin) });
  }

  if (method === 'GET' && path === '/api/steps/since') {
    const chaos = await getChaos(db);
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
    const chaos = await getChaos(db);
    if (!chaos) return json({ ok: true, tracking: false });
    await db.prepare('UPDATE chaos SET steps = ?, steps_at_ms = ? WHERE id = 1').bind(steps, now).run();
    if (steps >= GOAL_STEPS && !chaos.goal_met) {
      await db.prepare('UPDATE chaos SET goal_met = 1 WHERE id = 1').run();
      // Escape: pending alarms revert to their intended times (may be due immediately).
      await db.prepare("UPDATE alarms SET fire_ms = intended_ms, shifted = 0 WHERE status = 'scheduled' AND shifted = 1").run();
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
