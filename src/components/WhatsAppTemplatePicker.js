import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

/**
 * Shared WhatsApp template picker rendered inside both CreateTemplateScreen
 * and EditTemplateScreen when isWhatsApp is true.
 *
 * Props:
 *   templates  — array of { name, category, language, body }
 *   selected   — currently selected template name (string | null)
 *   onSelect   — (template) => void
 *   error      — string | null (validation error to show)
 *   emptyMsg   — optional string to override the "no templates" message
 */
export default function WhatsAppTemplatePicker({ templates, selected, onSelect, error }) {
  return (
    <>
      <Text style={styles.label}>WhatsApp Template</Text>
      <Text style={styles.hint}>
        Only APPROVED templates can be scheduled. Manage/create templates from the
        WhatsApp tab first if you don't see the one you need here.
      </Text>
      {templates.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>
            No approved WhatsApp templates found yet. Open the WhatsApp tab to sync,
            or wait for Meta to approve one.
          </Text>
        </View>
      ) : (
        templates.map((t) => {
          const isSelected = selected === t.name;
          return (
            <TouchableOpacity
              key={t.name}
              style={[styles.card, isSelected && styles.cardSelected]}
              onPress={() => onSelect(t)}
              activeOpacity={0.8}>
              <View style={styles.topRow}>
                <Text style={styles.name}>{t.name}</Text>
                {isSelected && <Text style={styles.check}>✓</Text>}
              </View>
              <Text style={styles.meta}>{t.category} · {t.language}</Text>
              {t.body ? (
                <Text style={styles.body} numberOfLines={2}>{t.body}</Text>
              ) : null}
            </TouchableOpacity>
          );
        })
      )}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  label:      { fontSize: 14, fontWeight: '700', color: '#1A1A2E', marginBottom: 4, marginTop: 8 },
  hint:       { fontSize: 12, color: '#888', marginBottom: 8 },
  emptyBox:   { backgroundColor: '#FFF8E1', borderRadius: 10, padding: 14, marginBottom: 8 },
  emptyText:  { fontSize: 12, color: '#B8860B', lineHeight: 18 },
  card: {
    backgroundColor: '#fff', borderRadius: 10, padding: 12, marginBottom: 8,
    borderWidth: 1.5, borderColor: '#E0E0E0',
  },
  cardSelected: { borderColor: '#1A1A2E', backgroundColor: '#F8F8FF' },
  topRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name:     { fontSize: 14, fontWeight: '600', color: '#1A1A2E', flex: 1 },
  check:    { fontSize: 16, color: '#10B981', fontWeight: '700', marginLeft: 8 },
  meta:     { fontSize: 11, color: '#888', marginTop: 2 },
  body:     { fontSize: 12, color: '#555', marginTop: 4, lineHeight: 16 },
  errorText:{ fontSize: 12, color: '#D32F2F', marginTop: 4 },
});
