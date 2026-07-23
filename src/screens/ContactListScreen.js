import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, StatusBar, Alert, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getAllContacts, deleteContact, updateContactAndReschedule } from '../database/contactDB';
import { getAllTemplates } from '../database/templateDB';
import { getScheduledAlarmsByContact } from '../database/scheduledAlarmDB';
import { getDaysUntilExpiry, findMatchingTemplate } from '../utils/templateMatcher';
import { formatExpiryDate12Hour, formatDateTime12Hour, parse12HourTimeTo24Hour } from '../utils/dateFormat';
import { validateDate, validateTime } from '../utils/validators';
import { ErrorMessages, handleError, showError, showConfirm, showSuccess } from '../utils/errorHandler';
import { runExpiryCheck } from '../utils/schedulerEngine';
import { cancelAlarmsForContact } from '../utils/alarmScheduler';
import { scanDatabase } from '../utils/dbScan';

export default function ContactListScreen({ navigation }) {
  const [contacts, setContacts] = useState([]);
  const [templates, setTemplates] = useState([]);

  // Test panel (__DEV__ only) — which contact's panel is open, the
  // scheduled_alarms rows for it (read-only "already set" display), and
  // the tester's new-date/new-time inputs for the Update Time button.
  const [testOpenId, setTestOpenId] = useState(null);
  const [testAlarms, setTestAlarms] = useState([]);
  const [testDate, setTestDate] = useState('');
  const [testTime, setTestTime] = useState('');
  const [testMeridiem, setTestMeridiem] = useState('AM');
  const [testErrors, setTestErrors] = useState({});

  const loadContacts = () => {
    try {
      const data = getAllContacts();
      setContacts(data);
      setTemplates(getAllTemplates());
    } catch (error) {
      handleError(error, 'ContactListScreen.loadContacts');
      showError('Error', ErrorMessages.DB_READ);
    }
  };

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

  // Update Time — updates contacts.expiry_date / expiry_datetime AND, if
  // the expiry actually changed, reschedules that contact's alarms via
  // updateContactAndReschedule() (cancel old + schedule new against active
  // templates). This is now the same path a real edit would take.
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

      const { ok, rescheduled } = await updateContactAndReschedule({
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
      showSuccess(
        'Time Updated',
        `${contact.name}'s expiry has been updated${rescheduled ? ' and alarms rescheduled.' : ' in the database.'}`
      );
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
    }, [])
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

  /**
   * Deleting a contact must also clean up any alarms scheduled for it —
   * otherwise AlarmManager keeps a dangling exact-alarm entry pointing at
   * a contact that no longer exists. cancelAlarmsForContact() cancels the
   * native alarm AND marks the scheduled_alarms row 'cancelled' (audit
   * trail preserved, not deleted). Runs before the DB delete so we still
   * have contact.id to look up its alarms.
   */
  const handleDelete = (id, name) => {
    showConfirm(
      'Delete Contact',
      `Are you sure you want to delete "${name}"?`,
      async () => {
        try {
          if (Platform.OS === 'android') {
            const cancelledCount = await cancelAlarmsForContact(id);
            console.log(`[ContactListScreen] Cancelled ${cancelledCount} alarm(s) for deleted contact ${id}`);
          }

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
            <Text style={styles.contactName}>{item.name}</Text>
            <Text style={styles.contactPhone}>{item.phone_number}</Text>
            <Text style={styles.contactExpiry}>Expires: {formatExpiryDate12Hour(item.expiry_datetime)}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: status.bg }]}>
            <Text style={[styles.badgeText, { color: status.color }]}>{status.label}</Text>
          </View>
        </View>
        <View style={styles.cardFooter}>
          <TouchableOpacity style={styles.btnSend} onPress={() => handleSend(item)}>
            <Text style={styles.btnSendText}>Send Message</Text>
          </TouchableOpacity>
          {__DEV__ && (
            <TouchableOpacity style={styles.btnTest} onPress={() => toggleTestPanel(item)}>
              <Text style={styles.btnTestText}>{testOpenId === item.id ? 'Close Test' : 'Test'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.btnDelete} onPress={() => handleDelete(item.id, item.name)}>
            <Text style={styles.btnDeleteText}>Delete</Text>
          </TouchableOpacity>
        </View>

        {__DEV__ && testOpenId === item.id && (
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
          <Text style={styles.headerSubtitle}>{contacts.length} contact{contacts.length !== 1 ? 's' : ''}</Text>
        </View>
        {/* Dev/Testing only — hidden in production builds */}
        {__DEV__ && (
          <TouchableOpacity style={styles.checkBtn} onPress={handleCheckExpiring}>
            <Text style={styles.checkBtnText}>Check Expiring</Text>
          </TouchableOpacity>
        )}
      </View>
      <FlatList
        data={contacts}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>👥</Text>
            <Text style={styles.emptyTitle}>No Contacts Yet</Text>
            <Text style={styles.emptySubtitle}>Add your first contact to get started</Text>
          </View>
        }
      />
      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('AddContact', { onSave: loadContacts })}>
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
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  avatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#1A1A2E', justifyContent: 'center', alignItems: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 16, fontWeight: '600', color: '#1A1A2E' },
  contactPhone: { fontSize: 13, color: '#666', marginTop: 2 },
  contactExpiry: { fontSize: 12, color: '#999', marginTop: 2, flexShrink: 1 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  cardFooter: {
    flexDirection: 'row', borderTopWidth: 1,
    borderTopColor: '#F5F5F5', padding: 12, gap: 8,
  },
  btnSend: {
    flex: 1, backgroundColor: '#1A1A2E',
    paddingVertical: 10, borderRadius: 10, alignItems: 'center',
  },
  btnSendText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  btnDelete: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 10, alignItems: 'center',
    borderWidth: 1, borderColor: '#FFE0E0', backgroundColor: '#FFF5F5',
  },
  btnDeleteText: { color: '#D32F2F', fontWeight: '600', fontSize: 14 },
  btnTest: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 10, alignItems: 'center',
    borderWidth: 1, borderColor: '#E0E0F0', backgroundColor: '#F4F4FB',
  },
  btnTestText: { color: '#4A4A8A', fontWeight: '600', fontSize: 14 },
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
    position: 'absolute', bottom: 24, right: 20, left: 20,
    backgroundColor: '#1A1A2E', paddingVertical: 16,
    borderRadius: 14, alignItems: 'center', elevation: 5,
  },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  emptyContainer: { alignItems: 'center', marginTop: 80 },
  emptyIcon: { fontSize: 60, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#1A1A2E' },
  emptySubtitle: { fontSize: 14, color: '#888', marginTop: 8 },
});