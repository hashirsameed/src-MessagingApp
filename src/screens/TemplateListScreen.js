import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Switch,
  StyleSheet, StatusBar, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getAllTemplates, deleteTemplate, toggleTemplateActive } from '../database/templateDB';
import { getAllContacts } from '../database/contactDB';
import { cancelAlarmsForTemplate, rescheduleAlarmsForTemplate } from '../utils/alarmScheduler';
import { formatTemplateSendTime } from '../utils/dateFormat';
import { handleError, showError, showConfirm, ErrorMessages } from '../utils/errorHandler';
import { InlineLoader } from '../components/LoadingSpinner';

export default function TemplateListScreen({ navigation }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);

  const loadTemplates = () => {
    try {
      setLoading(true);
      setTemplates(getAllTemplates());
    } catch (error) {
      handleError(error, 'TemplateListScreen.loadTemplates');
      showError('Error', ErrorMessages.DB_READ);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { loadTemplates(); }, []));

  /**
   * Toggling ON/OFF has two effects:
   *  1. DB flag update (existing behavior) — controls future matching.
   *  2. Alarm lifecycle sync (new) — OFF cancels every scheduled alarm
   *     tied to this template across all contacts; ON re-schedules
   *     fresh alarms against current contacts. This keeps AlarmManager
   *     + scheduled_alarms consistent with the template's real state,
   *     per the confirmed architecture (Approach #1 — cleanup layer).
   */
  const handleToggle = async (item, value) => {
    try {
      const ok = toggleTemplateActive(item.id, value);
      if (!ok) {
        showError('Error', ErrorMessages.DB_WRITE);
        return;
      }

      setTemplates((prev) =>
        prev.map((t) => t.id === item.id ? { ...t, is_active: value ? 1 : 0 } : t)
      );

      if (Platform.OS === 'android') {
        const updatedTemplate = { ...item, is_active: value ? 1 : 0 };
        const allContacts = getAllContacts();
        const results = await rescheduleAlarmsForTemplate(updatedTemplate, allContacts);
        console.log(`[TemplateListScreen] Template "${item.title}" toggled ${value ? 'ON' : 'OFF'} — ${results.length} alarm(s) affected`);
      }
    } catch (error) {
      handleError(error, 'TemplateListScreen.handleToggle');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleDelete = (id, title) => {
    showConfirm(
      'Delete Template',
      `Delete "${title}"?`,
      async () => {
        try {
          if (Platform.OS === 'android') {
            const cancelledCount = await cancelAlarmsForTemplate(id);
            console.log(`[TemplateListScreen] Cancelled ${cancelledCount} alarm(s) before deleting template ${id}`);
          }

          const ok = deleteTemplate(id);
          if (!ok) { showError('Error', ErrorMessages.DB_DELETE); return; }
          loadTemplates();
        } catch (error) {
          handleError(error, 'TemplateListScreen.handleDelete');
          showError('Error', ErrorMessages.DB_DELETE);
        }
      },
      'Delete',
      true,
    );
  };

  const renderItem = ({ item }) => {
    const active     = item.is_active === 1;
    const days       = item.days_before ?? 1;
    const daysLabel  = `${days} day${days !== 1 ? 's' : ''} before expiry`;
    const timeLabel  = formatTemplateSendTime(item.send_time);

    return (
      <View style={[styles.card, !active && styles.cardInactive]}>
        <View style={styles.cardBody}>
          <View style={styles.iconContainer}>
            <Text style={styles.icon}>📝</Text>
          </View>
          <View style={styles.cardContent}>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.daysLabel}>Time: {timeLabel}</Text>
            <Text style={styles.daysLabel}>📅 {daysLabel}</Text>
            <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
          </View>
          {/* Toggle */}
          <Switch
            value={active}
            onValueChange={(v) => handleToggle(item, v)}
            trackColor={{ false: '#E0E0E0', true: '#1A1A2E' }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.cardFooter}>
          <TouchableOpacity
            style={styles.btnEdit}
            onPress={() => navigation.navigate('EditTemplate', { template: item, onSave: loadTemplates })}>
            <Text style={styles.btnEditText}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.btnDelete}
            onPress={() => handleDelete(item.id, item.title)}>
            <Text style={styles.btnDeleteText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Templates</Text>
        <Text style={styles.headerSubtitle}>
          {loading ? 'Loading...' : `${templates.length} template${templates.length !== 1 ? 's' : ''}`}
        </Text>
      </View>

      {loading ? (
        <InlineLoader message="Loading templates..." />
      ) : (
        <FlatList
          data={templates}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>📝</Text>
              <Text style={styles.emptyTitle}>No Templates Yet</Text>
              <Text style={styles.emptySubtitle}>Create your first template to get started</Text>
            </View>
          }
        />
      )}

      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('CreateTemplate')}>
        <Text style={styles.fabText}>+ New Template</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#F8F9FA' },
  header:         { backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  headerTitle:    { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 14, color: '#888', marginTop: 2 },

  card:           { backgroundColor: '#fff', borderRadius: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  cardInactive:   { opacity: 0.55 },
  cardBody:       { flexDirection: 'row', padding: 16, alignItems: 'center' },
  iconContainer:  { width: 44, height: 44, borderRadius: 12, backgroundColor: '#F0F0F0', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  icon:           { fontSize: 20 },
  cardContent:    { flex: 1, marginRight: 8 },
  title:          { fontSize: 15, fontWeight: '700', color: '#1A1A2E' },
  daysLabel:      { fontSize: 11, color: '#6B7280', marginTop: 2, marginBottom: 2 },
  body:           { fontSize: 12, color: '#9E9E9E', lineHeight: 17 },

  cardFooter:     { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#F5F5F5', padding: 12, gap: 8 },
  btnEdit:        { flex: 1, backgroundColor: '#EEF2FF', paddingVertical: 9, borderRadius: 10, alignItems: 'center' },
  btnEditText:    { color: '#3730A3', fontWeight: '600', fontSize: 13 },
  btnDelete:      { flex: 1, backgroundColor: '#FFF5F5', paddingVertical: 9, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#FFE0E0' },
  btnDeleteText:  { color: '#D32F2F', fontWeight: '600', fontSize: 13 },

  fab:            { position: 'absolute', bottom: 24, right: 20, left: 20, backgroundColor: '#1A1A2E', paddingVertical: 16, borderRadius: 14, alignItems: 'center', elevation: 5 },
  fabText:        { color: '#fff', fontWeight: '700', fontSize: 16 },
  emptyContainer: { alignItems: 'center', marginTop: 80 },
  emptyIcon:      { fontSize: 60, marginBottom: 16 },
  emptyTitle:     { fontSize: 20, fontWeight: '700', color: '#1A1A2E' },
  emptySubtitle:  { fontSize: 14, color: '#888', marginTop: 8, textAlign: 'center' },
});
