import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Switch,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, StatusBar, Keyboard,
} from 'react-native';
import { updateTemplate } from '../database/templateDB';
import { getCachedApprovedWhatsAppTemplates } from '../database/whatsappTemplateCacheDB';
import { rescheduleAlarmsForTemplateId } from '../utils/alarmScheduler';
import { handleError, showError, showSuccess, ErrorMessages } from '../utils/errorHandler';
import { validateTemplateTitle, validateTemplateBody, validateOptionalTime } from '../utils/validators';
import { parse12HourTimeTo24Hour, split24HourTimeTo12Hour, formatDaysLabel } from '../utils/dateFormat';
import PlatformPicker from '../components/PlatformPicker';
import WhatsAppTemplatePicker from '../components/WhatsAppTemplatePicker';
import useTemplatePreview from '../hooks/useTemplatePreview';

export default function EditTemplateScreen({ navigation, route }) {
  const { template, onSave } = route.params;

  const [title, setTitle]           = useState(template.title);
  const [body, setBody]             = useState(template.body);
  const [daysBefore, setDaysBefore] = useState(String(template.days_before ?? 1));
  const initialSendTime = split24HourTimeTo12Hour(template.send_time);
  const [sendTime, setSendTime]     = useState(initialSendTime.time);
  const [sendMeridiem, setSendMeridiem] = useState(initialSendTime.meridiem);
  const [isActive, setIsActive]     = useState(template.is_active === 1);
  const [platformId, setPlatformId] = useState(template.platform_id ?? 'sms');
  const [errors, setErrors]         = useState({});
  const [loading, setLoading]       = useState(false);

  const [metaTemplateName, setMetaTemplateName]         = useState(template.meta_template_name ?? null);
  const [metaTemplateLanguage, setMetaTemplateLanguage] = useState(template.meta_template_language ?? null);
  const [approvedWaTemplates, setApprovedWaTemplates]   = useState([]);
  const isWhatsApp = platformId === 'whatsapp';

  useEffect(() => {
    if (isWhatsApp) {
      setApprovedWaTemplates(getCachedApprovedWhatsAppTemplates());
    }
  }, [isWhatsApp]);

  const selectMetaTemplate = (t) => {
    setMetaTemplateName(t.name);
    setMetaTemplateLanguage(t.language);
    setBody(t.body ?? '');
    setErrors((e) => ({ ...e, metaTemplate: '' }));
  };

  const validateAll = () => {
    const titleResult = validateTemplateTitle(title);
    const timeResult   = validateOptionalTime(sendTime);

    const newErrors = {};
    if (!titleResult.valid) newErrors.title = titleResult.message;
    if (!timeResult.valid)  newErrors.time  = timeResult.message;
    else if (sendTime.trim() && !sendMeridiem) newErrors.time = 'Select AM or PM.';

    if (isWhatsApp) {
      if (!metaTemplateName) newErrors.metaTemplate = 'Pick an approved WhatsApp template.';
    } else {
      const bodyResult = validateTemplateBody(body);
      if (!bodyResult.valid) newErrors.body = bodyResult.message;
    }

    const d = parseInt(daysBefore, 10);
    if (isNaN(d)) {
      newErrors.days = 'Enter a valid integer (e.g. -3, 0, 7)';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validateAll()) return;

    setLoading(true);
    try {
      const normalizedSendTime = sendTime.trim()
        ? parse12HourTimeTo24Hour(sendTime, sendMeridiem)
        : null;

      if (sendTime.trim() && !normalizedSendTime) {
        showError('Error', 'Invalid template send time entered.');
        return;
      }

      const updated = {
        ...template,
        title: title.trim(),
        body: body.trim(),
        days_before: parseInt(daysBefore, 10),
        is_active: isActive ? 1 : 0,
        send_time: normalizedSendTime,
        platform_id: platformId,
        meta_template_name: isWhatsApp ? metaTemplateName : null,
        meta_template_language: isWhatsApp ? metaTemplateLanguage : null,
      };

      const ok = updateTemplate(updated);
      if (!ok) {
        showError('Error', ErrorMessages.DB_WRITE);
        return;
      }

      if (Platform.OS === 'android') {
        const results = await rescheduleAlarmsForTemplateId(updated);
        console.log(`[EditTemplateScreen] Resynced ${results.length} alarm(s) for "${updated.title}"`);
      }
      onSave?.();
      showSuccess('Template Updated', 'Template has been updated successfully.', () => navigation.goBack());
    } catch (error) {
      handleError(error, 'EditTemplateScreen.handleSave');
      showError('Error', ErrorMessages.DB_WRITE);
    } finally {
      setLoading(false);
    }
  };

  const { previewDaysBefore, previewBodyText } = useTemplatePreview(body, daysBefore);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        <View style={styles.header}>
          <Text style={styles.headerTitle}>Edit Template</Text>
          <Text style={styles.headerSubtitle}>Update your message template</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Template Title</Text>
          <TextInput
            style={[styles.input, errors.title && styles.inputError]}
            placeholder="e.g. Policy Expiry Reminder"
            placeholderTextColor="#BDBDBD"
            value={title}
            onChangeText={(val) => { setTitle(val); setErrors(e => ({ ...e, title: '' })); }}
          />
          {errors.title ? <Text style={styles.errorText}>{errors.title}</Text> : null}

          <View style={styles.divider} />

          <PlatformPicker value={platformId} onChange={setPlatformId} />

          <View style={styles.divider} />

          {/* Days Before */}
          <Text style={styles.label}>Send how many days before expiry?</Text>
          <Text style={styles.hint}>Enter any integer, including negatives (e.g. -3, 0, 7)</Text>
          <TextInput
            style={[styles.input, errors.days && styles.inputError]}
            placeholder="e.g. -3, 0, 7"
            placeholderTextColor="#BDBDBD"
            value={daysBefore}
            onChangeText={(val) => {
              const sanitized = val.replace(/[^0-9-]/g, '').replace(/(?!^)-/g, '');
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
              onChangeText={(val) => {
                setSendTime(val);
                setErrors(e => ({ ...e, time: '' }));
              }}
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

          {isWhatsApp ? (
            <WhatsAppTemplatePicker
              templates={approvedWaTemplates}
              selected={metaTemplateName}
              onSelect={selectMetaTemplate}
              error={errors.metaTemplate}
            />
          ) : (
            <>
              <Text style={styles.label}>Message Body</Text>
              <Text style={styles.hint}>Use {'{name}'} {'{days}'} {'{expiry}'} {'{phone}'}</Text>
              <TextInput
                style={[styles.input, styles.textArea, errors.body && styles.inputError]}
                placeholder="Dear {name}, your subscription expires in {days} days."
                placeholderTextColor="#BDBDBD"
                value={body}
                onChangeText={(val) => { setBody(val); setErrors(e => ({ ...e, body: '' })); }}
                multiline
                numberOfLines={6}
                textAlignVertical="top"
              />
              {errors.body ? <Text style={styles.errorText}>{errors.body}</Text> : null}
            </>
          )}
        </View>

        {/* Preview Card */}
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

        <TouchableOpacity
          style={[styles.saveBtn, loading && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={loading}>
          <Text style={styles.saveBtnText}>
            {loading ? 'Saving...' : 'Update Template'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={() => navigation.goBack()}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>

      </ScrollView>
    </KeyboardAvoidingView>
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
  },
  headerTitle: { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 14, color: '#888', marginTop: 2 },
  card: {
    backgroundColor: '#fff', borderRadius: 16,
    padding: 20, margin: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  label: { fontSize: 13, fontWeight: '700', color: '#1A1A2E', marginBottom: 4 },
  hint: { fontSize: 11, color: '#9E9E9E', marginBottom: 8 },
  input: {
    backgroundColor: '#F8F9FA', borderRadius: 10,
    padding: 14, fontSize: 15, color: '#1A1A2E',
    borderWidth: 1.5, borderColor: '#EEEEEE',
  },
  inputError: { borderColor: '#D32F2F', backgroundColor: '#FFF5F5' },
  errorText: { fontSize: 12, color: '#D32F2F', marginTop: 4 },
  textArea: { height: 140, textAlignVertical: 'top' },
  divider: { height: 1, backgroundColor: '#F5F5F5', marginVertical: 16 },
  timeInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeInput: { flex: 1 },
  meridiemGroup: { flexDirection: 'row', gap: 8 },
  meridiemGroupError: { borderWidth: 1.5, borderColor: '#D32F2F', borderRadius: 12, padding: 3 },
  meridiemBtn: {
    minWidth: 52,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#EEEEEE',
    backgroundColor: '#F8F9FA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meridiemBtnActive: { backgroundColor: '#1A1A2E', borderColor: '#1A1A2E' },
  meridiemText: { fontSize: 13, fontWeight: '700', color: '#1A1A2E' },
  meridiemTextActive: { color: '#fff' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  previewCard: {
    backgroundColor: '#1A1A2E', borderRadius: 16,
    padding: 20, marginHorizontal: 16, marginBottom: 16,
  },
  previewLabel: {
    fontSize: 10, color: '#888', fontWeight: '700',
    letterSpacing: 1.5, marginBottom: 4,
  },
  previewMeta: { fontSize: 11, color: '#888', marginBottom: 8 },
  previewTitle: { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 8 },
  previewBody: { fontSize: 14, color: '#BDBDBD', lineHeight: 20 },
  saveBtn: {
    backgroundColor: '#1A1A2E', marginHorizontal: 16,
    paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', elevation: 3,
  },
  saveBtnDisabled: { backgroundColor: '#9E9E9E', elevation: 0 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  cancelBtn: { padding: 16, alignItems: 'center', marginBottom: 40 },
  cancelBtnText: { color: '#9E9E9E', fontSize: 15, fontWeight: '500' },

  waEmptyBox: { backgroundColor: '#FFF8EB', borderRadius: 10, padding: 14 },
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
});