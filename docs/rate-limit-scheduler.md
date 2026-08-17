# Multi-Tier Sliding-Window Rate-Limiting Scheduler

This documents the constraint-based send scheduler that replaces the old
"hard gate + pacing curve." It is a
**multi-tier, sliding-window, dynamically scheduled, persistent, concurrency-safe**
rate limiter. The engine lives in `src/utils/rateLimitEngine.js` (pure,
deterministic, fully unit-tested); the live system gates at dispatch time in
`src/utils/queueProcessor.js`.

**Invariant (never violated): no configured tier may ever exceed its limit.**
Everything below — the 50% recovery policy, the execution+gap floor, the
smooth-pacing floor — only ever *delays* sends beyond what the hard limits
require. Nothing relaxes them.

---

## 1. Sliding-window semantics

A tier is `(windowMs, limit)`: at most `limit` sends may be counted inside any
rolling window of `windowMs`.

```
count(now) = #{ send timestamps t : now - windowMs ≤ t ≤ now }
```

- The lower bound is **inclusive**, matching the scheduler's canonical history
  interpretation.
- A send at time `t` is counted at exactly `t + windowMs` and **ages out at
  `t + windowMs + 1 ms`**. The `+1ms` is the inclusive-boundary epsilon: at
  `t + windowMs` the send is still inside the window, so scheduling a retry at
  exactly that instant would re-block and ping-pong. Tests pin this boundary
  (`rateLimitEngine.test.js`).
- This is a *true* rolling window — never a fixed "reset every 15 minutes"
  counter. Windows are evaluated against actual send timestamps at every
  decision.

## 2. Tier interaction (AND, max-safe-time)

Every tier is evaluated independently and **all must hold simultaneously**.
For each queued message the scheduler computes the earliest safe time as:

```
nextSafeTime = max(  now,
                     safeTime(tier1), safeTime(tier2), …,   # sliding windows
                     executionFloor,                         # execution + gap
                     pacingTime )                            # smooth distribution
```

The tier demanding the **latest** safe time is the binding constraint
(`selectedTier`). A 15-minute tier may be empty while a 2-hour tier is full —
the scheduler still waits for the 2-hour tier. Clearing one window never
bypasses another (proved by the `multi-tier interlock` integration test).

## 3. Execution + gap semantics (NOT start-to-start)

The 1-second minimum is **not** a start-to-start interval. The next message may
only start `minSendIntervalMs` (default 1000) **after the previous message's
execution completed**:

```
Message starts → execution → message completes → 1000ms gap → next message starts
```

Example: M1 starts 10:00:00.000, completes 10:00:00.400 → M2 starts 10:00:01.400.

```
executionFloor = lastActualCompletionMs + minSendIntervalMs
```

- The send timestamp recorded in the sliding-window history is the **actual
  dispatch start** (`recordDispatchStart`), captured only on an accepted
  outcome. The completion is captured via `recordDispatchCompletion`.
- Because the gap is measured from completion, start-to-start spacing becomes
  `executionDuration + minGap ≥ 1000ms`, so at most one message per second (for
  both starts and completions) is guaranteed automatically.

## 4. Recovery threshold (50% policy)

When a tier reaches its limit, the scheduler does **not** resume at the first
freed slot. It waits until roughly `recoveryThreshold` of that tier's capacity
has returned (default `0.5` = wait until ~50% free), then resumes normal
scheduling.

```
targetRemaining = min(limit - 1, max(0, floor(limit * (1 - recoveryThreshold))))
safeTime        = (the (count - targetRemaining - 1)-th-oldest send) + windowMs + 1
```

Example — 15-minute / 150 messages, saturated at 150/150, threshold 0.5:

```
targetRemaining = min(149, 75) = 75        # resume when 75 remain in the window
safeTime        = when the 75th-oldest send ages out
                → 75 messages have expired, 75/150 = 50% capacity available
```

- `recoveryThreshold = 0` → `targetRemaining = limit - 1` → resumes at the
  first freed slot (the old behavior).
