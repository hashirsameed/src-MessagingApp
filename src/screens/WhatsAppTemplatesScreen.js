import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, RefreshControl, Alert,
  FlatList, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { fetchMetaTemplates, createMetaTemplate } from '../utils/metaTemplateService';
import { CATEGORIES, LANGUAGES } from '../utils/metaTemplateValidator';
import {
  formatTemplateName,
  extractVariableIndices,
  validateTemplatePayloadInputs,
  buildMetaTemplatePayload,
} from '../utils/metaTemplatePayload';
import { handleError } from '../utils/errorHandler';

const STATUS_META = {
  APPROVED: { color: '#10B981', bg: '#ECFDF5', icon: '✅', label: 'Approved' },
  PENDING:  { color: '#F59E0B', bg: '#FFFBEB', icon: '🟡', label: 'Pending review' },
  REJECTED: { color: '#EF4444', bg: '#FEF2F2', icon: '❌', label: 'Rejected' },
};

const ERROR_CODE_MESSAGES = {
  NO_CREDENTIALS:    'WhatsApp is not configured. Set it up in Settings first.',
  MISSING_WABA_ID:   'Add your WhatsApp Business Account ID in Settings to manage templates.',
  AUTH_FAILED:       'Your access token is invalid or expired. Update it in Settings.',
  RATE_LIMITED:      'Too many requests to Meta. Please wait a moment and try again.',
  META_SERVER_ERROR: 'Meta servers are temporarily unavailable. Try again shortly.',
  TIMEOUT:           'The request timed out. Check your internet connection.',
  NETWORK_ERROR:     'Could not reach Meta. Check your internet connection.',
  INVALID_RESPONSE:  'Received an unexpected response from Meta.',
};

const friendlyError = (errorCode, fallback) =>
  ERROR_CODE_MESSAGES[errorCode] ?? fallback ?? 'Something went wrong.';

