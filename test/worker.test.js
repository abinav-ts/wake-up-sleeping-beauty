// Drives the real Worker (fetch + tick) against an in-memory SQLite shim that mimics D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { tick } from '../src/index.js';

function makeDb() {
  const sql = new DatabaseSync(':memory:');
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    first: async () => sql.prepare(q).get(...args) ?? null,
  });
  return {
    prepare: (q) => stmt(q),
    batch: async (ss) => { const out = []; for (const s of ss) out.push(await s.run()); return out; },
    _sql: sql,
  };
}

const TOKEN = 'legacy-token';
const U1 = 'a'.repeat(32);
const U2 = 'b'.repeat(32);
const H = 3600e3, M = 60e3;
const newEnv = () => ({ DB: makeDb(), TOKEN, ASSETS: {} });

const call = (env, method, path, body, uid = U1, headers = {}) =>
  worker.fetch(new Request(`https://x.test${path}`, {
    method,
    headers: { 'x-device-id': uid, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env).then((r) => r.json().then((j) => ({ ...j, status: r.status })));
const row = (env, id) => env.DB._sql.prepare('SELECT * FROM alarms WHERE id = ?').get(id);

function clock(t) {
  const realNow = Date.now;
  let now = 1_800_000_000_000; // exactly on a UTC hour
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  return { get now() { return now; }, set now(v) { now = v; } };
}

test('identity: missing or malformed device id is rejected', async () => {
  const env = newEnv();
  const bare = await worker.fetch(new Request('https://x.test/api/state'), env);
  assert.equal(bare.status, 401);
  assert.equal((await call(env, 'GET', '/api/state', null, 'not-hex')).status, 401);
  assert.equal((await call(env, 'GET', '/api/state', null, 'a'.repeat(31))).status, 401);
  assert.equal((await call(env, 'GET', '/api/state', null, U1)).status, 200);
  // the Shortcut webhook identifies by ?u=
  const viaQuery = await worker.fetch(new Request(`https://x.test/api/steps/since?u=${U1}`), env);
  assert.equal(viaQuery.status, 200);
});

test('full lifecycle: ring, x measured, chaos shifts later alarms, steps escape', async (t) => {
  const env = newEnv();
  const c = clock(t);

  const a1 = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 10 * M })).id;
  assert.equal((await call(env, 'POST', '/api/alarms', { intended_ms: c.now - 1000 })).status, 400);
  // an alarm for ~24h later, created BEFORE the first one has rung (shift must be lazily rolled)
  const a2 = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 10 * M + 24 * H + 5 * M })).id;
  assert.equal(row(env, a1).shifted, 0);
  assert.equal(row(env, a2).shifted, 0);

  c.now += 10 * M;
  await tick(env, c.now);
  assert.equal(row(env, a1).status, 'ringing');

  // snooze at +3m, rings again at +8m, stop at +12m  => x = 12 - 3 grace = 9
  c.now += 3 * M;
  await call(env, 'POST', '/api/ring/snooze');
  assert.equal(row(env, a1).status, 'snoozed');
  c.now += 5 * M;
  await tick(env, c.now);
  assert.equal(row(env, a1).status, 'ringing');
  c.now += 4 * M;
  const stop = await call(env, 'POST', '/api/ring/stop');
  assert.equal(stop.x_min, 9);
  assert.equal(row(env, a1).status, 'done');

  assert.equal(row(env, a2).shifted, 1);

  // the API never leaks the real fire time
  const st = await call(env, 'GET', '/api/state');
  const leaked = JSON.stringify(st);
  assert.ok(!leaked.includes('fire_ms') && !leaked.includes('shifted'));
  assert.equal(st.chaos.goal_met, false);

  const early = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 20 * H })).id;
  assert.equal(row(env, early).shifted, 0);
  assert.equal(row(env, early).fire_ms, row(env, early).intended_ms);

  const late = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 30 * H })).id;
  assert.equal(row(env, late).shifted, 1);

  assert.equal((await call(env, 'POST', '/api/steps', { steps: 4000 })).goal_met, false);
  assert.equal(row(env, late).shifted, 1);
  const done = await call(env, 'POST', '/api/steps?steps=10500');
  assert.equal(done.goal_met, true);
  for (const id of [a2, late]) {
    const r = row(env, id);
    assert.equal(r.shifted, 0);
    assert.equal(r.fire_ms, r.intended_ms);
  }
  const after = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 40 * H })).id;
  assert.equal(row(env, after).shifted, 0);

  const since = await call(env, 'GET', '/api/steps/since');
  assert.equal(since.since_ms, st.chaos.start_ms);
});

