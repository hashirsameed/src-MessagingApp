import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  StatusBar, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getDefaultPlatform, setDefaultPlatform, getSmsPerHourLimit, setSmsPerHourLimit } from '../database/settingsDB';
import { handleError, showError, showSuccess, ErrorMessages } from '../utils/errorHandler';
import { runExpiryCheck } from '../utils/scheduler';
import { hasWhatsAppCredentials } from '../utils/whatsappService';

const PLATFORM_OPTIONS = [
  { id: 'sms',      name: 'SMS',      icon: '📱' },
  { id: 'whatsapp', name: 'WhatsApp', icon: '💬' },
  { id: 'email',    name: 'Email',    icon: '📧' },
  { id: 'gmail',    name: 'Gmail',    icon: '📩' },
];

export default function SettingsScreen({ navigation }) {
  const [defaultPlatform, setDefaultPlatformState] = useState(null);
  const [runningCheck, setRunningCheck]             = useState(false);
  const [waConfigured, setWaConfigured]             = useState(false);
  const [smsPerHour, setSmsPerHourState]            = useState('300');

  const loadSettings = async () => {
    try {
      setDefaultPlatformState(getDefaultPlatform());
      setSmsPerHourState(String(getSmsPerHourLimit()));
      const configured = await hasWhatsAppCredentials();
      setWaConfigured(configured);
    } catch (error) {
      handleError(error, 'SettingsScreen.loadSettings');
      showError('Error', ErrorMessages.DB_READ);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadSettings();
    }, []),
  );

  const handleSelectPlatform = (platform) => {
    try {
      const ok = setDefaultPlatform(platform.id);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      setDefaultPlatformState(platform.id);
      showSuccess('Default Updated', `${platform.name} is now your default platform.`);
    } catch (error) {
      handleError(error, 'SettingsScreen.handleSelectPlatform');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleSaveSmsLimit = () => {
    const num = parseInt(smsPerHour, 10);
    if (isNaN(num) || num <= 0) {
      showError('Error', 'Enter a valid number greater than 0.');
      return;
    }
    try {
      const ok = setSmsPerHourLimit(num);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      showSuccess('Saved', `SMS limit set to ${num} per hour.`);
    } catch (error) {
      handleError(error, 'SettingsScreen.handleSaveSmsLimit');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleRunNow = () => {
    Alert.alert(
      'Run Check Now',
      'This will scan all contacts, queue expiring ones, and send messages automatically.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Run',
          onPress: async () => {
            setRunningCheck(true);
            try {
              const summary = await runExpiryCheck();
              setRunningCheck(false);
              Alert.alert(
                'Check Complete',
                `Contacts checked: ${summary.checked}\n` +
                `Queued & sending: ${summary.queued}\n` +
                `Skipped (no template): ${summary.skippedNoTemplate ?? 0}`,
              );
            } catch (error) {
              setRunningCheck(false);
              handleError(error, 'SettingsScreen.handleRunNow');
              showError('Error', 'Check failed. See logs for details.');
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
        <Text style={styles.headerSubtitle}>Manage app preferences</Text>
      </View>

      {/* ── Default Platform ── */}
      <Text style={styles.sectionLabel}>DEFAULT PLATFORM</Text>
      <Text style={styles.sectionHint}>
        Messages will be sent via this platform automatically.
      </Text>

      {PLATFORM_OPTIONS.map((platform) => {
        const isSelected = defaultPlatform === platform.id;
        return (
          <TouchableOpacity
            key={platform.id}
            style={[styles.card, isSelected && styles.cardSelected]}
            onPress={() => handleSelectPlatform(platform)}
            activeOpacity={0.7}>
            <View style={styles.iconContainer}>
              <Text style={styles.icon}>{platform.icon}</Text>
            </View>
            <Text style={styles.label}>{platform.name}</Text>
            <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
              {isSelected && <View style={styles.radioInner} />}
            </View>
          </TouchableOpacity>
        );
      })}

      {!defaultPlatform && (
        <Text style={styles.noDefaultText}>
          No default set — SMS will be used as fallback.
        </Text>
      )}

      {/* ── WhatsApp API Config ── */}
      <Text style={[styles.sectionLabel, { marginTop: 28 }]}>WHATSAPP API</Text>
      <Text style={styles.sectionHint}>
        Configure Meta API credentials for fully automatic WhatsApp sending.
      </Text>

      <TouchableOpacity
        style={[styles.card, styles.waCard]}
        onPress={() => navigation.navigate('WhatsAppConfig')}
        activeOpacity={0.7}>
        <View style={styles.iconContainer}>
          <Text style={styles.icon}>💬</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>WhatsApp Configuration</Text>
          <Text style={[styles.waStatus, waConfigured ? styles.waStatusOk : styles.waStatusOff]}>
            {waConfigured ? '✅ Configured' : '⚠️ Not configured'}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </TouchableOpacity>

      {/* ── SMS Rate Limit ── */}
      <Text style={[styles.sectionLabel, { marginTop: 28 }]}>SMS RATE LIMIT</Text>
      <Text style={styles.sectionHint}>
        Max SMS messages sent per rolling 60-minute window. Extra messages wait in the queue and send automatically once the window frees up — nothing is ever dropped.
      </Text>

      <View style={[styles.card, styles.smsLimitCard]}>
        <TextInput
          style={styles.smsLimitInput}
          keyboardType="numeric"
          value={smsPerHour}
          onChangeText={(v) => setSmsPerHourState(v.replace(/[^0-9]/g, ''))}
          placeholder="e.g. 300"
          placeholderTextColor="#BDBDBD"
        />
        <TouchableOpacity onPress={handleSaveSmsLimit} style={styles.smsLimitSaveBtn} activeOpacity={0.8}>
          <Text style={styles.smsLimitSaveBtnText}>Save</Text>
        </TouchableOpacity>
      </View>

      {/* ── Scheduler (Dev/Testing only — hidden in production builds) ── */}
      {__DEV__ && (
        <>
          <Text style={[styles.sectionLabel, { marginTop: 28 }]}>SCHEDULER (DEV ONLY)</Text>
          <Text style={styles.sectionHint}>
            Manually trigger a check. Messages will be sent automatically after queuing.
          </Text>
          <Text style={[styles.sectionHint, { marginTop: -10 }]}>
            Each template's own "days before expiry" setting controls its schedule.
          </Text>

          <TouchableOpacity
            style={[styles.runBtn, runningCheck && styles.runBtnDisabled]}
            onPress={handleRunNow}
            disabled={runningCheck}
            activeOpacity={0.8}>
            {runningCheck
              ? <ActivityIndicator size="small" color="#fff" />
              : <><Text style={styles.runBtnIcon}>🔍</Text>
                 <Text style={styles.runBtnText}>Run Check Now</Text></>}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  content:   { paddingBottom: 40 },

  header: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
    marginBottom: 4,
  },
  headerTitle:    { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 14, color: '#888', marginTop: 2 },

  sectionLabel: {
    fontSize: 10, color: '#9E9E9E', fontWeight: '700',
    letterSpacing: 1.5, marginHorizontal: 16, marginTop: 20, marginBottom: 6,
  },
  sectionHint: {
    fontSize: 12, color: '#9E9E9E', marginHorizontal: 16, marginBottom: 14, lineHeight: 17,
  },

  card: {
    backgroundColor: '#fff', borderRadius: 14, padding: 16,
    marginHorizontal: 16, marginBottom: 10,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  cardSelected: { borderColor: '#1A1A2E', backgroundColor: '#FAFAFA' },
  waCard:       { alignItems: 'center' },
  iconContainer: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: '#F8F9FA',
    justifyContent: 'center', alignItems: 'center', marginRight: 14,
  },
  icon:    { fontSize: 24 },
  label:   { fontSize: 16, fontWeight: '600', color: '#1A1A2E' },
  chevron: { fontSize: 22, color: '#BDBDBD', marginLeft: 8 },

  waStatus:    { fontSize: 12, marginTop: 2 },
  waStatusOk:  { color: '#10B981' },
  waStatusOff: { color: '#F59E0B' },

  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: '#BDBDBD',
    justifyContent: 'center', alignItems: 'center',
  },
  radioOuterSelected: { borderColor: '#1A1A2E' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#1A1A2E' },
  noDefaultText: {
    fontSize: 12, color: '#9E9E9E', marginHorizontal: 16, marginTop: 8, textAlign: 'center',
  },

  smsLimitCard: { alignItems: 'center', gap: 12 },
  smsLimitInput: {
    flex: 1, fontSize: 16, color: '#1A1A2E',
    paddingVertical: 4,
  },
  smsLimitSaveBtn: {
    backgroundColor: '#1A1A2E', paddingHorizontal: 18,
    paddingVertical: 10, borderRadius: 10,
  },
  smsLimitSaveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  runBtn: {
    marginHorizontal: 16, backgroundColor: '#1A1A2E',
    borderRadius: 14, paddingVertical: 15,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  runBtnDisabled: { backgroundColor: '#BDBDBD' },
  runBtnIcon:     { fontSize: 16 },
  runBtnText:     { color: '#fff', fontSize: 15, fontWeight: '700' },
});