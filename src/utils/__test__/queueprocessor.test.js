import { processQueue } from '../queueProcessor';
import { PermissionsAndroid, NativeModules } from 'react-native';
import {
  claimPendingQueue,
  markAsSent,
  markAsFailed,
  revertToPending,
  countSmsSentInLastHour,
} from '../../database/messageQueueDB';
import { getAllContacts } from '../../database/contactDB';
import { getAllTemplates } from '../../database/templateDB';
import { getAllPlatforms } from '../../database/platformDB';
import { getSmsPerHourLimit } from '../../database/settingsDB';
import { personalizeMessage } from '../templateMatcher';
import { handleError } from '../errorHandler';
import { sendWhatsAppMessage, hasWhatsAppCredentials } from '../whatsappService';

jest.mock('react-native', () => ({
  Linking: {
    canOpenURL: jest.fn(),
    openURL: jest.fn(),
  },
  Platform: { OS: 'android' },
  PermissionsAndroid: {
    check: jest.fn(),
    request: jest.fn(),
    PERMISSIONS: { SEND_SMS: 'android.permission.SEND_SMS' },
    RESULTS: { GRANTED: 'granted' },
  },
  AppState: { currentState: 'active' },
  NativeModules: {
    SmsModule: { sendSms: jest.fn() },
  },
}));

jest.mock('../../database/messageQueueDB', () => ({
  claimPendingQueue: jest.fn(),
  markAsSent: jest.fn(),
  markAsFailed: jest.fn(),
  revertToPending: jest.fn(),
  countSmsSentInLastHour: jest.fn(),
}));

jest.mock('../../database/contactDB', () => ({
  getAllContacts: jest.fn(),
}));

jest.mock('../../database/templateDB', () => ({
  getAllTemplates: jest.fn(),
}));

jest.mock('../../database/platformDB', () => ({
  getAllPlatforms: jest.fn(),
}));

jest.mock('../../database/settingsDB', () => ({
  getSmsPerHourLimit: jest.fn(),
}));

jest.mock('../templateMatcher', () => ({
  getDaysUntilExpiry: jest.fn(() => 3),
  personalizeMessage: jest.fn(() => 'Hello test message'),
}));

jest.mock('../errorHandler', () => ({
  handleError: jest.fn(),
}));

jest.mock('../whatsappService', () => ({
  sendWhatsAppMessage: jest.fn(),
  hasWhatsAppCredentials: jest.fn(),
}));

jest.mock('../debugTrace', () => ({
  debugTrace: jest.fn(),
  debugTraceError: jest.fn(),
  debugTraceDuration: jest.fn(),
  generateTraceId: jest.fn(() => 'trace-test-id'),
}));

const baseContact = { id: 1, phone_number: '03001234567', email: 'test@example.com' };
const baseTemplate = { id: 1, body: 'Hi {name}' };

