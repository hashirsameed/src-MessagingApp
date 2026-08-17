/**
 * rateLimitEngine.js — Pure multi-tier sliding-window rate-limiting scheduler.
 *
 * DELIBERATELY PURE: no DB imports, no react-native imports, no Date.now()
 * side effects. Every function is a deterministic pure function over plain
 * sorted-number arrays and plain config objects, so the exact production
 * math is unit-testable without mocks, and two identical inputs always yield
 * identical outputs (spec §21).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 * A "tier" is (windowMs, limit): at most `limit` sends may be counted inside
 * any rolling window of `windowMs`. `history` is a sorted-ascending array of
 * send timestamps (ms epoch, wall-clock). `countInWindow(now, windowMs)`
 * counts timestamps in `[now - windowMs, now]` — INCLUSIVE lower bound, to
 * match the DB (`datetime(sent_at) >= datetime('now', ...)`). A send at time
 * `t` therefore ages out at `t + windowMs + 1` ms.
 *
 * Multiple tiers are ANDed: a send is allowed only if EVERY tier has capacity.
 * `calculateNextSafeSendTime` returns the max of every tier's safe time, plus
 * an execution-time floor and a smooth-pacing floor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONFIRMED BEHAVIOR 1 — Execution + gap (NOT start-to-start)
 *   nextSendTime = actualCompletionTime + minimumGap
 *   The 1000ms minimum is measured AFTER the previous message's execution
 *   completes, not between two send starts. See calculateNextSafeSendTime's
 *   execFloor.
 *
 * CONFIRMED BEHAVIOR 2 — 50% recovery policy
 *   When a tier saturates, do NOT resume at the first freed slot. Wait until
 *   roughly `recoveryThreshold` of the tier's capacity has returned (default
 *   0.5 → wait until ~50% free), then resume. Subordinate to the hard limits:
 *   the returned safe time is NEVER earlier than the hard limit allows.
 *
 * CONFIRMED BEHAVIOR 3 — Hard invariant
 *   No tier may ever exceed its configured limit. The 50% rule only ever
 *   delays beyond what the hard limits require; it never relaxes them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// DEPRECATED — was the exponent for the old exponential pressure-curve
// pacing formula. computePacingGapMs no longer uses this (replaced with
// Dynamic Equal-Spacing / Fair-Share pacing, see below). Kept exported only
// so any other file still importing it doesn't break; safe to delete once
// nothing references it.
export const THROTTLE_CURVE_POWER = 4;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ─────────────────────────────────────────────────────────────────────────────
// Binary-search helpers (history is sorted ascending)
// ─────────────────────────────────────────────────────────────────────────────
const lowerBound = (arr, target) => {
  // first index i with arr[i] >= target
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const upperBound = (arr, target) => {
  // first index i with arr[i] > target
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// ─────────────────────────────────────────────────────────────────────────────
// History helpers (over a plain sorted array of ms timestamps)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop entries older than `now - maxWindowMs`. Used once at hydration so a
 * lane only keeps the sends that any configured tier could still count.
 * @returns a NEW array (input is not mutated).
 */
export const pruneHistory = (history, now, maxWindowMs) => {
  if (!Array.isArray(history) || history.length === 0) return [];
  const cutoff = now - maxWindowMs;
  return history.slice(lowerBound(history, cutoff));
};

/**
 * Count sends inside [now - windowMs, now] (inclusive lower bound — matches
 * the DB's `>=`).
 */
export const countInWindow = (history, now, windowMs) => {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const lo = lowerBound(history, now - windowMs);
  const hi = upperBound(history, now);
  return hi - lo;
};

/**
 * k-th oldest send (0-indexed) still inside [now - windowMs, now], or null if
 * k is out of range (fewer than k+1 historical sends in the window — used by
 * the in-flight-only saturation fallback).
 */
export const kthOldestInWindow = (history, now, windowMs, k) => {
  if (!Array.isArray(history) || history.length === 0) return null;
  const lo = lowerBound(history, now - windowMs);
  const idx = lo + k;
  return idx < history.length ? history[idx] : null;
};

/**
 * Monotonic append: never insert a timestamp smaller than the current tail
 * (guards against the wall clock jumping backwards mid-run). Returns the array
 * (mutated in place — callers pass a history they own).
 */
