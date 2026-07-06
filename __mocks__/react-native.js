/**
 * Minimal test-only mock of react-native. Pure-logic suites (database,
 * scheduling, matching) only need Alert.alert. App.test.tsx also pulls in
 * @react-navigation/native, which calls Platform.select(...) at import
 * time, so Platform needs a real select() implementation too.
 */
module.exports = {
  Alert: {
    alert: jest.fn(),
  },
  Platform: {
    OS: 'android',
    select: (obj) => obj.android ?? obj.default ?? obj.native,
  },
  NativeModules: {},
};