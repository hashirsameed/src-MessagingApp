/**
 * scheduler.js
 *
 * Expo-free scheduler wrapper.
 * Background fetch removed — bare React Native project.
 *
 * What works:
 *   - Foreground check: runs every time app becomes active (App.tsx AppState listener)
 *   - Manual check: SettingsScreen "Run Check Now" button
 *   - Auto-send: runExpiryCheck() auto-triggers processQueue() if items queued
 */

import { runExpiryCheck } from './schedulerEngine';
import { handleError } from './errorHandler';
import { debugTrace, debugTraceError } from './debugTrace';

export { runExpiryCheck };

export const registerBackgroundScheduler = async () => {
  try {
    debugTrace('RegisterBackgroundScheduler', { mode: 'foreground_only', backgroundFetch: 'not_configured' });
  } catch (error) {
    debugTraceError('RegisterBackgroundSchedulerCatch', error, { function: 'registerBackgroundScheduler' });
    handleError(error, 'registerBackgroundScheduler');
  }
};

export const unregisterBackgroundScheduler = async () => {
  // no-op
};