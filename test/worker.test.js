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
  return { prepare: (q) => stmt(q), batch: async (ss) => { for (const s of ss) await s.run(); return []; }, _sql: sql };
}

const TOKEN = 't0k';
const H = 3600e3, M = 60e3;
const call = (env, method, path, body) =>
  worker.fetch(new Request(`https://x.test${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
const row = (env, id) => env.DB._sql.prepare('SELECT * FROM alarms WHERE id = ?').get(id);

test('full lifecycle: ring, x measured, chaos shifts later alarms, steps escape', async (t) => {
  const env = { DB: makeDb(), TOKEN, ASSETS: {} };
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  assert.equal((await worker.fetch(new Request('https://x.test/api/state'), env)).status, 401);

  const a1 = (await call(env, 'POST', '/api/alarms', { intended_ms: now + 10 * M })).id;
  assert.equal((await call(env, 'POST', '/api/alarms', { intended_ms: now - 1000 })).status, 400);
  // an alarm set for ~24h later, created BEFORE the first one has rung (shift must be lazily rolled)
  const a2 = (await call(env, 'POST', '/api/alarms', { intended_ms: now + 10 * M + 24 * H + 5 * M })).id;
  assert.equal(row(env, a1).shifted, 0);
  assert.equal(row(env, a2).shifted, 0);

  // alarm 1 rings (cron tick right at fire time); nobody subscribed so no pushes / no sleeping
  now += 10 * M;
  await tick(env, now);
  assert.equal(row(env, a1).status, 'ringing');

  // user snoozes at +3m, it rings again at +8m, user stops at +12m  => x = 12 - 3 grace = 9
  now += 3 * M;
  await call(env, 'POST', '/api/ring/snooze');
  assert.equal(row(env, a1).status, 'snoozed');
  now += 5 * M;
  await tick(env, now);
  assert.equal(row(env, a1).status, 'ringing');
  now += 4 * M;
  const stop = await call(env, 'POST', '/api/ring/stop');
  assert.equal(stop.x_min, 9);
  assert.equal(row(env, a1).status, 'done');

  // a2 intended exactly 24h + 5m after the ring start => affected, hidden shift rolled now
  assert.equal(row(env, a2).shifted, 1);

  // the API never leaks the real fire time
  const st = await call(env, 'GET', '/api/state');
  const leaked = JSON.stringify(st);
  assert.ok(!leaked.includes('fire_ms') && !leaked.includes('shifted'));
  assert.equal(st.chaos.goal_met, false);

  // an alarm intended BEFORE start+24h is untouched
  const early = (await call(env, 'POST', '/api/alarms', { intended_ms: now + 20 * H })).id;
  assert.equal(row(env, early).shifted, 0);
  assert.equal(row(env, early).fire_ms, row(env, early).intended_ms);

  // new alarms after the threshold are shifted at creation
  const late = (await call(env, 'POST', '/api/alarms', { intended_ms: now + 30 * H })).id;
  assert.equal(row(env, late).shifted, 1);

  // steps: partial progress does nothing, reaching the goal reverts shifts
  assert.equal((await call(env, 'POST', '/api/steps', { steps: 4000 })).goal_met, false);
  assert.equal(row(env, late).shifted, 1);
  const done = await call(env, 'POST', '/api/steps?steps=10500');
  assert.equal(done.goal_met, true);
  for (const id of [a2, late]) {
    const r = row(env, id);
    assert.equal(r.shifted, 0);
    assert.equal(r.fire_ms, r.intended_ms);
  }
  // later alarms are no longer shifted either
  const after = (await call(env, 'POST', '/api/alarms', { intended_ms: now + 40 * H })).id;
  assert.equal(row(env, after).shifted, 0);

  // since-endpoint reports the chaos start
  const since = await call(env, 'GET', '/api/steps/since');
  assert.equal(since.since_ms, st.chaos.start_ms);
});

test('unanswered alarm auto-stops after 30 minutes with x capped', async (t) => {
  const env = { DB: makeDb(), TOKEN, ASSETS: {} };
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });

  const id = (await call(env, 'POST', '/api/alarms', { intended_ms: now + M })).id;
  now += M; await tick(env, now);
  assert.equal(row(env, id).status, 'ringing');
  now += 31 * M; await tick(env, now);
  const r = row(env, id);
  assert.equal(r.status, 'done');
  assert.equal(r.x_min, 27);
});

test('steps are ignored until an alarm has rung', async () => {
  const env = { DB: makeDb(), TOKEN, ASSETS: {} };
  const r = await call(env, 'POST', '/api/steps', { steps: 20000 });
  assert.equal(r.tracking, false);
});
