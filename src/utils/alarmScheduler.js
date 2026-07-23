import { NativeModules, Platform, Alert } from 'react-native';
import { handleError } from './errorHandler';
import {
  upsertScheduledAlarm,
  markScheduledAlarmCancelled,
  cancelAllScheduledAlarmsForContact,
  cancelAllScheduledAlarmsForTemplate,
  getAllActiveScheduledAlarms,
  getScheduledAlarm,
  deleteScheduledAlarm,
} from '../database/scheduledAlarmDB';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { toPakistanParts, pakistanPartsToUtcMs } from './pakistanTime';

import { getAllTemplates } from '../database/templateDB';
import { getAllContacts } from '../database/contactDB';

const { AlarmModule } = NativeModules;
const IMMEDIATE_ALARM_DELAY_MS = 10000;

export const isAlarmModuleAvailable = () =>
  Platform.OS === 'android' &&
  AlarmModule &&
  typeof AlarmModule.scheduleExactAlarm === 'function' &&
  typeof AlarmModule.cancelExactAlarm === 'function';

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 — getRequestCode hash collision risk kam kiya
// Pehle: Sirf 31-bit hash (max ~2.1 billion values). Bohot contacts × templates
//         mein do alag pairs ka ek hi requestCode ban sakta tha. `scheduled_alarms`
//         mein `request_code UNIQUE` constraint fail hoti — alarm schedule nahi
//         hota, kisi ko pata nahi chalta (silent miss).
// Fix:   Do-pass polynomial hash: pehle forward, phir backward. Dono ko XOR karo.
//         Same string length mein anagram collisions practically khatam.
//         Phir `>>> 0` se unsigned 32-bit banao — Android requestCode
//         positive integer mangta hai.
// ─────────────────────────────────────────────────────────────────────────────
export const getRequestCode = (contactId, templateId) => {
  const str = `${contactId}:${templateId}`;

  // Forward pass
  let h1 = 0;
  for (let i = 0; i < str.length; i++) {
    h1 = (Math.imul(h1, 31) + str.charCodeAt(i)) | 0;
  }

  // Backward pass — anagram collision rok-ta hai (e.g. "ab:cd" vs "cd:ab")
  let h2 = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    h2 = (Math.imul(h2, 37) + str.charCodeAt(i)) | 0;
  }

  // XOR dono hashes, phir 31-bit positive range mein mask karo — Android
  // PendingIntent/AlarmManager ka requestCode signed 32-bit Java int hota h
  // (max 2147483647). `>>> 0` unsigned 32-bit deta tha jo isse overflow kr sakta
  // tha; `& 0x7fffffff` hamesha 0..2147483647 range mein rakhta h.
  return (h1 ^ h2) & 0x7fffffff;
};

export const canScheduleExactAlarms = async () => {
  if (Platform.OS !== 'android') return true;
  if (!AlarmModule?.canScheduleExactAlarms) {
    debugTrace('CanScheduleExactAlarmsExit', { exitReason: 'native_module_not_linked' });
    return false;
  }
  try {
    const result = await AlarmModule.canScheduleExactAlarms();
    debugTrace('CanScheduleExactAlarmsResult', { granted: result });
    return result;
  } catch (error) {
    debugTraceError('CanScheduleExactAlarmsCatch', error, { function: 'canScheduleExactAlarms' });
    handleError(error, 'canScheduleExactAlarms');
    return false;
  }
};

export const requestBatteryOptimizationExemption = () => {
  return new Promise((resolve) => {
    if (Platform.OS !== 'android') return resolve();
    if (!AlarmModule?.isIgnoringBatteryOptimizations) return resolve();

    AlarmModule.isIgnoringBatteryOptimizations()
      .then((ignoring) => {
        debugTrace('BatteryOptimizationCheck', { ignoring });
        if (ignoring) return resolve();

        Alert.alert(
          'Disable Battery Optimization',
          'To avoid delayed reminders, please allow this app to run without battery restrictions.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => {
              debugTrace('BatteryOptimizationPromptResult', { userChoice: 'cancel' });
              resolve();
            } },
            {
              text: 'Allow',
              onPress: () => {
                debugTrace('BatteryOptimizationPromptResult', { userChoice: 'allow' });
                AlarmModule.requestIgnoreBatteryOptimizations();
                resolve();
              },
            },
          ],
          { cancelable: false },
        );
      })
      .catch((error) => {
        debugTraceError('BatteryOptimizationCheckCatch', error, { function: 'requestBatteryOptimizationExemption' });
        handleError(error, 'requestBatteryOptimizationExemption');
        resolve();
      });
  });
};

