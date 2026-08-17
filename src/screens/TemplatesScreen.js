import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Switch,
  StyleSheet, StatusBar, Platform, ScrollView, Animated, Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTemplatesPage, getTemplateCountsByPlatform, deleteTemplate, toggleTemplateActive } from '../database/templateDB';
import { getEnabledPlatforms, seedDefaultPlatforms } from '../database/platformDB';
import { syncWhatsAppTemplatesCache } from '../database/whatsappTemplateCacheDB';
import { fetchMetaTemplates } from '../utils/metaTemplateService';
import { cancelAlarmsForTemplate, rescheduleAlarmsForTemplateId } from '../utils/alarmScheduler';
import { formatTemplateSendTime, formatDaysLabel } from '../utils/dateFormat';
import { handleError, showError, showConfirm, ErrorMessages } from '../utils/errorHandler';
import { InlineLoader } from '../components/LoadingSpinner';
import WhatsAppTemplatesScreen from './WhatsAppTemplatesScreen';

const SCREEN_WIDTH = Dimensions.get('window').width;
const WA_PAGES = ['Scheduled', 'Approved Templates'];
const PAGE_SIZE = 30;

export default function TemplatesScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [platforms, setPlatforms]   = useState([]);
  const [activeTab, setActiveTab]   = useState('sms');
  const [templateCounts, setTemplateCounts] = useState({});
  const [itemsByTab, setItemsByTab]     = useState({});
  const [pageByTab, setPageByTab]       = useState({});
  const [hasMoreByTab, setHasMoreByTab] = useState({});
  const [loadingMore, setLoadingMore]   = useState(false);
  const [loading, setLoading]       = useState(true);
  const [waPageIndex, setWaPageIndex] = useState(0);
  const waScrollX = useRef(new Animated.Value(0)).current;
  const waPagerRef = useRef(null);

  // Refreshes the WhatsApp template cache directly, instead of waiting for
  // WhatsAppTemplatesScreen to have been opened at least once. Safe to call
  // even when WhatsApp isn't configured — fetchMetaTemplates() just returns
  // { success: false } in that case, nothing throws, nothing changes.
  const refreshWhatsAppCache = async () => {
    try {
      const result = await fetchMetaTemplates();
      if (result.success) {
        syncWhatsAppTemplatesCache(result.templates);
      }
    } catch (error) {
      handleError(error, 'TemplatesScreen.refreshWhatsAppCache');
      // Non-fatal — badge just falls back to whatever was cached before.
    }
  };

  const buildPlatformState = () => {
    const allPlatforms = getEnabledPlatforms();
    const countByPlatform = getTemplateCountsByPlatform();

    // Count local templates per platform, then sort tabs so the platform
    // with the most templates leads. Now that WhatsApp schedules are real
    // local `templates` rows too (platform_id='whatsapp', pointing at an
    // approved Meta template), this count is consistent across every
    // platform — no separate WhatsApp-only override needed anymore.
    const sortedPlatforms = [...allPlatforms].sort(
      (a, b) => (countByPlatform[b.id] ?? 0) - (countByPlatform[a.id] ?? 0)
    );

    setPlatforms(sortedPlatforms);
    setTemplateCounts(countByPlatform);
    // Keep current tab if it still exists, else fall back to first platform.
    setActiveTab((prev) => (sortedPlatforms.some((p) => p.id === prev) ? prev : (sortedPlatforms[0]?.id ?? 'sms')));
  };

  const loadTabPage = useCallback((tab) => {
    const data = getTemplatesPage(tab, PAGE_SIZE, 0);
    setItemsByTab((prev) => ({ ...prev, [tab]: data }));
    setPageByTab((prev) => ({ ...prev, [tab]: 0 }));
    setHasMoreByTab((prev) => ({ ...prev, [tab]: data.length === PAGE_SIZE }));
  }, []);

  const loadMoreForTab = (tab) => {
    if (loadingMore || !hasMoreByTab[tab]) return;
    setLoadingMore(true);
    try {
      const nextPage = (pageByTab[tab] ?? 0) + 1;
      const data = getTemplatesPage(tab, PAGE_SIZE, nextPage * PAGE_SIZE);
      if (data.length > 0) {
        setItemsByTab((prev) => ({ ...prev, [tab]: [...(prev[tab] || []), ...data] }));
        setPageByTab((prev) => ({ ...prev, [tab]: nextPage }));
      }
      setHasMoreByTab((prev) => ({ ...prev, [tab]: data.length === PAGE_SIZE }));
    } finally {
      setLoadingMore(false);
    }
  };

  const loadAll = async () => {
    try {
      setLoading(true);
      seedDefaultPlatforms();

      // Show local data immediately, don't block the screen on the network
      // call — then refresh the WA cache in the background and re-read
      // counts once it lands, so the badge updates without a flicker/hang.
      buildPlatformState();
      loadTabPage(activeTab);
      setLoading(false);

      await refreshWhatsAppCache();
      buildPlatformState();
    } catch (error) {
      handleError(error, 'TemplatesScreen.loadAll');
      showError('Error', ErrorMessages.DB_READ);
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { loadAll(); }, []));

  useEffect(() => {
    if (activeTab && !itemsByTab[activeTab]) loadTabPage(activeTab);
  }, [activeTab, itemsByTab, loadTabPage]);

  const activePlatform = platforms.find((p) => p.id === activeTab);
  const isManagedRemote = activePlatform?.platform_type === 'managed_remote';

  const tabTemplates = itemsByTab[activeTab] || [];

  // ── Local-text tab: reminder template list (same behavior as before) ────
  const handleToggle = async (item, value) => {
    try {
      const ok = toggleTemplateActive(item.id, value);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }

      setItemsByTab((prev) => ({
        ...prev,
        [activeTab]: (prev[activeTab] || []).map((t) =>
          t.id === item.id ? { ...t, is_active: value ? 1 : 0 } : t
        ),
      }));

      if (Platform.OS === 'android') {
        const updatedTemplate = { ...item, is_active: value ? 1 : 0 };
        const results = await rescheduleAlarmsForTemplateId(updatedTemplate);
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
          loadTabPage(activeTab);
          buildPlatformState();
        } catch (error) {
          handleError(error, 'TemplatesScreen.handleDelete');
          showError('Error', ErrorMessages.DB_DELETE);
        }
      },
      'Delete',
      true,
    );
  };

  const goToWaPage = (index) => {
    setWaPageIndex(index);
    waPagerRef.current?.scrollTo({ x: index * SCREEN_WIDTH, animated: true });
  };

  const handleWaMomentumEnd = (e) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setWaPageIndex(index);
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
            <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.daysLabel} numberOfLines={1}>⏰ {timeLabel} · 📅 {formatDaysLabel(item.days_before)}</Text>
            <Text style={styles.body} numberOfLines={1}>{item.body}</Text>
          </View>
          <Switch
            value={active}
            onValueChange={(v) => handleToggle(item, v)}
            trackColor={{ false: '#E0E0E0', true: '#1A1A2E' }}
            thumbColor="#fff"
            style={styles.switchCompact}
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
          {platforms.map((p) => {
            const count = templateCounts[p.id] ?? 0;
            const isActive = activeTab === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[styles.tab, isActive && styles.tabActive]}
                onPress={() => setActiveTab(p.id)}
                activeOpacity={0.7}>
                <Text style={styles.tabIcon}>{p.icon}</Text>
                <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                  {p.name}
                </Text>
                {count > 0 && (
                  <View style={[styles.tabBadge, isActive && styles.tabBadgeActive]}>
                    <Text style={[styles.tabBadgeText, isActive && styles.tabBadgeTextActive]}>
                      {count}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <InlineLoader message="Loading templates..." />
      ) : isManagedRemote ? (
        <View style={styles.waWrap}>
          {/* Segmented sub-nav — two distinct pages, swipe or tap between
              them. Kept visually separate from the platform pill bar above
              so it reads as "page within a page", not another row of tabs. */}
          <View style={styles.waSegmentWrap}>
            <View style={styles.waSegmentTrack}>
              <Animated.View
                style={[
                  styles.waSegmentIndicator,
                  {
                    transform: [{
                      translateX: waScrollX.interpolate({
                        inputRange: [0, SCREEN_WIDTH],
                        outputRange: [0, (SCREEN_WIDTH - 32) / 2],
                        extrapolate: 'clamp',
                      }),
                    }],
                  },
                ]}
              />
              {WA_PAGES.map((label, index) => (
                <TouchableOpacity
                  key={label}
                  style={styles.waSegmentBtn}
                  activeOpacity={0.75}
                  onPress={() => goToWaPage(index)}>
                  <Text style={[
                    styles.waSegmentText,
                    waPageIndex === index && styles.waSegmentTextActive,
                  ]}>
                    {label}{label === 'Scheduled' && (templateCounts[activeTab] ?? 0) > 0 ? `  ·  ${templateCounts[activeTab]}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <Animated.ScrollView
            ref={waPagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { x: waScrollX } } }],
              { useNativeDriver: false },
            )}
            scrollEventThrottle={16}
            onMomentumScrollEnd={handleWaMomentumEnd}
            style={styles.waPager}>

            {/* Page 1 — Scheduled Reminders: local `templates` rows with
                platform_id 'whatsapp', each pointing at an approved Meta
                template (days_before/send_time, same shape as SMS/Email). */}
            <View style={styles.waPage}>
              <FlatList
                data={tabTemplates}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                onEndReached={() => loadMoreForTab(activeTab)}
                onEndReachedThreshold={0.4}
                contentContainerStyle={{ padding: 16, paddingBottom: 140 }}
                ListFooterComponent={loadingMore ? <Text style={styles.loadingMore}>Loading more...</Text> : null}
                ListEmptyComponent={
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyIcon}>🗓</Text>
                    <Text style={styles.emptyTitle}>No Reminders Scheduled</Text>
                    <Text style={styles.emptySubtitle}>
                      Schedule a reminder that sends an approved WhatsApp template automatically.
                    </Text>
                  </View>
                }
              />
              <TouchableOpacity
                style={[styles.fab, { bottom: 16 + insets.bottom }]}
                onPress={() => navigation.navigate('CreateTemplate', { presetPlatformId: 'whatsapp' })}>
                <Text style={styles.fabText}>+ Schedule Reminder</Text>
              </TouchableOpacity>
            </View>

            {/* Page 2 — Approved Templates: WhatsAppTemplatesScreen's own
                Meta Cloud API template manager, untouched, embedded as-is. */}
            <View style={styles.waPage}>
              <WhatsAppTemplatesScreen />
            </View>
          </Animated.ScrollView>
        </View>
      ) : (
        <>
          <FlatList
            data={tabTemplates}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            onEndReached={() => loadMoreForTab(activeTab)}
            onEndReachedThreshold={0.4}
            contentContainerStyle={{ padding: 16, paddingBottom: 140 }}
            ListFooterComponent={loadingMore ? <Text style={styles.loadingMore}>Loading more...</Text> : null}
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
            style={[styles.fab, { bottom: 16 + insets.bottom }]}
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
  header:         { backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  headerTitle:    { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  loadingMore:    { textAlign: 'center', color: '#9CA3AF', paddingVertical: 12 },

  tabBarWrap:     { backgroundColor: '#F8F9FA' },
  tabBarContent:  { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  tab:            {
    flexDirection: 'row', alignItems: 'center', flexShrink: 0,
    paddingHorizontal: 12, height: 32, borderRadius: 16,
    backgroundColor: '#F8F9FA', borderWidth: 1, borderColor: '#DEE1E6',
  },
  tabActive:      { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  tabIcon:        { fontSize: 12, marginRight: 5 },
  tabText:        { fontSize: 13, fontWeight: '600', color: '#1A1A2E' },
  tabTextActive:  { color: '#fff' },

  tabBadge: {
    marginLeft: 6, minWidth: 18, height: 18, borderRadius: 9,
    paddingHorizontal: 5, backgroundColor: '#EDEFF2',
    justifyContent: 'center', alignItems: 'center',
  },
  tabBadgeActive:     { backgroundColor: 'rgba(255,255,255,0.22)' },
  tabBadgeText:       { fontSize: 10, fontWeight: '700', color: '#1A1A2E' },
  tabBadgeTextActive: { color: '#fff' },

  waWrap:   { flex: 1 },

  waSegmentWrap:  { paddingHorizontal: 16, paddingBottom: 12 },
  waSegmentTrack: {
    flexDirection: 'row', backgroundColor: '#EDEFF2', borderRadius: 12,
    height: 40, padding: 3, position: 'relative',
  },
  waSegmentIndicator: {
    position: 'absolute', top: 3, left: 3, bottom: 3,
    width: '50%', backgroundColor: '#fff', borderRadius: 9,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  waSegmentBtn:        { flex: 1, alignItems: 'center', justifyContent: 'center' },
  waSegmentText:       { fontSize: 13, fontWeight: '600', color: '#8B8FA3' },
  waSegmentTextActive: { color: '#1A1A2E', fontWeight: '700' },

  waPager: { flex: 1 },
  waPage:  { width: SCREEN_WIDTH, flex: 1 },

  card:           { backgroundColor: '#fff', borderRadius: 14, marginBottom: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 2 },
  cardInactive:   { opacity: 0.55 },
  cardBody:       { flexDirection: 'row', padding: 12, alignItems: 'center' },
  iconContainer:  { width: 38, height: 38, borderRadius: 10, backgroundColor: '#F0F0F0', justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  icon:           { fontSize: 17 },
  cardContent:    { flex: 1, marginRight: 8 },
  title:          { fontSize: 14, fontWeight: '700', color: '#1A1A2E' },
  daysLabel:      { fontSize: 11, color: '#6B7280', marginTop: 2 },
  body:           { fontSize: 12, color: '#9E9E9E', marginTop: 2 },
  switchCompact:  { transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] },

  cardFooter:     { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#F5F5F5', padding: 10, gap: 6 },
  btnEdit:        { flex: 1, backgroundColor: '#EEF2FF', paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  btnEditText:    { color: '#3730A3', fontWeight: '600', fontSize: 12 },
  btnDelete:      { flex: 1, backgroundColor: '#FFF5F5', paddingVertical: 8, borderRadius: 9, alignItems: 'center', borderWidth: 1, borderColor: '#FFE0E0' },
  btnDeleteText:  { color: '#D32F2F', fontWeight: '600', fontSize: 12 },

  fab:            { position: 'absolute', right: 20, left: 20, backgroundColor: '#1A1A2E', paddingVertical: 14, borderRadius: 14, alignItems: 'center', elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 6 },
  fabText:        { color: '#fff', fontWeight: '700', fontSize: 15 },
  emptyContainer: { alignItems: 'center', marginTop: 80 },
  emptyIcon:      { fontSize: 60, marginBottom: 16 },
  emptyTitle:     { fontSize: 20, fontWeight: '700', color: '#1A1A2E' },
  emptySubtitle:  { fontSize: 14, color: '#888', marginTop: 8, textAlign: 'center' },
});