import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity,
  StyleSheet, ScrollView, Linking, StatusBar,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getAllPlatforms, seedDefaultPlatforms } from '../database/platformDB';
import { getDefaultPlatform } from '../database/settingsDB';
import { handleError, showError, ErrorMessages } from '../utils/errorHandler';
import { getDaysUntilExpiry, personalizeMessage } from '../utils/templateMatcher';

const FIXED_PLATFORMS = [
  {
    id: 'sms',
    name: 'SMS',
    icon: '📱',
    url_scheme: 'sms:{phone}?body={message}',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    icon: '💬',
    url_scheme: 'whatsapp://send?phone={phone}&text={message}',
  },
];

export default function PlatformSelectScreen({ navigation, route }) {
  const { template, contact } = route.params;
  const [selected, setSelected] = useState(null);
  const [customPlatforms, setCustomPlatforms] = useState([]);
  const [othersExpanded, setOthersExpanded] = useState(false);

  // Loads custom platforms + applies the saved default platform automatically,
  // the same way a phone pre-selects a default SIM but still lets you switch.
  const loadPlatforms = () => {
    try {
      seedDefaultPlatforms();
      const data = getAllPlatforms();
      setCustomPlatforms(data);

      const defaultPlatformId = getDefaultPlatform();
      if (defaultPlatformId) {
        const allKnownPlatforms = [...FIXED_PLATFORMS, ...data];
        const match = allKnownPlatforms.find((p) => p.id === defaultPlatformId);
        if (match) {
          setSelected(match);
        }
      }
    } catch (error) {
      handleError(error, 'PlatformSelectScreen.loadPlatforms');
      showError('Error', ErrorMessages.DB_READ);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadPlatforms();
    }, [])
  );

  const formatPhone = (phone, platformId) => {
    const cleaned = phone.replace(/^0/, '');
    if (platformId === 'whatsapp') return `92${cleaned}`;
    return phone;
  };

  const handleSend = () => {
    if (!selected) {
      showError('No Platform Selected', 'Please select a messaging platform.');
      return;
    }

    const phone = contact?.phone_number || '';
    const daysLeft = contact ? getDaysUntilExpiry(contact.expiry_datetime) : 0;
    const message = contact
      ? personalizeMessage(template.body, contact, daysLeft)
      : template.body;

    let url;
    try {
      url = selected.url_scheme
        .replace('{phone}', formatPhone(phone, selected.id))
        .replace('{message}', encodeURIComponent(message));
    } catch (error) {
      handleError(error, 'PlatformSelectScreen.buildUrl');
      showError('Error', ErrorMessages.PLATFORM_OPEN_FAILED(selected.name));
      return;
    }

    Linking.canOpenURL(url)
      .then(supported => {
        if (supported) {
          return Linking.openURL(url);
        }
        showError('Not Installed', ErrorMessages.PLATFORM_NOT_FOUND(selected.name));
      })
      .catch(error => {
        handleError(error, 'PlatformSelectScreen.handleSend');
        showError('Error', ErrorMessages.PLATFORM_OPEN_FAILED(selected.name));
      });
  };

  const renderPlatformCard = (platform) => (
    <TouchableOpacity
      key={platform.id}
      style={[
        styles.platformCard,
        selected?.id === platform.id && styles.platformCardSelected,
      ]}
      onPress={() => setSelected(platform)}
      activeOpacity={0.7}>
      <View style={styles.platformIconContainer}>
        <Text style={styles.platformIcon}>{platform.icon}</Text>
      </View>
      <Text style={styles.platformLabel}>{platform.name}</Text>
      <View style={[
        styles.radioOuter,
        selected?.id === platform.id && styles.radioOuterSelected,
      ]}>
        {selected?.id === platform.id && (
          <View style={styles.radioInner} />
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <StatusBar backgroundColor="#fff" barStyle="dark-content" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Send Message</Text>
        <Text style={styles.headerSubtitle}>Select a platform to deliver your message</Text>
      </View>

      <View style={styles.previewCard}>
        <Text style={styles.sectionLabel}>MESSAGE PREVIEW</Text>
        <Text style={styles.previewTitle}>{template.title}</Text>
        <Text style={styles.previewBody}>
          {contact
            ? personalizeMessage(template.body, contact, getDaysUntilExpiry(contact.expiry_datetime))
            : template.body}
        </Text>
        {contact && (
          <View style={styles.recipientRow}>
            <View style={styles.recipientAvatar}>
              <Text style={styles.recipientAvatarText}>
                {contact.name.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View>
              <Text style={styles.recipientName}>{contact.name}</Text>
              <Text style={styles.recipientPhone}>{contact.phone_number}</Text>
            </View>
          </View>
        )}
      </View>

      <Text style={styles.sectionLabel2}>SELECT PLATFORM</Text>
      {FIXED_PLATFORMS.map(platform => renderPlatformCard(platform))}

      <TouchableOpacity
        style={styles.othersHeader}
        onPress={() => setOthersExpanded(!othersExpanded)}
        activeOpacity={0.7}>
        <View style={styles.othersLeft}>
          <View style={styles.platformIconContainer}>
            <Text style={styles.platformIcon}>📨</Text>
          </View>
          <Text style={styles.platformLabel}>Others</Text>
        </View>
        <Text style={styles.expandIcon}>{othersExpanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {othersExpanded && (
        <View style={styles.othersContent}>
          {customPlatforms.length === 0 ? (
            <View style={styles.noCustomPlatforms}>
              <Text style={styles.noCustomText}>No custom platforms added yet.</Text>
              <TouchableOpacity onPress={() => navigation.navigate('PlatformManager')}>
                <Text style={styles.addPlatformLink}>+ Add a Platform</Text>
              </TouchableOpacity>
            </View>
          ) : (
            customPlatforms.map(platform => renderPlatformCard(platform))
          )}
        </View>
      )}

      <TouchableOpacity
        style={[styles.sendBtn, !selected && styles.sendBtnDisabled]}
        onPress={handleSend}
        activeOpacity={selected ? 0.8 : 1}>
        <Text style={styles.sendBtnText}>
          {selected ? `Send via ${selected.name}` : 'Select a Platform'}
        </Text>
      </TouchableOpacity>

    </ScrollView>
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
  previewCard: {
    backgroundColor: '#1A1A2E', borderRadius: 16,
    padding: 20, margin: 16, marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 10, color: '#888', fontWeight: '700',
    letterSpacing: 1.5, marginBottom: 10,
  },
  previewTitle: { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 6 },
  previewBody: { fontSize: 14, color: '#BDBDBD', lineHeight: 20 },
  recipientRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 16, paddingTop: 16,
    borderTopWidth: 1, borderTopColor: '#2D2D4E',
  },
  recipientAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#fff', justifyContent: 'center',
    alignItems: 'center', marginRight: 10,
  },
  recipientAvatarText: { color: '#1A1A2E', fontWeight: '700', fontSize: 16 },
  recipientName: { fontSize: 14, fontWeight: '600', color: '#fff' },
  recipientPhone: { fontSize: 12, color: '#888', marginTop: 2 },
  sectionLabel2: {
    fontSize: 10, color: '#9E9E9E', fontWeight: '700',
    letterSpacing: 1.5, marginHorizontal: 16, marginTop: 8, marginBottom: 12,
  },
  platformCard: {
    backgroundColor: '#fff', borderRadius: 14, padding: 16,
    marginHorizontal: 16, marginBottom: 10,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  platformCardSelected: { borderColor: '#1A1A2E', backgroundColor: '#FAFAFA' },
  platformIconContainer: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: '#F8F9FA', justifyContent: 'center',
    alignItems: 'center', marginRight: 14,
  },
  platformIcon: { fontSize: 24 },
  platformLabel: { fontSize: 16, fontWeight: '600', color: '#1A1A2E', flex: 1 },
  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: '#BDBDBD',
    justifyContent: 'center', alignItems: 'center',
  },
  radioOuterSelected: { borderColor: '#1A1A2E' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#1A1A2E' },
  othersHeader: {
    backgroundColor: '#fff', borderRadius: 14, padding: 16,
    marginHorizontal: 16, marginBottom: 4,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  othersLeft: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  expandIcon: { fontSize: 12, color: '#9E9E9E' },
  othersContent: {
    marginHorizontal: 16, marginBottom: 4,
    backgroundColor: '#F8F9FA', borderRadius: 12,
    borderWidth: 1, borderColor: '#F0F0F0',
    overflow: 'hidden',
  },
  noCustomPlatforms: { padding: 20, alignItems: 'center' },
  noCustomText: { fontSize: 14, color: '#9E9E9E' },
  addPlatformLink: { fontSize: 14, color: '#1A1A2E', fontWeight: '700', marginTop: 8 },
  sendBtn: {
    backgroundColor: '#1A1A2E', marginHorizontal: 16,
    paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', marginTop: 12, marginBottom: 40, elevation: 3,
  },
  sendBtnDisabled: { backgroundColor: '#E0E0E0', elevation: 0 },
  sendBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});