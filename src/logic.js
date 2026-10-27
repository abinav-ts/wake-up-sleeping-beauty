// Pure rules of the game. No I/O, so it is unit-testable.

export const GOAL_STEPS = 10000;
export const GRACE_MS = 24 * 3600e3;
export const SIGMA_MIN_PER_X = 15; // shift ~ Normal(0, 15 min * x), x = minutes the alarm was left ringing
export const MIN_LEAD_MS = 60e3; // a shifted alarm never lands in the past
export const SNOOZE_MS = 5 * 60e3;
export const REACTION_GRACE_MS = 3 * 60e3; // the first 3 minutes of ringing/snoozing don't count toward x
export const MAX_RING_MS = 30 * 60e3; // unanswered alarms auto-stop (x capped here)

export function cryptoRng() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 4294967296;
}

// Standard normal via Box-Muller.
export function randn(rng = cryptoRng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function drawShiftMs(xMin, rng = cryptoRng) {
  return Math.round(randn(rng) * SIGMA_MIN_PER_X * xMin * 60e3);
}

// chaos = { start_ms, x_min, goal_met } describing the last alarm that rang.
// Any alarm whose intended time is at/after start + 24h is subject to the shift,
// unless the step goal was reached in the meantime.
export function isAffected(intendedMs, chaos) {
  return !!chaos && !chaos.goal_met && intendedMs >= chaos.start_ms + GRACE_MS;
}

export function planFire(intendedMs, chaos, now, rng = cryptoRng) {
  if (!isAffected(intendedMs, chaos)) return { fire_ms: intendedMs, shifted: 0 };
  const shifted = intendedMs + drawShiftMs(chaos.x_min, rng);
  return { fire_ms: Math.max(shifted, now + MIN_LEAD_MS), shifted: 1 };
}

// x = minutes rung beyond the reaction-time grace (stop time capped at MAX_RING_MS).
export function ringMinutes(ringStartedMs, stopMs) {
  const capped = Math.min(stopMs, ringStartedMs + MAX_RING_MS);
  return Math.max(0, (capped - ringStartedMs - REACTION_GRACE_MS) / 60e3);
}
