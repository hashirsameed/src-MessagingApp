import { toPakistanParts, pakistanPartsToUtcMs, pakistanDayStartMs } from '../pakistanTime';

describe('pakistanTime', () => {
  describe('toPakistanParts', () => {
    it('shifts a UTC instant forward by 5 hours to get Pakistan wall-clock parts', () => {
      // 2026-07-04T19:30:00Z is midnight in Pakistan the next day (UTC+5)
      const parts = toPakistanParts(new Date('2026-07-04T19:30:00Z'));
      expect(parts).toEqual({
        year: 2026, month: 7, day: 5, hour: 0, minute: 30, second: 0,
      });
    });

    it('handles a time that stays on the same UTC calendar day', () => {
      // 2026-07-04T10:00:00Z + 5h = 2026-07-04T15:00:00 PKT
      const parts = toPakistanParts(new Date('2026-07-04T10:00:00Z'));
      expect(parts).toEqual({
        year: 2026, month: 7, day: 4, hour: 15, minute: 0, second: 0,
      });
    });
  });

  describe('pakistanPartsToUtcMs', () => {
    it('is the inverse of toPakistanParts (round-trips correctly)', () => {
      const original = new Date('2026-07-04T19:30:00Z');
      const parts = toPakistanParts(original);
      const roundTripped = pakistanPartsToUtcMs(
        parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second,
      );
      expect(roundTripped).toBe(original.getTime());
    });

    it('5:00 PM Pakistan time is 12:00 PM UTC (fixed +5, no DST)', () => {
      const ms = pakistanPartsToUtcMs(2026, 7, 4, 17, 0, 0);
      expect(new Date(ms).toISOString()).toBe('2026-07-04T12:00:00.000Z');
    });
  });

  describe('pakistanDayStartMs', () => {
    it('returns midnight PKT for the given instant, not midnight UTC or device-local', () => {
      // 2026-07-04T21:00:00Z is 2026-07-05, 2:00 AM in Pakistan
      const dayStart = pakistanDayStartMs(new Date('2026-07-04T21:00:00Z'));
      expect(new Date(dayStart).toISOString()).toBe('2026-07-04T19:00:00.000Z'); // = 2026-07-05T00:00 PKT
    });
  });
});