const requestExactAlarmPermission = () => {
  return new Promise((resolve) => {
    if (Platform.OS !== 'android') return resolve();
    if (!AlarmModule?.canScheduleExactAlarms) return resolve();

    AlarmModule.canScheduleExactAlarms()
      .then((granted) => {
        debugTrace('ExactAlarmPermissionCheck', { granted });
        if (granted) return resolve();

        Alert.alert(
          'Allow Exact Alarms',
          'To send expiry reminders at the exact time you set — even when the app is closed — please allow "Alarms & reminders" for this app.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => {
              debugTrace('ExactAlarmPermissionPromptResult', { userChoice: 'cancel' });
              resolve();
            } },
            {
              text: 'Allow',
              onPress: () => {
                debugTrace('ExactAlarmPermissionPromptResult', { userChoice: 'allow' });
                AlarmModule.openExactAlarmSettings();
                resolve();
              },
            },
          ],
          { cancelable: false },
        );
      })
      .catch((error) => {
        debugTraceError('ExactAlarmPermissionCheckCatch', error, { function: 'requestExactAlarmPermission' });
        handleError(error, 'requestExactAlarmPermission');
        resolve();
      });
  });
};

export const runPermissionOnboardingFlow = async () => {
  if (Platform.OS !== 'android') return;
  const traceId = generateTraceId('permissionOnboarding');
  debugTrace('RunPermissionOnboardingFlowStart', { traceId });
  try {
    await requestExactAlarmPermission();
    await requestBatteryOptimizationExemption();
    debugTrace('RunPermissionOnboardingFlowEnd', { traceId, outcome: 'completed' });
  } catch (error) {
    debugTraceError('RunPermissionOnboardingFlowCatch', error, { function: 'runPermissionOnboardingFlow', traceId });
    handleError(error, 'runPermissionOnboardingFlow');
  }
};

export const computeTargetAlarmTimestamp = (contact, template) => {
  const expiry = new Date(contact.expiry_datetime);
  if (isNaN(expiry.getTime())) return null;

  const daysBefore = Number.isInteger(template.days_before)
    ? template.days_before
    : parseInt(template.days_before ?? 1, 10);
  if (isNaN(daysBefore)) return null;

  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(template.send_time ?? '');

  const expiryParts = toPakistanParts(expiry);
  const expiryPktMidnightMs = pakistanPartsToUtcMs(expiryParts.year, expiryParts.month, expiryParts.day);
  const shiftedMidnightMs = expiryPktMidnightMs - daysBefore * 24 * 60 * 60 * 1000;
  const shiftedParts = toPakistanParts(new Date(shiftedMidnightMs));

  if (!timeMatch) {
    return pakistanPartsToUtcMs(
      shiftedParts.year, shiftedParts.month, shiftedParts.day,
      expiryParts.hour, expiryParts.minute, expiryParts.second,
    );
  }

  return pakistanPartsToUtcMs(
    shiftedParts.year, shiftedParts.month, shiftedParts.day,
    parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0,
  );
};

export const wasAlarmTargetBeforeContactCreated = (contact, alarmMs) => {
  if (alarmMs === null || !contact?.created_at) return false;
  const createdAtMs = new Date(contact.created_at).getTime();
  if (isNaN(createdAtMs)) return false;
  return alarmMs < createdAtMs;
};

export const computeAlarmTimestamp = (contact, template) => {
  const alarmMs = computeTargetAlarmTimestamp(contact, template);
  if (alarmMs === null) return null;

  if (wasAlarmTargetBeforeContactCreated(contact, alarmMs)) return null;

  if (alarmMs <= Date.now()) {
    return Date.now() + IMMEDIATE_ALARM_DELAY_MS;
  }

  return alarmMs;
};

