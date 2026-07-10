import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Switch,
  StyleSheet, StatusBar, Platform, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getAllTemplates, deleteTemplate, toggleTemplateActive } from '../database/templateDB';
import { getAllContacts } from '../database/contactDB';
import { getAllPlatforms, seedDefaultPlatforms } from '../database/platformDB';
import { cancelAlarmsForTemplate, rescheduleAlarmsForTemplate } from '../utils/alarmScheduler';
import { formatTemplateSendTime } from '../utils/dateFormat';
import { handleError, showError, showConfirm, ErrorMessages } from '../utils/errorHandler';
import { InlineLoader } from '../components/LoadingSpinner';
import WhatsAppTemplatesScreen from './WhatsAppTemplatesScreen';

export default function TemplatesScreen({ navigation }) {
  const [platforms, setPlatforms]   = useState([]);
  const [activeTab, setActiveTab]   = useState('sms');
  const [templates, setTemplates]   = useState([]);
  const [loading, setLoading]       = useState(true);

  const loadAll = () => {
    try {
      setLoading(true);
      seedDefaultPlatforms();
      const allPlatforms = getAllPlatforms();
      setPlatforms(allPlatforms);
      // Keep current tab if it still exists, else fall back to first platform.
      setActiveTab((prev) => (allPlatforms.some((p) => p.id === prev) ? prev : (allPlatforms[0]?.id ?? 'sms')));
      setTemplates(getAllTemplates());
    } catch (error) {
      handleError(error, 'TemplatesScreen.loadAll');
      showError('Error', ErrorMessages.DB_READ);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { loadAll(); }, []));

  const activePlatform = platforms.find((p) => p.id === activeTab);
  const isManagedRemote = activePlatform?.platform_type === 'managed_remote';

  const tabTemplates = templates.filter((t) => (t.platform_id ?? 'sms') === activeTab);

  // ── Local-text tab: reminder template list (same behavior as before) ────
  const handleToggle = async (item, value) => {
    try {
      const ok = toggleTemplateActive(item.id, value);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }

      setTemplates((prev) =>
        prev.map((t) => t.id === item.id ? { ...t, is_active: value ? 1 : 0 } : t)
      );

      if (Platform.OS === 'android') {
        const updatedTemplate = { ...item, is_active: value ? 1 : 0 };
        const allContacts = getAllContacts();
        const results = await rescheduleAlarmsForTemplate(updatedTemplate, allContacts);
        console.log(`[TemplatesScreen] Template "${item.title}" toggled ${value ? 'ON' : 'OFF'} — ${results.length} alarm(s) affected`);
      }
    } catch (error) {
      handleError(error, 'TemplatesScreen.handleToggle');
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
            console.log(`[TemplatesScreen] Cancelled ${cancelledCount} alarm(s) before deleting template ${id}`);
          }
          const ok = deleteTemplate(id);
          if (!ok) { showError('Error', ErrorMessages.DB_DELETE); return; }
          loadAll();
        } catch (error) {
          handleError(error, 'TemplatesScreen.handleDelete');
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
            onPress={() => navigation.navigate('EditTemplate', { template: item, onSave: loadAll })}>
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
      </View>

      {/* Tab bar — pill style */}
      <View style={styles.tabBarWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBarContent}>
          {platforms.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.tab, activeTab === p.id && styles.tabActive]}
              onPress={() => setActiveTab(p.id)}
              activeOpacity={0.7}>
              <Text style={styles.tabIcon}>{p.icon}</Text>
              <Text style={[styles.tabText, activeTab === p.id && styles.tabTextActive]}>
                {p.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {loading ? (
        <InlineLoader message="Loading templates..." />
      ) : isManagedRemote ? (
        // WhatsApp (Meta API) — untouched, existing screen embedded as-is.
        <WhatsAppTemplatesScreen />
      ) : (
        <>
          <FlatList
            data={tabTemplates}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={{ padding: 16, paddingBottom: 140 }}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyIcon}>📝</Text>
                <Text style={styles.emptyTitle}>No Templates Yet</Text>
                <Text style={styles.emptySubtitle}>
                  Create your first {activePlatform?.name ?? ''} template to get started
                </Text>
              </View>
            }
          />
          <TouchableOpacity
            style={styles.fab}
            onPress={() => navigation.navigate('CreateTemplate', { presetPlatformId: activeTab })}>
            <Text style={styles.fabText}>+ New Template</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#F8F9FA' },
  header:         { backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  headerTitle:    { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },

  tabBarWrap:     { backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  tabBarContent:  { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  tab:            {
    flexDirection: 'row', alignItems: 'center', flexShrink: 0,
    paddingHorizontal: 18, height: 40, borderRadius: 20,
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#E5E7EB',
  },
  tabActive:      { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  tabIcon:        { fontSize: 14, marginRight: 6 },
  tabText:        { fontSize: 14, fontWeight: '600', color: '#1A1A2E' },
  tabTextActive:  { color: '#fff' },

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