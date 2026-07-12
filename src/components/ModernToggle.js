import React, { useRef, useEffect } from 'react';
import { TouchableOpacity, Animated, StyleSheet } from 'react-native';

const TRACK_WIDTH  = 52;
const TRACK_HEIGHT = 30;
const THUMB_SIZE   = 24;
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - 6; // 3px inset each side

const TRACK_OFF = '#E5E7EB';
const TRACK_ON  = '#1A1A2E';

/**
 * A custom animated toggle (not the stock RN <Switch>) so the Permissions
 * section reads as a deliberate, modern control rather than the OS-default
 * pill used everywhere else. Slides + crossfades the track color together
 * on every value change.
 */
export default function ModernToggle({ value, onValueChange, disabled = false }) {
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: 180,
      useNativeDriver: false,
    }).start();
  }, [value]);

  const thumbTranslate = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [3, 3 + THUMB_TRAVEL],
  });

  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [TRACK_OFF, TRACK_ON],
  });

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
      <Animated.View style={[styles.track, { backgroundColor: trackColor }, disabled && styles.trackDisabled]}>
        <Animated.View style={[styles.thumb, { transform: [{ translateX: thumbTranslate }] }]} />
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    justifyContent: 'center',
  },
  trackDisabled: { opacity: 0.5 },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
});