export default function WhatsAppTemplatesScreen() {
  const [templates, setTemplates]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError]   = useState(null);
  const [createModalVisible, setCreateModalVisible] = useState(false);

  const loadTemplates = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchMetaTemplates();
      if (result.success) {
        setTemplates(result.templates);
      } else {
        setTemplates([]);
        setLoadError({ code: result.errorCode, message: result.error });
      }
    } catch (error) {
      handleError(error, 'WhatsAppTemplatesScreen.loadTemplates');
      setLoadError({ code: 'UNKNOWN_ERROR', message: 'Failed to load templates.' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadTemplates(); }, [loadTemplates]));

  const renderTemplate = ({ item }) => {
    const meta = STATUS_META[item.status] ?? STATUS_META.PENDING;
    const bodyComponent = item.components?.find((c) => c.type === 'BODY');

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          <View style={[styles.badge, { backgroundColor: meta.bg }]}>
            <Text style={[styles.badgeText, { color: meta.color }]}>{meta.icon} {meta.label}</Text>
          </View>
        </View>
        <Text style={styles.cardMeta}>{item.category} · {item.language}</Text>
        {bodyComponent?.text ? (
          <Text style={styles.cardBody} numberOfLines={2}>{bodyComponent.text}</Text>
        ) : null}
        {item.status === 'REJECTED' && item.rejected_reason ? (
          <View style={styles.rejectBox}>
            <Text style={styles.rejectText}>⚠ {item.rejected_reason}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.container}>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#1A1A2E" />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorTitle}>Couldn't load templates</Text>
          <Text style={styles.errorMessage}>{friendlyError(loadError.code, loadError.message)}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => loadTemplates()}>
            <Text style={styles.retryBtnText}>🔄 Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={templates}
          keyExtractor={(item) => item.id ?? item.name}
          renderItem={renderTemplate}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => loadTemplates(true)} tintColor="#1A1A2E" />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.errorIcon}>📋</Text>
              <Text style={styles.errorTitle}>No templates yet</Text>
              <Text style={styles.errorMessage}>Create your first WhatsApp template to get started.</Text>
            </View>
          }
        />
      )}

      <TouchableOpacity style={styles.fab} onPress={() => setCreateModalVisible(true)}>
        <Text style={styles.fabText}>+ New Template</Text>
      </TouchableOpacity>

      <CreateTemplateModal
        visible={createModalVisible}
        onClose={() => setCreateModalVisible(false)}
        onCreated={() => { setCreateModalVisible(false); loadTemplates(); }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Create Template Modal
// ---------------------------------------------------------------------------

function CreateTemplateModal({ visible, onClose, onCreated }) {
  const [name, setName]         = useState('');
  const [category, setCategory] = useState('');
  const [language, setLanguage] = useState('en_US');
  const [headerText, setHeaderText] = useState('');
  const [bodyText, setBodyText]     = useState('');
  const [footer, setFooter]         = useState('');

  // Component-wise sample state — mirrors Meta's internal variable scoping.
  // header[0] = sample for {{1}} in the header (max 1 variable allowed there).
  // body[i]   = sample for the (i+1)-th sequential variable in the body.
  const [sampleValues, setSampleValues] = useState({
    header: [],
    body: [],
  });

  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors]         = useState({});
  const [apiError, setApiError]     = useState(null);

  const resetForm = () => {
    setName(''); setCategory(''); setLanguage('en_US');
    setHeaderText(''); setBodyText(''); setFooter('');
    setSampleValues({ header: [], body: [] });
    setErrors({}); setApiError(null);
  };

  const handleClose = () => { resetForm(); onClose(); };

  // ── Real-time variable parsing ───────────────────────────────────────
  const headerIndices = extractVariableIndices(headerText);
  const bodyIndices   = extractVariableIndices(bodyText);

  /**
   * Immutable update handler for the component-wise sample state.
   * componentType: 'header' | 'body'
   * index: zero-based slot within that component's sample array
   */
  const handleSampleChange = (componentType, index, value) => {
    setSampleValues((prev) => {
      const nextArray = [...prev[componentType]];
      nextArray[index] = value;
      return { ...prev, [componentType]: nextArray };
    });
    // Clear any stale sample-related error once the user starts fixing it
    setErrors((e) => ({ ...e, headerSample: '', bodySample: '' }));
  };

  // ── Submit readiness check (drives button disabled state) ───────────
  const allSamplesFilled = () => {
    if (headerIndices.length > 0) {
      const v = sampleValues.header[0];
      if (!v || !v.trim()) return false;
    }
    for (let i = 0; i < bodyIndices.length; i++) {
      const v = sampleValues.body[i];
      if (!v || !v.trim()) return false;
    }
    return true;
  };

  const canSubmit =
    name.trim().length > 0 &&
    category.length > 0 &&
    language.length > 0 &&
    bodyText.trim().length > 0 &&
    allSamplesFilled() &&
    !submitting;

  // ── Submit handler ────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setApiError(null);

    // Category / language are simple enum checks, not part of the payload
    // validator (which focuses on variable structure), so check here.
    const fieldErrors = {};
    if (!CATEGORIES.includes(category)) {
      fieldErrors.category = 'Select a valid category: Utility, Marketing, or Authentication.';
    }
    if (!LANGUAGES.some((l) => l.code === language)) {
      fieldErrors.language = 'Select a supported language.';
    }

    const { valid, errors: payloadErrors } = validateTemplatePayloadInputs({
      name, headerText, bodyText, sampleValues,
    });

    const allErrors = { ...fieldErrors, ...payloadErrors };

    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      return;
    }
    setErrors({});

    setSubmitting(true);
    try {
      const payload = buildMetaTemplatePayload(
        name, category, language, headerText, bodyText, sampleValues, footer,
      );

      const result = await createMetaTemplate(payload);

      if (result.success) {
        Alert.alert(
          'Submitted',
          'Your template was submitted to Meta for review. This usually takes a few minutes up to 24 hours.',
        );
        resetForm();
        onCreated();
      } else {
        setApiError(friendlyError(result.errorCode, result.error));
      }
    } catch (error) {
      handleError(error, 'CreateTemplateModal.handleSubmit');
      setApiError('An unexpected error occurred. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>New WhatsApp Template</Text>
          <TouchableOpacity onPress={handleClose}><Text style={styles.modalClose}>✕</Text></TouchableOpacity>
        </View>

        <ScrollView style={styles.modalBody} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

          {apiError ? (
            <View style={styles.apiErrorBox}>
              <Text style={styles.apiErrorText}>⚠ {apiError}</Text>
            </View>
          ) : null}

          {/* Name */}
          <Text style={styles.label}>Template name</Text>
          <Text style={styles.hint}>Auto-formatted to lowercase_with_underscores</Text>
          <TextInput
            style={[styles.input, errors.name && styles.inputError]}
            placeholder="e.g. policy_reminder_3d"
            placeholderTextColor="#BDBDBD"
            value={name}
            onChangeText={(v) => { setName(formatTemplateName(v)); setErrors((e) => ({ ...e, name: '' })); }}
            autoCapitalize="none"
          />
          {name ? <Text style={styles.previewName}>Will be saved as: {formatTemplateName(name)}</Text> : null}
          {errors.name ? <Text style={styles.errorText}>{errors.name}</Text> : null}

          {/* Category */}
          <Text style={[styles.label, { marginTop: 16 }]}>Category</Text>
          <View style={styles.pillRow}>
            {CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat}
                style={[styles.pill, category === cat && styles.pillSelected]}
                onPress={() => { setCategory(cat); setErrors((e) => ({ ...e, category: '' })); }}>
                <Text style={[styles.pillText, category === cat && styles.pillTextSelected]}>{cat}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {errors.category ? <Text style={styles.errorText}>{errors.category}</Text> : null}

          {/* Language */}
          <Text style={[styles.label, { marginTop: 16 }]}>Language</Text>
          <View style={styles.pillRow}>
            {LANGUAGES.map((lang) => (
              <TouchableOpacity
                key={lang.code}
                style={[styles.pill, language === lang.code && styles.pillSelected]}
                onPress={() => { setLanguage(lang.code); setErrors((e) => ({ ...e, language: '' })); }}>
                <Text style={[styles.pillText, language === lang.code && styles.pillTextSelected]}>{lang.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {errors.language ? <Text style={styles.errorText}>{errors.language}</Text> : null}

          {/* ── Header (optional) ── */}
          <Text style={[styles.label, { marginTop: 16 }]}>Header text (optional)</Text>
          <Text style={styles.hint}>Max 1 variable: {'{{1}}'}</Text>
          <TextInput
            style={[styles.input, errors.headerText && styles.inputError]}
            placeholder="e.g. Hello {{1}}"
            placeholderTextColor="#BDBDBD"
            value={headerText}
            onChangeText={(v) => { setHeaderText(v); setErrors((e) => ({ ...e, headerText: '', headerSample: '' })); }}
            maxLength={60}
          />
          {errors.headerText ? <Text style={styles.errorText}>{errors.headerText}</Text> : null}

          {/* Header sample — only rendered if {{1}} present in header */}
          {headerIndices.length > 0 ? (
            <View style={{ marginTop: 8 }}>
              <Text style={styles.sampleLabel}>Sample for header {'{{1}}'}</Text>
              <TextInput
                style={[styles.input, errors.headerSample && styles.inputError]}
                placeholder="e.g. John"
                placeholderTextColor="#BDBDBD"
                value={sampleValues.header[0] ?? ''}
                onChangeText={(v) => handleSampleChange('header', 0, v)}
              />
              {errors.headerSample ? <Text style={styles.errorText}>{errors.headerSample}</Text> : null}
            </View>
          ) : null}

          {/* ── Body (required) ── */}
          <Text style={[styles.label, { marginTop: 16 }]}>Message body</Text>
          <Text style={styles.hint}>
            Use {'{{1}}'}, {'{{2}}'}... for variables. Cannot start/end with a variable.
          </Text>
          <TextInput
            style={[styles.input, styles.textArea, errors.bodyText && styles.inputError]}
            placeholder="Dear {{1}}, your policy expires in {{2}} days."
            placeholderTextColor="#BDBDBD"
            value={bodyText}
            onChangeText={(v) => { setBodyText(v); setErrors((e) => ({ ...e, bodyText: '', bodySample: '' })); }}
            multiline
            numberOfLines={5}
            textAlignVertical="top"
            maxLength={1024}
          />
          <Text style={styles.charCount}>{bodyText.length}/1024</Text>
          {errors.bodyText ? <Text style={styles.errorText}>{errors.bodyText}</Text> : null}

          {/* Body samples — one input per unique variable found in real time */}
          {bodyIndices.length > 0 ? (
            <View style={{ marginTop: 8 }}>
              <Text style={styles.sampleLabel}>Sample values for body variables</Text>
              {bodyIndices.map((variableNumber, slotIndex) => (
                <TextInput
                  key={variableNumber}
                  style={[styles.input, { marginBottom: 8 }]}
                  placeholder={`Example for {{${variableNumber}}}, e.g. John`}
                  placeholderTextColor="#BDBDBD"
                  value={sampleValues.body[slotIndex] ?? ''}
                  onChangeText={(v) => handleSampleChange('body', slotIndex, v)}
                />
              ))}
              {errors.bodySample ? <Text style={styles.errorText}>{errors.bodySample}</Text> : null}
            </View>
          ) : null}

          {/* Footer */}
          <Text style={[styles.label, { marginTop: 16 }]}>Footer (optional)</Text>
          <Text style={styles.hint}>Max 60 characters, no variables</Text>
          <TextInput
            style={[styles.input, errors.footer && styles.inputError]}
            placeholder="Reply STOP to opt out"
            placeholderTextColor="#BDBDBD"
            value={footer}
            onChangeText={(v) => { setFooter(v); setErrors((e) => ({ ...e, footer: '' })); }}
            maxLength={60}
          />
          {errors.footer ? <Text style={styles.errorText}>{errors.footer}</Text> : null}

          <TouchableOpacity
            style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}>
            {submitting
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.submitBtnText}>Submit to Meta</Text>}
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  center:    { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },

  errorIcon:    { fontSize: 48, marginBottom: 12 },
  errorTitle:   { fontSize: 17, fontWeight: '700', color: '#1A1A2E', marginBottom: 6, textAlign: 'center' },
  errorMessage: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 19, marginBottom: 16 },
  retryBtn:     { backgroundColor: '#1A1A2E', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  card:        { backgroundColor: '#fff', borderRadius: 14, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  cardHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitle:   { fontSize: 15, fontWeight: '700', color: '#1A1A2E', flex: 1, marginRight: 8 },
  badge:       { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText:   { fontSize: 11, fontWeight: '700' },
  cardMeta:    { fontSize: 11, color: '#9CA3AF', marginBottom: 6 },
  cardBody:    { fontSize: 13, color: '#6B7280', lineHeight: 18 },
  rejectBox:   { marginTop: 8, backgroundColor: '#FEF2F2', borderRadius: 8, padding: 8 },
  rejectText:  { fontSize: 11, color: '#EF4444' },

  fab:     { position: 'absolute', bottom: 24, right: 20, left: 20, backgroundColor: '#1A1A2E', paddingVertical: 16, borderRadius: 14, alignItems: 'center', elevation: 5 },
  fabText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  modalTitle:  { fontSize: 18, fontWeight: '700', color: '#1A1A2E' },
  modalClose:  { fontSize: 22, color: '#9CA3AF' },
  modalBody:   { flex: 1, backgroundColor: '#F8F9FA' },

  apiErrorBox:  { backgroundColor: '#FEF2F2', borderRadius: 10, padding: 12, marginBottom: 16 },
  apiErrorText: { color: '#EF4444', fontSize: 13, fontWeight: '600' },

  label:    { fontSize: 13, fontWeight: '700', color: '#1A1A2E', marginBottom: 4 },
  sampleLabel: { fontSize: 12, fontWeight: '700', color: '#6B7280', marginBottom: 6 },
  hint:     { fontSize: 11, color: '#9E9E9E', marginBottom: 8 },
  previewName: { fontSize: 11, color: '#3B82F6', marginTop: 4, fontStyle: 'italic' },
  input:    { backgroundColor: '#fff', borderRadius: 10, padding: 12, fontSize: 14, color: '#1A1A2E', borderWidth: 1.5, borderColor: '#EEEEEE' },
  inputError: { borderColor: '#D32F2F', backgroundColor: '#FFF5F5' },
  errorText:  { fontSize: 12, color: '#D32F2F', marginTop: 4, marginBottom: 4 },
  textArea:   { height: 110, textAlignVertical: 'top' },
  charCount:  { fontSize: 11, color: '#9CA3AF', textAlign: 'right', marginTop: 2 },

  pillRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill:     { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#EEEEEE' },
  pillSelected: { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  pillText: { fontSize: 12, fontWeight: '600', color: '#1A1A2E' },
  pillTextSelected: { color: '#fff' },

  submitBtn: { backgroundColor: '#1A1A2E', borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 24 },
  submitBtnDisabled: { opacity: 0.45 },
  submitBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});