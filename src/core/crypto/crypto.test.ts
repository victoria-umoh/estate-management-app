import { describe, expect, it } from 'vitest';
import {
  blindIndex,
  blindIndexEquals,
  decryptField,
  encryptField,
  hashToken,
  isEncryptedField,
  issueToken,
  maskAccountNumber,
  maskEmail,
  maskNin,
  maskPhone,
  normalizeForIndex,
  verifyToken,
} from './index';

const NIN = '12345678901';

describe('field encryption', () => {
  it('round-trips a value', () => {
    expect(decryptField(encryptField(NIN))).toBe(NIN);
  });

  it('round-trips unicode and long values', () => {
    const value = 'Ọláwálé Adébáyọ̀ — 🏡 '.repeat(50);
    expect(decryptField(encryptField(value))).toBe(value);
  });

  // Randomised IVs are what stop an observer learning that two residents share
  // a NIN just by comparing stored ciphertext.
  it('produces different ciphertext for identical plaintext', () => {
    const a = encryptField(NIN);
    const b = encryptField(NIN);
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
    expect(decryptField(a)).toBe(decryptField(b));
  });

  it('never stores the plaintext inside the encrypted envelope', () => {
    const encrypted = encryptField(NIN);
    expect(JSON.stringify(encrypted)).not.toContain(NIN);
  });

  it('stamps the key version so keys can be rotated', () => {
    expect(encryptField(NIN).v).toBe(1);
  });

  describe('tamper detection', () => {
    it('rejects modified ciphertext', () => {
      const encrypted = encryptField(NIN);
      const bytes = Buffer.from(encrypted.ct, 'base64');
      bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
      expect(() => decryptField({ ...encrypted, ct: bytes.toString('base64') })).toThrow(
        /tampered|wrong/i,
      );
    });

    it('rejects a modified authentication tag', () => {
      const encrypted = encryptField(NIN);
      const tag = Buffer.from(encrypted.tag, 'base64');
      tag.writeUInt8(tag.readUInt8(0) ^ 0xff, 0);
      expect(() => decryptField({ ...encrypted, tag: tag.toString('base64') })).toThrow();
    });

    it('rejects a swapped IV', () => {
      const a = encryptField(NIN);
      const b = encryptField('99999999999');
      expect(() => decryptField({ ...a, iv: b.iv })).toThrow();
    });

    it('rejects a malformed envelope outright', () => {
      const encrypted = encryptField(NIN);
      expect(() => decryptField({ ...encrypted, iv: 'AAAA' })).toThrow(/Malformed/);
    });
  });

  describe('context binding', () => {
    // Without AAD, a ciphertext could be copied from one record's field into
    // another and would still decrypt cleanly.
    it('will not decrypt under a different context', () => {
      const encrypted = encryptField(NIN, 'resident:abc:nin');
      expect(decryptField(encrypted, 'resident:abc:nin')).toBe(NIN);
      expect(() => decryptField(encrypted, 'resident:xyz:nin')).toThrow();
    });

    it('will not decrypt a context-bound value without the context', () => {
      expect(() => decryptField(encryptField(NIN, 'resident:abc:nin'))).toThrow();
    });
  });

  it('recognises encrypted envelopes', () => {
    expect(isEncryptedField(encryptField(NIN))).toBe(true);
    expect(isEncryptedField({ ct: 'x' })).toBe(false);
    expect(isEncryptedField(NIN)).toBe(false);
    expect(isEncryptedField(null)).toBe(false);
  });
});

describe('blind index', () => {
  it('is deterministic, which is what makes a unique index possible', () => {
    expect(blindIndex(NIN, 'nin')).toBe(blindIndex(NIN, 'nin'));
  });

  it('never contains the input value', () => {
    expect(blindIndex(NIN, 'nin')).not.toContain(NIN);
  });

  it('separates the same digits across different field kinds', () => {
    // Otherwise a NIN and a phone number that share digits would correlate.
    expect(blindIndex('12345678901', 'nin')).not.toBe(blindIndex('12345678901', 'phone'));
  });

  it('rejects empty values rather than indexing the empty string', () => {
    expect(() => blindIndex('   ', 'nin')).toThrow();
  });

  describe('normalisation — defeats trivial duplicate-registration attempts', () => {
    it('collapses NIN formatting', () => {
      expect(blindIndex('123-456-789-01', 'nin')).toBe(blindIndex('12345678901', 'nin'));
    });

    it('collapses Nigerian phone spellings', () => {
      const local = blindIndex('08012345678', 'phone');
      expect(blindIndex('+2348012345678', 'phone')).toBe(local);
      expect(blindIndex('0801 234 5678', 'phone')).toBe(local);
      expect(blindIndex('234-801-234-5678', 'phone')).toBe(local);
    });

    it('collapses email case', () => {
      expect(blindIndex('Ada@Example.COM', 'email')).toBe(blindIndex('ada@example.com', 'email'));
    });

    it('collapses plate formatting', () => {
      expect(blindIndex('abc-123 xy', 'plate')).toBe(blindIndex('ABC123XY', 'plate'));
    });

    it('still distinguishes genuinely different values', () => {
      expect(blindIndex('12345678901', 'nin')).not.toBe(blindIndex('12345678902', 'nin'));
    });
  });

  it('exposes normalisation for reuse by validators', () => {
    expect(normalizeForIndex('+234 801 234 5678', 'phone')).toBe('8012345678');
    expect(normalizeForIndex('  ABC-123 ', 'plate')).toBe('ABC123');
  });

  it('compares indexes in constant time', () => {
    const index = blindIndex(NIN, 'nin');
    expect(blindIndexEquals(index, index)).toBe(true);
    expect(blindIndexEquals(index, blindIndex('99999999999', 'nin'))).toBe(false);
    expect(blindIndexEquals(index, 'short')).toBe(false);
  });
});

