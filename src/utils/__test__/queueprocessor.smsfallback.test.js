// This scenario needs its own file: queueProcessor.js does
// `const { SmsModule } = NativeModules;` once, at module-load time.
// To exercise the "native module not linked" branch, NativeModules.SmsModule
// has to already be absent the moment the module under test is first
// imported — mutating it later in a shared test file has no effect on the
// already-captured reference. Jest gives every test file its own module
// registry, so a dedicated file is the simplest way to get that.

import { processQueue } from '../queueProcessor';
import { Linking, PermissionsAndroid } from 'react-native';
import { claimPendingQueue, markAsSent, markAsFailed } from '../../database/messageQueueDB';
import { getAllContacts } from '../../database/contactDB';
import { getAllTemplates } from '../../database/templateDB';
import { getAllPlatforms } from '../../database/platformDB';
import { getSmsPerHourLimit } from '../../database/settingsDB';
import { personalizeMessage } from '../templateMatcher';

jest.mock('react-native', () => ({
  Linking: {
    canOpenURL: jest.fn(),
    openURL: jest.fn(),
  },
  Platform: { OS: 'android' },
  PermissionsAndroid: {
    request: jest.fn(),
    PERMISSIONS: { SEND_SMS: 'android.permission.SEND_SMS' },
    RESULTS: { GRANTED: 'granted' },
  },
  // No SmsModule here on purpose — simulates the native module not being linked.
  NativeModules: {},
}));

jest.mock('../../database/messageQueueDB', () => ({
  claimPendingQueue: jest.fn(),
  markAsSent: jest.fn(),
  markAsFailed: jest.fn(),
  revertToPending: jest.fn(),
  countSmsSentInLastHour: jest.fn(() => 0),
}));

jest.mock('../../database/contactDB', () => ({
  getAllContacts: jest.fn(),
}));

jest.mock('../../database/templateDB', () => ({
  getAllTemplates: jest.fn(),
}));

jest.mock('../../database/platformDB', () => ({
  getAllPlatforms: jest.fn(() => []),
}));

jest.mock('../../database/settingsDB', () => ({
  getSmsPerHourLimit: jest.fn(() => 50),
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
  hasWhatsAppCredentials: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../debugTrace', () => ({
  debugTrace: jest.fn(),
  debugTraceError: jest.fn(),
  debugTraceDuration: jest.fn(),
  generateTraceId: jest.fn(() => 'trace-test-id'),
}));

const baseContact = { id: 1, phone_number: '03001234567', email: 'test@example.com' };
const baseTemplate = { id: 1, body: 'Hi {name}' };

describe('processQueue - SMS native module not linked', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAllContacts.mockReturnValue([baseContact]);
    getAllTemplates.mockReturnValue([baseTemplate]);
    getAllPlatforms.mockReturnValue([]);
    getSmsPerHourLimit.mockReturnValue(50);
    personalizeMessage.mockReturnValue('Hello test message');
    PermissionsAndroid.request.mockResolvedValue('granted');
  });

  test('falls back to Linking and marks item opened when SmsModule is not linked and the URL can be opened', async () => {
    const item = { id: 1, contact_id: 1, template_id: 1, platform_id: 'sms' };
    claimPendingQueue.mockReturnValue([item]);
    Linking.canOpenURL.mockResolvedValue(true);
    Linking.openURL.mockResolvedValue();

    const summary = await processQueue();

    expect(Linking.openURL).toHaveBeenCalled();
    expect(markAsSent).toHaveBeenCalledWith(1, expect.any(String));
    expect(summary.opened).toBe(1);
  });

  test('fails with SMS_PLATFORM_UNAVAILABLE when SmsModule is not linked and no SMS app can handle the URL', async () => {
    const item = { id: 2, contact_id: 1, template_id: 1, platform_id: 'sms' };
    claimPendingQueue.mockReturnValue([item]);
    Linking.canOpenURL.mockResolvedValue(false);

    const summary = await processQueue();

    expect(Linking.openURL).not.toHaveBeenCalled();
    expect(markAsFailed).toHaveBeenCalledWith(2, 'SMS_PLATFORM_UNAVAILABLE', expect.any(String));
    expect(summary.failed).toBe(1);
  });
});