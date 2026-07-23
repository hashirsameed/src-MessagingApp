import React, { useState, useCallback, useRef } from 'react';
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
  Animated,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  getAllQueue,
  removeFromQueue,
  revertToPending,
} from '../database/messageQueueDB';
import { getAllContacts } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { processQueue } from '../utils/queueProcessor';
import { formatDateTime12Hour } from '../utils/dateFormat';

const TABS = ['PENDING', 'SENT', 'FAILED'];
const SCREEN_WIDTH = Dimensions.get('window').width;

const STATUS_META = {
  PENDING: { color: '#F59E0B', bg: '#FFFBEB', label: 'Pending', icon: '⏳' },
  SENT:    { color: '#10B981', bg: '#ECFDF5', label: 'Sent',    icon: '✅' },
  FAILED:  { color: '#EF4444', bg: '#FEF2F2', label: 'Failed',  icon: '❌' },
};

/**
 * Allow retry for failed SMS (Android) and failed WhatsApp messages.
 */
const shouldShowRetry  = (item) =>
  item.status === 'FAILED' && 
  (item.platform_id === 'sms' || item.platform_id === 'whatsapp');

const shouldShowDelete = (item) =>
  item.status === 'PENDING' ||
  item.status === 'FAILED' ||
  (Platform.OS === 'android' && item.platform_id === 'sms');

export default function QueueScreen() {
  const [activeTab, setActiveTab]       = useState('PENDING');
  const [allItems, setAllItems]         = useState([]);
  const [contactMap, setContactMap]     = useState({});
  const [templateMap, setTemplateMap]   = useState({});
  const [refreshing, setRefreshing]     = useState(false);
  const [processing, setProcessing]     = useState(false);
  const scrollX  = useRef(new Animated.Value(0)).current;
  const pagerRef = useRef(null);

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

  // Live-refresh while screen is focused — messages get sent by a background
  // native alarm, not by any UI action, so focus-only reload wasn't enough.
  useFocusEffect(
    useCallback(() => {
      loadData();
      const interval = setInterval(loadData, 5000);
      return () => clearInterval(interval);
    }, [loadData])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    loadData();
    setTimeout(() => setRefreshing(false), 500);
  }, [loadData]);

  const pendingCount  = allItems.filter((i) => i.status === 'PENDING').length;
  const sentCount     = allItems.filter((i) => i.status === 'SENT').length;
  const failedCount   = allItems.filter((i) => i.status === 'FAILED').length;
  const tabCount      = { PENDING: pendingCount, SENT: sentCount, FAILED: failedCount };

  const goToTab = (index) => {
    setActiveTab(TABS[index]);
    pagerRef.current?.scrollTo({ x: index * SCREEN_WIDTH, animated: true });
  };

  const handleMomentumEnd = (e) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setActiveTab(TABS[index] ?? TABS[0]);
  };

  const handleRetry = (item) => {
    Alert.alert(
      'Retry Message',
      'Reset this message to Pending and attempt to send it again now?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retry Now',
          onPress: async () => {
            revertToPending(item.id);
            loadData();
            setProcessing(true);
            try {
              await processQueue();
            } catch (error) {
              console.error('Error processing queue on retry:', error);
            } finally {
              setProcessing(false);
              loadData();
            }
          },
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
        {contact?.phone_number ? <Text style={styles.contactSub}>{contact.phone_number}</Text> : null}
        {contact?.email ? <Text style={styles.contactSub}>{contact.email}</Text> : null}

        {/* Template */}
        <Text style={styles.templateName}>
          📝 {template
            ? (template.title ?? template.name ?? `Template #${item.template_id}`)
            : `Template #${item.template_id}`}
        </Text>

        {/* Timestamps */}
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>Queued: {formatDateTime12Hour(item.created_at)}</Text>
          
          {/* ✅ ADDED: Explicitly show scheduled time for pending items to eliminate confusion */}
          {item.status === 'PENDING' ? (
            <Text style={[styles.timeText, { color: meta.color, fontWeight: '600' }]}>
              Scheduled for: {formatDateTime12Hour(item.scheduled_for)}
            </Text>
          ) : null}

          {item.sent_at ? (
            <Text style={styles.timeText}>Sent: {formatDateTime12Hour(item.sent_at)}</Text>
          ) : null}
        </View>

        {/* Error */}
        {item.status === 'FAILED' && item.error_reason ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>
              ⚠ {item.error_reason.replace(/_/g, ' ')}
            </Text>
          </View>
        ) : null}

        {item.attempt_count > 0 ? <Text style={styles.attemptText}>Attempts: {item.attempt_count}</Text> : null}

        {/* Action buttons */}
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

  const renderEmpty = (status) => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyIcon}>
        {status === 'PENDING' ? '📭' : status === 'SENT' ? '📬' : '🚫'}
      </Text>
      <Text style={styles.emptyTitle}>No {STATUS_META[status].label} Messages</Text>
      <Text style={styles.emptySubtitle}>
        {status === 'PENDING'
          ? 'Messages will appear here and send automatically at their scheduled time.'
          : status === 'SENT'
          ? 'Successfully sent messages will appear here.'
          : 'Failed deliveries will be listed here with their reasons.'}
      </Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Processing Indicator */}
      {processing && (
        <View style={styles.processingBar}>
          <ActivityIndicator size="small" color="#1A1A2E" />
          <Text style={styles.processingText}>Processing queue...</Text>
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabBar}>
        <Animated.View
          style={[
            styles.tabIndicator,
            {
              backgroundColor: STATUS_META[activeTab].color,
              transform: [{
                translateX: scrollX.interpolate({
                  inputRange: [0, SCREEN_WIDTH, SCREEN_WIDTH * 2],
                  outputRange: [0, SCREEN_WIDTH / 3, (SCREEN_WIDTH / 3) * 2],
                  extrapolate: 'clamp',
                }),
              }],
            },
          ]}
        />
        {TABS.map((tab, index) => {
          const meta     = STATUS_META[tab];
          const isActive = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              style={styles.tab}
              onPress={() => goToTab(index)}
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

      {/* Pages */}
      <Animated.ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false },
        )}
        scrollEventThrottle={16}
        onMomentumScrollEnd={handleMomentumEnd}
        style={styles.pager}>
        {TABS.map((tab) => {
          const items = allItems.filter((i) => i.status === tab);
          return (
            <View key={tab} style={styles.page}>
              <FlatList
                data={items}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                ListEmptyComponent={renderEmpty(tab)}
                contentContainerStyle={
                  items.length === 0 ? styles.emptyFlex : styles.listContent
                }
                refreshControl={
                  <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1A1A2E" />
                }
              />
            </View>
          );
        })}
      </Animated.ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FC' },

  processingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    backgroundColor: '#FFFBEB',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
    gap: 8,
  },
  processingText: { fontSize: 13, fontWeight: '600', color: '#D97706' },

  tabBar:       { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F0F0F0', position: 'relative' },
  tabIndicator: { position: 'absolute', bottom: 0, left: 0, height: 2.5, width: SCREEN_WIDTH / 3 },
  tab:          { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, gap: 6 },
  tabLabel:     { fontSize: 13, fontWeight: '600', color: '#BDBDBD' },
  tabBadge:     { borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  tabBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },

  pager: { flex: 1 },
  page:  { width: SCREEN_WIDTH, flex: 1 },

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