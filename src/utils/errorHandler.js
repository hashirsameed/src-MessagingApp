import { Alert } from 'react-native';
import { debugTraceError, debugTraceRecoverable } from './debugTrace';

export const ErrorMessages = {
  DB_READ: 'Failed to load data. Please restart the app.',
  DB_WRITE: 'Failed to save data. Please try again.',
  DB_DELETE: 'Failed to delete. Please try again.',
  PLATFORM_NOT_FOUND: (name) => `${name} is not installed on this device.`,
  PLATFORM_OPEN_FAILED: (name) => `Failed to open ${name}. Please try again.`,
  TEMPLATE_NOT_FOUND: (days) => `No template found for ${days} day(s) remaining.\n\nPlease create a "${days} days" template first.`,
  VALIDATION_REQUIRED: (field) => `Please enter a valid ${field}.`,
  VALIDATION_DATE: 'Invalid date format. Please use YYYY-MM-DD (e.g. 2026-12-31).',
  UNKNOWN: 'Something went wrong. Please try again.',
};

export const handleError = (error, context = '') => {
  debugTraceError('HandleError', error, { function: context });
};

// For errors that are expected and already handled gracefully by the
// caller — no internet, request timed out, etc — where the UI shows its
// own friendly/retryable message. Logs to Metro for debugging without
// popping React Native's LogBox red-screen overlay (which handleError's
// console.error does, even for errors that aren't actually crashes).
export const handleRecoverableError = (error, context = '') => {
  debugTraceRecoverable('RecoverableError', error, { function: context });
};

export const showError = (title, message) => {
  Alert.alert(title, message, [{ text: 'OK' }]);
};

export const showSuccess = (title, message, onPress) => {
  Alert.alert(title, message, [{ text: 'OK', onPress }]);
};

export const showConfirm = (title, message, onConfirm, confirmText = 'Confirm', destructive = false) => {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: confirmText,
      style: destructive ? 'destructive' : 'default',
      onPress: onConfirm,
    },
  ]);
};
