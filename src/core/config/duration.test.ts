import { describe, expect, it } from 'vitest';
import { formatDuration, isValidDuration, parseDuration } from './duration';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['30d', 2_592_000_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('tolerates surrounding whitespace from copy-pasted env files', () => {
    expect(parseDuration('  15m  ')).toBe(900_000);
  });

  // A malformed TTL that silently became 0 or Infinity would be a security bug,
  // so every one of these must throw rather than fall back to a default.
  it.each(['15', 'm', '', '15 m', '-5m', '0m', '15y', '1.5h', 'abc'])('rejects %o', (input) => {
    expect(() => parseDuration(input)).toThrow();
  });
});

describe('isValidDuration', () => {
  it('agrees with parseDuration', () => {
    expect(isValidDuration('15m')).toBe(true);
    expect(isValidDuration('0m')).toBe(false);
    expect(isValidDuration('nope')).toBe(false);
  });
});

describe('formatDuration', () => {
  it('renders using the largest exact unit', () => {
    expect(formatDuration(900_000)).toBe('15m');
    expect(formatDuration(2_592_000_000)).toBe('30d');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(90_000)).toBe('90s');
  });
});
