import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, StatusBar,
} from 'react-native';
import { insertContact } from '../database/contactDB';
import { handleError, showError, showSuccess, ErrorMessages } from '../utils/errorHandler';
import { validateName, validatePhoneNumber, validateDate, validateTime } from '../utils/validators';
import { parse12HourTimeTo24Hour, toUTCISOString } from '../utils/dateFormat';

export default function AddContactScreen({ navigation, route }) {
  const [name, setName]             = useState('');
  const [phone, setPhone]           = useState('');
  const [expiryDate, setExpiryDate] = useState(''); // YYYY-MM-DD
  const [expiryTime, setExpiryTime] = useState(''); // HH:MM (12-hour display)
  const [expiryMeridiem, setExpiryMeridiem] = useState('AM');
  const [errors, setErrors]         = useState({});
  const [loading, setLoading]       = useState(false);

  const validateAll = () => {
    const nameResult  = validateName(name);
    const phoneResult = validatePhoneNumber(phone);
    const dateResult  = validateDate(expiryDate);
    const timeResult  = validateTime(expiryTime);

    const newErrors = {};
    if (!nameResult.valid)  newErrors.name  = nameResult.message;
    if (!phoneResult.valid) newErrors.phone = phoneResult.message;
    if (!dateResult.valid)  newErrors.date  = dateResult.message;
    if (!timeResult.valid)  newErrors.time  = timeResult.message;

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleMeridiemSelect = (value) => {
    setExpiryMeridiem(value);
    setErrors((currentErrors) => ({ ...currentErrors, time: '' }));
  };

  const handleSave = async () => {
    if (!validateAll()) return;

    setLoading(true);
    try {
      const normalizedTime = parse12HourTimeTo24Hour(expiryTime, expiryMeridiem);

      if (!normalizedTime) {
        showError('Error', 'Invalid date or time entered.');
        setLoading(false);
        return;
      }

      const localDateTime = new Date(`${expiryDate.trim()}T${normalizedTime}:00`);

      if (isNaN(localDateTime.getTime())) {
        showError('Error', 'Invalid date or time entered.');
        setLoading(false);
        return;
      }

      const expiryUTC = toUTCISOString(localDateTime);

      const newContact = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: name.trim(),
        phone_number: phone.trim(),
        expiry_datetime: expiryUTC,
      };

      const ok = insertContact(newContact);
      if (!ok) {
        showError('Error', ErrorMessages.DB_WRITE);
        return;
      }

      // Alarm scheduling now happens via the contact-events signal layer.
      route.params?.onSave?.();
      showSuccess('Contact Saved', 'Contact has been added successfully.', () => navigation.goBack());
    } catch (error) {
      handleError(error, 'AddContactScreen.handleSave');
      showError('Error', ErrorMessages.DB_WRITE);
    } finally {
      setLoading(false);
    }
  };

  return (
    // FIX — Save Contact button keyboard-shift bug
    // Masla: AndroidManifest.xml pehle `adjustResize` tha — keyboard khulte
    //         hi window resize hoti, aur is ScrollView ke andar wale Save/
    //         Cancel buttons upar shift ho jate (screen ka available height
    //         hi kam ho jata tha).
    // Fix:   Manifest ab `adjustPan` use karta hai (poore app ke liye) —
    //         window resize nahi hoti, Android khud sirf focused input ko
    //         keyboard ke upar pan karta hai. Isliye Android par
    //         KeyboardAvoidingView ka `behavior` ab bhi `undefined` (no-op)
    //         hai — ye sirf iOS ke liye 'padding' laga raha hai, jahan
    //         adjustPan/adjustResize ka concept hi nahi hota.
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>

        <View style={styles.header}>
          <Text style={styles.headerTitle}>Add Contact</Text>
          <Text style={styles.headerSubtitle}>Enter contact details below</Text>
        </View>

        <View style={styles.card}>

          {/* Name */}
          <Text style={styles.label}>Full Name</Text>
          <TextInput
            style={[styles.input, errors.name && styles.inputError]}
            placeholder="e.g. Ali Khan"
            placeholderTextColor="#BDBDBD"
            value={name}
            onChangeText={(val) => { setName(val); setErrors(e => ({ ...e, name: '' })); }}
          />
          {errors.name ? <Text style={styles.errorText}>{errors.name}</Text> : null}

          <View style={styles.divider} />

          {/* Phone */}
          <Text style={styles.label}>Phone Number</Text>
          <Text style={styles.hint}>Pakistan format: 03XXXXXXXXX</Text>
          <TextInput
            style={[styles.input, errors.phone && styles.inputError]}
            placeholder="e.g. 03001234567"
            placeholderTextColor="#BDBDBD"
            value={phone}
            onChangeText={(val) => { setPhone(val); setErrors(e => ({ ...e, phone: '' })); }}
            keyboardType="phone-pad"
            maxLength={11}
          />
          {errors.phone ? <Text style={styles.errorText}>{errors.phone}</Text> : null}

          <View style={styles.divider} />

          {/* Expiry Date */}
          <Text style={styles.label}>Expiry Date</Text>
          <Text style={styles.hint}>Format: YYYY-MM-DD</Text>
          <TextInput
            style={[styles.input, errors.date && styles.inputError]}
            placeholder="e.g. 2026-12-31"
            placeholderTextColor="#BDBDBD"
            value={expiryDate}
            onChangeText={(val) => { setExpiryDate(val); setErrors(e => ({ ...e, date: '' })); }}
          />
          {errors.date ? <Text style={styles.errorText}>{errors.date}</Text> : null}

          <View style={styles.divider} />

          {/* Expiry Time */}
          <Text style={styles.label}>Expiry Time</Text>
          <Text style={styles.hint}>12-hour format with AM/PM, e.g. 9:00 AM or 2:30 PM</Text>
          <View style={styles.timeInputRow}>
            <TextInput
              style={[styles.input, styles.timeInput, errors.time && styles.inputError]}
              placeholder="e.g. 2:30"
              placeholderTextColor="#BDBDBD"
              value={expiryTime}
              onChangeText={(val) => { setExpiryTime(val); setErrors(e => ({ ...e, time: '' })); }}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
            <View style={styles.meridiemGroup}>
              {['AM', 'PM'].map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[
                    styles.meridiemBtn,
                    expiryMeridiem === option && styles.meridiemBtnActive,
                  ]}
                  onPress={() => handleMeridiemSelect(option)}
                  activeOpacity={0.8}>
                  <Text style={[
                    styles.meridiemText,
                    expiryMeridiem === option && styles.meridiemTextActive,
                  ]}>{option}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {errors.time ? <Text style={styles.errorText}>{errors.time}</Text> : null}

        </View>

        <TouchableOpacity
          style={[styles.saveBtn, loading && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={loading}>
          <Text style={styles.saveBtnText}>
            {loading ? 'Saving...' : 'Save Contact'}
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
  timeInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  timeInput: { flex: 1 },
  meridiemGroup: { flexDirection: 'row', gap: 8 },
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
  inputError: { borderColor: '#D32F2F', backgroundColor: '#FFF5F5' },
  errorText: { fontSize: 12, color: '#D32F2F', marginTop: 4 },
  divider: { height: 1, backgroundColor: '#F5F5F5', marginVertical: 16 },
  saveBtn: {
    backgroundColor: '#1A1A2E', marginHorizontal: 16,
    paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', elevation: 3,
  },
  saveBtnDisabled: { backgroundColor: '#9E9E9E', elevation: 0 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  cancelBtn: { padding: 16, alignItems: 'center', marginBottom: 40 },
  cancelBtnText: { color: '#9E9E9E', fontSize: 15, fontWeight: '500' },
});