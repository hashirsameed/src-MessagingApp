import { StyleSheet } from 'react-native';

test('StyleSheet.create exists', () => {
  console.log('StyleSheet is:', StyleSheet);
  expect(typeof StyleSheet.create).toBe('function');
});