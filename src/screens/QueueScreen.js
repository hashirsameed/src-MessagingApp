import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  getAllQueue,
  removeFromQueue,
  markAsFailed,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { formatDateTime12Hour } from '../utils/dateFormat';

const TABS = ['PENDING', 'SENT', 'FAILED'];

const STATUS_META = {
  PENDING: { color: '#F59E0B', bg: '#FFFBEB', label: 'Pending', icon: '⏳' },
  SENT:    { color: '#10B981', bg: '#ECFDF5', label: 'Sent',    icon: '✅' },
  FAILED:  { color: '#EF4444', bg: '#FEF2F2', label: 'Failed',  icon: '❌' },
};

/**
 * Only SMS items on Android get action buttons.
 * WhatsApp/Email/Gmail are fully automatic — no manual action needed.
 * iOS SMS uses Linking (user taps Send) — no retry button either.
 */
const shouldShowRetry  = (item) =>
  Platform.OS === 'android' && item.platform_id === 'sms' && item.status === 'FAILED';

const shouldShowDelete = (item) =>
  item.status === 'PENDING' ||
  (Platform.OS === 'android' && item.platform_id === 'sms');

export default function QueueScreen() {
  const [activeTab, setActiveTab]       = useState('PENDING');
  const [allItems, setAllItems]         = useState([]);
  const [contactMap, setContactMap]     = useState({});
  const [templateMap, setTemplateMap]   = useState({});
  const [refreshing, setRefreshing]     = useState(false);

  const loadData = useCallback(() => {
    const items     = getAllQueue();
    const contacts  = getAllContacts();
    const templates = getAllTemplates();

    const cMap = {};
    contacts.forEach((c) => { cMap[c.id] = c; });
    const tMap = {};
    templates.forEach((t) => { tMap[t.id] = t; });

    setAllItems(items);
    setContactMap(cMap);
    setTemplateMap(tMap);
  }, []);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
    setRefreshing(false);
  }, [loadData]);

  const filteredItems = allItems.filter((i) => i.status === activeTab);
  const pendingCount  = allItems.filter((i) => i.status === 'PENDING').length;
  const sentCount     = allItems.filter((i) => i.status === 'SENT').length;
  const failedCount   = allItems.filter((i) => i.status === 'FAILED').length;
  const tabCount      = { PENDING: pendingCount, SENT: sentCount, FAILED: failedCount };

  const handleRetry = (item) => {
    Alert.alert(
      'Retry SMS',
      'Remove this item? Run Check Now in Settings to re-queue it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove & Re-queue',
          onPress: () => { removeFromQueue(item.id); loadData(); },
        },
      ],
    );
  };

  const handleDelete = (item) => {
    Alert.alert(
      'Delete',
      'Remove this item from the queue permanently?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => { removeFromQueue(item.id); loadData(); },
        },
      ],
    );
  };

  // ── Card renderer ──────────────────────────────────────────────────────
  const renderItem = ({ item }) => {
    const contact    = contactMap[item.contact_id];
    const template   = templateMap[item.template_id];
    const meta       = STATUS_META[item.status] ?? STATUS_META.PENDING;
    const showRetry  = shouldShowRetry(item);
    const showDelete = shouldShowDelete(item);

    return (
      <View style={[styles.card, { borderLeftColor: meta.color }]}>
        {/* Header */}
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: meta.bg }]}>
            <Text style={[styles.badgeText, { color: meta.color }]}>
              {meta.icon} {meta.label}
            </Text>
          </View>
          <Text style={styles.platformText}>
            {item.platform_id?.toUpperCase() ?? '—'}
          </Text>
        </View>

        {/* Contact */}
        <Text style={styles.contactName}>
          {contact ? contact.name : `Contact #${item.contact_id}`}
        </Text>
        {contact?.phone_number
          ? <Text style={styles.contactSub}>{contact.phone_number}</Text>
          : null}
        {contact?.email
          ? <Text style={styles.contactSub}>{contact.email}</Text>
          : null}

        {/* Template */}
        <Text style={styles.templateName}>
          📝 {template
            ? (template.title ?? template.name ?? `Template #${item.template_id}`)
            : `Template #${item.template_id}`}
        </Text>

        {/* Timestamps */}
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>Queued: {formatDateTime12Hour(item.created_at)}</Text>
          {item.sent_at
            ? <Text style={styles.timeText}>Sent: {formatDateTime12Hour(item.sent_at)}</Text>
            : null}
        </View>

        {/* Error */}
        {item.error_reason ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>
              ⚠ {item.error_reason.replace(/_/g, ' ')}
            </Text>
          </View>
        ) : null}

        {item.attempt_count > 0
          ? <Text style={styles.attemptText}>Attempts: {item.attempt_count}</Text>
          : null}

        {/* Action buttons — only SMS on Android */}
        {(showRetry || showDelete) && (
          <View style={styles.actionRow}>
            {showRetry && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.retryBtn]}
                onPress={() => handleRetry(item)}
                activeOpacity={0.7}>
                <Text style={styles.retryBtnText}>🔄 Retry</Text>
              </TouchableOpacity>
            )}
            {showDelete && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.deleteBtn]}
                onPress={() => handleDelete(item)}
                activeOpacity={0.7}>
                <Text style={styles.deleteBtnText}>🗑 Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyIcon}>
        {activeTab === 'PENDING' ? '📭' : activeTab === 'SENT' ? '📬' : '🚫'}
      </Text>
      <Text style={styles.emptyTitle}>No {STATUS_META[activeTab].label} Messages</Text>
      <Text style={styles.emptySubtitle}>
        {activeTab === 'PENDING'
          ? 'Messages will appear here and send automatically.'
          : activeTab === 'SENT'
          ? 'Successfully sent messages will appear here.'
          : 'Failed deliveries will be listed here with their reasons.'}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Tabs */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const meta     = STATUS_META[tab];
          const isActive = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, isActive && { borderBottomColor: meta.color, borderBottomWidth: 2.5 }]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.7}>
              <Text style={[styles.tabLabel, isActive && { color: meta.color, fontWeight: '700' }]}>
                {meta.label}
              </Text>
              {tabCount[tab] > 0 && (
                <View style={[styles.tabBadge, { backgroundColor: meta.color }]}>
                  <Text style={styles.tabBadgeText}>{tabCount[tab]}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* List */}
      <FlatList
        data={filteredItems}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={
          filteredItems.length === 0 ? styles.emptyFlex : styles.listContent
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1A1A2E" />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FC' },

  tabBar:       { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  tab:          { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, gap: 6 },
  tabLabel:     { fontSize: 13, fontWeight: '600', color: '#BDBDBD' },
  tabBadge:     { borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  tabBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },

  listContent: { padding: 16, gap: 12 },
  emptyFlex:   { flex: 1 },

  card:        { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 12, borderLeftWidth: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  cardHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  badge:       { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText:   { fontSize: 11, fontWeight: '700' },
  platformText:{ fontSize: 11, fontWeight: '700', color: '#9CA3AF', letterSpacing: 0.5 },
  contactName: { fontSize: 15, fontWeight: '700', color: '#1A1A2E', marginBottom: 2 },
  contactSub:  { fontSize: 12, color: '#6B7280', marginBottom: 1 },
  templateName:{ fontSize: 12, color: '#6B7280', marginTop: 6, marginBottom: 6 },
  timeRow:     { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 },
  timeText:    { fontSize: 11, color: '#9CA3AF', flexShrink: 1 },
  errorBox:    { marginTop: 8, backgroundColor: '#FEF2F2', borderRadius: 6, padding: 8 },
  errorText:   { fontSize: 11, color: '#EF4444', fontWeight: '600' },
  attemptText: { fontSize: 11, color: '#9CA3AF', marginTop: 4 },

  actionRow:    { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn:    { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  retryBtn:     { backgroundColor: '#EFF6FF', borderWidth: 1, borderColor: '#3B82F6' },
  retryBtnText: { fontSize: 12, fontWeight: '700', color: '#3B82F6' },
  deleteBtn:    { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#EF4444' },
  deleteBtnText:{ fontSize: 12, fontWeight: '700', color: '#EF4444' },

  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyIcon:      { fontSize: 48, marginBottom: 16 },
  emptyTitle:     { fontSize: 17, fontWeight: '700', color: '#1A1A2E', marginBottom: 8, textAlign: 'center' },
  emptySubtitle:  { fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 20 },
});