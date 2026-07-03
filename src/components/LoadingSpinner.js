import React from 'react';
import {
  View, ActivityIndicator, Text, StyleSheet, Modal,
} from 'react-native';

export const LoadingSpinner = ({ visible, message = 'Loading...' }) => {
  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" visible={visible}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <ActivityIndicator size="large" color="#1A1A2E" />
          <Text style={styles.message}>{message}</Text>
        </View>
      </View>
    </Modal>
  );
};

export const InlineLoader = ({ message = 'Loading...' }) => (
  <View style={styles.inlineContainer}>
    <ActivityIndicator size="small" color="#1A1A2E" />
    <Text style={styles.inlineMessage}>{message}</Text>
  </View>
);

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center', alignItems: 'center',
  },
  container: {
    backgroundColor: '#fff', borderRadius: 16,
    padding: 28, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 8,
    minWidth: 160,
  },
  message: { fontSize: 14, color: '#1A1A2E', marginTop: 14, fontWeight: '500' },
  inlineContainer: {
    flex: 1, justifyContent: 'center',
    alignItems: 'center', padding: 40,
  },
  inlineMessage: { fontSize: 14, color: '#9E9E9E', marginTop: 12 },
});