describe('processQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // sensible defaults so each test only overrides what it cares about
    getAllContacts.mockReturnValue([baseContact]);
    getAllTemplates.mockReturnValue([baseTemplate]);
    getAllPlatforms.mockReturnValue([]);
    getSmsPerHourLimit.mockReturnValue(50);
    countSmsSentInLastHour.mockReturnValue(0);
    hasWhatsAppCredentials.mockResolvedValue(true);
    personalizeMessage.mockReturnValue('Hello test message');
    PermissionsAndroid.request.mockResolvedValue('granted');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns a zeroed summary and skips loading bulk data when the queue is empty', async () => {
    claimPendingQueue.mockReturnValue([]);

    const summary = await processQueue();

    expect(summary).toEqual({ processed: 0, sent: 0, opened: 0, failed: 0, rateLimited: 0 });
    expect(getAllContacts).not.toHaveBeenCalled();
  });

  test('marks item as sent when WhatsApp dispatch succeeds', async () => {
    const item = { id: 1, contact_id: 1, template_id: 1, platform_id: 'whatsapp' };
    claimPendingQueue.mockReturnValue([item]);
    sendWhatsAppMessage.mockResolvedValue({ success: true });

    const summary = await processQueue();

    expect(sendWhatsAppMessage).toHaveBeenCalledWith('923001234567', 'Hello test message', expect.any(Object));
    expect(markAsSent).toHaveBeenCalledWith(1, expect.any(String));
    expect(summary).toEqual({ processed: 1, sent: 1, opened: 0, failed: 0, rateLimited: 0 });
  });

  test('fails item with WHATSAPP_NOT_CONFIGURED when no WhatsApp credentials are set', async () => {
    const item = { id: 2, contact_id: 1, template_id: 1, platform_id: 'whatsapp' };
    claimPendingQueue.mockReturnValue([item]);
    hasWhatsAppCredentials.mockResolvedValue(false);

    const summary = await processQueue();

    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(markAsFailed).toHaveBeenCalledWith(2, 'WHATSAPP_NOT_CONFIGURED', expect.any(String));
    expect(summary.failed).toBe(1);
  });

  test('reverts an SMS item to pending instead of failing it when the hourly SMS limit is already reached', async () => {
    const item = { id: 3, contact_id: 1, template_id: 1, platform_id: 'sms' };
    claimPendingQueue.mockReturnValue([item]);
    getSmsPerHourLimit.mockReturnValue(5);
    countSmsSentInLastHour.mockReturnValue(5);

    const summary = await processQueue();

    expect(revertToPending).toHaveBeenCalledWith(3, expect.any(String));
    expect(markAsFailed).not.toHaveBeenCalled();
    expect(summary).toEqual({ processed: 0, sent: 0, opened: 0, failed: 0, rateLimited: 1 });
  });

  test('marks item failed with a combined reason when contact, template and platform are all missing', async () => {
    const item = { id: 4, contact_id: 99, template_id: 99, platform_id: 'does-not-exist' };
    claimPendingQueue.mockReturnValue([item]);
    getAllContacts.mockReturnValue([]);
    getAllTemplates.mockReturnValue([]);

    const summary = await processQueue();

    expect(markAsFailed).toHaveBeenCalledWith(
      4,
      'CONTACT_NOT_FOUND_AND_TEMPLATE_NOT_FOUND_AND_PLATFORM_NOT_FOUND',
      expect.any(String),
    );
    expect(summary.processed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  test('fails item when the platform needs an email but the contact has none', async () => {
    const item = { id: 5, contact_id: 1, template_id: 1, platform_id: 'email' };
    claimPendingQueue.mockReturnValue([item]);
    getAllContacts.mockReturnValue([{ ...baseContact, email: '' }]);

    const summary = await processQueue();

    expect(markAsFailed).toHaveBeenCalledWith(5, 'EMAIL_MISSING_ON_CONTACT', expect.any(String));
    expect(summary.failed).toBe(1);
  });

  test('fails item when the platform needs a phone number but the contact has none', async () => {
    const item = { id: 6, contact_id: 1, template_id: 1, platform_id: 'sms' };
    claimPendingQueue.mockReturnValue([item]);
    getAllContacts.mockReturnValue([{ ...baseContact, phone_number: '' }]);

    const summary = await processQueue();

    expect(markAsFailed).toHaveBeenCalledWith(6, 'PHONE_MISSING_ON_CONTACT', expect.any(String));
    expect(summary.failed).toBe(1);
  });

  test('sends SMS natively and marks item sent when SMS permission is granted', async () => {
    const item = { id: 7, contact_id: 1, template_id: 1, platform_id: 'sms' };
    claimPendingQueue.mockReturnValue([item]);
    PermissionsAndroid.request.mockResolvedValue('granted');
    NativeModules.SmsModule.sendSms.mockResolvedValue('SENT');

    const summary = await processQueue();

    expect(NativeModules.SmsModule.sendSms).toHaveBeenCalledWith('03001234567', 'Hello test message');
    expect(markAsSent).toHaveBeenCalledWith(7, expect.any(String));
    expect(summary.sent).toBe(1);
  });

  test('fails SMS item with NO_SMS_PERMISSION when permission is denied on Android', async () => {
    const item = { id: 8, contact_id: 1, template_id: 1, platform_id: 'sms' };
    claimPendingQueue.mockReturnValue([item]);
    PermissionsAndroid.request.mockResolvedValue('denied');

    const summary = await processQueue();

    expect(NativeModules.SmsModule.sendSms).not.toHaveBeenCalled();
    expect(markAsFailed).toHaveBeenCalledWith(8, 'NO_SMS_PERMISSION', expect.any(String));
    expect(summary.failed).toBe(1);
  });

  test('marks item failed with SEND_FAILED_UNKNOWN and reports the error when dispatch throws', async () => {
    const item = { id: 10, contact_id: 1, template_id: 1, platform_id: 'whatsapp' };
    claimPendingQueue.mockReturnValue([item]);
    sendWhatsAppMessage.mockRejectedValue(new Error('network down'));

    const summary = await processQueue();

    expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'processQueue.item.10');
    expect(markAsFailed).toHaveBeenCalledWith(10, 'SEND_FAILED_UNKNOWN', expect.any(String));
    expect(summary.failed).toBe(1);
  });

  test('invokes onProgress after each item and processes multiple items with the inter-item delay', async () => {
    jest.useFakeTimers();
    const items = [
      { id: 11, contact_id: 1, template_id: 1, platform_id: 'whatsapp' },
      { id: 12, contact_id: 1, template_id: 1, platform_id: 'whatsapp' },
    ];
    claimPendingQueue.mockReturnValue(items);
    sendWhatsAppMessage.mockResolvedValue({ success: true });
    const onProgress = jest.fn();

    const resultPromise = processQueue(onProgress);
    await jest.runAllTimersAsync();
    const summary = await resultPromise;

    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2);
    expect(summary.sent).toBe(2);
  });

  test('applies the SMS hourly limit mid-run once enough SMS have gone out in this batch', async () => {
    const items = [
      { id: 13, contact_id: 1, template_id: 1, platform_id: 'sms' },
      { id: 14, contact_id: 1, template_id: 1, platform_id: 'sms' },
    ];
    claimPendingQueue.mockReturnValue(items);
    getSmsPerHourLimit.mockReturnValue(1);
    countSmsSentInLastHour.mockReturnValue(0);
    NativeModules.SmsModule.sendSms.mockResolvedValue('SENT');

    jest.useFakeTimers();
    const resultPromise = processQueue();
    await jest.runAllTimersAsync();
    const summary = await resultPromise;

    expect(summary.sent).toBe(1);
    expect(summary.rateLimited).toBe(1);
    expect(revertToPending).toHaveBeenCalledWith(14, expect.any(String));
  });

  test('uses a caller-supplied parentTraceId instead of generating a new trace id', async () => {
    const item = { id: 15, contact_id: 1, template_id: 1, platform_id: 'whatsapp' };
    claimPendingQueue.mockReturnValue([item]);
    sendWhatsAppMessage.mockResolvedValue({ success: true });

    await processQueue(undefined, 'parent-trace-abc');

    expect(markAsSent).toHaveBeenCalledWith(15, 'parent-trace-abc');
  });
});