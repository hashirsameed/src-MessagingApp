import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, ScrollView,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { simulateExpiryCheckAt } from '../utils/devSimulation';
import { formatPakistanDateTime } from '../utils/pakistanTime';

export default function DevTestScreen() {
  const [fakeNowMs, setFakeNowMs] = useState(Date.now());
  const [log, setLog] = useState([]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const resetNow = () => setFakeNowMs(Date.now());

  // Android's native pickers are two separate modal dialogs (calendar, then
  // clock) — there's no combined "date+time" mode. Picking a date keeps the
  // current time-of-day, and vice versa, so each only changes its own part.
  const onDateChange = (event, selectedDate) => {
    setShowDatePicker(false);
    if (event.type === 'dismissed' || !selectedDate) return;
    setFakeNowMs((prev) => {
      const merged = new Date(selectedDate);
      const prevD = new Date(prev);
      merged.setHours(prevD.getHours(), prevD.getMinutes(), prevD.getSeconds(), 0);
      return merged.getTime();
    });
  };

  const onTimeChange = (event, selectedTime) => {
    setShowTimePicker(false);
    if (event.type === 'dismissed' || !selectedTime) return;
    setFakeNowMs((prev) => {
      const merged = new Date(prev);
      merged.setHours(selectedTime.getHours(), selectedTime.getMinutes(), 0, 0);
      return merged.getTime();
    });
  };

  const runSimulation = () => {
    const fired = simulateExpiryCheckAt(fakeNowMs);
    const header = {
      id: `run-${Date.now()}`,
      isHeader: true,
      atMs: fakeNowMs,
      count: fired.length,
    };
    const entries = fired.map((f, i) => ({
      id: `${header.id}-${f.contactId}-${f.templateId}-${i}`,
      ...f,
    }));
    setLog((prev) => [header, ...entries, ...prev]);
  };

  const clearLog = () => setLog([]);

  const isTimeTravel = Math.abs(fakeNowMs - Date.now()) > 60000;
  const fakeDate = new Date(fakeNowMs);
  const dateLabel = fakeDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeLabel = fakeDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>🧪 Testing Lab</Text>
        <Text style={styles.headerSubtitle}>
          Dry-run only — no SMS/WhatsApp is sent, no real alarms are touched, nothing is queued.
        </Text>
      </View>

      {/* ── Simulated clock ── */}
      <Text style={styles.sectionLabel}>SIMULATED TIME</Text>
      <View style={[styles.clockCard, isTimeTravel && styles.clockCardTravel]}>
        <Text style={styles.clockValue}>
          {formatPakistanDateTime(new Date(fakeNowMs).toISOString())}
        </Text>
        <Text style={styles.clockSub}>
          {isTimeTravel ? '⏱ Time-travel active — this is NOT the real device clock' : 'Pakistan time · matches real clock'}
        </Text>
      </View>

      <View style={styles.dateTimeRow}>
        <TouchableOpacity
          style={styles.dateTimeBtn}
          onPress={() => setShowDatePicker(true)}
          activeOpacity={0.8}>
          <Text style={styles.dateTimeBtnLabel}>📅 Date</Text>
          <Text style={styles.dateTimeBtnValue}>{dateLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.dateTimeBtn}
          onPress={() => setShowTimePicker(true)}
          activeOpacity={0.8}>
          <Text style={styles.dateTimeBtnLabel}>🕐 Time</Text>
          <Text style={styles.dateTimeBtnValue}>{timeLabel}</Text>
        </TouchableOpacity>
      </View>

      {showDatePicker && (
        <DateTimePicker
          value={fakeDate}
          mode="date"
          display="default"
          onChange={onDateChange}
        />
      )}
      {showTimePicker && (
        <DateTimePicker
          value={fakeDate}
          mode="time"
          display="default"
          is24Hour={false}
          onChange={onTimeChange}
        />
      )}

      <TouchableOpacity style={styles.resetBtn} onPress={resetNow} activeOpacity={0.7}>
        <Text style={styles.resetBtnText}>↺ Reset to real now</Text>
      </TouchableOpacity>

      {/* ── Run ── */}
      <Text style={[styles.sectionLabel, { marginTop: 26 }]}>SIMULATION</Text>
      <Text style={styles.sectionHint}>
        Scans all contacts × active templates at the simulated time above — the exact same
        matching + grace-window logic the real scheduler uses — and logs what WOULD fire.
      </Text>
      <TouchableOpacity style={styles.runBtn} onPress={runSimulation} activeOpacity={0.85}>
        <Text style={styles.runBtnText}>▶ Run Check at Simulated Time</Text>
      </TouchableOpacity>

      {/* ── Log ── */}
      <View style={styles.logHeaderRow}>
        <Text style={styles.sectionLabel}>LIVE LOG</Text>
        {log.length > 0 && (
          <TouchableOpacity onPress={clearLog}>
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {log.length === 0 && (
        <Text style={styles.emptyLog}>No runs yet — jump the clock and tap Run.</Text>
      )}

      {log.map((entry) =>
        entry.isHeader ? (
          <View key={entry.id} style={styles.runHeaderCard}>
            <Text style={styles.runHeaderText}>
              Run @ {formatPakistanDateTime(new Date(entry.atMs).toISOString())} — {entry.count} would fire
            </Text>
          </View>
        ) : (
          <View key={entry.id} style={styles.logCard}>
            <View style={styles.logCardTop}>
              <Text style={styles.logContact}>{entry.contactName}</Text>
              <View style={styles.dryRunBadge}>
                <Text style={styles.dryRunBadgeText}>DRY RUN</Text>
              </View>
            </View>
            <Text style={styles.logMeta}>
              {String(entry.platformId).toUpperCase()} · "{entry.templateTitle}" · {entry.daysLeft} day(s)
              {entry.metaTemplateName ? ` · Meta: ${entry.metaTemplateName}` : ''}
            </Text>
            <Text style={styles.logBody}>{entry.rendered}</Text>
          </View>
        )
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  content:   { paddingBottom: 40 },

  header: {
    backgroundColor: '#fff',
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: '#F0F0F0', marginBottom: 4,
  },
  headerTitle:    { fontSize: 24, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 12, color: '#888', marginTop: 4, lineHeight: 17 },

  sectionLabel: {
    fontSize: 10, color: '#9E9E9E', fontWeight: '700',
    letterSpacing: 1.5, marginHorizontal: 16, marginTop: 20, marginBottom: 6,
  },
  sectionHint: {
    fontSize: 12, color: '#9E9E9E', marginHorizontal: 16, marginBottom: 12, lineHeight: 17,
  },

  clockCard: {
    marginHorizontal: 16, backgroundColor: '#fff', borderRadius: 14,
    padding: 16, borderWidth: 1.5, borderColor: '#F0F0F0',
  },
  clockCardTravel: { borderColor: '#1A1A2E', backgroundColor: '#F5F5FA' },
  clockValue: { fontSize: 17, fontWeight: '700', color: '#1A1A2E' },
  clockSub:   { fontSize: 11, color: '#9E9E9E', marginTop: 4 },

  dateTimeRow: {
    flexDirection: 'row', gap: 10,
    marginHorizontal: 16, marginTop: 12,
  },
  dateTimeBtn: {
    flex: 1, backgroundColor: '#fff', borderRadius: 12,
    paddingVertical: 12, paddingHorizontal: 14,
    borderWidth: 1.5, borderColor: '#EEEEEE',
  },
  dateTimeBtnLabel: { fontSize: 10, color: '#9E9E9E', fontWeight: '700', letterSpacing: 0.5 },
  dateTimeBtnValue: { fontSize: 15, color: '#1A1A2E', fontWeight: '700', marginTop: 3 },

  resetBtn: { marginHorizontal: 16, marginTop: 10, alignSelf: 'flex-start' },
  resetBtnText: { fontSize: 12, color: '#3730A3', fontWeight: '600' },

  runBtn: {
    marginHorizontal: 16, backgroundColor: '#1A1A2E',
    borderRadius: 14, paddingVertical: 15, alignItems: 'center',
  },
  runBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  logHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginTop: 26,
  },
  clearText: { fontSize: 12, color: '#D32F2F', fontWeight: '600' },
  emptyLog: {
    fontSize: 12, color: '#9E9E9E', marginHorizontal: 16,
    marginTop: 4, fontStyle: 'italic',
  },

  runHeaderCard: {
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: '#EEF2FF', borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  runHeaderText: { fontSize: 11, fontWeight: '700', color: '#3730A3' },

  logCard: {
    marginHorizontal: 16, marginTop: 8,
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#F0F0F0',
  },
  logCardTop: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  logContact: { fontSize: 14, fontWeight: '700', color: '#1A1A2E' },
  dryRunBadge: {
    backgroundColor: '#FFF8EB', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
  },
  dryRunBadgeText: { fontSize: 9, fontWeight: '700', color: '#F59E0B', letterSpacing: 0.5 },
  logMeta: { fontSize: 11, color: '#6B7280', marginTop: 4 },
  logBody: { fontSize: 12, color: '#4B5563', marginTop: 6, lineHeight: 17 },
});