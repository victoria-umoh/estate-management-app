import { describe, expect, it } from 'vitest';
import {
  assertPasswordStrength,
  burnPasswordVerification,
  hashPassword,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('produces an argon2id digest with the configured cost', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('never stores the plaintext', async () => {
    expect(await hashPassword('SuperSecret123')).not.toContain('SuperSecret123');
  });

  it('salts, so identical passwords hash differently', async () => {
    const a = await hashPassword('SamePassword123');
    const b = await hashPassword('SamePassword123');
    expect(a).not.toBe(b);
    expect(await verifyPassword('SamePassword123', a)).toBe(true);
    expect(await verifyPassword('SamePassword123', b)).toBe(true);
  });

  it('verifies correct and rejects incorrect passwords', async () => {
    const digest = await hashPassword('CorrectPassword123');
    expect(await verifyPassword('CorrectPassword123', digest)).toBe(true);
    expect(await verifyPassword('correctpassword123', digest)).toBe(false);
    expect(await verifyPassword('', digest)).toBe(false);
  });

  // A corrupted record must read as "wrong password", not as a server error
  // that singles this account out.
  it('returns false for a malformed digest instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('timing equalisation', () => {
  // The decoy must do real argon2 work. A hardcoded constant would be rejected
  // during parsing and return almost instantly, leaving the enumeration signal
  // this exists to remove.
  it('costs comparable time to a genuine verification', async () => {
    const digest = await hashPassword('RealPassword123');

    // Warm up, so neither measurement pays one-time init cost.
    await verifyPassword('x', digest);
    await burnPasswordVerification('x');

    const realStart = performance.now();
    await verifyPassword('WrongPassword123', digest);
    const realMs = performance.now() - realStart;

    const decoyStart = performance.now();
    await burnPasswordVerification('WrongPassword123');
    const decoyMs = performance.now() - decoyStart;

    // Both do a full argon2 pass, so the decoy must not be an order of
    // magnitude cheaper. A rejected-at-parse constant would be ~0ms here.
    expect(decoyMs).toBeGreaterThan(realMs * 0.25);
  });
});

describe('password policy', () => {
  it('accepts a strong password', () => {
    expect(() => assertPasswordStrength('Tr0ubador&Horse')).not.toThrow();
  });

  it.each([
    ['too short', 'Ab1cdef'],
    ['no uppercase', 'lowercase123456'],
    ['no lowercase', 'UPPERCASE123456'],
    ['no digit', 'NoDigitsInHere'],
  ])('rejects a password that is %s', (_label, password) => {
    expect(() => assertPasswordStrength(password)).toThrow(/not strong enough/);
  });

  it('rejects passwords from credential-stuffing lists', () => {
    expect(() => assertPasswordStrength('Password123')).toThrow();
  });

  // The specific reason is carried in `details`, so the top-level message stays
  // generic and safe to show anywhere.
  function reasonFor(password: string, context?: { email?: string; name?: string }): string {
    try {
      assertPasswordStrength(password, context);
      return '';
    } catch (error) {
      return (error as { details: Array<{ message: string }> }).details[0]!.message;
    }
  }

  // In an estate, everyone knows your name and email.
  it('rejects a password containing the user email or name', () => {
    expect(reasonFor('Adebayo12345X', { email: 'adebayo@example.com' })).toMatch(/email/i);
    expect(reasonFor('Olawale12345X', { name: 'Olawale' })).toMatch(/name/i);
  });

  it('reports every problem at once rather than one at a time', () => {
    try {
      assertPasswordStrength('short');
      expect.unreachable();
    } catch (error) {
      const message = (error as { details: Array<{ message: string }> }).details[0]!.message;
      expect(message).toContain('10 characters');
      expect(message).toContain('uppercase');
      expect(message).toContain('number');
    }
  });

  it('rejects absurdly long passwords, which are a DoS vector against argon2', () => {
    expect(reasonFor('A1'.repeat(200) + 'b')).toMatch(/no more than 128/);
  });
});