- `recoveryThreshold = 1` → waits for the whole window to clear.
- This is a **recovery/pacing policy layered on the hard limits**. It only ever
  makes the safe time later than the hard limit would allow; it never makes it
  earlier. The retry alarm is armed for this recovery-aware time
  (`scheduleRateLimitRetryAlarm`'s `engineTierSafeTimes`), so a saturated
  platform wakes up exactly when capacity has genuinely returned instead of
  re-saturating every time one slot frees.

## 5. Smooth pacing (queue-aware distribution)

The pacing floor distributes sends smoothly instead of bursting into a wait:

```
per tier:
  usage    = count / limit
  demand   = queueDepth * minSendIntervalMs / windowMs
  pressure = clamp(max(usage, demand), 0, 1)
  gap      = clamp(minSendIntervalMs + (windowMs/limit - minSendIntervalMs) * pressure^4,
                   at minSendIntervalMs)
overall pacing gap = max over tiers
pacingTime = lastSendStart + overallPacingGap
```

- Small queue, empty tier → gap ≈ the execution+gap floor (send fast).
- Deep backlog (e.g. 1000 messages against 150/15min) → pressure → 1 → gap →
  the tier's sustained rate (window/limit), so the backlog spreads across the
  window instead of exhausting it in a burst and waiting.
- `pacingTime` is anchored to the *previous send's start*, so the **first**
  message of a run still goes at its earliest safe time (spec §24) — the pacing
  spaces consecutive sends, it never delays the first.

## 6. Configuration changes

Config is **re-read every run**: `resolveRateLimits()` for tiers, and
`getMinSendIntervalMs()` / `getRateLimitRecoveryThreshold()` for the global
settings. There is no persisted schedule to invalidate.

- **Limits become more restrictive** → the next run recomputes and future sends
  move later automatically (integration-tested: a 15/5 → 15/2 reduction blocks
  immediately).
- **Limits become less restrictive** → capacity is freed on the next run
  (integration-tested: 15/2 → 15/4 drains immediately).
- Already-sent rows remain part of history (`message_queue.sent_at` is never
  rewritten retroactively).

## 7. Concurrency

- **Atomic check-and-reserve.** `calculateNextSafeSendTime()` and
  `reserveSlot()` run in the same synchronous block (no `await` between), and
  the reservation is **held across the inline delay**. On React Native's
  single JS thread, no other task can interleave mid-check-and-reserve, so two
  workers can never both believe capacity exists and over-send. Integration
  test: two `processSingleItem` calls with a tier of 1 → exactly one sends.
- **`_isProcessing`** still serializes `processQueue()` itself; the reservation
  ledger covers concurrent Path A (alarm → `processSingleItem`) and Path B
  (bulk → `processLane`) dispatches for the same platform.
- **Known residual:** across two *concurrent* paths, tier caps are exact, but
  the 1-second *spacing* floor is best-effort — both may decide before either
  dispatches (each `await delay` yields the thread). Optional hardening
  (planned-start timestamps in reservations) is deferred; this does not affect
  the hard "no tier exceeded" invariant.

## 8. Failure semantics

Only **accepted** sends consume rate-limit capacity.

- `scheduled` / `reserved` / `attempted` / `failed` / `cancelled` messages
  **never** enter the sliding-window history.
- A send is recorded only when the adapter returns an accepted outcome
  (`'sent'` / `'opened'` — the provider accepted it), and its recorded
  timestamp is the actual dispatch start.
- Validation failures and permanent send failures are `markAsFailed` with no
  history entry (integration-tested: a failing row leaves the tier's capacity
  untouched).

## 9. Persistence / restart

- **History source of truth:** `message_queue` rows with `status='SENT'`
  (`sent_at`, UTC zero-millisecond ISO). Indexed on `(status, sent_at)`.
- On each run the engine **hydrates** per-platform history via
  `rateLimitDB.getSentHistoryForPlatform()` (epoch-ms computed in SQLite via
  `strftime('%s', datetime(sent_at))`, which robustly parses both the app's ISO
  format and any space-separated backdated/raw-write format), then appends
  incrementally. Restart correctness = "re-read the SENT rows".
- **Precision note:** `sent_at` is zero-millisecond, so hydrated timestamps
  snap to second boundaries. The in-process history keeps full ms precision
  during a run; after a restart, minute-scale tier windows are unaffected, and
  the 1-second floor is enforced in-process via `recordDispatchStart`/
  `recordDispatchCompletion`, not via hydrated history.
- Clock-jump guards: hydration drops rows timestamped > 60s in the future, and
  `appendSend` never inserts a timestamp smaller than the current tail.

## 10. Behavior change vs. the old code

- **SMS pacing drops from a 2s safety floor to the global 1s execution+gap
  floor** (the old `SAFETY_FLOOR_MS = { sms: 2000, whatsapp: 800 }` is no longer
  used by the live path). Real-device SMS thresholds vary by manufacturer; if a
  device proves flaky, raise `min_send_interval_ms` in Settings — the setting
  exists exactly for this.
- The old hard-gate and pacing-curve helpers were removed. The engine is the
  only implementation that makes local rate-limit decisions.

## Configuration reference

| Setting | Key | Default | Meaning |
|---|---|---|---|
| Minimum send gap | `min_send_interval_ms` | `1000` | ms after execution completes before the next send may start |
| Recovery threshold | `rate_limit_recovery_threshold` | `0.5` | fraction of a saturated tier's capacity that must return before resuming |
| Tiers | `platform_rate_limit_tiers` | SMS 150/15min, 250/1hr, 750/24hr | multi-tier, ANDed (edit in Settings) |
| Custom override | `platform_rate_limits` | — | single tier that replaces the tier scheme entirely (Settings) |
