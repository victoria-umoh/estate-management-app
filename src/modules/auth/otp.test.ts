import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheAdapter, setCache } from '@/integrations/cache';
import { clearOtp, issueOtp, verifyOtp } from './otp';

beforeEach(() => setCache(new MemoryCacheAdapter()));
afterEach(() => setCache(undefined));

const SUBJECT = '+2348012345678';

describe('OTP issuance', () => {
  it('issues a numeric code of the configured length', async () => {
    expect(await issueOtp('phone-verification', SUBJECT)).toMatch(/^\d{6}$/);
  });

  it('issues different codes each time', async () => {
    const codes = new Set(
      await Promise.all(
        Array.from({ length: 30 }, () => issueOtp('phone-verification', `${Math.random()}`)),
      ),
    );
    // A CSPRNG, not Math.random: predictable codes would be a complete bypass.
    expect(codes.size).toBeGreaterThan(25);
  });

  it('replaces any previous code for the same subject and purpose', async () => {
    const first = await issueOtp('phone-verification', SUBJECT);
    const second = await issueOtp('phone-verification', SUBJECT);

    await expect(verifyOtp('phone-verification', SUBJECT, first)).rejects.toThrow();
    await expect(verifyOtp('phone-verification', SUBJECT, second)).resolves.toBeUndefined();
  });
});

describe('OTP verification', () => {
  it('accepts the correct code', async () => {
    const code = await issueOtp('phone-verification', SUBJECT);
    await expect(verifyOtp('phone-verification', SUBJECT, code)).resolves.toBeUndefined();
  });

  // Single use: a replayed code must not work.
  it('consumes the code on success', async () => {
    const code = await issueOtp('phone-verification', SUBJECT);
    await verifyOtp('phone-verification', SUBJECT, code);
    await expect(verifyOtp('phone-verification', SUBJECT, code)).rejects.toThrow();
  });

  it('rejects an incorrect code', async () => {
    await issueOtp('phone-verification', SUBJECT);
    await expect(verifyOtp('phone-verification', SUBJECT, '000000')).rejects.toMatchObject({
      code: 'OTP_INVALID',
    });
  });

  it('rejects when no code was issued', async () => {
    await expect(verifyOtp('phone-verification', SUBJECT, '123456')).rejects.toMatchObject({
      code: 'OTP_EXPIRED',
    });
  });

  // A 6-digit code is 1-in-a-million per guess, so the attempt cap is what
  // actually makes it safe.
  it('destroys the code after the attempt limit', async () => {
    const code = await issueOtp('phone-verification', SUBJECT);

    for (let i = 0; i < 3; i++) {
      await expect(verifyOtp('phone-verification', SUBJECT, '000000')).rejects.toThrow();
    }

    // Even the CORRECT code no longer works — the window is closed, not merely
    // rate limited.
    await expect(verifyOtp('phone-verification', SUBJECT, code)).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it('keeps codes separate per purpose', async () => {
    const forLogin = await issueOtp('login-2fa', SUBJECT);
    await issueOtp('phone-verification', SUBJECT);

    await expect(verifyOtp('phone-verification', SUBJECT, forLogin)).rejects.toThrow();
    await expect(verifyOtp('login-2fa', SUBJECT, forLogin)).resolves.toBeUndefined();
  });

  it('keeps codes separate per subject', async () => {
    const forA = await issueOtp('phone-verification', '+2348011111111');
    await issueOtp('phone-verification', '+2348022222222');

    await expect(verifyOtp('phone-verification', '+2348022222222', forA)).rejects.toThrow();
  });

  // Reporting "no code outstanding" differently from "wrong code" would leak
  // whether a number is mid-registration.
  it('gives the same message whether the code is wrong or absent', async () => {
    const absent = await verifyOtp('phone-verification', SUBJECT, '111111').catch((e) => e.message);

    await issueOtp('phone-verification', SUBJECT);
    const wrong = await verifyOtp('phone-verification', SUBJECT, '111111').catch((e) => e.message);

    expect(absent).toBe(wrong);
  });

  it('clears a code on request', async () => {
    const code = await issueOtp('phone-verification', SUBJECT);
    await clearOtp('phone-verification', SUBJECT);
    await expect(verifyOtp('phone-verification', SUBJECT, code)).rejects.toThrow();
  });
});
