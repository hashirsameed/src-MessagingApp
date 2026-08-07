import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  StatusBar, ScrollView, Alert, ActivityIndicator, NativeModules, Platform, Switch, PermissionsAndroid,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getDefaultPlatform, setDefaultPlatform } from '../database/settingsDB';
import { getAllPlatforms, togglePlatformEnabled, seedDefaultPlatforms } from '../database/platformDB';
import { getAllRateLimits, setRateLimit, clearRateLimit, getAllRateLimitTiers, setRateLimitTier, deleteRateLimitTier } from '../database/rateLimitDB';
import { handleError, showError, showSuccess, ErrorMessages } from '../utils/errorHandler';
import { runExpiryCheck } from '../utils/scheduler';
import { hasWhatsAppCredentials } from '../utils/whatsappService';
import { hasBulkSmsCredentials } from '../utils/bulkSmsService';
import { requestSmsPermission } from '../platforms/localTextAdapter';
import { canScheduleExactAlarms, cancelAlarmsForPlatform, rescheduleAlarmsForPlatform } from '../utils/alarmScheduler';
import ModernToggle from '../components/ModernToggle';
// FIX — settingsDB.js mein `getDevMode`/`setDevMode` naam se koi export
// kabhi tha hi nahi. Asal dev-mode flag `../utils/devMode` mein hai, jiske
// exports `isDevModeOn()` / `setDevModeOn()` hain (andar hi settingsDB ke
// generic getSetting/setSetting use karte hain). Purana import runtime pe
// `undefined` resolve hota tha — ContactListScreen.js mein isi wajah se
// "undefined is not a function" render error aa raha tha; SettingsScreen.js
// mein bhi wahi galat import tha, sirf abhi tak crash nahi hua tha kyunki
// yahan call thoda alag jagah (handler ke andar) tha.
import { isDevModeOn, setDevModeOn } from '../utils/devMode';

const { AlarmModule } = NativeModules;