export const appendSend = (history, ms) => {
  const last = history.length > 0 ? history[history.length - 1] : -Infinity;
  history.push(ms >= last ? ms : last);
  return history;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tier safe-time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Earliest time at which a single tier permits another send.
 *
 * - has capacity  → safe at `now`.
 * - saturated     → wait until the window count drops to `targetRemaining`
 *   (= min(limit-1, floor(limit * (1 - recoveryThreshold))), so R=0.5 waits
 *   until ~50% of the tier is empty). That happens when the `k`-th-oldest
 *   (0-indexed) send ages out at `t[k] + windowMs + 1` (the +1 is the
 *   inclusive-boundary epsilon — at exactly `t[k] + windowMs` the send is
 *   still counted).
 *
 * @param {object} opts
 * @param {number[]} opts.history  sorted ascending send-start ms timestamps
 * @param {number} opts.now        current time ms
 * @param {number} opts.windowMs   tier window
 * @param {number} opts.limit      tier cap
 * @param {number} [opts.inFlight=0]  sends reserved but not yet recorded
 * @param {number} [opts.recoveryThreshold=0.5]  fraction of capacity that must
 *   return before a saturated tier resumes (0 = first freed slot)
 * @returns {{ safeTimeMs:number, kind:'has_capacity'|'saturated_recovery',
 *            count:number, remainingCapacity:number,
 *            targetRemaining:number|null, kth:number|null }}
 */
export const calculateTierSafeTime = ({
  history,
  now,
  windowMs,
  limit,
  inFlight = 0,
  recoveryThreshold = 0.5,
}) => {
  const count = countInWindow(history, now, windowMs) + inFlight;

  if (count < limit) {
    return {
      safeTimeMs: now,
      kind: 'has_capacity',
      count,
      remainingCapacity: limit - count,
      targetRemaining: null,
      kth: null,
    };
  }

  // Saturated (count >= limit; >= is defensive against external writes).
  const R = clamp01(recoveryThreshold);
  // min() — NOT max() — is the correct recovery target (F1): R=0 → limit-1
  // (resume at 1 slot free), R=0.5 → ~half, R=1 → full window must clear.
  const targetRemaining = Math.min(limit - 1, Math.max(0, Math.floor(limit * (1 - R))));
  const k = count - targetRemaining - 1; // k-th oldest that must age out (always in range: k >= 0, k <= count-1)
  let kth = kthOldestInWindow(history, now, windowMs, k);
  if (kth === null) {
    // F6 — saturated purely (or mostly) by in-flight reservations with too
    // little history to index. Those reservations started ~now, so they age
    // out ~a full window from now. Conservative and correct.
    kth = now;
  }

  return {
    safeTimeMs: kth + windowMs + 1, // +1ms inclusive-boundary epsilon (F2)
    kind: 'saturated_recovery',
    count,
    remainingCapacity: 0,
    targetRemaining,
    kth,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Smooth pacing (strategy layer — never overrides the hard constraints)
//
// DYNAMIC EQUAL-SPACING / FAIR-SHARE PACING (replaces the old exponential
// pressure-curve). Applied against ONLY the SHORTEST-window tier:
//
//   targetGap = max(minSendIntervalMs, shortestTier.windowMs / queueDepth)
//
// Why only the shortest tier, not every tier independently: dividing every
// tier's own (much larger) window by the same queueDepth and taking the max
// makes the longest tier dominate for any small-to-moderate batch (e.g. a
// 24hr/750 tier's window ÷ 8 messages ≈ 3 hours/message) — clearly wrong.
// The longer tiers don't need their own equal-spacing calculation: every
// send this formula produces is ALSO counted toward every longer tier's
// sliding-window count (they're the same underlying timestamps), so as soon
// as a longer tier's own cap is approached, ITS hard limit
// (calculateTierSafeTime, below, unchanged, still ANDed across every tier)
// naturally takes over and blocks/recovers on its own — the schedule
// cascades from the shortest tier to the next-shortest automatically,
// without this function needing to know about anything beyond the
// immediate (shortest) tier. Verified against 150/15min + 250/1hr + 750/24hr:
// a 300-message batch fills the 15min tier, hands off to the 1hr tier's hard
// limit, then resumes — with zero special-cased "overflow" logic required
// here.
//
// A tiny queue (e.g. 5 messages) is still deliberately spread across the
// full shortest-tier window rather than bursted at the floor — that's the
// point of fair-share pacing. Recalculated fresh on every call: queueDepth
// changes (new messages arrive, or some are sent) ⇒ the gap changes
// immediately, no caching, no stale interval.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic inter-send gap: spread `queueDepth` messages evenly across
 * the SHORTEST configured tier's window. Longer tiers are enforced purely
 * as hard limits elsewhere (calculateTierSafeTime) — see the design note
 * above for why they must not also compute their own equal-spacing gap.
 *
 * @param {object} opts
 * @param {Array<{windowMs:number, limit:number}>} opts.tiers
 * @param {number} opts.queueDepth      pending messages for this platform
 * @param {number} opts.minSendIntervalMs  hard floor — never faster than this
 * @returns {number} required gap (ms), based on the shortest tier's window
 */
export const computePacingGapMs = ({
  tiers,
  queueDepth,
  minSendIntervalMs,
}) => {
  const floor = Math.max(0, minSendIntervalMs);
  if (!tiers || tiers.length === 0 || !queueDepth || queueDepth <= 0) return floor;

  const shortest = tiers.reduce((a, b) => (b.windowMs < a.windowMs ? b : a));
  if (!shortest.windowMs || shortest.windowMs <= 0) return floor;

  const equalSpacingGap = shortest.windowMs / queueDepth;
  return Math.max(floor, equalSpacingGap);
};

// ─────────────────────────────────────────────────────────────────────────────
// Next safe send time (the LIVE decision)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Earliest time at which the next message for a platform may be dispatched,
 * respecting EVERY tier (AND), the execution-time floor, and the pacing floor.
 *
 * @param {object} opts
 * @param {string} [opts.platformId]   for logging only
 * @param {number} opts.now            current wall-clock time ms
 * @param {number} opts.queueDepth     pending messages for this platform
 * @param {Array<{windowMs:number, limit:number}>} opts.tiers  resolved tiers (ms)
 * @param {number[]} opts.history      sorted ascending send-start ms timestamps
 * @param {Record<number,number>} [opts.inFlightByWindow={}]  reservations per windowMs
 * @param {{lastActualCompletionMs: number|null}} [opts.executionContext]
 *   lastActualCompletionMs = ms the previous send's execution completed. The
 *   next send may only start `minSendIntervalMs` AFTER that (execution + gap).
 * @param {number} [opts.minSendIntervalMs=1000]  completion-to-start floor
 * @param {number} [opts.recoveryThreshold=0.5]   saturated-tier recovery fraction
 *
 * @returns {{ safeTimeMs:number,
 *             selectedTier:{windowMs:number, limit:number}|null,
 *             perTier:Array<{windowMs:number, limit:number, count:number,
 *                            remainingCapacity:number, safeTimeMs:number,
 *                            reason:string, oldestTimestampMs:number|null}>,
 *             executionFloor:number, reason:string }}
 */
export const calculateNextSafeSendTime = ({
  platformId = null,
  now,
  queueDepth,
  tiers = [],
  history = [],
  inFlightByWindow = {},
  executionContext = {},
  minSendIntervalMs = 1000,
  recoveryThreshold = 0.5,
}) => {
  const floor = Math.max(0, minSendIntervalMs);

  // 1. Hard tier constraints (AND) + per-tier pacing.
  const perTier = [];
  let hardTierTime = now;

  for (const tier of tiers) {
    const tSafe = calculateTierSafeTime({
      history,
      now,
      windowMs: tier.windowMs,
      limit: tier.limit,
      inFlight: inFlightByWindow[tier.windowMs] ?? 0,
      recoveryThreshold,
    });
    perTier.push({
      windowMs: tier.windowMs,
      limit: tier.limit,
      count: tSafe.count,
      remainingCapacity: tSafe.remainingCapacity,
      safeTimeMs: tSafe.safeTimeMs, // hard tier time (used by retry alarm targeting)
      reason: tSafe.kind,
      oldestTimestampMs: tSafe.kth,
    });
    if (tSafe.safeTimeMs > hardTierTime) hardTierTime = tSafe.safeTimeMs;
  }

  // 2. Execution + gap floor (CONFIRMED BEHAVIOR 1):
  //    nextSendTime = actualCompletionTime + minimumGap
  const lastCompletion = executionContext.lastActualCompletionMs ?? null;
  const executionFloor = lastCompletion === null ? -Infinity : lastCompletion + floor;

  // 3. Smooth pacing floor — spaces CONSECUTIVE send STARTS. It is anchored to
  //    the previous send's start (not to `now`), so the FIRST message of a run
  //    still goes at its earliest safe time (spec §24) while a backlog spreads
  //    smoothly. No previous send → no spacing floor yet.
  const lastStart = executionContext.lastActualStartMs ?? null;
  const pacingGap = tiers.length > 0 ? computePacingGapMs({ tiers, queueDepth, minSendIntervalMs: floor }) : floor;
  const pacingTime = lastStart === null ? now : lastStart + pacingGap;

  // 4. The constraint that binds.
  const safeTimeMs = Math.max(now, hardTierTime, executionFloor, pacingTime);

  let selectedTier = null;
  let reason = 'pacing';
  if (perTier.length > 0) {
    let maxTierSafe = -Infinity;
    let selIdx = -1;
    perTier.forEach((p, i) => {
      if (p.safeTimeMs > maxTierSafe) {
        maxTierSafe = p.safeTimeMs;
        selIdx = i;
      }
    });
    if (selIdx >= 0) {
      selectedTier = { windowMs: perTier[selIdx].windowMs, limit: perTier[selIdx].limit };
      if (safeTimeMs === perTier[selIdx].safeTimeMs) {
        reason = perTier[selIdx].reason === 'saturated_recovery' ? 'saturated_recovery' : 'tier';
      }
    }
  }
  if (executionFloor > -Infinity && safeTimeMs === executionFloor) reason = 'execution_floor';
  else if (pacingTime >= hardTierTime && safeTimeMs === pacingTime) reason = 'pacing';

  return { platformId, safeTimeMs, selectedTier, perTier, executionFloor, reason };
};

// ─────────────────────────────────────────────────────────────────────────────
// Full-queue deterministic schedule (ANALYSIS — tests / dev preview only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministically simulate the send times for `queueDepth` queued messages,
 * one after another, honoring every tier, the execution+gap floor, and the
 * pacing floor. The LIVE system must NOT call this — it advances `now`
 * internally and assumes an empty in-flight ledger; it exists so the scheduler
 * is provable (spec §16, §21, §24) and so tests can assert exact schedules.
 *
 * @param {object} opts
 * @param {Array<{windowMs:number, limit:number}>} opts.tiers
 * @param {number[]} opts.history
 * @param {number} opts.queueDepth
 * @param {number} opts.now
 * @param {number} [opts.minSendIntervalMs=1000]
 * @param {number} [opts.recoveryThreshold=0.5]
 * @param {number} [opts.execDurationMs=0]  simulated per-send execution time
 * @returns {Array<{index:number, safeTimeMs:number,
 *                  selectedTier:{windowMs:number, limit:number}|null, reason:string}>}
 */
export const calculateSchedule = ({
  tiers,
  history,
  queueDepth,
  now,
  minSendIntervalMs = 1000,
  recoveryThreshold = 0.5,
  execDurationMs = 0,
}) => {
  const simHistory = [...history];
  let ctx = { lastActualStartMs: null, lastActualCompletionMs: null };
  let t = now;
  const out = [];

  for (let i = 0; i < queueDepth; i++) {
    const dec = calculateNextSafeSendTime({
      now: t,
      queueDepth: queueDepth - i,
      tiers,
      history: simHistory,
      inFlightByWindow: {},
      executionContext: ctx,
      minSendIntervalMs,
      recoveryThreshold,
    });
    out.push({ index: i, safeTimeMs: dec.safeTimeMs, selectedTier: dec.selectedTier, reason: dec.reason });
    appendSend(simHistory, dec.safeTimeMs);
    ctx = {
      lastActualStartMs: dec.safeTimeMs,
      lastActualCompletionMs: dec.safeTimeMs + execDurationMs,
    };
    t = dec.safeTimeMs;
  }

  return out;
};