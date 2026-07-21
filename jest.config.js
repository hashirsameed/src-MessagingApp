module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-.*)/)',
  ],
  setupFiles: [
    require.resolve('@react-native/jest-preset/jest/setup.js'), // restores RN internals — must come first
    '<rootDir>/jest.setup.js', // your safe-area-context / screens mocks
  ],
};