export default function SettingsScreen({ navigation }) {
  const [defaultPlatform, setDefaultPlatformState] = useState(null);
  const [runningCheck, setRunningCheck]             = useState(false);
  const [waConfigured, setWaConfigured]             = useState(false);
  const [bulkSmsConfigured, setBulkSmsConfigured]   = useState(false);
  const [rateLimitDrafts, setRateLimitDrafts]       = useState({}); // platformId -> { count, hours, minutes }
  const [tiersByPlatform, setTiersByPlatform]       = useState({}); // platformId -> [{ windowMinutes, limitCount }]
  const [newTierDrafts, setNewTierDrafts]           = useState({}); // platformId -> { count, hours, minutes }
  const [exactAlarmGranted, setExactAlarmGranted]   = useState(true);
  const [batteryExempt, setBatteryExempt]           = useState(true);
  const [smsGranted, setSmsGranted]                 = useState(true);
  const [platforms, setPlatforms]                   = useState([]);
  const [expandedIds, setExpandedIds]               = useState(new Set());
  const [devMode, setDevModeState]                 = useState(false);

  const loadSettings = async () => {
    try {
      // Email/Gmail rows only get inserted by seedDefaultPlatforms() — this
      // used to run only from TemplatesScreen, so opening Settings before
      // ever visiting Templates showed just SMS+WhatsApp (seeded at DB
      // init) with Email/Gmail missing until Templates got visited once.
      seedDefaultPlatforms();
      setDefaultPlatformState(getDefaultPlatform());
      const savedLimits = getAllRateLimits();
      const drafts = {};
      Object.keys(savedLimits).forEach((platformId) => {
        const { limitCount, windowMinutes } = savedLimits[platformId];
        drafts[platformId] = {
          count: String(limitCount),
          hours: String(Math.floor(windowMinutes / 60)),
          minutes: String(windowMinutes % 60),
        };
      });
      setRateLimitDrafts(drafts);
      setTiersByPlatform(getAllRateLimitTiers());
      setPlatforms(getAllPlatforms());
      setDevModeState(isDevModeOn());
      const [configured, bulkConfigured] = await Promise.all([
        hasWhatsAppCredentials(),
        hasBulkSmsCredentials(),
      ]);
      setWaConfigured(configured);
      setBulkSmsConfigured(bulkConfigured);

      // Re-check every time this screen is focused, not just at app cold
      // start — the user can revoke either permission from system Settings
      // at any point, and the app has no other way to notice that happened.
      if (Platform.OS === 'android') {
        const [exactGranted, ignoringBattery, smsPermGranted] = await Promise.all([
          canScheduleExactAlarms(),
          AlarmModule?.isIgnoringBatteryOptimizations
            ? AlarmModule.isIgnoringBatteryOptimizations()
            : Promise.resolve(true),
          PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.SEND_SMS),
        ]);
        setExactAlarmGranted(exactGranted);
        setBatteryExempt(ignoringBattery);
        setSmsGranted(smsPermGranted);
      }
    } catch (error) {
      handleError(error, 'SettingsScreen.loadSettings');
      showError('Error', ErrorMessages.DB_READ);
    }
  };

  const handleFixExactAlarm = () => {
    AlarmModule?.openExactAlarmSettings?.();
  };

  const handleFixBattery = () => {
    AlarmModule?.requestIgnoreBatteryOptimizations?.();
  };

  // ── SMS permission toggle. Android gives apps no way to revoke a
  // permission they already hold, so the "turn OFF" branch opens the
  // app's System Settings page instead of trying (and silently failing)
  // to flip anything in-process.
  const handleSmsToggle = async (value) => {
    if (value) {
      const granted = await requestSmsPermission();
      setSmsGranted(granted);
      if (!granted) {
        showError('Not granted', 'SMS permission was denied. You can still allow it from App Info → Permissions.');
      }
    } else {
      Alert.alert(
        'Turn off manually',
        'Android doesn\'t let apps turn this off themselves. Opening App Info — look for Permissions → SMS and deny it there.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => AlarmModule?.openAppSettings?.() },
        ],
      );
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadSettings();
    }, []),
  );

  const toggleExpand = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  const getDraft = (platformId) =>
    rateLimitDrafts[platformId] ?? { count: '', hours: '', minutes: '' };

  const updateDraft = (platformId, field, value) => {
    setRateLimitDrafts((prev) => ({
      ...prev,
      [platformId]: { ...getDraft(platformId), [field]: value },
    }));
  };

  const handleSaveRateLimit = (platformId, platformName) => {
    const draft = getDraft(platformId);
    const count = parseInt(draft.count, 10);
    const hours = parseInt(draft.hours || '0', 10);
    const minutes = parseInt(draft.minutes || '0', 10);
    const windowMinutes = (isNaN(hours) ? 0 : hours) * 60 + (isNaN(minutes) ? 0 : minutes);

    if (isNaN(count) || count <= 0) {
      showError('Error', 'Enter a valid message count greater than 0.');
      return;
    }
    if (windowMinutes <= 0) {
      showError('Error', 'Set a time window greater than 0 (hours and/or minutes).');
      return;
    }
    try {
      const ok = setRateLimit(platformId, count, windowMinutes);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      const label = hours > 0 && minutes > 0
        ? `${hours}h ${minutes}m`
        : hours > 0 ? `${hours}h` : `${minutes}m`;
      showSuccess('Saved', `${platformName}: max ${count} messages per ${label}.`);
    } catch (error) {
      handleError(error, 'SettingsScreen.handleSaveRateLimit');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleClearRateLimit = (platformId, platformName) => {
    try {
      const ok = clearRateLimit(platformId);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      setRateLimitDrafts((prev) => ({ ...prev, [platformId]: { count: '', hours: '', minutes: '' } }));
      showSuccess('Removed', `${platformName} now has no send limit.`);
    } catch (error) {
      handleError(error, 'SettingsScreen.handleClearRateLimit');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  // ── Default rate limit tiers (DB-driven, editable — e.g. SMS's
  // 150/15min + 250/1hr + 750/24hr). Multiple tiers can coexist per
  // platform; ALL must hold simultaneously for a send to be allowed. Only
  // used when the platform has no Custom Override set above (see
  // queueUtils.resolveRateLimits).
  const getNewTierDraft = (platformId) =>
    newTierDrafts[platformId] ?? { count: '', hours: '', minutes: '' };

  const updateNewTierDraft = (platformId, field, value) => {
    setNewTierDrafts((prev) => ({
      ...prev,
      [platformId]: { ...getNewTierDraft(platformId), [field]: value },
    }));
  };

  const handleAddTier = (platformId, platformName) => {
    const draft = getNewTierDraft(platformId);
    const count = parseInt(draft.count, 10);
    const hours = parseInt(draft.hours || '0', 10);
    const minutes = parseInt(draft.minutes || '0', 10);
    const windowMinutes = (isNaN(hours) ? 0 : hours) * 60 + (isNaN(minutes) ? 0 : minutes);

    if (isNaN(count) || count <= 0) {
      showError('Error', 'Enter a valid message count greater than 0.');
      return;
    }
    if (windowMinutes <= 0) {
      showError('Error', 'Set a time window greater than 0 (hours and/or minutes).');
      return;
    }
    try {
      const ok = setRateLimitTier(platformId, windowMinutes, count);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      setTiersByPlatform((prev) => {
        const existing = (prev[platformId] ?? []).filter((t) => t.windowMinutes !== windowMinutes);
        const next = [...existing, { windowMinutes, limitCount: count }].sort((a, b) => a.windowMinutes - b.windowMinutes);
        return { ...prev, [platformId]: next };
      });
      setNewTierDrafts((prev) => ({ ...prev, [platformId]: { count: '', hours: '', minutes: '' } }));
      showSuccess('Tier Saved', `${platformName}: max ${count} messages per ${formatWindow(windowMinutes)}.`);
    } catch (error) {
      handleError(error, 'SettingsScreen.handleAddTier');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleDeleteTier = (platformId, windowMinutes, platformName) => {
    try {
      const ok = deleteRateLimitTier(platformId, windowMinutes);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }
      setTiersByPlatform((prev) => ({
        ...prev,
        [platformId]: (prev[platformId] ?? []).filter((t) => t.windowMinutes !== windowMinutes),
      }));
      showSuccess('Tier Removed', `${platformName}'s ${formatWindow(windowMinutes)} tier was removed.`);
    } catch (error) {
      handleError(error, 'SettingsScreen.handleDeleteTier');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const formatWindow = (windowMinutes) => {
    const hours = Math.floor(windowMinutes / 60);
    const minutes = windowMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
  };

  const handlePlatformToggle = async (platform, value) => {
    try {
      const ok = togglePlatformEnabled(platform.id, value);
      if (!ok) { showError('Error', ErrorMessages.DB_WRITE); return; }

      if (Platform.OS === 'android') {
        if (value) {
          const results = await rescheduleAlarmsForPlatform(platform.id);
          console.log(`[Settings] ${platform.name} enabled — ${results.length} alarm(s) rescheduled`);
        } else {
          const cancelledCount = await cancelAlarmsForPlatform(platform.id);
          console.log(`[Settings] ${platform.name} disabled — ${cancelledCount} alarm(s) cancelled`);
        }
      }
      setPlatforms((prev) =>
        prev.map((p) => p.id === platform.id ? { ...p, is_enabled: value ? 1 : 0 } : p)
      );
    } catch (error) {
      handleError(error, 'SettingsScreen.handlePlatformToggle');
      showError('Error', ErrorMessages.DB_WRITE);
    }
  };

  const handleDevModeToggle = (value) => {
    const ok = setDevModeOn(value);
    if (ok) {
      setDevModeState(value);
      showSuccess(
        value ? 'Dev Mode ON' : 'Dev Mode OFF',
        value
          ? 'Developer features are now visible.'
          : 'Developer features are now hidden.',
      );
    } else {
      showError('Error', 'Could not save dev mode setting.');
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

      {/* ── Platforms — one accordion card per platform, everything platform-
          specific (enable toggle, default selection, rate limit, WhatsApp
          config) lives inside its own card instead of scattered sections. ── */}
      <Text style={styles.sectionLabel}>PLATFORMS</Text>
      <Text style={styles.sectionHint}>
        Tap a platform to configure it. Turning it off pauses its reminders (Templates
        screen tab is hidden too) without deleting anything — turn back on to resume.
      </Text>

      {platforms.map((platform) => {
        const isExpanded = expandedIds.has(platform.id);
        const isDefault  = defaultPlatform === platform.id;
        const isEnabled  = platform.is_enabled === 1;
        const isWhatsApp = platform.platform_type === 'managed_remote';
        const isBulkSms  = platform.platform_type === 'bulk_remote';
        const draft = getDraft(platform.id);
        const hasSavedLimit = !!rateLimitDrafts[platform.id]?.count;
        const tiers = tiersByPlatform[platform.id] ?? [];
        const newTierDraft = getNewTierDraft(platform.id);

        return (
          <View key={platform.id} style={styles.accCard}>
            <View style={styles.accHeader}>
              <TouchableOpacity
                style={styles.accHeaderMain}
                onPress={() => toggleExpand(platform.id)}
                activeOpacity={0.7}>
                <View style={styles.iconContainer}>
                  <Text style={styles.icon}>{platform.icon}</Text>
                </View>
                <Text style={styles.label} numberOfLines={1}>{platform.name}</Text>
              </TouchableOpacity>

              <Switch
                value={isEnabled}
                onValueChange={(v) => handlePlatformToggle(platform, v)}
                trackColor={{ false: '#E0E0E0', true: '#1A1A2E' }}
                thumbColor="#fff"
              />

              <TouchableOpacity
                onPress={() => toggleExpand(platform.id)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.chevron}>{isExpanded ? '⌃' : '›'}</Text>
              </TouchableOpacity>
            </View>

            {isExpanded && (
              <View style={styles.accBody}>
                {!isEnabled && (
                  <Text style={styles.pausedNote}>
                    ⏸ Paused — no reminders will be sent until you turn this back on.
                  </Text>
                )}

                {/* ── Default Rate Limit Tiers — DB-driven, editable, ALL
                    tiers must hold simultaneously (e.g. SMS ships with
                    150/15min + 250/1hr + 750/24hr). Ignored entirely if a
                    Custom Override is set below. ── */}
                <View style={styles.accSection}>
                  <Text style={styles.accSectionLabel}>Default Rate Limit Tiers</Text>
                  <Text style={styles.accSectionHint}>
                    Every tier below must hold at once — add as many as you need. These are
                    ignored if a Custom Override is set further down.
                  </Text>

                  {tiers.length > 0 && (
                    <View style={styles.tierList}>
                      {tiers.map((tier) => (
                        <View key={tier.windowMinutes} style={styles.tierRow}>
                          <Text style={styles.tierRowText}>
                            {tier.limitCount} per {formatWindow(tier.windowMinutes)}
                          </Text>
                          <TouchableOpacity
                            onPress={() => handleDeleteTier(platform.id, tier.windowMinutes, platform.name)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <Text style={styles.tierRemoveX}>✕</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}

                  <View style={styles.rateLimitRow}>
                    <TextInput
                      style={styles.rateLimitCountInput}
                      keyboardType="numeric"
                      value={newTierDraft.count}
                      onChangeText={(v) => updateNewTierDraft(platform.id, 'count', v.replace(/[^0-9]/g, ''))}
                      placeholder="e.g. 150"
                      placeholderTextColor="#BDBDBD"
                    />
                    <Text style={styles.rateLimitPerText}>per</Text>
                    <TextInput
                      style={styles.rateLimitTimeInput}
                      keyboardType="numeric"
                      value={newTierDraft.hours}
                      onChangeText={(v) => updateNewTierDraft(platform.id, 'hours', v.replace(/[^0-9]/g, ''))}
                      placeholder="0"
                      placeholderTextColor="#BDBDBD"
                    />
                    <Text style={styles.rateLimitUnitText}>h</Text>
                    <TextInput
                      style={styles.rateLimitTimeInput}
                      keyboardType="numeric"
                      value={newTierDraft.minutes}
                      onChangeText={(v) => updateNewTierDraft(platform.id, 'minutes', v.replace(/[^0-9]/g, ''))}
                      placeholder="15"
                      placeholderTextColor="#BDBDBD"
                    />
                    <Text style={styles.rateLimitUnitText}>m</Text>
                  </View>
                  <View style={styles.rateLimitBtnRow}>
                    <TouchableOpacity
                      onPress={() => handleAddTier(platform.id, platform.name)}
                      style={styles.smsLimitSaveBtn}
                      activeOpacity={0.8}>
                      <Text style={styles.smsLimitSaveBtnText}>Add Tier</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.accSection}>
                  <Text style={styles.accSectionLabel}>Custom Override</Text>
                  <Text style={styles.accSectionHint}>
                    Set one specific limit that REPLACES all the default tiers above entirely —
                    typically used when a Bulk SMS API is connected and its provider has its own
                    limit. Leave empty to use the default tiers instead.
                  </Text>
                  <View style={styles.rateLimitRow}>
                    <TextInput
                      style={styles.rateLimitCountInput}
                      keyboardType="numeric"
                      value={draft.count}
                      onChangeText={(v) => updateDraft(platform.id, 'count', v.replace(/[^0-9]/g, ''))}
                      placeholder="e.g. 5"
                      placeholderTextColor="#BDBDBD"
                    />
                    <Text style={styles.rateLimitPerText}>per</Text>
                    <TextInput
                      style={styles.rateLimitTimeInput}
                      keyboardType="numeric"
                      value={draft.hours}
                      onChangeText={(v) => updateDraft(platform.id, 'hours', v.replace(/[^0-9]/g, ''))}
                      placeholder="0"
                      placeholderTextColor="#BDBDBD"
                    />
                    <Text style={styles.rateLimitUnitText}>h</Text>
                    <TextInput
                      style={styles.rateLimitTimeInput}
                      keyboardType="numeric"
                      value={draft.minutes}
                      onChangeText={(v) => updateDraft(platform.id, 'minutes', v.replace(/[^0-9]/g, ''))}
                      placeholder="0"
                      placeholderTextColor="#BDBDBD"
                    />
                    <Text style={styles.rateLimitUnitText}>m</Text>
                  </View>
                  <View style={styles.rateLimitBtnRow}>
                    <TouchableOpacity
                      onPress={() => handleSaveRateLimit(platform.id, platform.name)}
                      style={styles.smsLimitSaveBtn}
                      activeOpacity={0.8}>
                      <Text style={styles.smsLimitSaveBtnText}>Save</Text>
                    </TouchableOpacity>
                    {hasSavedLimit && (
                      <TouchableOpacity
                        onPress={() => handleClearRateLimit(platform.id, platform.name)}
                        style={styles.rateLimitClearBtn}
                        activeOpacity={0.8}>
                        <Text style={styles.rateLimitClearBtnText}>Remove Limit</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {isWhatsApp && (
                  <TouchableOpacity
                    style={styles.accRow}
                    onPress={() => navigation.navigate('WhatsAppConfig')}
                    activeOpacity={0.7}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.accRowLabel}>Configuration</Text>
                      <Text style={[styles.waStatus, waConfigured ? styles.waStatusOk : styles.waStatusOff]}>
                        {waConfigured ? '✅ Configured' : '⚠️ Not configured'}
                      </Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </TouchableOpacity>
                )}

                {isBulkSms && (
                  <TouchableOpacity
                    style={styles.accRow}
                    onPress={() => navigation.navigate('BulkSmsConfig')}
                    activeOpacity={0.7}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.accRowLabel}>Configuration</Text>
                      <Text style={[styles.waStatus, bulkSmsConfigured ? styles.waStatusOk : styles.waStatusOff]}>
                        {bulkSmsConfigured ? '✅ Configured' : '⚠️ Not configured'}
                      </Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={styles.defaultRow}
                  onPress={() => handleSelectPlatform(platform)}
                  activeOpacity={0.7}>
                  <View style={[styles.radioOuter, isDefault && styles.radioOuterSelected]}>
                    {isDefault && <View style={styles.radioInner} />}
                  </View>
                  <Text style={styles.defaultRowText}>Set as default platform</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}

      {!defaultPlatform && (
        <Text style={styles.noDefaultText}>
          No default set — SMS will be used as fallback.
        </Text>
      )}

      {/* ── Permissions — always visible, modern toggle row. Stays visible
          all the time so the person can grant or revisit it anytime, not
          just when something's already broken. ── */}
      {Platform.OS === 'android' && (
        <>
          <Text style={[styles.sectionLabel, { marginTop: 28 }]}>PERMISSIONS</Text>
          <Text style={styles.sectionHint}>
            Controls whether the app can send SMS reminders automatically. Turning it
            off routes you to Android's own settings screen — apps can't revoke their
            own permissions.
          </Text>

          <View style={styles.permCard}>
            <View style={styles.permRow}>
              <View style={styles.permIconWrap}>
                <Text style={styles.icon}>💬</Text>
              </View>
              <View style={styles.permTextWrap}>
                <Text style={styles.permTitle}>SMS Sending Permission</Text>
                <Text style={styles.permSubtitle}>
                  {smsGranted ? 'Granted — SMS reminders can send' : 'Not granted — SMS reminders will fail'}
                </Text>
              </View>
              <ModernToggle value={smsGranted} onValueChange={handleSmsToggle} />
            </View>
          </View>
        </>
      )}

      {/* ── Background Reliability ── */}
      {Platform.OS === 'android' && (!exactAlarmGranted || !batteryExempt) && (
        <>
          <Text style={[styles.sectionLabel, { marginTop: 28 }]}>BACKGROUND RELIABILITY</Text>
          <Text style={styles.sectionHint}>
            These must stay on or reminders may fire late or not at all when the app is closed.
          </Text>

          {!exactAlarmGranted && (
            <TouchableOpacity
              style={[styles.card, styles.waCard]}
              onPress={handleFixExactAlarm}
              activeOpacity={0.7}>
              <View style={styles.iconContainer}>
                <Text style={styles.icon}>⏰</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Alarms & Reminders</Text>
                <Text style={[styles.waStatus, styles.waStatusOff]}>⚠️ Not allowed — tap to fix</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}

          {!batteryExempt && (
            <TouchableOpacity
              style={[styles.card, styles.waCard]}
              onPress={handleFixBattery}
              activeOpacity={0.7}>
              <View style={styles.iconContainer}>
                <Text style={styles.icon}>🔋</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Battery Optimization</Text>
                <Text style={[styles.waStatus, styles.waStatusOff]}>⚠️ Restricted — tap to fix</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.noDefaultText}>
            Some phone brands (Xiaomi, Vivo, Oppo, Infinix, Tecno) also need "Autostart" allowed
            manually in their own battery settings — check your phone's Settings → Battery → Autostart.
          </Text>
        </>
      )}

      {/* ── Developer Mode toggle — DB-backed runtime flag, works in release
          builds too (unlike __DEV__ which is a compile-time constant). This
          row itself is never hidden, otherwise there'd be no way to turn it
          back on from a release build. ── */}
      <Text style={[styles.sectionLabel, { marginTop: 28 }]}>DEVELOPER</Text>
      <Text style={styles.sectionHint}>
        Toggle to show or hide developer tools (manual check, testing lab, debug traces).
      </Text>

      <View style={styles.permCard}>
        <View style={styles.permRow}>
          <View style={styles.permIconWrap}>
            <Text style={styles.icon}>🛠️</Text>
          </View>
          <View style={styles.permTextWrap}>
            <Text style={styles.permTitle}>Developer Mode</Text>
            <Text style={styles.permSubtitle}>
              {devMode ? 'Active — dev tools visible' : 'Inactive — dev tools hidden'}
            </Text>
          </View>
          <Switch
            value={devMode}
            onValueChange={handleDevModeToggle}
            trackColor={{ false: '#E0E0E0', true: '#1A1A2E' }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {/* ── Scheduler (Dev/Testing only — visible when dev mode is ON) ── */}
      {devMode && (
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

          <TouchableOpacity
            style={styles.labBtn}
            onPress={() => navigation.navigate('DevTestLab')}
            activeOpacity={0.8}>
            <Text style={styles.labBtnIcon}>🧪</Text>
            <Text style={styles.labBtnText}>Open Testing Lab</Text>
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
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
    marginBottom: 4,
  },
  headerTitle:    { fontSize: 28, fontWeight: '700', color: '#1A1A2E' },
  headerSubtitle: { fontSize: 13, color: '#888', marginTop: 2 },

  sectionLabel: {
    fontSize: 10, color: '#9E9E9E', fontWeight: '700',
    letterSpacing: 1.5, marginHorizontal: 16, marginTop: 18, marginBottom: 5,
  },
  sectionHint: {
    fontSize: 11.5, color: '#9E9E9E', marginHorizontal: 16, marginBottom: 12, lineHeight: 16,
  },

  // Generic card (still used by Background Reliability rows)
  card: {
    backgroundColor: '#fff', borderRadius: 13, padding: 13,
    marginHorizontal: 16, marginBottom: 8,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  waCard:       { alignItems: 'center' },
  iconContainer: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: '#F8F9FA',
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  icon:    { fontSize: 20 },
  label:   { fontSize: 15, fontWeight: '600', color: '#1A1A2E' },
  chevron: { fontSize: 20, color: '#BDBDBD', marginLeft: 6 },

  waStatus:    { fontSize: 11.5, marginTop: 2 },
  waStatusOk:  { color: '#10B981' },
  waStatusOff: { color: '#F59E0B' },

  radioOuter: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: '#BDBDBD',
    justifyContent: 'center', alignItems: 'center',
  },
  radioOuterSelected: { borderColor: '#1A1A2E' },
  radioInner: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#1A1A2E' },
  noDefaultText: {
    fontSize: 11.5, color: '#9E9E9E', marginHorizontal: 16, marginTop: 6, textAlign: 'center',
  },

  // ── Permissions card ──
  permCard: {
    backgroundColor: '#fff', borderRadius: 14,
    marginHorizontal: 16, marginBottom: 8,
    borderWidth: 1.5, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
    overflow: 'hidden',
  },
  permRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12, gap: 10,
  },
  permIconWrap: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: '#F8F9FA',
    justifyContent: 'center', alignItems: 'center',
  },
  permTextWrap:  { flex: 1 },
  permTitle:     { fontSize: 13.5, fontWeight: '700', color: '#1A1A2E' },
  permSubtitle:  { fontSize: 11, color: '#9CA3AF', marginTop: 1, lineHeight: 14 },
  permDivider:   { height: 1, backgroundColor: '#F5F5F5', marginLeft: 60 },

  // ── Accordion platform card ──
  accCard: {
    backgroundColor: '#fff', borderRadius: 13,
    marginHorizontal: 16, marginBottom: 8,
    borderWidth: 1.5, borderColor: '#F0F0F0',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
    overflow: 'hidden',
  },
  accHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12, gap: 8,
  },
  accHeaderMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  accBody: {
    borderTopWidth: 1, borderTopColor: '#F5F5F5',
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14,
  },
  accSection:      { marginBottom: 14 },
  accSectionLabel: { fontSize: 12.5, fontWeight: '700', color: '#1A1A2E', marginBottom: 3 },
  accSectionHint:  { fontSize: 11.5, color: '#9E9E9E', lineHeight: 16, marginBottom: 8 },

  accRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 9, marginBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#F5F5F5',
  },
  accRowLabel: { fontSize: 13.5, fontWeight: '600', color: '#1A1A2E' },

  pausedNote: {
    fontSize: 11.5, color: '#F59E0B', fontWeight: '600',
    marginBottom: 12, backgroundColor: '#FFF8EB',
    padding: 9, borderRadius: 9,
  },

  defaultRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  defaultRowText: { fontSize: 13.5, fontWeight: '600', color: '#1A1A2E' },

  rateLimitRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  rateLimitCountInput: {
    width: 58, fontSize: 14, color: '#1A1A2E', textAlign: 'center',
    paddingVertical: 7, paddingHorizontal: 7,
    backgroundColor: '#F8F9FA', borderRadius: 9,
    borderWidth: 1, borderColor: '#EEEEEE',
  },
  rateLimitPerText: { fontSize: 12.5, color: '#9E9E9E', fontWeight: '600' },
  rateLimitTimeInput: {
    width: 44, fontSize: 14, color: '#1A1A2E', textAlign: 'center',
    paddingVertical: 7, paddingHorizontal: 5,
    backgroundColor: '#F8F9FA', borderRadius: 9,
    borderWidth: 1, borderColor: '#EEEEEE',
  },
  rateLimitUnitText: { fontSize: 12.5, color: '#9E9E9E', fontWeight: '600', marginRight: 3 },
  rateLimitBtnRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  rateLimitClearBtn: {
    backgroundColor: '#FFF5F5', paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 9, borderWidth: 1, borderColor: '#FFE0E0',
  },
  rateLimitClearBtnText: { color: '#D32F2F', fontWeight: '600', fontSize: 12.5 },

  tierList: { marginBottom: 10, gap: 6 },
  tierRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#F8F9FA', borderRadius: 9, borderWidth: 1, borderColor: '#EEEEEE',
    paddingVertical: 8, paddingHorizontal: 11,
  },
  tierRowText: { fontSize: 13, fontWeight: '600', color: '#1A1A2E' },
  tierRemoveX: { fontSize: 13, color: '#D32F2F', fontWeight: '700', paddingHorizontal: 4 },

  smsLimitSaveBtn: {
    backgroundColor: '#1A1A2E', paddingHorizontal: 16,
    paddingVertical: 9, borderRadius: 9,
  },
  smsLimitSaveBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  runBtn: {
    marginHorizontal: 16, backgroundColor: '#1A1A2E',
    borderRadius: 13, paddingVertical: 13,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  runBtnDisabled: { backgroundColor: '#BDBDBD' },
  runBtnIcon:     { fontSize: 15 },
  runBtnText:     { color: '#fff', fontSize: 14, fontWeight: '700' },

  labBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    marginTop: 9, marginHorizontal: 16, backgroundColor: '#EEF2FF',
    borderRadius: 13, paddingVertical: 12, borderWidth: 1, borderColor: '#DDE3FF',
  },
  labBtnIcon: { fontSize: 14 },
  labBtnText: { color: '#3730A3', fontSize: 13, fontWeight: '700' },
});