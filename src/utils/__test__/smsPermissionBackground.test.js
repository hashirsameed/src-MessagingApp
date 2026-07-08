import { processQueue } from '../queueProcessor';
import { PermissionsAndroid, NativeModules, AppState } from 'react-native';
import { claimPendingQueue, markAsSent, markAsFailed, countSmsSentInLastHour } from '../../database/messageQueueDB';
import { getAllContacts } from '../../database/contactDB';
import { getAllTemplates } from '../../database/templateDB';
import { getAllPlatforms } from '../../database/platformDB';
import { getSmsPerHourLimit } from '../../database/settingsDB';
import { personalizeMessage } from '../templateMatcher';
import { hasWhatsAppCredentials } from '../whatsappService';

jest.mock('react-native', () => ({
  Linking: { canOpenURL: jest.fn(), openURL: jest.fn() },
  Platform: { OS: 'android' },
  PermissionsAndroid: {
    check: jest.fn(),
    request: jest.fn(),
    PERMISSIONS: { SEND_SMS: 'android.permission.SEND_SMS' },
    RESULTS: { GRANTED: 'granted' },
  },
  AppState: { currentState: 'active' },
  NativeModules: { SmsModule: { sendSms: jest.fn() } },
}));

jest.mock('../../database/messageQueueDB', () => ({
  claimPendingQueue: jest.fn(),
  markAsSent: jest.fn(),
  markAsFailed: jest.fn(),
  revertToPending: jest.fn(),
  countSmsSentInLastHour: jest.fn(),
}));
jest.mock('../../database/contactDB', () => ({ getAllContacts: jest.fn() }));
jest.mock('../../database/templateDB', () => ({ getAllTemplates: jest.fn() }));
jest.mock('../../database/platformDB', () => ({ getAllPlatforms: jest.fn() }));
jest.mock('../../database/settingsDB', () => ({ getSmsPerHourLimit: jest.fn() }));
jest.mock('../templateMatcher', () => ({
  getDaysUntilExpiry: jest.fn(() => 1),
  personalizeMessage: jest.fn((body) => body),
}));
jest.mock('../whatsappService', () => ({
  sendWhatsAppMessage: jest.fn(),
  hasWhatsAppCredentials: jest.fn(() => Promise.resolve(false)),
}));

beforeEach(() => {
  jest.clearAllMocks();
  getAllContacts.mockReturnValue([{ id: 'c1', name: 'Auon bhai', phone_number: '03172002094' }]);
  getAllTemplates.mockReturnValue([{ id: 't1', title: '1 day', body: 'Hi', is_active: 1 }]);
  getAllPlatforms.mockReturnValue([]);
  getSmsPerHourLimit.mockReturnValue(50);
  countSmsSentInLastHour.mockReturnValue(0);
  claimPendingQueue.mockReturnValue([
    { id: 'q1', contact_id: 'c1', template_id: 't1', platform_id: 'sms', attempt_count: 0 },
  ]);
});

test('BUG REPRO (old behavior): backgrounded app with already-granted permission used to fail via request()', async () => {
  // Simulates the real bug: permission already granted, but app is
  // backgrounded (headless task, no Activity) — request() would throw.
  AppState.currentState = 'background';
  PermissionsAndroid.check.mockResolvedValue(true); // already granted
  PermissionsAndroid.request.mockRejectedValue(new Error('no current activity'));
  NativeModules.SmsModule.sendSms.mockResolvedValue('SENT');

  const summary = await processQueue();

  // Fix: check() short-circuits to true, request() never even gets called.
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  expect(summary.sent).toBe(1);
  expect(markAsSent).toHaveBeenCalled();
  expect(markAsFailed).not.toHaveBeenCalled();
});

test('backgrounded app with NOT-yet-granted permission fails gracefully (no dialog attempted)', async () => {
  AppState.currentState = 'background';
  PermissionsAndroid.check.mockResolvedValue(false);
  NativeModules.SmsModule.sendSms.mockResolvedValue('SENT');

  const summary = await processQueue();

  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  expect(summary.failed).toBe(1);
  expect(markAsFailed).toHaveBeenCalledWith('q1', 'NO_SMS_PERMISSION', expect.anything());
});

test('foreground app with not-yet-granted permission still shows the dialog', async () => {
  AppState.currentState = 'active';
  PermissionsAndroid.check.mockResolvedValue(false);
  PermissionsAndroid.request.mockResolvedValue('granted');
  NativeModules.SmsModule.sendSms.mockResolvedValue('SENT');

  const summary = await processQueue();

  expect(PermissionsAndroid.request).toHaveBeenCalled();
  expect(summary.sent).toBe(1);
});
