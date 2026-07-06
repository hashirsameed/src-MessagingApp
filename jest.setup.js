jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock')
);

jest.mock('react-native-screens', () => {
  const actual = jest.requireActual('react-native-screens');
  return {
    ...actual,
    enableScreens: jest.fn(),
  };
});