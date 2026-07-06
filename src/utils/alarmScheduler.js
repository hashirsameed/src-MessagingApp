import { NativeModules, Platform, Alert } from 'react-native';
import { handleError } from './errorHandler';
import {
  upsertScheduledAlarm,
  markScheduledAlarmCancelled,
  cancelAllScheduledAlarmsForContact,
  cancelAllScheduledAlarmsForTemplate,
  getAllActiveScheduledAlarms,
} from '../database/scheduledAlarmDB';
import { debugTrace, debugTraceError, debugTraceDuration, generateTraceId } from './debugTrace';
import { toPakistanParts, pakistanPartsToUtcMs } from './pakistanTime';

const { AlarmModule } = NativeModules;
const IMMEDIATE_ALARM_DELAY_MS = 10000;

export const isAlarmModuleAvailable = () =>
  Platform.OS === 'android' &&
  AlarmModule &&
  typeof AlarmModule.scheduleExactAlarm === 'function' &&
  typeof AlarmModule.cancelExactAlarm === 'function';

/**
 * Deterministic 32-bit-safe hash for (contactId, templateId) -> requestCode.
 */
export const getRequestCode = (contactId, templateId) => {
  const str = `${contactId}:${templateId}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return hash & 0x7fffffff;
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

/**
 * Computes the alarm fire time for one template against one contact.
 *
 * days_before semantics:
 *   positive -> fires BEFORE expiry (existing behavior)
 *   zero     -> fires ON expiry day
 *   negative -> fires AFTER expiry (overdue reminder)
 *
 * If the computed moment is already in the past — either because an
 * after-expiry template's exact moment has passed, or because a contact
 * was added/synced late and its due reminder time already went by —
 * this fires almost immediately instead of silently dropping it. There
 * is no cutoff on how old the expiry can be; any overdue contact is
 * still eligible.
 */
export const computeTargetAlarmTimestamp = (contact, template) => {
  const expiry = new Date(contact.expiry_datetime);
  if (isNaN(expiry.getTime())) return null;

  const daysBefore = Number.isInteger(template.days_before)
    ? template.days_before
    : parseInt(template.days_before ?? 1, 10);
  if (isNaN(daysBefore)) return null;

  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(template.send_time ?? '');

  // Everything below is expressed in Pakistan wall-clock time (fixed
  // UTC+5, no DST) — never the device's own timezone. "days_before"
  // shifts by whole days on the Pakistan calendar.
  const expiryParts = toPakistanParts(expiry);
  const expiryPktMidnightMs = pakistanPartsToUtcMs(expiryParts.year, expiryParts.month, expiryParts.day);
  const shiftedMidnightMs = expiryPktMidnightMs - daysBefore * 24 * 60 * 60 * 1000;
  const shiftedParts = toPakistanParts(new Date(shiftedMidnightMs));

  if (!timeMatch) {
    // No explicit send_time — keep the expiry's own Pakistan time-of-day.
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

export const computeAlarmTimestamp = (contact, template) => {
  const alarmMs = computeTargetAlarmTimestamp(contact, template);
  if (alarmMs === null) return null;

  if (alarmMs <= Date.now()) {
    return Date.now() + IMMEDIATE_ALARM_DELAY_MS; // fire almost immediately
  }

  return alarmMs;
};

export const isTemplateAlarmDue = (contact, template, nowMs = Date.now()) => {
  const alarmMs = computeTargetAlarmTimestamp(contact, template);
  return alarmMs !== null && alarmMs <= nowMs;
};

export const scheduleAlarm = async (contactId, templateId, timestampMs) => {
  if (Platform.OS !== 'android') return 'SKIPPED_NON_ANDROID';
  if (!isAlarmModuleAvailable()) {
    handleError(new Error('AlarmModule is not linked'), 'scheduleAlarm');
    return 'FAILED_NATIVE_MODULE_UNAVAILABLE';
  }
  try {
    const requestCode = getRequestCode(contactId, templateId);
    const result = await AlarmModule.scheduleExactAlarm(
      requestCode,
      contactId,
      templateId,
      timestampMs,
    );

    if (result === 'SCHEDULED') {
      const triggerAtISO = new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
      upsertScheduledAlarm(contactId, templateId, requestCode, triggerAtISO);
    }

    return result;
  } catch (error) {
    handleError(error, 'scheduleAlarm');
    return 'FAILED_EXCEPTION';
  }
};

export const cancelAlarm = async (contactId, templateId) => {
  if (Platform.OS !== 'android') return true;
  if (!isAlarmModuleAvailable()) {
    markScheduledAlarmCancelled(contactId, templateId);
    return false;
  }
  try {
    const requestCode = getRequestCode(contactId, templateId);
    const nativeResult = await AlarmModule.cancelExactAlarm(requestCode, contactId, templateId);
    markScheduledAlarmCancelled(contactId, templateId);
    return nativeResult;
  } catch (error) {
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
  return cancelledRows.length;
};

export const rescheduleAlarmsForContact = async (contact, activeTemplates) => {
  await cancelAlarmsForContact(contact.id);
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
  const activeRows = getAllActiveScheduledAlarms();
  let rearmed = 0;
  if (Platform.OS !== 'android' || !isAlarmModuleAvailable()) return rearmed;

  for (const row of activeRows) {
    const triggerMs = new Date(row.trigger_at).getTime();
    if (isNaN(triggerMs) || triggerMs <= Date.now()) {
      markScheduledAlarmCancelled(row.contact_id, row.template_id);
      continue;
    }

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

  return rearmed;
};