/**
 * Minimal test-only mock of react-native. Our unit tests only exercise
 * pure data/SQL logic (database, scheduling, matching), not UI, so we
 * only need to stub what errorHandler.js touches: Alert.alert.
 */
module.exports = {
  Alert: {
    alert: jest.fn(),
  },
  Platform: { OS: 'android' },
  NativeModules: {},
};