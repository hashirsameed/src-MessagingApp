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

export { runExpiryCheck };

export const registerBackgroundScheduler = async () => {
  try {
    console.log('[Scheduler] Foreground auto-send active. Background fetch not configured.');
  } catch (error) {
    handleError(error, 'registerBackgroundScheduler');
  }
};

export const unregisterBackgroundScheduler = async () => {
  // no-op
};