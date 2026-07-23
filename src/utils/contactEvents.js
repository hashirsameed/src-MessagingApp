// Single signal slot — contactDB write functions call emitContactEvent(),
// one listener (registered in App.tsx) reacts by scheduling/cancelling alarms.

let listener = null;

// Replaces any previous listener — safe against duplicate registration on hot-reload.
export const setContactListener = (fn) => {
  listener = fn;
};

export const emitContactEvent = async (event) => {
  if (!listener) return;
  try {
    await listener(event);
  } catch (error) {
    console.log('[contactEvents] listener error:', error);
  }
};