test('unanswered alarm auto-stops after 30 minutes with x capped', async (t) => {
  const env = newEnv();
  const c = clock(t);
  const id = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + M })).id;
  c.now += M; await tick(env, c.now);
  assert.equal(row(env, id).status, 'ringing');
  c.now += 31 * M; await tick(env, c.now);
  const r = row(env, id);
  assert.equal(r.status, 'done');
  assert.equal(r.x_min, 27);
});

test('steps are ignored until an alarm has rung', async () => {
  const env = newEnv();
  const r = await call(env, 'POST', '/api/steps', { steps: 20000 });
  assert.equal(r.tracking, false);
});

test('users are isolated: alarms, ringing, chaos and steps never cross', async (t) => {
  const env = newEnv();
  const c = clock(t);

  const a1 = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 5 * M }, U1)).id;
  const b1 = (await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 5 * M }, U2)).id;
  assert.deepEqual((await call(env, 'GET', '/api/state', null, U1)).alarms.map((a) => a.id), [a1]);
  assert.deepEqual((await call(env, 'GET', '/api/state', null, U2)).alarms.map((a) => a.id), [b1]);

  // U2 cannot delete U1's alarm
  await call(env, 'DELETE', `/api/alarms/${a1}`, null, U2);
  assert.equal(row(env, a1).status, 'scheduled');

  c.now += 5 * M;
  await tick(env, c.now);
  assert.equal(row(env, a1).status, 'ringing');
  assert.equal(row(env, b1).status, 'ringing');

  // U2 stopping/snoozing only affects U2
  c.now += 10 * M;
  await call(env, 'POST', '/api/ring/stop', null, U2);
  assert.equal(row(env, b1).status, 'done');
  assert.equal(row(env, a1).status, 'ringing');
  const s1 = await call(env, 'GET', '/api/state', null, U1);
  assert.equal(s1.chaos, null);                         // U1 has no chaos yet
  assert.equal((await call(env, 'GET', '/api/state', null, U2)).chaos.x_min, 7); // 10 min - 3 grace

  // steps reported by U2 do not touch U1; U1 has no chaos to escape
  assert.equal((await call(env, 'POST', '/api/steps?steps=12000', null, U2)).goal_met, true);
  assert.equal((await call(env, 'POST', '/api/steps?steps=12000', null, U1)).tracking, false);

  // push subscriptions belong to their owner
  await call(env, 'POST', '/api/push/subscribe', { endpoint: 'https://push.example/1' }, U1);
  assert.equal((await call(env, 'GET', '/api/state', null, U1)).subscribed, true);
  assert.equal((await call(env, 'GET', '/api/state', null, U2)).subscribed, false);
});

test('new-device signups are rate limited per IP', async () => {
  const env = newEnv();
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  const uidN = (n) => n.toString(16).padStart(32, '0');
  for (let n = 1; n <= 20; n++) assert.equal((await call(env, 'GET', '/api/state', null, uidN(n), ip)).status, 200);
  assert.equal((await call(env, 'GET', '/api/state', null, uidN(21), ip)).status, 429);
  // existing devices are unaffected, and another IP can still sign up
  assert.equal((await call(env, 'GET', '/api/state', null, uidN(1), ip)).status, 200);
  assert.equal((await call(env, 'GET', '/api/state', null, uidN(22), { 'cf-connecting-ip': '198.51.100.7' })).status, 200);
});

