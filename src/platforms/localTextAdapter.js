import { Linking, Platform, PermissionsAndroid, NativeModules, AppState } from 'react-native';
import { debugTrace, debugTraceError } from '../utils/debugTrace';

const { SmsModule } = NativeModules;

const DEFAULT_EMAIL_SUBJECT = 'Important: Policy Renewal Reminder';

const formatPhone = (phone) => {
  const cleaned = phone.replace(/\D/g, '').replace(/^0/, '');
  return `92${cleaned}`;
};

const buildUrl = (platform, contact, message) => {
  let url = platform.url_scheme;
  if (url.includes('{phone}')) {
    url = url.replace('{phone}', formatPhone(contact.phone_number ?? ''));
  }
  if (url.includes('{email}')) {
    url = url.replace('{email}', encodeURIComponent(contact.email ?? ''));
  }
  if (url.includes('{subject}')) {
    url = url.replace('{subject}', encodeURIComponent(DEFAULT_EMAIL_SUBJECT));
  }
  if (url.includes('{message}')) {
    url = url.replace('{message}', encodeURIComponent(message));
  }
  return url;
};

// Same permission logic as before: check() works headless, request() needs
// foreground Activity — only fired when AppState is 'active'.
export const requestSmsPermission = async () => {
  debugTrace('RequestSmsPermissionBefore', {});
  try {
    const alreadyGranted = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.SEND_SMS,
    );
    if (alreadyGranted) {
      debugTrace('RequestSmsPermissionAfter', { granted: true, source: 'already_granted_check' });
      return true;
    }

    if (AppState.currentState !== 'active') {
      debugTrace('RequestSmsPermissionAfter', {
        granted: false, source: 'not_granted_and_backgrounded', appState: AppState.currentState,
      });
      return false;
    }

    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.SEND_SMS,
      {
        title: 'SMS Permission',
        message: 'This app needs permission to send SMS messages automatically.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      },
    );
    const isGranted = granted === PermissionsAndroid.RESULTS.GRANTED;
    debugTrace('RequestSmsPermissionAfter', { granted: isGranted, rawResult: granted, source: 'foreground_dialog' });
    return isGranted;
  } catch (error) {
    debugTraceError('RequestSmsPermissionCatch', error, { function: 'requestSmsPermission' });
    debugTrace('RequestSmsPermissionAfter', { granted: false, exitReason: 'exception' });
    return false;
  }
};

const sendNativeSms = async (phoneNumber, message, traceContext = {}) => {
  debugTrace('SendNativeSmsBefore', {
    ...traceContext,
    phoneNumber,
    messageLength: message?.length ?? 0,
  });
  if (!SmsModule) {
    debugTrace('SendNativeSmsExit', { ...traceContext, exitReason: 'native_module_not_linked' });
    return { sent: false, reason: 'NATIVE_MODULE_NOT_LINKED' };
  }
  try {
    debugTrace('NativeModuleSendSmsBefore', { ...traceContext, phoneNumber });
    const resultCode = await SmsModule.sendSms(phoneNumber, message);
    debugTrace('NativeModuleSendSmsAfter', { ...traceContext, phoneNumber, resultCode });
    if (resultCode === 'SENT') {
      debugTrace('SendNativeSmsExit', { ...traceContext, outcome: 'sent', resultCode });
      return { sent: true, reason: 'SENT' };
    }
    debugTrace('SendNativeSmsExit', { ...traceContext, outcome: 'failed', resultCode });
    return { sent: false, reason: resultCode || 'UNKNOWN' };
  } catch (error) {
    debugTraceError('SendNativeSmsCatch', error, { function: 'sendNativeSms', ...traceContext, phoneNumber });
    return { sent: false, reason: `EXCEPTION_${error?.message ?? 'UNKNOWN'}` };
  }
};

