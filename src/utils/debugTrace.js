import { isDevModeOn } from './devMode';

const TRACE_PREFIX = '[TRACE]';

const safeValue = (value) => {
  if (value === undefined || value === null) return '';
  if (value instanceof Error) return value.message;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
};

const formatFields = (fields = {}) => {
  const payload = {
    time: new Date().toISOString(),
    ...fields,
  };

  return Object.entries(payload)
    .map(([key, value]) => `${key}=${safeValue(value)}`)
    .join(' ');
};

export const debugTrace = (step, fields = {}) => {
  if (!isDevModeOn()) return;
  console.log(`${TRACE_PREFIX} step=${step} ${formatFields(fields)}`);
};

export const debugTraceError = (step, error, fields = {}) => {
  if (!isDevModeOn()) return;
  console.error(
    `${TRACE_PREFIX} step=${step} ${formatFields({
      ...fields,
      errorMessage: error?.message ?? String(error),
      stack: error?.stack ?? '',
    })}`,
  );
};

// Same shape as debugTraceError, but console.log instead of console.error —
// for conditions that are expected and already handled gracefully by the
// caller (no internet, request timeout, etc). console.error triggers React
// Native's LogBox red overlay even when the app itself recovers fine, which
// makes a normal "no internet" moment look like a crash. Use this instead
// for anything the UI already shows a friendly, retryable message for.
export const debugTraceRecoverable = (step, error, fields = {}) => {
  if (!isDevModeOn()) return;
  console.log(
    `${TRACE_PREFIX} step=${step} ${formatFields({
      ...fields,
      errorMessage: error?.message ?? String(error),
    })}`,
  );
};

/**
 * Logs a database state transition for queue/alarm tables.
 * oldState/newState should be status strings, e.g. PENDING → PROCESSING.
 */
export const debugTraceDbWrite = (step, { table, pk, oldState, newState, ...rest } = {}) => {
  if (!isDevModeOn()) return;
  debugTrace(step, {
    table,
    pk,
    oldState,
    newState,
    ...rest,
  });
};

// ---------------------------------------------------------------------------
// Trace ID generation (Point 1) — every top-level execution (AlarmFiredTask,
// a processQueue() run, a manual "Run Check Now", RescheduleAlarmsTask)
// generates ONE traceId at its entry point, then threads it through every
// function call it makes. This is what lets you separate two overlapping
// runs in the logs instead of their lines interleaving indistinguishably.
// ---------------------------------------------------------------------------
let executionCounter = 0;

/**
 * @param {string} label  Short human-readable prefix identifying the
 *                        trigger source, e.g. 'alarmFired', 'foregroundInterval',
 *                        'manualCheck', 'bootReschedule'.
 */
export const generateTraceId = (label = 'exec') => {
  executionCounter += 1;
  return `${label}-${Date.now()}-${executionCounter}`;
};

// ---------------------------------------------------------------------------
// Duration tracking (Point 3) — pair with Date.now() at the start of a
// function, pass that startTime here at the end. Emits durationMs so you
// can spot slow steps before they approach the 30s Headless JS timeout.
// ---------------------------------------------------------------------------
export const debugTraceDuration = (step, startTime, fields = {}) => {
  if (!isDevModeOn()) return;
  const durationMs = Date.now() - startTime;
  debugTrace(step, { ...fields, durationMs });
};