test('open alarms per user are capped and the horizon is bounded', async (t) => {
  const env = newEnv();
  const c = clock(t);
  for (let i = 1; i <= 25; i++) assert.equal((await call(env, 'POST', '/api/alarms', { intended_ms: c.now + i * H })).status, 200);
  assert.equal((await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 26 * H })).status, 400);
  // another user is not affected by U1's cap, but may not schedule > 1 year out
  assert.equal((await call(env, 'POST', '/api/alarms', { intended_ms: c.now + H }, U2)).status, 200);
  assert.equal((await call(env, 'POST', '/api/alarms', { intended_ms: c.now + 400 * 24 * H }, U2)).status, 400);
});

test('legacy single-user data migrates and is claimed once with the old token', async (t) => {
  const env = newEnv();
  const c = clock(t);
  env.DB._sql.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE alarms (id TEXT PRIMARY KEY, intended_ms INTEGER NOT NULL, fire_ms INTEGER NOT NULL,
      shifted INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, ring_started_ms INTEGER, snooze_until_ms INTEGER,
      stopped_ms INTEGER, x_min REAL, created_ms INTEGER NOT NULL);
    CREATE TABLE chaos (id INTEGER PRIMARY KEY CHECK (id = 1), start_ms INTEGER NOT NULL, x_min REAL NOT NULL,
      goal_met INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, steps_at_ms INTEGER);
    CREATE TABLE subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, created_ms INTEGER NOT NULL);
    INSERT INTO alarms VALUES ('old1', ${c.now + H}, ${c.now + H}, 0, 'scheduled', NULL, NULL, NULL, NULL, ${c.now});
    INSERT INTO chaos VALUES (1, ${c.now - H}, 5, 0, 1234, NULL);
    INSERT INTO subs VALUES ('https://push.example/old', '{}', ${c.now});
  `);

  // migration is automatic; legacy rows are invisible to everyone until claimed
  assert.deepEqual((await call(env, 'GET', '/api/state', null, U1)).alarms, []);
  assert.equal(row(env, 'old1').uid, '');

  assert.equal((await call(env, 'POST', '/api/claim', { token: 'wrong' }, U2)).status, 404);
  assert.equal(row(env, 'old1').uid, '');

  const claimed = await call(env, 'POST', '/api/claim', { token: TOKEN }, U1);
  assert.equal(claimed.alarms, 1);
  assert.equal(claimed.subs, 1);
  assert.equal(claimed.chaos, true);
  assert.equal(row(env, 'old1').uid, U1);
  const st = await call(env, 'GET', '/api/state', null, U1);
  assert.equal(st.alarms.length, 1);
  assert.equal(st.chaos.steps, 1234);
  assert.equal(st.subscribed, true);

  // a second device presenting the token finds nothing left to take
  const again = await call(env, 'POST', '/api/claim', { token: TOKEN }, U2);
  assert.equal(again.alarms, 0);
  assert.equal((await call(env, 'GET', '/api/state', null, U2)).alarms.length, 0);
});

test('claim is disabled when no legacy token is configured', async () => {
  const env = { DB: makeDb(), ASSETS: {} };
  assert.equal((await call(env, 'POST', '/api/claim', { token: 'anything' })).status, 404);
});

test('hourly housekeeping forgets users inactive for 90 days', async (t) => {
  const env = newEnv();
  const c = clock(t);
  await call(env, 'POST', '/api/alarms', { intended_ms: c.now + H }, U1);
  await call(env, 'GET', '/api/state', null, U2);
  c.now += 91 * 24 * H; // on the hour; only U1 and U2 exist and both are now stale...
  await call(env, 'GET', '/api/state', null, U2); // ...except U2, who comes back
  await tick(env, c.now);
  assert.equal(env.DB._sql.prepare('SELECT COUNT(*) AS n FROM alarms WHERE uid = ?').get(U1).n, 0);
  assert.equal(env.DB._sql.prepare('SELECT COUNT(*) AS n FROM users WHERE uid = ?').get(U1).n, 0);
  assert.equal(env.DB._sql.prepare('SELECT COUNT(*) AS n FROM users WHERE uid = ?').get(U2).n, 1);
});
