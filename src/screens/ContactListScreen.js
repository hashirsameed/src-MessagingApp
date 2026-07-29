import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, StatusBar, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getContactsPage, searchContacts, getContactsCount, deleteContact, updateContact,
} from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getScheduledAlarmsByContact } from '../database/scheduledAlarmDB';
import { getDaysUntilExpiry, findMatchingTemplate } from '../utils/templateMatcher';
import { formatExpiryDate12Hour, formatDateTime12Hour, parse12HourTimeTo24Hour } from '../utils/dateFormat';
import { validateDate, validateTime } from '../utils/validators';
import { ErrorMessages, handleError, showError, showConfirm, showSuccess } from '../utils/errorHandler';
import { runExpiryCheck } from '../utils/schedulerEngine';
import { scanDatabase } from '../utils/dbScan';
// FIX — asal export settingsDB.js mein `getDevMode` naam se kabhi tha hi
// nahi. Dev-mode flag ka real module `../utils/devMode` hai, jiska export
// `isDevModeOn()` hai (andar hi settingsDB ke getSetting/setSetting use
// karta hai). Purana import (`getDevMode` from `../database/settingsDB`)
// runtime pe `undefined` resolve hota tha — isi liye "undefined is not a
// function" render error aa raha tha (line 363).
import { isDevModeOn } from '../utils/devMode';

const PAGE_SIZE = 30;
// Debounce the search box so every keystroke doesn't fire its own SQL
// query — only the settled value (300ms after typing stops) reloads the
// list. searchContacts()/getContactsPage() share the same LIMIT/OFFSET
// page shape, so swapping between "searching" and "plain list" here is
// just a matter of which one gets called.
const SEARCH_DEBOUNCE_MS = 300;

