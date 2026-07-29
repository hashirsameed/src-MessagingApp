import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { getAllPlatforms, seedDefaultPlatforms, togglePlatformEnabled } from '../database/platformDB';
import { rescheduleAlarmsForPlatform } from '../utils/alarmScheduler';
import { showConfirm, handleError, showError, ErrorMessages } from '../utils/errorHandler';

/**
 * PlatformPicker — pill row for choosing which platform a template sends
 * through. Reads getAllPlatforms() (sms/whatsapp + any custom platform),
 * so a new platform added anywhere in the app shows up here automatically —
 * no code change needed (Step 6 goal: extensible without touching this file).
 *
 * A disabled platform's pill is shown shaded (dashed border, dimmed text,
 * "Off" tag) and stays tappable — tapping it doesn't select it directly,
 * it asks to enable the platform first, then selects it once enabled.
 * This is the same enable/reschedule effect SettingsScreen's toggle has.
 *
 * value: platform id string (e.g. 'sms')
 * onChange: (platformId: string) => void
 * onPlatformsChanged: optional callback fired after an inline enable, so a
 *   parent screen tracking its own "any platform enabled?" state (e.g. the
 *   all-off gate in CreateTemplateScreen) can refresh in sync.
 */
export default function PlatformPicker({ value, onChange, onPlatformsChanged }) {
  const [platforms, setPlatforms] = useState([]);

  const loadPlatforms = () => {
    setPlatforms(getAllPlatforms());
  };

  useEffect(() => {
    seedDefaultPlatforms();
    loadPlatforms();
  }, []);

  // Enabling from here mirrors SettingsScreen's handlePlatformToggle
  // (reschedule alarms for that platform on Android) so a platform turned
  // on from inside the template screen behaves identically to one turned
  // on from Settings.
  const enableAndSelect = async (platform) => {
    try {
      const ok = togglePlatformEnabled(platform.id, true);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      if (Platform.OS === 'android') {
        await rescheduleAlarmsForPlatform(platform.id);
      }
      loadPlatforms();
      onChange(platform.id);
      onPlatformsChanged?.();
    } catch (error) {
      handleError(error, 'PlatformPicker.enableAndSelect');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handlePillPress = (platform) => {
    if (platform.is_enabled === 1) {
      onChange(platform.id);
      return;
    }
    showConfirm(
      'Platform Disabled',
      `${platform.name} is currently off. Enable it now to use it for this template?`,
      () => enableAndSelect(platform),
      'Enable'
    );
  };

  if (platforms.length === 0) return null;

  return (
    <View>
      <Text style={styles.label}>Platform</Text>
      <Text style={styles.hint}>Which platform should this template send through?</Text>
      <View style={styles.pillRow}>
        {platforms.map((p) => {
          const isEnabled = p.is_enabled === 1;
          return (
            <TouchableOpacity
              key={p.id}
              style={[
                styles.pill,
                value === p.id && styles.pillSelected,
                !isEnabled && styles.pillDisabled,
              ]}
              onPress={() => handlePillPress(p)}
              activeOpacity={0.8}>
              <Text style={[
                styles.pillText,
                value === p.id && styles.pillTextSelected,
                !isEnabled && styles.pillTextDisabled,
              ]}>
                {p.icon} {p.name}
              </Text>
              {!isEnabled && (
                <Text style={styles.pillOffTag}>Off — tap to enable</Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: '#1A1A2E', marginBottom: 4 },
  hint: { fontSize: 11, color: '#9E9E9E', marginBottom: 8 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    backgroundColor: '#F8F9FA', borderWidth: 1.5, borderColor: '#EEEEEE',
  },
  pillSelected: { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  pillText: { fontSize: 12, fontWeight: '600', color: '#1A1A2E' },
  pillTextSelected: { color: '#fff' },
  // Shaded look for an off platform — dashed border + dimmed background so
  // it visually reads as "unavailable right now" without looking broken or
  // un-tappable. Text stays legible; only the tag/opacity signal "off".
  pillDisabled: {
    backgroundColor: '#F1F1F1', borderColor: '#DADADA',
    borderStyle: 'dashed', opacity: 0.7,
  },
  pillTextDisabled: { color: '#9E9E9E' },
  pillOffTag: {
    fontSize: 9, fontWeight: '700', color: '#B0003A',
    marginTop: 2, textAlign: 'center',
  },
});