export const isTemplateAlarmDue = (contact, template, nowMs = Date.now()) => {
  const alarmMs = computeTargetAlarmTimestamp(contact, template);
  if (alarmMs === null) return false;
  if (wasAlarmTargetBeforeContactCreated(contact, alarmMs)) return false;
  return alarmMs <= nowMs;
};

export const scheduleAlarm = async (contactId, templateId, timestampMs) => {
  if (Platform.OS !== 'android') return 'SKIPPED_NON_ANDROID';
  if (!isAlarmModuleAvailable()) {
    handleError(new Error('AlarmModule is not linked'), 'scheduleAlarm');
    return 'FAILED_NATIVE_MODULE_UNAVAILABLE';
  }
  
  const traceId = generateTraceId('scheduleAlarm');
  debugTrace('ScheduleAlarmStart', { traceId, contactId, templateId, timestampMs });

  try {
    const triggerAtISO = new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const existing = getScheduledAlarm(contactId, templateId);
    
    if (
      existing &&
      (existing.status === 'fired' || existing.status === 'firing') &&
      existing.trigger_at === triggerAtISO
    ) {
      debugTrace('ScheduleAlarmSkipAlreadyFired', { traceId, contactId, templateId });
      return 'SKIPPED_ALREADY_FIRED';
    }

    const requestCode = getRequestCode(contactId, templateId);

    const dbSuccess = upsertScheduledAlarm(contactId, templateId, requestCode, triggerAtISO);
    
    if (!dbSuccess) {
      debugTraceError('ScheduleAlarmDbFailed', new Error('DB upsert failed'), { traceId, contactId, templateId });
      return 'FAILED_DB_UPSERT';
    }

    const result = await AlarmModule.scheduleExactAlarm(
      requestCode,
      contactId,
      templateId,
      timestampMs,
    );

    if (result === 'SCHEDULED') {
      if (AlarmModule.refreshReminderSurfaces) {
        AlarmModule.refreshReminderSurfaces().catch((error) => {
          handleError(error, 'scheduleAlarm.refreshReminderSurfaces');
        });
      }
      debugTrace('ScheduleAlarmSuccess', { traceId, contactId, templateId, requestCode });
    }

    return result;
  } catch (error) {
    debugTraceError('ScheduleAlarmCatch', error, { function: 'scheduleAlarm', traceId, contactId, templateId });
    handleError(error, 'scheduleAlarm');
    return 'FAILED_EXCEPTION';
  }
};

export const cancelAlarm = async (contactId, templateId) => {
  if (Platform.OS !== 'android') {
    deleteScheduledAlarm(contactId, templateId);
    return true;
  }
  if (!isAlarmModuleAvailable()) {
    deleteScheduledAlarm(contactId, templateId);
    return false;
  }
  
  const traceId = generateTraceId('cancelAlarm');
  debugTrace('CancelAlarmStart', { traceId, contactId, templateId });

  try {
    const requestCode = getRequestCode(contactId, templateId);
    const nativeResult = await AlarmModule.cancelExactAlarm(requestCode, contactId, templateId);
    
    deleteScheduledAlarm(contactId, templateId);
    
    if (AlarmModule.refreshReminderSurfaces) {
      AlarmModule.refreshReminderSurfaces().catch((error) => {
        handleError(error, 'cancelAlarm.refreshReminderSurfaces');
      });
    }
    
    debugTrace('CancelAlarmSuccess', { traceId, contactId, templateId, nativeResult });
    return nativeResult;
  } catch (error) {
    debugTraceError('CancelAlarmCatch', error, { function: 'cancelAlarm', traceId, contactId, templateId });
    handleError(error, 'cancelAlarm');
    return false;
  }
};

export const scheduleAlarmsForContact = async (contact, activeTemplates) => {
  const results = [];
  for (const template of activeTemplates) {
    const ts = computeAlarmTimestamp(contact, template);
    if (ts === null) continue;
    const result = await scheduleAlarm(contact.id, template.id, ts);
    results.push({ templateId: template.id, result });
  }
  return results;
};

