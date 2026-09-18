import { describe, expect, it } from 'vitest';
import { scrubObject, scrubText, scrubUrl } from './scrub';

describe('scrubObject', () => {
  it.each(['nin', 'password', 'refreshToken', 'apiKey', 'cvv', 'accountNumber', 'authorization'])(
    'redacts a %s field',
    (key) => {
      expect(scrubObject({ [key]: 'sensitive' })[key]).toBe('[REDACTED]');
    },
  );

  it('is case-insensitive and matches embedded names', () => {
    const result = scrubObject({ residentNIN: '1', API_KEY: '2', card_number: '3' });
    expect(Object.values(result)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]']);
  });

  it('keeps non-sensitive fields, or reports become useless', () => {
    expect(scrubObject({ name: 'Ada', houseNumber: '12B' })).toEqual({
      name: 'Ada',
      houseNumber: '12B',
    });
  });

  it('scrubs nested objects and arrays', () => {
    const result = scrubObject({
      resident: { name: 'Ada', nin: '12345678901' },
      vehicles: [{ plate: 'ABC123', ownerNin: '12345678901' }],
    });

    expect(JSON.stringify(result)).not.toContain('12345678901');
    expect(JSON.stringify(result)).toContain('ABC123');
  });

  // A cyclic or very deep payload must not hang the process inside an error
  // handler.
  it('bounds recursion depth', () => {
    let deep: Record<string, unknown> = { nin: 'x' };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(() => scrubObject(deep)).not.toThrow();
  });

  it('passes primitives through', () => {
    expect(scrubObject('plain')).toBe('plain');
    expect(scrubObject(null)).toBeNull();
  });
});

describe('scrubUrl', () => {
  it('redacts sensitive query parameters', () => {
    const result = scrubUrl('https://x.com/search?nin=12345678901&name=Ada');
    expect(result).toContain('nin=%5BREDACTED%5D');
    expect(result).toContain('name=Ada');
  });

  it('returns malformed input unchanged rather than throwing', () => {
    expect(scrubUrl('not a url')).toBe('not a url');
  });
});

describe('scrubText', () => {
  // Covers values embedded in a message rather than carried in a named field.
  it('redacts an 11-digit NIN', () => {
    expect(scrubText('Resident 12345678901 failed verification')).not.toContain('12345678901');
  });

  it('redacts bearer tokens', () => {
    expect(scrubText('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('redacts credentials inside a connection string', () => {
    const result = scrubText('failed: mongodb://admin:hunter2@10.0.0.5/estate');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('mongodb://');
  });

  it('redacts Paystack keys', () => {
    expect(scrubText('using sk_live_abc123def456')).not.toContain('sk_live_abc123def456');
  });

  it('leaves ordinary text alone', () => {
    expect(scrubText('Visitor pass expired at gate 2')).toBe('Visitor pass expired at gate 2');
  });
});
