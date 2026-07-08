import { runExpiryCheck } from '../schedulerEngine';
import { getExpiringContacts } from '../../database/contactDB';
import { getActiveTemplates } from '../../database/templateDB';
import { addToQueue } from '../../database/messageQueueDB';
import { getDefaultPlatform } from '../../database/settingsDB';
import { getDaysUntilExpiry, findMatchingTemplates } from '../templateMatcher';
import { handleError } from '../errorHandler';
import { processQueue } from '../queueProcessor';
import { isTemplateAlarmDue } from '../alarmScheduler';

jest.mock('../../database/contactDB', () => ({
  getExpiringContacts: jest.fn(),
}));

jest.mock('../../database/templateDB', () => ({
  getActiveTemplates: jest.fn(),
}));

jest.mock('../../database/messageQueueDB', () => ({
  addToQueue: jest.fn(),
}));

jest.mock('../../database/settingsDB', () => ({
  getDefaultPlatform: jest.fn(),
}));

jest.mock('../templateMatcher', () => ({
  getDaysUntilExpiry: jest.fn(),
  findMatchingTemplates: jest.fn(),
}));

jest.mock('../errorHandler', () => ({
  handleError: jest.fn(),
}));

jest.mock('../queueProcessor', () => ({
  processQueue: jest.fn(),
}));

jest.mock('../alarmScheduler', () => ({
  isTemplateAlarmDue: jest.fn(),
  // Returns a timestamp a few seconds in the past relative to whenever it's
  // called, so any template that passes isTemplateAlarmDue also falls
  // inside runExpiryCheck's 1-hour grace-period window by default.
  computeTargetAlarmTimestamp: jest.fn(() => Date.now() - 5000),
}));

jest.mock('../debugTrace', () => ({
  debugTrace: jest.fn(),
  debugTraceError: jest.fn(),
  debugTraceDuration: jest.fn(),
  generateTraceId: jest.fn(() => 'trace-test-id'),
}));

describe('runExpiryCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefaultPlatform.mockReturnValue('sms');
    processQueue.mockResolvedValue({});
    getDaysUntilExpiry.mockReturnValue(3);
  });

  test('returns zero counts and does not touch the queue when there are no expiring contacts', async () => {
    getExpiringContacts.mockReturnValue([]);
    getActiveTemplates.mockReturnValue([]);

    const result = await runExpiryCheck();

    expect(result).toEqual({ checked: 0, queued: 0, skippedNoTemplate: 0, skippedTimeWindow: 0 });
    expect(addToQueue).not.toHaveBeenCalled();
    expect(processQueue).not.toHaveBeenCalled();
  });

  test('queues a notification and triggers processQueue when a template matches and is due', async () => {
    const contact = { id: 1, name: 'Ali', expiry_datetime: '2026-08-01T00:00:00.000Z' };
    const template = { id: 1, title: 'Renewal', days_before: 3 };
    getExpiringContacts.mockReturnValue([contact]);
    getActiveTemplates.mockReturnValue([template]);
    findMatchingTemplates.mockReturnValue([template]);
    isTemplateAlarmDue.mockReturnValue(true);
    addToQueue.mockReturnValue(true);

    const result = await runExpiryCheck();

    expect(addToQueue).toHaveBeenCalledWith(1, 1, 'sms');
    expect(result).toEqual({ checked: 1, queued: 1, skippedNoTemplate: 0, skippedTimeWindow: 0 });
    expect(processQueue).toHaveBeenCalledWith(undefined, expect.any(String));
  });

  test('skips a contact when templates match by date but none are due yet', async () => {
    const contact = { id: 2, expiry_datetime: '2026-08-01T00:00:00.000Z' };
    const template = { id: 2, days_before: 3 };
    getExpiringContacts.mockReturnValue([contact]);
    getActiveTemplates.mockReturnValue([template]);
    findMatchingTemplates.mockReturnValue([template]);
    isTemplateAlarmDue.mockReturnValue(false);

    const result = await runExpiryCheck();

    expect(addToQueue).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, queued: 0, skippedNoTemplate: 1, skippedTimeWindow: 0 });
    expect(processQueue).not.toHaveBeenCalled();
  });

  test('skips a contact when no templates match its days-left value at all', async () => {
    const contact = { id: 3, expiry_datetime: '2026-08-01T00:00:00.000Z' };
    getExpiringContacts.mockReturnValue([contact]);
    getActiveTemplates.mockReturnValue([]);
    findMatchingTemplates.mockReturnValue([]);

    const result = await runExpiryCheck();

    expect(isTemplateAlarmDue).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, queued: 0, skippedNoTemplate: 1, skippedTimeWindow: 0 });
  });

  test('counts only the templates addToQueue actually accepts, ignoring ones already queued (dedup)', async () => {
    const contact = { id: 4, expiry_datetime: '2026-08-01T00:00:00.000Z' };
    const templateA = { id: 10, days_before: 3 };
    const templateB = { id: 11, days_before: 1 };
    getExpiringContacts.mockReturnValue([contact]);
    getActiveTemplates.mockReturnValue([templateA, templateB]);
    findMatchingTemplates.mockReturnValue([templateA, templateB]);
    isTemplateAlarmDue.mockReturnValue(true);
    addToQueue.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await runExpiryCheck();

    expect(addToQueue).toHaveBeenCalledTimes(2);
    expect(result.queued).toBe(1);
    expect(result.skippedNoTemplate).toBe(0);
  });

  test('returns a zeroed result and reports the error when loading contacts throws', async () => {
    getExpiringContacts.mockImplementation(() => {
      throw new Error('db locked');
    });

    const result = await runExpiryCheck();

    expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'runExpiryCheck');
    expect(result).toEqual({ checked: 0, queued: 0, skippedNoTemplate: 0, skippedTimeWindow: 0 });
    expect(processQueue).not.toHaveBeenCalled();
  });

  test('propagates a caller-supplied parentTraceId into processQueue', async () => {
    const contact = { id: 5, expiry_datetime: '2026-08-01T00:00:00.000Z' };
    const template = { id: 20, days_before: 3 };
    getExpiringContacts.mockReturnValue([contact]);
    getActiveTemplates.mockReturnValue([template]);
    findMatchingTemplates.mockReturnValue([template]);
    isTemplateAlarmDue.mockReturnValue(true);
    addToQueue.mockReturnValue(true);

    await runExpiryCheck('parent-trace-123');

    expect(processQueue).toHaveBeenCalledWith(undefined, 'parent-trace-123');
  });
});