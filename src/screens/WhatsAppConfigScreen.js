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
  saveWhatsAppCredentials,
  getWhatsAppCredentials,
  clearWhatsAppCredentials,
  testWhatsAppConnection,
} from '../utils/whatsappService';
import { handleError, showError, showSuccess } from '../utils/errorHandler';

export default function WhatsAppConfigScreen({ navigation }) {
  const [accessToken, setAccessToken]           = useState('');
  const [phoneNumberId, setPhoneNumberId]       = useState('');
  const [businessAccountId, setBusinessAccountId] = useState('');
  const [isConfigured, setIsConfigured]         = useState(false);
  const [loading, setLoading]                   = useState(true);
  const [saving, setSaving]                     = useState(false);
  const [testing, setTesting]                   = useState(false);
  const [showToken, setShowToken]               = useState(false);

  useEffect(() => {
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    try {
      setLoading(true);
      const creds = await getWhatsAppCredentials();
      if (creds) {
        setAccessToken(creds.accessToken ?? '');
        setPhoneNumberId(creds.phoneNumberId ?? '');
        setBusinessAccountId(creds.businessAccountId ?? '');
        setIsConfigured(true);
      }
    } catch (error) {
      handleError(error, 'WhatsAppConfigScreen.loadCredentials');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!accessToken.trim()) {
      showError('Missing Field', 'Please enter your Access Token.');
      return;
    }
    if (!phoneNumberId.trim()) {
      showError('Missing Field', 'Please enter your Phone Number ID.');
      return;
    }

    setSaving(true);
    try {
      const ok = await saveWhatsAppCredentials(
        accessToken.trim(),
        phoneNumberId.trim(),
        businessAccountId.trim() || null,
      );
      if (ok) {
        setIsConfigured(true);
        showSuccess('Saved', 'WhatsApp credentials saved securely.');
      } else {
        showError('Error', 'Failed to save credentials. Please try again.');
      }
    } catch (error) {
      handleError(error, 'WhatsAppConfigScreen.handleSave');
      showError('Error', 'Failed to save credentials.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!accessToken.trim() || !phoneNumberId.trim()) {
      showError('Missing Fields', 'Save your credentials first, then test.');
      return;
    }

    setTesting(true);
    try {
      const result = await testWhatsAppConnection();
      if (result.success) {
        Alert.alert('✅ Connected', `WhatsApp Business Account: ${result.displayName}`);
      } else {
        Alert.alert('❌ Connection Failed', result.error ?? 'Unknown error');
      }
    } catch (error) {
      handleError(error, 'WhatsAppConfigScreen.handleTest');
      showError('Error', 'Test failed.');
    } finally {
      setTesting(false);
    }
  };

  const handleClear = () => {
    Alert.alert(
      'Remove Credentials',
      'Are you sure you want to remove WhatsApp API credentials? Automatic sending will stop.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await clearWhatsAppCredentials();
            setAccessToken('');
            setPhoneNumberId('');
            setBusinessAccountId('');
            setIsConfigured(false);
            showSuccess('Removed', 'WhatsApp credentials cleared.');
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
            ? 'WhatsApp API configured — automatic sending active'
            : 'Not configured — WhatsApp messages cannot be sent automatically'}
        </Text>
      </View>

      {/* Info box */}
      <View style={styles.infoBox}>
        <Text style={styles.infoTitle}>Where to get these?</Text>
        <Text style={styles.infoText}>
          1. Go to developers.facebook.com{'\n'}
          2. Create an App → Add WhatsApp product{'\n'}
          3. Copy your Phone Number ID, Access Token, and Business Account ID{'\n'}
          4. For testing: use the free test number Meta provides
        </Text>
      </View>

      {/* Phone Number ID */}
      <Text style={styles.fieldLabel}>PHONE NUMBER ID</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={phoneNumberId}
          onChangeText={setPhoneNumberId}
          placeholder="e.g. 123456789012345"
          placeholderTextColor="#BDBDBD"
          keyboardType="numeric"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Business Account ID */}
      <Text style={styles.fieldLabel}>WHATSAPP BUSINESS ACCOUNT ID</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={businessAccountId}
          onChangeText={setBusinessAccountId}
          placeholder="e.g. 172218051236131 (optional)"
          placeholderTextColor="#BDBDBD"
          keyboardType="numeric"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <Text style={styles.fieldHint}>
        Required only for managing message templates (create/view approval status).
        Sending messages works without it.
      </Text>

      {/* Access Token */}
      <Text style={styles.fieldLabel}>ACCESS TOKEN</Text>
      <View style={styles.inputContainer}>
        <TextInput
          style={[styles.input, styles.inputToken]}
          value={accessToken}
          onChangeText={setAccessToken}
          placeholder="EAAxxxxxx..."
          placeholderTextColor="#BDBDBD"
          secureTextEntry={!showToken}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={false}
        />
        <TouchableOpacity
          style={styles.eyeBtn}
          onPress={() => setShowToken((v) => !v)}>
          <Text style={styles.eyeIcon}>{showToken ? '🙈' : '👁️'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.tokenHint}>
        Keep this token secret — it allows sending messages on your behalf.
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

      {/* Test button */}
      <TouchableOpacity
        style={[styles.btn, styles.btnSecondary, testing && styles.btnDisabled]}
        onPress={handleTest}
        disabled={testing}
        activeOpacity={0.8}>
        {testing
          ? <ActivityIndicator size="small" color="#1A1A2E" />
          : <Text style={styles.btnTextSecondary}>🔌 Test Connection</Text>}
      </TouchableOpacity>

      {/* Manage Templates button — only if Business Account ID is set */}
      {isConfigured && businessAccountId.trim() ? (
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary]}
          onPress={() => navigation.navigate('WhatsAppTemplates')}
          activeOpacity={0.8}>
          <Text style={styles.btnTextSecondary}>📋 Manage Message Templates</Text>
        </TouchableOpacity>
      ) : null}

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