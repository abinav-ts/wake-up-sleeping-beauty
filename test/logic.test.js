import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRACE_MS, MIN_LEAD_MS, MAX_RING_MS, REACTION_GRACE_MS, drawShiftMs, isAffected, planFire, ringMinutes,
} from '../src/logic.js';
import { generateVapid, vapidJwt } from '../src/push.js';

const H = 3600e3, M = 60e3;
const chaos = { start_ms: 1_000_000_000_000, x_min: 10, goal_met: 0 };

test('alarms before start+24h are not affected; at/after are', () => {
  assert.equal(isAffected(chaos.start_ms + GRACE_MS - 1, chaos), false);
  assert.equal(isAffected(chaos.start_ms + GRACE_MS, chaos), true);
  assert.equal(isAffected(chaos.start_ms + 5 * GRACE_MS, chaos), true);
});

test('no chaos yet, or goal met, means no shift', () => {
  const t = chaos.start_ms + 30 * H;
  assert.deepEqual(planFire(t, null, 0), { fire_ms: t, shifted: 0 });
  assert.deepEqual(planFire(t, { ...chaos, goal_met: 1 }, 0), { fire_ms: t, shifted: 0 });
});

test('shift is zero-mean with sigma = 15 min * x and both signs occur', () => {
  const n = 20000, xs = Array.from({ length: n }, () => drawShiftMs(10) / M);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  assert.ok(Math.abs(mean) < 5, `mean ${mean}`);
  assert.ok(Math.abs(sd - 150) < 8, `sd ${sd}`);
  assert.ok(xs.some((v) => v < -300) && xs.some((v) => v > 300), 'unbounded tails');
});

test('longer ringing gives a wider spread', () => {
  const spread = (x) => Math.max(...Array.from({ length: 2000 }, () => Math.abs(drawShiftMs(x))));
  assert.ok(spread(20) > spread(1));
});

test('shifted fire time never lands in the past', () => {
  const now = chaos.start_ms + 30 * H;
  const intended = now + 1 * M;
  for (let i = 0; i < 500; i++) {
    const p = planFire(intended, chaos, now);
    assert.ok(p.fire_ms >= now + MIN_LEAD_MS);
  }
});

test('x is minutes rung beyond the 3 min reaction grace, capped', () => {
  assert.equal(ringMinutes(0, 2 * M), 0);
  assert.equal(ringMinutes(0, 3 * M), 0);
  assert.equal(ringMinutes(0, 7 * M), 4);
  assert.equal(ringMinutes(0, 10 * H), (MAX_RING_MS - REACTION_GRACE_MS) / M);
});

test('VAPID JWT verifies with the published public key', async () => {
  const v = await generateVapid();
  const jwt = await vapidJwt(v.privJwk, 'https://web.push.apple.com', 'https://example.workers.dev');
  const [h, b, s] = jwt.split('.');
  const fromB64u = (x) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const pub = await crypto.subtle.importKey('raw', fromB64u(v.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64u(s), new TextEncoder().encode(`${h}.${b}`)));
  assert.equal(fromB64u(v.pub).length, 65);
  assert.equal(JSON.parse(new TextDecoder().decode(fromB64u(b))).aud, 'https://web.push.apple.com');
});