export default function ContactListScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [contacts, setContacts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [totalCount, setTotalCount] = useState(0);

  // Search + lazy-loading pagination — same pattern QueueScreen.js already
  // uses for its date-range filter, applied here to name search.
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchDebounceRef = useRef(null);

  // devMode state mein cached hai (SettingsScreen.js wale pattern jaisa) —
  // isDevModeOn() ko seedha JSX/renderItem ke andar baar-baar call karne se
  // bachne ke liye. Ek hi read loadContacts() ke andar hoti hai (jo
  // useFocusEffect se har focus par chalta hai), baaki jagah state se hi
  // read hota hai.
  const [devMode, setDevMode] = useState(false);

  // Test panel (dev mode only) — which contact's panel is open, the
  // scheduled_alarms rows for it (read-only "already set" display), and
  // the tester's new-date/new-time inputs for the Update Time button.
  const [testOpenId, setTestOpenId] = useState(null);
  const [testAlarms, setTestAlarms] = useState([]);
  const [testDate, setTestDate] = useState('');
  const [testTime, setTestTime] = useState('');
  const [testMeridiem, setTestMeridiem] = useState('AM');
  const [testErrors, setTestErrors] = useState({});

  // Loads page 0 for whatever query is currently active (empty = plain
  // list). Called on focus, after add/delete/update, and (debounced) on
  // every search-box change. Resets pagination each time, since a new
  // query means a new result set from the top.
  const loadContacts = useCallback((query = searchQuery) => {
    try {
      const trimmed = query.trim();
      const data = trimmed
        ? searchContacts(trimmed, PAGE_SIZE, 0)
        : getContactsPage(PAGE_SIZE, 0);
      setContacts(data);
      setPage(0);
      setHasMore(data.length === PAGE_SIZE);
      setTotalCount(getContactsCount(trimmed));
      setTemplates(getAllTemplates());
      setDevMode(isDevModeOn()); // single read per focus, cached in state
    } catch (error) {
      handleError(error, 'ContactListScreen.loadContacts');
      showError('Error', ErrorMessages.DB_READ);
    }
  }, [searchQuery]);

  // Lazy-load the next page — this is the fix for a 500-1000 row contact
  // table loading all at once; it now only ever pulls PAGE_SIZE rows at a
  // time, same LIMIT/OFFSET shape whether searching or browsing the full list.
  const loadMoreContacts = () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const trimmed = searchQuery.trim();
      const nextPage = page + 1;
      const data = trimmed
        ? searchContacts(trimmed, PAGE_SIZE, nextPage * PAGE_SIZE)
        : getContactsPage(PAGE_SIZE, nextPage * PAGE_SIZE);
      if (data.length > 0) {
        setContacts((prev) => [...prev, ...data]);
        setPage(nextPage);
      }
      setHasMore(data.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  };

  const onSearchChange = (text) => {
    setSearchQuery(text);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => loadContacts(text), SEARCH_DEBOUNCE_MS);
  };

  // Clear any pending debounce timer on unmount so it doesn't fire a
  // setState against an unmounted screen.
  useEffect(() => () => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
  }, []);

  const refreshTestAlarms = (contactId) => {
    try {
      setTestAlarms(getScheduledAlarmsByContact(contactId));
    } catch (error) {
      handleError(error, 'ContactListScreen.refreshTestAlarms');
    }
  };

  const toggleTestPanel = (contact) => {
    if (testOpenId === contact.id) {
      setTestOpenId(null);
      return;
    }
    setTestOpenId(contact.id);
    setTestDate('');
    setTestTime('');
    setTestMeridiem('AM');
    setTestErrors({});
    refreshTestAlarms(contact.id);
  };

  // Update Time — plain updateContact(); the signal layer reschedules alarms if expiry changed.
  const handleUpdateTestTime = async (contact) => {
    const dateResult = validateDate(testDate);
    const timeResult = validateTime(testTime);
    const newErrors = {};
    if (!dateResult.valid) newErrors.date = dateResult.message;
    if (!timeResult.valid) newErrors.time = timeResult.message;
    setTestErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    try {
      const normalizedTime = parse12HourTimeTo24Hour(testTime, testMeridiem);
      if (!normalizedTime) {
        setTestErrors({ time: 'Invalid time entered.' });
        return;
      }
      const localDateTime = new Date(`${testDate.trim()}T${normalizedTime}:00`);
      if (isNaN(localDateTime.getTime())) {
        setTestErrors({ date: 'Invalid date/time entered.' });
        return;
      }
      const expiryUTC = localDateTime.toISOString().replace(/\.\d{3}Z$/, 'Z');

      const ok = updateContact({
        id: contact.id,
        name: contact.name,
        phone_number: contact.phone_number,
        expiry_datetime: expiryUTC,
      });
      if (!ok) {
        showError('Error', ErrorMessages.DB_WRITE);
        return;
      }
      loadContacts();
      refreshTestAlarms(contact.id);
      showSuccess('Time Updated', `${contact.name}'s expiry has been updated.`);
    } catch (error) {
      handleError(error, 'ContactListScreen.handleUpdateTestTime');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  // Scan — calls ONLY scanDatabase() (dbScan.js), which is pure SELECT
  // queries against scheduled_alarms and message_queue. Nothing else runs:
  // no fireScheduledPair, no processQueue, no scheduleAlarmsForContact, no
  // native alarm/SMS call. Pressing this can never send a real message or
  // change any row — it only reads current state and reports it.
  const handleScan = () => {
    const result = scanDatabase();
    showSuccess(
      'Database Scan',
      `Scheduled: ${result.summary.scheduledCount}\n` +
      `Overdue (waiting): ${result.summary.overdueCount}\n` +
      `Pending in queue: ${result.summary.pendingQueueCount}`
    );
  };

  useFocusEffect(
    useCallback(() => {
      loadContacts();
    }, [loadContacts])
  );

  const handleSend = (contact) => {
    try {
      const daysLeft = getDaysUntilExpiry(contact.expiry_datetime);
      const templates = getAllTemplates();
      const matched = findMatchingTemplate(templates, daysLeft);

      if (!matched) {
        Alert_TemplateNotFound(daysLeft);
        return;
      }

      showConfirm(
        'Template Found',
        `Contact: ${contact.name}\nDays Left: ${daysLeft}\nTemplate: "${matched.title}"`,
        () => navigation.navigate('PlatformSelect', { template: matched, contact }),
        'Send Now'
      );
    } catch (error) {
      handleError(error, 'ContactListScreen.handleSend');
      showError('Error', ErrorMessages.UNKNOWN);
    }
  };

  const Alert_TemplateNotFound = (daysLeft) => {
    Alert.alert(
      'Template Not Found',
      ErrorMessages.TEMPLATE_NOT_FOUND(daysLeft),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Create Template', onPress: () => navigation.navigate('CreateTemplate') },
      ]
    );
  };

  // Deleting a contact — the signal layer cancels its alarms after DB delete succeeds.
  const handleDelete = (id, name) => {
    showConfirm(
      'Delete Contact',
      `Are you sure you want to delete "${name}"?`,
      async () => {
        try {
          const ok = deleteContact(id);
          if (!ok) {
            showError('Error', ErrorMessages.DB_DELETE);
            return;
          }
          loadContacts();
          showSuccess('Deleted', `"${name}" has been removed.`);
        } catch (error) {
          handleError(error, 'ContactListScreen.handleDelete');
          showError('Error', ErrorMessages.DB_DELETE);
        }
      },
      'Delete',
      true
    );
  };

  const handleCheckExpiring = async () => {
    try {
      const result = await runExpiryCheck();
      showSuccess(
        'Check Complete',
        `Checked: ${result.checked}\nQueued: ${result.queued}\nSkipped (no template): ${result.skippedNoTemplate}`
      );
    } catch (error) {
      handleError(error, 'ContactListScreen.handleCheckExpiring');
      showError('Error', ErrorMessages.UNKNOWN);
    }
  };

  const getExpiryStatus = (daysLeft) => {
    if (daysLeft < 0) return { label: 'Expired', color: '#B0003A', bg: '#FFEBEE' };
    if (daysLeft === 0) return { label: 'Expires Today', color: '#B0003A', bg: '#FFEBEE' };
    if (daysLeft <= 3) return { label: `${daysLeft} Day${daysLeft > 1 ? 's' : ''} Left`, color: '#E65100', bg: '#FFF3E0' };
    return { label: `${daysLeft} Days Left`, color: '#2E7D32', bg: '#E8F5E9' };
  };

  const renderItem = ({ item }) => {
    const daysLeft = getDaysUntilExpiry(item.expiry_datetime);
    const status = getExpiryStatus(daysLeft);

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.contactInfo}>
            <Text style={styles.contactName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.contactPhone} numberOfLines={1}>{item.phone_number}</Text>
            <Text style={styles.contactExpiry} numberOfLines={1}>🗓 {formatExpiryDate12Hour(item.expiry_datetime)}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: status.bg }]}>
            <Text style={[styles.badgeText, { color: status.color }]} numberOfLines={1}>{status.label}</Text>
          </View>
        </View>
        <View style={styles.cardFooter}>
          <TouchableOpacity style={styles.btnSend} onPress={() => handleSend(item)}>
            <Text style={styles.btnSendText}>Send</Text>
          </TouchableOpacity>
          {devMode && (
            <TouchableOpacity style={styles.btnTest} onPress={() => toggleTestPanel(item)}>
              <Text style={styles.btnTestText}>{testOpenId === item.id ? 'Close' : 'Test'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.btnDelete} onPress={() => handleDelete(item.id, item.name)}>
            <Text style={styles.btnDeleteText}>Delete</Text>
          </TouchableOpacity>
        </View>

        {devMode && testOpenId === item.id && (
          <View style={styles.testPanel}>
            <Text style={styles.testPanelTitle}>Scheduled alarms (already set)</Text>
            {testAlarms.length === 0 ? (
              <Text style={styles.testHint}>No scheduled_alarms row yet — create/edit an active template first.</Text>
            ) : (
              testAlarms.map((row) => {
                const tpl = templates.find(t => t.id === row.template_id);
                return (
                  <View key={row.id} style={styles.testAlarmRow}>
                    <Text style={styles.testAlarmText}>
                      {tpl ? tpl.title : row.template_id}: {formatDateTime12Hour(row.trigger_at)}
                    </Text>
                    <Text style={styles.testAlarmStatus}>{row.status}</Text>
                  </View>
                );
              })
            )}

            <View style={styles.testDivider} />

            <Text style={styles.testPanelTitle}>Update Time (DB only — expiry_date / expiry_datetime)</Text>
            <View style={styles.testInputRow}>
              <TextInput
                style={[styles.testInput, { flex: 1.3 }, testErrors.date && styles.inputError]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#BDBDBD"
                value={testDate}
                onChangeText={setTestDate}
              />
              <TextInput
                style={[styles.testInput, { flex: 1 }, testErrors.time && styles.inputError]}
                placeholder="h:mm"
                placeholderTextColor="#BDBDBD"
                value={testTime}
                onChangeText={setTestTime}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
              {['AM', 'PM'].map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.meridiemBtnSm, testMeridiem === option && styles.meridiemBtnSmActive]}
                  onPress={() => setTestMeridiem(option)}>
                  <Text style={[styles.meridiemTextSm, testMeridiem === option && styles.meridiemTextSmActive]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {testErrors.date ? <Text style={styles.errorText}>{testErrors.date}</Text> : null}
            {testErrors.time ? <Text style={styles.errorText}>{testErrors.time}</Text> : null}

            <View style={styles.testBtnRow}>
              <TouchableOpacity style={styles.btnUpdateTime} onPress={() => handleUpdateTestTime(item)}>
                <Text style={styles.btnUpdateTimeText}>Update Time</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnScan} onPress={handleScan}>
                <Text style={styles.btnScanText}>Scan</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Contacts</Text>
          <Text style={styles.headerSubtitle}>{totalCount} contact{totalCount !== 1 ? 's' : ''}</Text>
        </View>
        {/* Dev/Testing only — hidden unless Developer Mode is ON */}
        {devMode && (
          <TouchableOpacity style={styles.checkBtn} onPress={handleCheckExpiring}>
            <Text style={styles.checkBtnText}>Check Expiring</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name..."
          placeholderTextColor="#9CA3AF"
          value={searchQuery}
          onChangeText={onSearchChange}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity style={styles.searchClearBtn} onPress={() => onSearchChange('')}>
            <Text style={styles.searchClearText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={contacts}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        onEndReached={loadMoreContacts}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator style={{ marginVertical: 12 }} color="#1A1A2E" />
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>👥</Text>
            <Text style={styles.emptyTitle}>
              {searchQuery.trim() ? 'No Matches' : 'No Contacts Yet'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {searchQuery.trim()
                ? `Nothing matches "${searchQuery.trim()}"`
                : 'Add your first contact to get started'}
            </Text>
          </View>
        }
      />
      <TouchableOpacity
        style={[styles.fab, { bottom: 16 + insets.bottom }]}
        onPress={() => navigation.navigate('AddContact', { onSave: loadContacts })}>
        <Text style={styles.fabText}>+ Add Contact</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  header: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
    flexDirection: 'row',
    alignItems: 'center',
  },
  checkBtn: {
    backgroundColor: '#1A1A2E',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  checkBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 14, color: '#888', marginTop: 2 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#F0F0F0',
  },
  searchInput: {
    flex: 1, fontSize: 14, color: '#1A1A2E', backgroundColor: '#F8F9FC',
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
    borderWidth: 1, borderColor: '#EEEEEE',
  },
  searchClearBtn: { paddingHorizontal: 4, paddingVertical: 6 },
  searchClearText: { color: '#9CA3AF', fontSize: 16, fontWeight: '700' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#1A1A2E', justifyContent: 'center', alignItems: 'center',
    marginRight: 10,
  },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  contactInfo: { flex: 1, marginRight: 8 },
  contactName: { fontSize: 15, fontWeight: '600', color: '#1A1A2E' },
  contactPhone: { fontSize: 12, color: '#666', marginTop: 1 },
  contactExpiry: { fontSize: 11, color: '#999', marginTop: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, maxWidth: 96 },
  badgeText: { fontSize: 10, fontWeight: '600' },
  cardFooter: {
    flexDirection: 'row', borderTopWidth: 1,
    borderTopColor: '#F5F5F5', padding: 10, gap: 6,
  },
  btnSend: {
    flex: 1, backgroundColor: '#1A1A2E',
    paddingVertical: 9, borderRadius: 9, alignItems: 'center',
  },
  btnSendText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnDelete: {
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 9, alignItems: 'center',
    borderWidth: 1, borderColor: '#FFE0E0', backgroundColor: '#FFF5F5',
  },
  btnDeleteText: { color: '#D32F2F', fontWeight: '600', fontSize: 13 },
  btnTest: {
    paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 9, alignItems: 'center',
    borderWidth: 1, borderColor: '#E0E0F0', backgroundColor: '#F4F4FB',
  },
  btnTestText: { color: '#4A4A8A', fontWeight: '600', fontSize: 13 },
  testPanel: {
    margin: 12, marginTop: 0, padding: 14,
    borderRadius: 12, backgroundColor: '#FAFAFC',
    borderWidth: 1, borderColor: '#EDEDF5',
  },
  testPanelTitle: { fontSize: 12, fontWeight: '700', color: '#1A1A2E', marginBottom: 6 },
  testHint: { fontSize: 12, color: '#999', marginBottom: 4 },
  testAlarmRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingVertical: 4,
  },
  testAlarmText: { fontSize: 12, color: '#333', flex: 1, flexShrink: 1 },
  testAlarmStatus: { fontSize: 11, fontWeight: '700', color: '#6A6AAE', marginLeft: 8 },
  testDivider: { height: 1, backgroundColor: '#EDEDF5', marginVertical: 10 },
  testInputRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  testInput: {
    backgroundColor: '#fff', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: '#1A1A2E',
    borderWidth: 1, borderColor: '#EEEEEE',
  },
  meridiemBtnSm: {
    paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: '#EEEEEE', backgroundColor: '#fff',
  },
  meridiemBtnSmActive: { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  meridiemTextSm: { fontSize: 11, fontWeight: '700', color: '#1A1A2E' },
  meridiemTextSmActive: { color: '#fff' },
  inputError: { borderColor: '#D32F2F', backgroundColor: '#FFF5F5' },
  errorText: { fontSize: 11, color: '#D32F2F', marginTop: 4 },
  testBtnRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btnUpdateTime: {
    flex: 1, backgroundColor: '#4A4A8A',
    paddingVertical: 10, borderRadius: 10, alignItems: 'center',
  },
  btnUpdateTimeText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  btnScan: {
    flex: 1, backgroundColor: '#1A1A2E',
    paddingVertical: 10, borderRadius: 10, alignItems: 'center',
  },
  btnScanText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  fab: {
    position: 'absolute', right: 20, left: 20,
    backgroundColor: '#1A1A2E', paddingVertical: 14,
    borderRadius: 14, alignItems: 'center', elevation: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 6,
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  emptyContainer: { alignItems: 'center', marginTop: 80 },
  emptyIcon: { fontSize: 60, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#1A1A2E' },
  emptySubtitle: { fontSize: 14, color: '#888', marginTop: 8 },
});