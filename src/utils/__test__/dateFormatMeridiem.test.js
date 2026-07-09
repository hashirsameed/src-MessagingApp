import { split24HourTimeTo12Hour, parse12HourTimeTo24Hour } from '../dateFormat';

test('split24HourTimeTo12Hour: no send_time -> meridiem is null, not falsely AM', () => {
  const result = split24HourTimeTo12Hour(null);
  expect(result).toEqual({ time: '', meridiem: null });
});

test('split24HourTimeTo12Hour: valid time still splits meridiem correctly', () => {
  expect(split24HourTimeTo12Hour('14:30')).toEqual({ time: '2:30', meridiem: 'PM' });
  expect(split24HourTimeTo12Hour('09:00')).toEqual({ time: '9:00', meridiem: 'AM' });
});

test('parse12HourTimeTo24Hour: time typed but no meridiem chosen -> rejected (forces explicit AM/PM pick)', () => {
  expect(parse12HourTimeTo24Hour('9:00', null)).toBeNull();
});

test('parse12HourTimeTo24Hour: time + meridiem both set -> works as before', () => {
  expect(parse12HourTimeTo24Hour('9:00', 'AM')).toBe('09:00');
  expect(parse12HourTimeTo24Hour('2:30', 'PM')).toBe('14:30');
});
