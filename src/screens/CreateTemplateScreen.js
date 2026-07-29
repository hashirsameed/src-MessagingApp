import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Switch,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, StatusBar, Keyboard, Modal,
} from 'react-native';
import { insertTemplate } from '../database/templateDB';
import { getAllContacts } from '../database/contactDB';
import {
  getAllPlatforms, getEnabledPlatforms, togglePlatformEnabled, seedDefaultPlatforms,
} from '../database/platformDB';
import { getCachedApprovedWhatsAppTemplates } from '../database/whatsappTemplateCacheDB';
import {
  rescheduleAlarmsForTemplate, rescheduleAlarmsForPlatform, cancelAlarmsForPlatform,
} from '../utils/alarmScheduler';
import { handleError, showError, showSuccess, ErrorMessages } from '../utils/errorHandler';
import { validateTemplateTitle, validateTemplateBody, validateOptionalTime } from '../utils/validators';
import { parse12HourTimeTo24Hour, formatDaysLabel } from '../utils/dateFormat';
import { personalizeMessage } from '../utils/templateMatcher';
import PlatformPicker from '../components/PlatformPicker';

export default function CreateTemplateScreen({ navigation, route }) {
  const [title, setTitle]         = useState('');
  const [body, setBody]           = useState('');
  const [daysBefore, setDaysBefore] = useState('1');
  const [sendTime, setSendTime]   = useState('');
  const [sendMeridiem, setSendMeridiem] = useState(null);
  const [isActive, setIsActive]   = useState(true);
  const [platformId, setPlatformId] = useState(route?.params?.presetPlatformId ?? 'sms');
  const [errors, setErrors]       = useState({});

  // WhatsApp-only: which APPROVED Meta template this schedule sends. Meta
  // rejects freeform text outside a live 24h session, so a WhatsApp row
  // can't use the free-text body below — it must point at one specific
  // approved template by name+language instead.
  const [metaTemplateName, setMetaTemplateName]     = useState(null);
  const [metaTemplateLanguage, setMetaTemplateLanguage] = useState(null);
  const [approvedWaTemplates, setApprovedWaTemplates] = useState([]);
  const isWhatsApp = platformId === 'whatsapp';

  // No enabled platform = nothing a template can actually send through.
  // PlatformPicker still lists every platform regardless of is_enabled, so
  // without this check the screen would silently let you build and save a
  // template pointing at a platform that's currently off. platformsForModal
  // holds every platform (enabled or not) so the modal can offer a toggle
  // for each one; enabledPlatforms is just the count used to decide
  // whether to block the screen.
  const [enabledPlatforms, setEnabledPlatforms] = useState([]);
  const [platformsForModal, setPlatformsForModal] = useState([]);
  const [showEnablePlatformModal, setShowEnablePlatformModal] = useState(false);

  const refreshPlatformGate = () => {
    seedDefaultPlatforms(); // safe/idempotent — same call PlatformPicker itself makes
    const enabled = getEnabledPlatforms();
    setEnabledPlatforms(enabled);
    setPlatformsForModal(getAllPlatforms());
    setShowEnablePlatformModal(enabled.length === 0);
  };

  useEffect(() => {
    refreshPlatformGate();
  }, []);

  // Toggling from inside the modal — same effect as SettingsScreen's
  // platform switch (reschedule alarms on enable, cancel on disable) so
  // enabling a platform here behaves identically to enabling it there.
  const handleTogglePlatformInModal = async (platform, value) => {
    try {
      const ok = togglePlatformEnabled(platform.id, value);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      if (Platform.OS === 'android') {
        if (value) await rescheduleAlarmsForPlatform(platform.id);
        else await cancelAlarmsForPlatform(platform.id);
      }
      refreshPlatformGate();
    } catch (error) {
      handleError(error, 'CreateTemplateScreen.handleTogglePlatformInModal');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  useEffect(() => {
    if (isWhatsApp) {
      setApprovedWaTemplates(getCachedApprovedWhatsAppTemplates());
    }
  }, [isWhatsApp]);

  const selectMetaTemplate = (t) => {
    setMetaTemplateName(t.name);
    setMetaTemplateLanguage(t.language);
    setBody(t.body ?? ''); // display-only mirror, not what actually gets sent
    setErrors((e) => ({ ...e, metaTemplate: '' }));
  };

  const validate = () => {
    const titleResult = validateTemplateTitle(title);
    const timeResult = validateOptionalTime(sendTime);
    const e = {};
    if (!titleResult.valid) e.title = titleResult.message;
    if (!timeResult.valid)  e.time  = timeResult.message;
    else if (sendTime.trim() && !sendMeridiem) e.time = 'Select AM or PM.';

    if (isWhatsApp) {
      if (!metaTemplateName) e.metaTemplate = 'Pick an approved WhatsApp template.';
    } else {
      const bodyResult = validateTemplateBody(body);
      if (!bodyResult.valid) e.body = bodyResult.message;
    }

    const d = parseInt(daysBefore, 10);
    if (isNaN(d)) e.days = 'Enter a valid integer (e.g. -3, 0, 7)';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    // Defensive re-check — validate() doesn't cover this since it's not a
    // form-field error, it's "there's nothing to send through at all".
    // Re-reads fresh (not the possibly-stale enabledPlatforms state) so a
    // platform disabled in another tab/screen moments ago is still caught.
    if (getEnabledPlatforms().length === 0) {
      refreshPlatformGate();
      return;
    }

    try {
      const normalizedSendTime = sendTime.trim()
        ? parse12HourTimeTo24Hour(sendTime, sendMeridiem)
        : null;

      if (sendTime.trim() && !normalizedSendTime) {
        showError('Error', 'Invalid template send time entered.');
        return;
      }

      const newTemplate = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: title.trim(),
        body: body.trim(),
        days_before: parseInt(daysBefore, 10),
        is_active: isActive ? 1 : 0,
        send_time: normalizedSendTime,
        platform_id: platformId,
        meta_template_name: isWhatsApp ? metaTemplateName : null,
        meta_template_language: isWhatsApp ? metaTemplateLanguage : null,
      };

      const ok = insertTemplate(newTemplate);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }

      if (Platform.OS === 'android' && newTemplate.is_active === 1) {
        const allContacts = getAllContacts();
        const results = await rescheduleAlarmsForTemplate(newTemplate, allContacts);
        console.log(`[CreateTemplateScreen] Scheduled ${results.length} alarm(s) for "${newTemplate.title}"`);
      }

      showSuccess('Saved', 'Template saved.', () => navigation.goBack());
    } catch (error) {
      handleError(error, 'CreateTemplateScreen.handleSave');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  // Preview uses the exact days_before number the user just typed — this is
  // the actual value that will go out in the real message, not a sample.
  // {name}/{expiry}/{phone} use representative sample values since no real
  // contact is picked yet at template-creation time.
  const previewDaysBefore = (() => {
    const d = parseInt(daysBefore, 10);
    return isNaN(d) ? 0 : d;
  })();
  const previewSampleContact = {
    name: 'John Doe',
    phone_number: '0300-1234567',
    expiry_datetime: new Date(Date.now() + previewDaysBefore * 24 * 60 * 60 * 1000).toISOString(),
  };
  const previewBodyText = body.trim()
    ? personalizeMessage(body, previewSampleContact, previewDaysBefore)
    : 'Message body will appear here...';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        <View style={styles.header}>
          <Text style={styles.headerTitle}>New Template</Text>
          <Text style={styles.headerSubtitle}>Create a reusable message template</Text>
        </View>

        <View style={styles.card}>

          {/* Title */}
          <Text style={styles.label}>Template Title</Text>
          <TextInput
            style={[styles.input, errors.title && styles.inputError]}
            placeholder="e.g. Policy Expiry Reminder"
            placeholderTextColor="#BDBDBD"
            value={title}
            onChangeText={(v) => { setTitle(v); setErrors(e => ({ ...e, title: '' })); }}
          />
          {errors.title ? <Text style={styles.errorText}>{errors.title}</Text> : null}

          <View style={styles.divider} />

          <PlatformPicker value={platformId} onChange={setPlatformId} onPlatformsChanged={refreshPlatformGate} />

          <View style={styles.divider} />

          {/* Days Before */}
          <Text style={styles.label}>Send how many days before expiry?</Text>
          <Text style={styles.hint}>Enter any integer, including negatives (e.g. -3, 0, 7)</Text>
          <TextInput
            style={[styles.input, errors.days && styles.inputError]}
            placeholder="e.g. -3, 0, 7"
            placeholderTextColor="#BDBDBD"
            value={daysBefore}
            onChangeText={(v) => {
              const sanitized = v.replace(/[^0-9-]/g, '').replace(/(?!^)-/g, '');
              setDaysBefore(sanitized);
              setErrors(e => ({ ...e, days: '' }));
            }}
            keyboardType="numbers-and-punctuation"
            maxLength={3}
          />
          {errors.days ? <Text style={styles.errorText}>{errors.days}</Text> : null}

          <View style={styles.divider} />

          {/* Send Time */}
          <Text style={styles.label}>Send Time</Text>
          <Text style={styles.hint}>Optional. Leave blank to use each contact's expiry time.</Text>
          <View style={styles.timeInputRow}>
            <TextInput
              style={[styles.input, styles.timeInput, errors.time && styles.inputError]}
              placeholder="e.g. 9:00"
              placeholderTextColor="#BDBDBD"
              value={sendTime}
              onChangeText={(v) => { setSendTime(v); setErrors(e => ({ ...e, time: '' })); }}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
            <View style={[styles.meridiemGroup, (errors.time && sendTime.trim() && !sendMeridiem) && styles.meridiemGroupError]}>
              {['AM', 'PM'].map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[
                    styles.meridiemBtn,
                    sendMeridiem === option && styles.meridiemBtnActive,
                  ]}
                  onPress={() => {
                    setSendMeridiem(option);
                    setErrors(e => ({ ...e, time: '' }));
                    Keyboard.dismiss();
                  }}
                  activeOpacity={0.8}>
                  <Text style={[
                    styles.meridiemText,
                    sendMeridiem === option && styles.meridiemTextActive,
                  ]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {errors.time ? <Text style={styles.errorText}>{errors.time}</Text> : null}

          <View style={styles.divider} />

          {/* Active Toggle */}
          <View style={styles.toggleRow}>
            <View>
              <Text style={styles.label}>Active</Text>
              <Text style={styles.hint}>Only active templates are used for scheduling</Text>
            </View>
            <Switch
              value={isActive}
              onValueChange={setIsActive}
              trackColor={{ false: '#E0E0E0', true: '#1A1A2E' }}
              thumbColor="#fff"
            />
          </View>

          <View style={styles.divider} />

          {/* Body — SMS/Email/Gmail: free text. WhatsApp: pick an approved
              Meta template instead (Meta rejects freeform text outside a
              live session). */}
          {isWhatsApp ? (
            <>
              <Text style={styles.label}>WhatsApp Template</Text>
              <Text style={styles.hint}>
                Only APPROVED templates can be scheduled. Manage/create templates from the
                WhatsApp tab first if you don't see the one you need here.
              </Text>
              {approvedWaTemplates.length === 0 ? (
                <View style={styles.waEmptyBox}>
                  <Text style={styles.waEmptyText}>
                    No approved WhatsApp templates found yet. Open the WhatsApp tab to sync,
                    or wait for Meta to approve one.
                  </Text>
                </View>
              ) : (
                approvedWaTemplates.map((t) => {
                  const selected = metaTemplateName === t.name;
                  return (
                    <TouchableOpacity
                      key={t.name}
                      style={[styles.waTemplateCard, selected && styles.waTemplateCardSelected]}
                      onPress={() => selectMetaTemplate(t)}
                      activeOpacity={0.8}>
                      <View style={styles.waTemplateTop}>
                        <Text style={styles.waTemplateName}>{t.name}</Text>
                        {selected && <Text style={styles.waTemplateCheck}>✓</Text>}
                      </View>
                      <Text style={styles.waTemplateMeta}>{t.category} · {t.language}</Text>
                      {t.body ? (
                        <Text style={styles.waTemplateBody} numberOfLines={2}>{t.body}</Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })
              )}
              {errors.metaTemplate ? <Text style={styles.errorText}>{errors.metaTemplate}</Text> : null}
            </>
          ) : (
            <>
              <Text style={styles.label}>Message Body</Text>
              <Text style={styles.hint}>
                Variables: {'{name}'} {'{days}'} {'{expiry}'} {'{phone}'}
              </Text>
              <TextInput
                style={[styles.input, styles.textArea, errors.body && styles.inputError]}
                placeholder="Dear {name}, your policy expires in {days} days on {expiry}."
                placeholderTextColor="#BDBDBD"
                value={body}
                onChangeText={(v) => { setBody(v); setErrors(e => ({ ...e, body: '' })); }}
                multiline
                numberOfLines={6}
                textAlignVertical="top"
              />
              {errors.body ? <Text style={styles.errorText}>{errors.body}</Text> : null}
            </>
          )}

        </View>

        {/* Preview */}
        <View style={styles.previewCard}>
          <Text style={styles.previewLabel}>PREVIEW</Text>
          <Text style={styles.previewMeta}>
            📅 {(() => {
              const d = parseInt(daysBefore, 10);
              return isNaN(d) ? '?' : formatDaysLabel(d);
            })()}
            {'  '}•{'  '}
            {isActive ? '🟢 Active' : '🔴 Inactive'}
          </Text>
          <Text style={styles.previewTitle}>{title || 'Template Title'}</Text>
          <Text style={styles.previewBody}>{previewBodyText}</Text>
        </View>

        <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
          <Text style={styles.saveBtnText}>Save Template</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>

      </ScrollView>

      <Modal
        visible={showEnablePlatformModal}
        transparent
        animationType="fade"
        onRequestClose={() => navigation.goBack()}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalIcon}>⚠️</Text>
            <Text style={styles.modalTitle}>Please enable a platform first</Text>
            <Text style={styles.modalHint}>
              Every platform is currently off, so a template has nothing to send through.
              Turn on at least one below to continue.
            </Text>

            {platformsForModal.map((p) => (
              <View key={p.id} style={styles.modalPlatformRow}>
                <Text style={styles.modalPlatformIcon}>{p.icon}</Text>
                <Text style={styles.modalPlatformName} numberOfLines={1}>{p.name}</Text>
                <Switch
                  value={p.is_enabled === 1}
                  onValueChange={(v) => handleTogglePlatformInModal(p, v)}
                  trackColor={{ false: '#E0E0E0', true: '#1A1A2E' }}
                  thumbColor="#fff"
                />
              </View>
            ))}

            <TouchableOpacity style={styles.modalCancelBtn} onPress={() => navigation.goBack()}>
              <Text style={styles.modalCancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#F8F9FA' },
  header:          { backgroundColor: '#fff', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  headerTitle:     { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle:  { fontSize: 14, color: '#888', marginTop: 2 },
  card:            { backgroundColor: '#fff', borderRadius: 16, padding: 20, margin: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3 },
  label:           { fontSize: 13, fontWeight: '700', color: '#1A1A2E', marginBottom: 4 },
  hint:            { fontSize: 11, color: '#9E9E9E', marginBottom: 8 },
  input:           { backgroundColor: '#F8F9FA', borderRadius: 10, padding: 14, fontSize: 15, color: '#1A1A2E', borderWidth: 1.5, borderColor: '#EEEEEE' },
  inputError:      { borderColor: '#D32F2F', backgroundColor: '#FFF5F5' },
  errorText:       { fontSize: 12, color: '#D32F2F', marginTop: 4 },
  textArea:        { height: 140, textAlignVertical: 'top' },
  divider:         { height: 1, backgroundColor: '#F5F5F5', marginVertical: 16 },
  timeInputRow:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeInput:       { flex: 1 },
  meridiemGroup:   { flexDirection: 'row', gap: 8 },
  meridiemGroupError: { borderWidth: 1.5, borderColor: '#D32F2F', borderRadius: 12, padding: 3 },
  meridiemBtn:     { minWidth: 52, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, borderWidth: 1.5, borderColor: '#EEEEEE', backgroundColor: '#F8F9FA', alignItems: 'center', justifyContent: 'center' },
  meridiemBtnActive: { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  meridiemText:    { fontSize: 13, fontWeight: '700', color: '#1A1A2E' },
  meridiemTextActive: { color: '#fff' },
  toggleRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  previewCard:     { backgroundColor: '#1A1A2E', borderRadius: 16, padding: 20, marginHorizontal: 16, marginBottom: 16 },
  previewLabel:    { fontSize: 10, color: '#888', fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
  previewMeta:     { fontSize: 11, color: '#888', marginBottom: 8 },
  previewTitle:    { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 8 },
  previewBody:     { fontSize: 14, color: '#BDBDBD', lineHeight: 20 },
  saveBtn:         { backgroundColor: '#1A1A2E', marginHorizontal: 16, paddingVertical: 16, borderRadius: 14, alignItems: 'center', elevation: 3 },
  saveBtnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
  cancelBtn:       { padding: 16, alignItems: 'center', marginBottom: 40 },
  cancelBtnText:   { color: '#9E9E9E', fontSize: 15, fontWeight: '500' },

  waEmptyBox: {
    backgroundColor: '#FFF8EB', borderRadius: 10, padding: 14,
  },
  waEmptyText: { fontSize: 12, color: '#92600C', lineHeight: 17 },

  waTemplateCard: {
    backgroundColor: '#F8F9FA', borderRadius: 10, padding: 12, marginBottom: 8,
    borderWidth: 1.5, borderColor: '#EEEEEE',
  },
  waTemplateCardSelected: { borderColor: '#1A1A2E', backgroundColor: '#EEF2FF' },
  waTemplateTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  waTemplateName: { fontSize: 13, fontWeight: '700', color: '#1A1A2E' },
  waTemplateCheck: { fontSize: 14, fontWeight: '700', color: '#1A1A2E' },
  waTemplateMeta: { fontSize: 10, color: '#9E9E9E', marginTop: 2 },
  waTemplateBody: { fontSize: 12, color: '#4B5563', marginTop: 6, lineHeight: 16 },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  modalCard: {
    width: '100%', maxWidth: 400, backgroundColor: '#fff',
    borderRadius: 18, padding: 22, alignItems: 'center',
  },
  modalIcon: { fontSize: 32, marginBottom: 8 },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1A1A2E', textAlign: 'center' },
  modalHint: {
    fontSize: 12, color: '#9E9E9E', textAlign: 'center',
    marginTop: 6, marginBottom: 16, lineHeight: 17,
  },
  modalPlatformRow: {
    flexDirection: 'row', alignItems: 'center', width: '100%',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F5F5F5',
  },
  modalPlatformIcon: { fontSize: 18, marginRight: 10 },
  modalPlatformName: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1A1A2E' },
  modalCancelBtn: { marginTop: 16, paddingVertical: 8 },
  modalCancelBtnText: { color: '#9E9E9E', fontSize: 14, fontWeight: '600' },
});