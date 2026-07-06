import { getDaysUntilExpiry, findMatchingTemplates } from '../templateMatcher';

describe('getDaysUntilExpiry', () => {
  const realDateNow = Date;

  const freezeNowAt = (iso) => {
    global.Date = class extends realDateNow {
      constructor(...args) {
        if (args.length === 0) return new realDateNow(iso);
        return new realDateNow(...args);
      }
      static now() {
        return new realDateNow(iso).getTime();
      }
    };
  };

  afterEach(() => {
    global.Date = realDateNow;
  });

  it('returns 0 when expiry is later the same Pakistan-calendar day', () => {
    // "now" = 2026-07-04, 08:00 PKT (03:00 UTC)
    freezeNowAt('2026-07-04T03:00:00Z');
    // expiry = 2026-07-04, 22:00 PKT (17:00 UTC) — same PKT day
    expect(getDaysUntilExpiry('2026-07-04T17:00:00Z')).toBe(0);
  });

  it('does not get thrown off by a UTC day boundary that Pakistan hasn\'t crossed yet', () => {
    // 2026-07-04T21:00:00Z is already 2026-07-05 in UTC, but only
    // 2026-07-05, 02:00 AM in Pakistan — still "today" relative to an
    // expiry later that Pakistan day.
    freezeNowAt('2026-07-04T21:00:00Z'); // 2026-07-05, 02:00 PKT
    // expiry: 2026-07-05, 10:00 PKT (05:00 UTC)
    expect(getDaysUntilExpiry('2026-07-05T05:00:00Z')).toBe(0);
  });

  it('counts whole Pakistan-calendar days for a future expiry', () => {
    freezeNowAt('2026-07-04T03:00:00Z'); // 2026-07-04, 08:00 PKT
    // expiry 3 Pakistan-calendar days later
    expect(getDaysUntilExpiry('2026-07-07T17:00:00Z')).toBe(3);
  });

  it('returns a negative number for an expiry that already passed', () => {
    freezeNowAt('2026-07-04T03:00:00Z');
    expect(getDaysUntilExpiry('2026-07-01T17:00:00Z')).toBe(-3);
  });
});

describe('findMatchingTemplates', () => {
  const template = (overrides) => ({
    id: 't1', is_active: 1, days_before: 3, ...overrides,
  });

  it('matches active templates whose days_before equals daysLeft', () => {
    const templates = [template({ id: 'a', days_before: 3 }), template({ id: 'b', days_before: 5 })];
    expect(findMatchingTemplates(templates, 3).map((t) => t.id)).toEqual(['a']);
  });

  it('excludes inactive templates even if days_before matches', () => {
    const templates = [template({ id: 'a', days_before: 3, is_active: 0 })];
    expect(findMatchingTemplates(templates, 3)).toEqual([]);
  });

  it('returns multiple templates if more than one matches the same day', () => {
    const templates = [
      template({ id: 'a', days_before: 3 }),
      template({ id: 'b', days_before: 3 }),
    ];
    expect(findMatchingTemplates(templates, 3).map((t) => t.id)).toEqual(['a', 'b']);
  });
});