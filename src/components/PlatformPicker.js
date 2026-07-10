import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { getAllPlatforms, seedDefaultPlatforms } from '../database/platformDB';

/**
 * PlatformPicker — pill row for choosing which platform a template sends
 * through. Reads getAllPlatforms() (sms/whatsapp + any custom platform),
 * so a new platform added anywhere in the app shows up here automatically —
 * no code change needed (Step 6 goal: extensible without touching this file).
 *
 * value: platform id string (e.g. 'sms')
 * onChange: (platformId: string) => void
 */
export default function PlatformPicker({ value, onChange }) {
  const [platforms, setPlatforms] = useState([]);

  useEffect(() => {
    seedDefaultPlatforms();
    setPlatforms(getAllPlatforms());
  }, []);

  if (platforms.length === 0) return null;

  return (
    <View>
      <Text style={styles.label}>Platform</Text>
      <Text style={styles.hint}>Which platform should this template send through?</Text>
      <View style={styles.pillRow}>
        {platforms.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[styles.pill, value === p.id && styles.pillSelected]}
            onPress={() => onChange(p.id)}
            activeOpacity={0.8}>
            <Text style={[styles.pillText, value === p.id && styles.pillTextSelected]}>
              {p.icon} {p.name}
            </Text>
          </TouchableOpacity>
        ))}
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
});