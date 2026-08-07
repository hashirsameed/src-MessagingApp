import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import {
  saveBulkSmsCredentials,
  getBulkSmsCredentials,
  clearBulkSmsCredentials,
  sendBulkSms,
} from '../utils/bulkSmsService';
import { togglePlatformEnabled } from '../database/platformDB';
import { handleError, showError, showSuccess } from '../utils/errorHandler';

export default function BulkSmsConfigScreen() {
  const [apiUrl, setApiUrl]             = useState('');
  const [apiKey, setApiKey]             = useState('');
  const [senderId, setSenderId]         = useState('');
  const [testPhone, setTestPhone]       = useState('');
  const [isConfigured, setIsConfigured] = useState(false);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [testing, setTesting]           = useState(false);
  const [showKey, setShowKey]           = useState(false);

  useEffect(() => {
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    try {
      setLoading(true);
      const creds = await getBulkSmsCredentials();
      if (creds) {
        setApiUrl(creds.apiUrl ?? '');
        setApiKey(creds.apiKey ?? '');
        setSenderId(creds.senderId ?? '');
        setIsConfigured(true);
      }
    } catch (error) {
      handleError(error, 'BulkSmsConfigScreen.loadCredentials');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!apiUrl.trim()) {
      showError('Missing Field', 'Please enter the provider\'s API URL.');
      return;
    }
    if (!apiKey.trim()) {
      showError('Missing Field', 'Please enter your API Key.');
      return;
    }

    setSaving(true);
    try {
      const ok = await saveBulkSmsCredentials(
        apiUrl.trim(),
        apiKey.trim(),
        senderId.trim() || null,
      );
      if (ok) {
        setIsConfigured(true);
        // Bulk SMS is seeded disabled (db.js) until first configured —
        // flip it on now so it actually becomes usable, same moment
        // WhatsApp effectively becomes usable once credentials are saved.
        togglePlatformEnabled('sms_bulk', true);
        showSuccess('Saved', 'Bulk SMS credentials saved securely.');
      } else {
        showError('Error', 'Failed to save credentials. Please try again.');
      }
    } catch (error) {
      handleError(error, 'BulkSmsConfigScreen.handleSave');
      showError('Error', 'Failed to save credentials.');
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    if (!apiUrl.trim() || !apiKey.trim()) {
      showError('Missing Fields', 'Save your credentials first, then send a test.');
      return;
    }
    if (!testPhone.trim()) {
      showError('Missing Field', 'Enter a phone number to send the test SMS to.');
      return;
    }

    setTesting(true);
    try {
      const result = await sendBulkSms(testPhone.trim(), 'Test message from your Bulk SMS gateway setup.');
      if (result.success) {
        Alert.alert('✅ Sent', 'Test SMS sent successfully — check the recipient phone.');
      } else {
        Alert.alert('❌ Failed', result.error ?? 'Unknown error');
      }
    } catch (error) {
      handleError(error, 'BulkSmsConfigScreen.handleSendTest');
      showError('Error', 'Test send failed.');
    } finally {
      setTesting(false);
    }
  };

  const handleClear = () => {
    Alert.alert(
      'Remove Credentials',
      'Are you sure you want to remove Bulk SMS credentials? Automatic sending through this gateway will stop, and this platform will fall back to being paused.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await clearBulkSmsCredentials();
            togglePlatformEnabled('sms_bulk', false);
            setApiUrl('');
            setApiKey('');
            setSenderId('');
            setIsConfigured(false);
            showSuccess('Removed', 'Bulk SMS credentials cleared.');
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1A1A2E" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">

      {/* Status banner */}
      <View style={[styles.statusBanner, isConfigured ? styles.statusGreen : styles.statusOrange]}>
        <Text style={styles.statusIcon}>{isConfigured ? '✅' : '⚠️'}</Text>
        <Text style={styles.statusText}>
          {isConfigured
            ? 'Bulk SMS configured — automatic sending active'
            : 'Not configured — Bulk SMS messages cannot be sent automatically'}
        </Text>
      </View>

      {/* Info box */}
      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>Generic gateway — for now</Text>
        <Text style={styles.infoText}>
          This connects to any provider that accepts a JSON POST with {'{ to, message, sender_id }'} and
          a Bearer API key. Once you pick a specific provider (Twilio, Vonage, a local gateway, etc.),
          the request shape can be customized in bulkSmsService.js without touching anything else.
        </Text>
      </View>

      {/* When connected, this platform's own send limit is what governs
          pacing — not the app's default 150/15min, 250/1hr, 750/24hr SMS
          tiers. Set that limit from Settings → SMS platform → Custom
          Override, using whatever your provider allows. */}
      <View style={[styles.infoBox, styles.infoBoxAmber]}>
        <Text style={styles.infoTitle}>About rate limits</Text>
        <Text style={styles.infoText}>
          Bulk SMS bypasses the app's default tiered SMS limits. Set your own limit for this
          platform from Settings → Bulk SMS → Custom Override, matching whatever your provider allows.
        </Text>
      </View>

      {/* API URL */}
      <Text style={styles.fieldLabel}>API URL</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="https://api.yourprovider.com/v1/sms/send"
          placeholderTextColor="#BDBDBD"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </View>

      {/* Sender ID */}
      <Text style={styles.fieldLabel}>SENDER ID</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={senderId}
          onChangeText={setSenderId}
          placeholder="e.g. MyBrand (optional)"
          placeholderTextColor="#BDBDBD"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <Text style={styles.fieldHint}>
        Only included in the request if your provider supports/requires a sender ID.
      </Text>

      {/* API Key */}
      <Text style={styles.fieldLabel}>API KEY</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={[styles.input, styles.inputToken]}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="Your provider's API key"
          placeholderTextColor="#BDBDBD"
          secureTextEntry={!showKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.eyeBtn}
          onPress={() => setShowKey((v) => !v)}>
          <Text style={styles.eyeIcon}>{showKey ? '🙈' : '👁️'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.tokenHint}>
        Sent as "Authorization: Bearer …" — keep this secret.
      </Text>

      {/* Save button */}
      <TouchableOpacity
        style={[styles.btn, styles.btnPrimary, saving && styles.btnDisabled]}
        onPress={handleSave}
        disabled={saving}
        activeOpacity={0.8}>
        {saving
          ? <ActivityIndicator size="small" color="#fff" />
          : <Text style={styles.btnText}>💾 Save Credentials</Text>}
      </TouchableOpacity>

      {/* Test send */}
      <Text style={styles.fieldLabel}>SEND TEST SMS TO</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={testPhone}
          onChangeText={setTestPhone}
          placeholder="e.g. +923001234567"
          placeholderTextColor="#BDBDBD"
          keyboardType="phone-pad"
        />
      </View>
      <TouchableOpacity
        style={[styles.btn, styles.btnSecondary, testing && styles.btnDisabled]}
        onPress={handleSendTest}
        disabled={testing}
        activeOpacity={0.8}>
        {testing
          ? <ActivityIndicator size="small" color="#1A1A2E" />
          : <Text style={styles.btnTextSecondary}>🔌 Send Test SMS</Text>}
      </TouchableOpacity>

      {/* Clear button */}
      {isConfigured && (
        <TouchableOpacity
          style={[styles.btn, styles.btnDanger]}
          onPress={handleClear}
          activeOpacity={0.8}>
          <Text style={styles.btnTextDanger}>🗑 Remove Credentials</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#F8F9FA' },
  content:          { padding: 16, paddingBottom: 40 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    gap: 10,
  },
  statusGreen:  { backgroundColor: '#ECFDF5' },
  statusOrange: { backgroundColor: '#FFFBEB' },
  statusIcon:   { fontSize: 18 },
  statusText:   { flex: 1, fontSize: 13, fontWeight: '600', color: '#374151' },

  infoBox: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
  },
  infoBoxAmber: { backgroundColor: '#FFFBEB' },
  infoTitle: { fontSize: 13, fontWeight: '700', color: '#1D4ED8', marginBottom: 6 },
  infoText:  { fontSize: 12, color: '#374151', lineHeight: 20 },

  fieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#9E9E9E',
    letterSpacing: 1.5,
    marginBottom: 8,
    marginTop: 4,
  },
  fieldHint: {
    fontSize: 11,
    color: '#9E9E9E',
    marginTop: -10,
    marginBottom: 20,
    marginHorizontal: 4,
    lineHeight: 16,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#F0F0F0',
    marginBottom: 16,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#1A1A2E',
    paddingVertical: 14,
  },
  inputToken: { paddingRight: 8 },
  eyeBtn:     { padding: 4 },
  eyeIcon:    { fontSize: 18 },

  tokenHint: {
    fontSize: 11,
    color: '#EF4444',
    marginTop: -10,
    marginBottom: 20,
    marginHorizontal: 4,
  },

  btn: {
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  btnPrimary:       { backgroundColor: '#1A1A2E' },
  btnSecondary:     { backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#1A1A2E' },
  btnDanger:        { backgroundColor: '#FEF2F2', borderWidth: 1.5, borderColor: '#EF4444' },
  btnDisabled:      { opacity: 0.6 },
  btnText:          { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnTextSecondary: { color: '#1A1A2E', fontSize: 15, fontWeight: '700' },
  btnTextDanger:    { color: '#EF4444', fontSize: 15, fontWeight: '700' },
});