describe('masking', () => {
  it('keeps only the last 4 digits of a NIN', () => {
    expect(maskNin('12345678901')).toBe('•••••••8901');
    expect(maskNin('123-456-789-01')).toBe('•••••••8901');
  });

  it('masks short values entirely', () => {
    expect(maskNin('123')).toBe('•••');
  });

  it('masks phone numbers and account numbers', () => {
    expect(maskPhone('08012345678')).toBe('••••••••678');
    expect(maskAccountNumber('0123456789')).toBe('••••••6789');
  });

  it('masks the local part of an email but keeps the domain', () => {
    expect(maskEmail('adebayo@example.com')).toBe('ad•••••@example.com');
    expect(maskEmail('a@example.com')).toBe('a•@example.com');
  });

  it('never leaks the full value it was given', () => {
    expect(maskNin(NIN)).not.toContain('1234567');
    expect(maskEmail('adebayo@example.com')).not.toContain('adebayo');
  });
});

describe('QR credential tokens', () => {
  const base = { sub: 'visitor' as const, cid: 'cred_123', est: 'estate_1', ttlSeconds: 3600 };

  it('issues a verifiable token', () => {
    const { token, payload } = issueToken(base);
    const result = verifyToken(token);

    expect(result.valid).toBe(true);
    expect(result.payload?.cid).toBe('cred_123');
    expect(result.payload?.jti).toBe(payload.jti);
  });

  it('gives every token a unique id so it can be revoked individually', () => {
    const a = issueToken(base);
    const b = issueToken(base);
    expect(a.payload.jti).not.toBe(b.payload.jti);
    expect(a.token).not.toBe(b.token);
  });

  // A photographed QR must not reveal who it belongs to.
  it('carries no personal data in the payload', () => {
    const { token } = issueToken(base);
    const decoded = Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(decoded)).sort()).toEqual([
      'cid',
      'est',
      'exp',
      'iat',
      'jti',
      'sub',
    ]);
  });

  describe('rejects forged and stale tokens', () => {
    it('rejects a tampered payload', () => {
      const { token } = issueToken(base);
      const [v, payloadB64, sig] = token.split('.') as [string, string, string];
      const forged = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      forged.cid = 'cred_999';
      const reencoded = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url');

      expect(verifyToken(`${v}.${reencoded}.${sig}`)).toMatchObject({
        valid: false,
        reason: 'bad-signature',
      });
    });

    it('rejects a tampered signature', () => {
      const { token } = issueToken(base);
      const [v, p] = token.split('.') as [string, string];
      expect(verifyToken(`${v}.${p}.AAAAAAAA`).valid).toBe(false);
    });

    it.each([
      ['empty', ''],
      ['not a token', 'nonsense'],
      ['too few parts', 'v1.abc'],
      ['unknown version', 'v2.abc.def'],
    ])('rejects %s', (_label, token) => {
      expect(verifyToken(token).valid).toBe(false);
    });

    it('rejects an expired token but still reports the payload for logging', () => {
      const { token } = issueToken({ ...base, ttlSeconds: 60 });
      const result = verifyToken(token, Date.now() + 61_000);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('expired');
      // The gate needs this to log which pass was presented.
      expect(result.payload?.cid).toBe('cred_123');
    });

    it('accepts a token that has not yet expired', () => {
      const { token } = issueToken({ ...base, ttlSeconds: 60 });
      expect(verifyToken(token, Date.now() + 30_000).valid).toBe(true);
    });
  });

  describe('token hashing for storage', () => {
    it('is deterministic and hides the token', () => {
      const { token } = issueToken(base);
      expect(hashToken(token)).toBe(hashToken(token));
      expect(hashToken(token)).not.toContain(token.slice(0, 20));
      expect(hashToken(token)).toHaveLength(64);
    });

    it('differs per token', () => {
      expect(hashToken(issueToken(base).token)).not.toBe(hashToken(issueToken(base).token));
    });
  });
});
