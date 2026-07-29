// In-process reservation ledger — supplements the DB's countSentInWindow()
// with sends that are currently IN-FLIGHT (rate-limit check already passed,
// dispatch not yet resolved). Without this, two concurrent sends for the
// same platform can both read the same DB count, both pass the limit
// check, and both dispatch — exceeding the configured limit. Concretely
// this happens when two exact alarms fire close together (two separate
// processSingleItem calls), or one alarm fires while processLane() is
// mid-batch for the same platform.
//
// Correctness depends on React Native's JS thread being single-threaded
// and run-to-completion (true for Hermes/JSC — headless-task invocations
// in the same running app process all share this one JS thread). Every
// call site below reads the count and pushes its own reservation with
// zero `await` in between, so no other queued task can interleave
// mid-check-and-reserve — whichever call's synchronous block runs first
// wins the slot, i.e. first-come-first-served.

const reservationsByPlatform = new Map(); // platformId -> Array<{ id, reservedAtMs }>
let nextReservationId = 1;

const pruneExpired = (platformId, windowMinutes) => {
  const list = reservationsByPlatform.get(platformId);
  if (!list || list.length === 0) return [];
  const cutoffMs = Date.now() - windowMinutes * 60 * 1000;
  const fresh = list.filter((r) => r.reservedAtMs > cutoffMs);
  if (fresh.length !== list.length) reservationsByPlatform.set(platformId, fresh);
  return fresh;
};

// How many sends for this platform are currently reserved (dispatch in
// flight, not yet confirmed SENT/FAILED in the DB) within the window.
export const getInFlightCount = (platformId, windowMinutes) =>
  pruneExpired(platformId, windowMinutes).length;

// Synchronous — call this in the SAME synchronous block as the rate-limit
// count check, before any `await`. Returns a reservation id; always
// release it (success, failure, or thrown error) via releaseSlot().
export const reserveSlot = (platformId) => {
  const id = nextReservationId++;
  const list = reservationsByPlatform.get(platformId) ?? [];
  list.push({ id, reservedAtMs: Date.now() });
  reservationsByPlatform.set(platformId, list);
  return id;
};

export const releaseSlot = (platformId, id) => {
  const list = reservationsByPlatform.get(platformId);
  if (!list) return;
  const idx = list.findIndex((r) => r.id === id);
  if (idx !== -1) list.splice(idx, 1);
};