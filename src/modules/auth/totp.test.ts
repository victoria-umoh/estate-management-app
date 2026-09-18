import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { decryptField } from '@/core/crypto';
import { consumeBackupCode, createTotpEnrollment, generateBackupCodes, verifyTotp } from './totp';

describe('TOTP enrolment', () => {
  it('produces an encrypted secret and a provisioning URL', () => {
    const enrollment = createTotpEnrollment('ada@example.com');

    expect(enrollment.otpauthUrl).toContain('otpauth://totp/');
    expect(enrollment.otpauthUrl).toContain('EstateOS');
    // The seed is password-equivalent — anyone holding it can mint codes
    // forever — so it must not be stored in the clear.
    expect(JSON.stringify(enrollment.secret)).not.toContain(enrollment.plainSecret);
    expect(decryptField(enrollment.secret, 'user:totp')).toBe(enrollment.plainSecret);
  });

  it('issues a different secret per enrolment', () => {
    expect(createTotpEnrollment('a@x.com').plainSecret).not.toBe(
      createTotpEnrollment('a@x.com').plainSecret,
    );
  });
});

describe('TOTP verification', () => {
  it('accepts a current code', () => {
    const enrollment = createTotpEnrollment('ada@example.com');
    const code = authenticator.generate(enrollment.plainSecret);
    expect(verifyTotp(enrollment.secret, code)).toBe(true);
  });

  it('tolerates spaces, which authenticator apps display', () => {
    const enrollment = createTotpEnrollment('ada@example.com');
    const code = authenticator.generate(enrollment.plainSecret);
    expect(verifyTotp(enrollment.secret, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const enrollment = createTotpEnrollment('ada@example.com');
    expect(verifyTotp(enrollment.secret, '000000')).toBe(false);
  });

  it("rejects another user's code", () => {
    const a = createTotpEnrollment('a@x.com');
    const b = createTotpEnrollment('b@x.com');
    expect(verifyTotp(a.secret, authenticator.generate(b.plainSecret))).toBe(false);
  });

  it('returns false rather than throwing on a corrupted secret', () => {
    const enrollment = createTotpEnrollment('a@x.com');
    expect(verifyTotp({ ...enrollment.secret, ct: 'corrupt' }, '123456')).toBe(false);
  });
});

describe('backup codes', () => {
  it('generates hashed codes and returns the plaintext once', () => {
    const { plain, hashed } = generateBackupCodes(10);

    expect(plain).toHaveLength(10);
    expect(new Set(plain).size).toBe(10);
    // Password-equivalent, so stored hashed.
    for (const code of plain) expect(hashed.join()).not.toContain(code);
  });

  it('consumes a code exactly once', () => {
    const { plain, hashed } = generateBackupCodes(5);

    const first = consumeBackupCode(hashed, plain[0]!);
    expect(first.matched).toBe(true);
    expect(first.remaining).toHaveLength(4);

    // Replaying the same code must fail.
    expect(consumeBackupCode(first.remaining, plain[0]!).matched).toBe(false);
  });

  it('accepts codes regardless of formatting', () => {
    const { plain, hashed } = generateBackupCodes(3);
    const messy = plain[0]!.toLowerCase().replace(/-/g, ' ');
    expect(consumeBackupCode(hashed, messy).matched).toBe(true);
  });

  it('rejects an unknown code without consuming anything', () => {
    const { hashed } = generateBackupCodes(3);
    const result = consumeBackupCode(hashed, 'AAAAA-BBBBB');
    expect(result.matched).toBe(false);
    expect(result.remaining).toHaveLength(3);
  });
});
