import { getRateLimit, countSentInWindow, getWindowFreeAtMs } from '../database/rateLimitDB';

/**
 * Read-only dry-run of the rate-limit gate — same math queueProcessor uses
 * before an actual send, but here it ONLY reads already-SENT rows and
 * compares counts. Never calls sendSMS/sendWhatsApp, never writes to
 * message_queue, never touches the native alarm layer. Safe to call
 * repeatedly from a test screen.
 */
export const simulateRateLimitCheck = (platformId, fakeNowMs = Date.now()) => {
  const limit = getRateLimit(platformId); // null = unlimited for this platform

  if (!limit) {
    return {
      platformId,
      limited: false,
      sentInWindow: 0,
      limitCount: null,
      windowMinutes: null,
      wouldBlock: false,
      freeAtMs: null,
      freeInMinutes: null,
    };
  }

  const { limitCount, windowMinutes } = limit;
  const sentInWindow = countSentInWindow(platformId, windowMinutes);
  const wouldBlock = sentInWindow >= limitCount;
  const freeAtMs = wouldBlock ? getWindowFreeAtMs(platformId, windowMinutes) : null;

  return {
    platformId,
    limited: true,
    sentInWindow,
    limitCount,
    windowMinutes,
    wouldBlock,
    freeAtMs,
    freeInMinutes: freeAtMs ? Math.max(0, Math.ceil((freeAtMs - fakeNowMs) / 60000)) : null,
  };
};