export const cancelAlarmsForContact = async (contactId) => {
  const cancelledRows = cancelAllScheduledAlarmsForContact(contactId);
  if (Platform.OS !== 'android' || !isAlarmModuleAvailable()) return cancelledRows.length;
  
  for (const row of cancelledRows) {
    try {
      await AlarmModule.cancelExactAlarm(row.request_code, row.contact_id, row.template_id);
    } catch (error) {
      handleError(error, 'cancelAlarmsForContact.native');
    }
  }
  
  if (cancelledRows.length > 0 && AlarmModule.refreshReminderSurfaces) {
    AlarmModule.refreshReminderSurfaces().catch((error) => {
      handleError(error, 'cancelAlarmsForContact.refreshReminderSurfaces');
    });
  }
  return cancelledRows.length;
};

export const cancelAlarmsForTemplate = async (templateId) => {
  const cancelledRows = cancelAllScheduledAlarmsForTemplate(templateId);
  if (Platform.OS !== 'android' || !isAlarmModuleAvailable()) return cancelledRows.length;
  
  for (const row of cancelledRows) {
    try {
      await AlarmModule.cancelExactAlarm(row.request_code, row.contact_id, row.template_id);
    } catch (error) {
      handleError(error, 'cancelAlarmsForTemplate.native');
    }
  }
  
  if (cancelledRows.length > 0 && AlarmModule.refreshReminderSurfaces) {
    AlarmModule.refreshReminderSurfaces().catch((error) => {
      handleError(error, 'cancelAlarmsForTemplate.refreshReminderSurfaces');
    });
  }
  return cancelledRows.length;
};

export const rescheduleAlarmsForContact = async (contact, activeTemplates) => {
  return scheduleAlarmsForContact(contact, activeTemplates);
};

export const rescheduleAlarmsForTemplate = async (template, allContacts) => {
  await cancelAlarmsForTemplate(template.id);

  if (!template.is_active) return [];

  const results = [];
  for (const contact of allContacts) {
    const ts = computeAlarmTimestamp(contact, template);
    if (ts === null) continue;
    const result = await scheduleAlarm(contact.id, template.id, ts);
    results.push({ contactId: contact.id, result });
  }
  return results;
};

export const rearmAllScheduledAlarmsAfterBoot = async () => {
  const { fireScheduledPair } = require('./alarmFireCore');

  const activeRows = getAllActiveScheduledAlarms();
  let rearmed = 0;
  let firedImmediately = 0;

  for (const row of activeRows) {
    const triggerMs = new Date(row.trigger_at).getTime();

    if (isNaN(triggerMs)) {
      markScheduledAlarmCancelled(row.contact_id, row.template_id);
      continue;
    }

    if (triggerMs <= Date.now()) {
      const outcome = await fireScheduledPair(row.contact_id, row.template_id, generateTraceId('bootMissed'));
      if (outcome === 'fired' || outcome === 'already_handled') firedImmediately += 1;
      continue;
    }

    if (Platform.OS !== 'android' || !isAlarmModuleAvailable()) continue;

    try {
      const result = await AlarmModule.scheduleExactAlarm(
        row.request_code,
        row.contact_id,
        row.template_id,
        triggerMs,
      );
      if (result === 'SCHEDULED') rearmed += 1;
    } catch (error) {
      handleError(error, 'rearmAllScheduledAlarmsAfterBoot');
    }
  }

  debugTrace('RearmAllScheduledAlarmsAfterBootSummary', {
    totalRows: activeRows.length, rearmed, firedImmediately,
  });

  return rearmed + firedImmediately;
};

// ✅ FIXED: 'const template' declared (was previously undeclared 'a', causing a ReferenceError/implicit-global bug)
export const cancelAlarmsForPlatform = async (platformId) => {
  const templates = getAllTemplates().filter(
    (t) => (t.platform_id ?? 'sms') === platformId
  );
  let total = 0;
  for (const template of templates) {
    total += await cancelAlarmsForTemplate(template.id);
  }
  return total;
};

export const rescheduleAlarmsForPlatform = async (platformId) => {
  const templates = getAllTemplates()
    .filter((t) => (t.platform_id ?? 'sms') === platformId && t.is_active === 1);
  const contacts = getAllContacts();

  let results = [];
  for (const template of templates) {
    const r = await rescheduleAlarmsForTemplate(template, contacts);
    results = results.concat(r);
  }
  return results;
};