const sendViaLinking = async (platform, contact, message, traceContext = {}) => {
  const url = buildUrl(platform, contact, message);
  debugTrace('SendViaLinkingBefore', { ...traceContext, platformId: platform.id, urlLength: url.length });
  let supported = false;
  try {
    supported = await Linking.canOpenURL(url);
  } catch (error) {
    debugTraceError('SendViaLinkingCanOpenCatch', error, { function: 'sendViaLinking', ...traceContext, platformId: platform.id });
    supported = false;
  }
  debugTrace('SendViaLinkingCanOpenAfter', { ...traceContext, platformId: platform.id, supported });
  if (!supported) {
    debugTrace('SendViaLinkingExit', { ...traceContext, platformId: platform.id, exitReason: 'url_not_supported' });
    return false;
  }
  await Linking.openURL(url);
  debugTrace('SendViaLinkingExit', { ...traceContext, platformId: platform.id, outcome: 'opened' });
  return true;
};

/**
 * dispatch — handles platform_type = 'local_text' (sms, email, gmail, custom).
 * ctx = { smsPermissionGranted, traceContext }
 * Returns: 'sent' | 'opened' | 'failed_<REASON>' — same result vocabulary
 * queueProcessor already understands, so Step 5 is a drop-in swap.
 */
export const dispatch = async (platform, contact, message, ctx = {}) => {
  const { smsPermissionGranted = false, traceContext = {} } = ctx;

  if (platform.id === 'sms') {
    if (Platform.OS === 'android') {
      if (!smsPermissionGranted) {
        debugTrace('DispatchItemExit', {
          ...traceContext, platformId: 'sms', exitReason: 'no_sms_permission', result: 'failed_NO_SMS_PERMISSION',
        });
        return 'failed_NO_SMS_PERMISSION';
      }

      const { sent, reason } = await sendNativeSms(contact.phone_number, message, traceContext);
      if (sent) {
        debugTrace('DispatchItemExit', { ...traceContext, platformId: 'sms', outcome: 'sent' });
        return 'sent';
      }

      if (reason === 'NATIVE_MODULE_NOT_LINKED') {
        debugTrace('DispatchItemSmsFallbackLinking', { ...traceContext, reason });
        const opened = await sendViaLinking(platform, contact, message, traceContext);
        const result = opened ? 'opened' : 'failed_SMS_PLATFORM_UNAVAILABLE';
        debugTrace('DispatchItemExit', { ...traceContext, platformId: 'sms', outcome: opened ? 'opened' : 'failed', result });
        return result;
      }

      const failResult = `failed_${reason}`;
      debugTrace('DispatchItemExit', { ...traceContext, platformId: 'sms', outcome: 'failed', result: failResult });
      return failResult;
    }

    const opened = await sendViaLinking(platform, contact, message, traceContext);
    const result = opened ? 'opened' : 'failed_SMS_PLATFORM_UNAVAILABLE';
    debugTrace('DispatchItemExit', { ...traceContext, platformId: 'sms', outcome: opened ? 'opened' : 'failed', result });
    return result;
  }

  // Email / Gmail / any custom url_scheme platform
  const opened = await sendViaLinking(platform, contact, message, traceContext);
  if (opened) {
    debugTrace('DispatchItemExit', { ...traceContext, platformId: platform.id, outcome: 'opened' });
    return 'opened';
  }
  const failResult = `failed_PLATFORM_NOT_INSTALLED_${platform.id.toUpperCase()}`;
  debugTrace('DispatchItemExit', { ...traceContext, platformId: platform.id, outcome: 'failed', result: failResult });
  return failResult;
};

export default { dispatch, requestSmsPermission };

// Self-register — importing this module anywhere wires it into the registry.
// Step 5 will `import '../platforms/localTextAdapter'` once near app entry
// (or import it directly where dispatch happens) instead of hardcoding.
import { registerAdapter } from './registry';
registerAdapter('local_text', { dispatch, requestSmsPermission });