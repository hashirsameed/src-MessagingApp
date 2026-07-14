jest.mock('react-native');
jest.mock('react-native-quick-sqlite');

import {
  computeTargetAlarmTimestamp,
  isTemplateAlarmDue,
  wasAlarmTargetBeforeContactCreated,
} from '../alarmScheduler';

describe('computeTargetAlarmTimestamp', () => {
  it('uses the explicit send_time (Pakistan wall clock), not the expiry\'s own time-of-day', () => {
    const contact = { expiry_datetime: '2026-07-10T05:00:00Z' }; // 2026-07-10, 10:00 PKT
    const template = { days_before: 2, send_time: '17:00' }; // 5:00 PM PKT
    const ms = computeTargetAlarmTimestamp(contact, template);
    // Expected: 2026-07-08, 17:00 PKT = 2026-07-08T12:00:00Z
    expect(new Date(ms).toISOString()).toBe('2026-07-08T12:00:00.000Z');
  });

  it('falls back to the expiry\'s own Pakistan time-of-day when send_time is not set', () => {
    const contact = { expiry_datetime: '2026-07-10T05:00:00Z' }; // 10:00 AM PKT
    const template = { days_before: 2, send_time: null };
    const ms = computeTargetAlarmTimestamp(contact, template);
    // Expected: 2026-07-08, 10:00 AM PKT = 2026-07-08T05:00:00Z
    expect(new Date(ms).toISOString()).toBe('2026-07-08T05:00:00.000Z');
  });

  it('returns null for an unparseable expiry date', () => {
    expect(computeTargetAlarmTimestamp({ expiry_datetime: 'not-a-date' }, { days_before: 1 })).toBeNull();
  });
});

describe('isTemplateAlarmDue (Problem 3 — date AND time must both match)', () => {
  const contact = { expiry_datetime: '2026-07-10T05:00:00Z' }; // 10:00 AM PKT
  // Target fire time: 2026-07-08, 17:00 PKT = 2026-07-08T12:00:00Z
  const template = { days_before: 2, send_time: '17:00' };

  it('is NOT due before the target time on the correct day (date matches, time does not)', () => {
    const beforeTime = new Date('2026-07-08T11:00:00Z').getTime(); // 16:00 PKT, 1h early
    expect(isTemplateAlarmDue(contact, template, beforeTime)).toBe(false);
  });

  it('IS due once the target date+time has passed', () => {
    const afterTime = new Date('2026-07-08T12:00:01Z').getTime(); // just after 17:00 PKT
    expect(isTemplateAlarmDue(contact, template, afterTime)).toBe(true);
  });

  it('is NOT due on a day that matches days_before by date alone at the wrong time — regression guard for the old bypass bug', () => {
    // Previously: if a caller forgot to filter by time, a same-day check
    // at any hour would look "due" once days_before matched. This directly
    // exercises isTemplateAlarmDue with an early-morning timestamp on the
    // CORRECT day to confirm date-match alone isn't enough.
    const earlyMorningSameDay = new Date('2026-07-08T01:00:00Z').getTime(); // 06:00 PKT
    expect(isTemplateAlarmDue(contact, template, earlyMorningSameDay)).toBe(false);
  });
});

describe('late-added-contact bug: a template time that passed before the contact existed must be skipped, not instantly fired', () => {
  // Contact expires at 10:45 PKT. Template A is fixed for 10:20 PKT the same
  // day (days_before: 0). The contact is only added at 10:25 PKT — i.e.
  // AFTER Template A's 10:20 slot already passed, but BEFORE the 10:45
  // expiry template. Template A must never fire for this contact; Template B
  // (10:45) should fire normally when its own time arrives.
  const expiryDatetime = '2026-07-10T05:45:00Z'; // 2026-07-10, 10:45 AM PKT
  const templateA = { days_before: 0, send_time: '10:20' }; // target: 05:20Z
  const templateB = { days_before: 0, send_time: '10:45' }; // target: 05:45Z
  const contactAddedLate = {
    expiry_datetime: expiryDatetime,
    created_at: '2026-07-10T05:25:00Z', // added at 10:25 PKT, after 10:20
  };

  it('wasAlarmTargetBeforeContactCreated is true for the missed 10:20 slot', () => {
    const alarmMs = computeTargetAlarmTimestamp(contactAddedLate, templateA);
    expect(wasAlarmTargetBeforeContactCreated(contactAddedLate, alarmMs)).toBe(true);
  });

  it('isTemplateAlarmDue never reports the 10:20 template as due for this contact, even long after', () => {
    const wayAfter = new Date('2026-07-10T06:00:00Z').getTime(); // 11:00 PKT
    expect(isTemplateAlarmDue(contactAddedLate, templateA, wayAfter)).toBe(false);
  });

  it('isTemplateAlarmDue still fires the 10:45 template normally once its own time arrives', () => {
    const atExpiry = new Date('2026-07-10T05:45:01Z').getTime();
    expect(isTemplateAlarmDue(contactAddedLate, templateB, atExpiry)).toBe(true);
  });

  it('a contact that already existed before 10:20 still gets normal catch-up behavior for a missed alarm', () => {
    const contactAddedEarly = {
      expiry_datetime: expiryDatetime,
      created_at: '2026-07-10T04:00:00Z', // added at 09:00 PKT, well before 10:20
    };
    const alarmMs = computeTargetAlarmTimestamp(contactAddedEarly, templateA);
    expect(wasAlarmTargetBeforeContactCreated(contactAddedEarly, alarmMs)).toBe(false);
    const wayAfter = new Date('2026-07-10T06:00:00Z').getTime();
    expect(isTemplateAlarmDue(contactAddedEarly, templateA, wayAfter)).toBe(true);
  });
});