import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Switch,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, StatusBar,
} from 'react-native';
import { insertTemplate } from '../database/templateDB';
import { getAllContacts } from '../database/contactDB';
import { rescheduleAlarmsForTemplate } from '../utils/alarmScheduler';
import { handleError, showError, showSuccess, ErrorMessages } from '../utils/errorHandler';
import { validateTemplateTitle, validateTemplateBody, validateOptionalTime } from '../utils/validators';
import { parse12HourTimeTo24Hour } from '../utils/dateFormat';
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

  const validate = () => {
    const titleResult = validateTemplateTitle(title);
    const bodyResult = validateTemplateBody(body);
    const timeResult = validateOptionalTime(sendTime);
    const e = {};
    if (!titleResult.valid) e.title = titleResult.message;
    if (!bodyResult.valid)  e.body  = bodyResult.message;
    if (!timeResult.valid)  e.time  = timeResult.message;
    const d = parseInt(daysBefore, 10);
    if (isNaN(d)) e.days = 'Enter a valid integer (e.g. -3, 0, 7)';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    try {
      const normalizedSendTime = sendTime.trim()
        ? parse12HourTimeTo24Hour(sendTime, sendMeridiem)
        : null;

      if (sendTime.trim() && !normalizedSendTime) {
        showError('Error', 'Invalid template send time entered.');
        return;
      }

      const newTemplate = {
        id: Date.now().toString(),
        title: title.trim(),
        body: body.trim(),
        days_before: parseInt(daysBefore, 10),
        is_active: isActive ? 1 : 0,
        send_time: normalizedSendTime,
        platform_id: platformId,
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
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>

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
            <View style={styles.meridiemGroup}>
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

          {/* Body */}
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

        </View>

        {/* Preview */}
        <View style={styles.previewCard}>
          <Text style={styles.previewLabel}>PREVIEW</Text>
          <Text style={styles.previewMeta}>
            📅 {daysBefore || '?'} day{daysBefore !== '1' ? 's' : ''} before expiry
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
});