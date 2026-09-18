import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { config } from '@/core/config';
import { ValidationError } from '@/core/errors';

/**
 * Password hashing with argon2id.
 *
 * argon2id rather than bcrypt: it is memory-hard, so the GPU and ASIC attacks
 * that make bcrypt increasingly weak are far more expensive. Cost parameters
 * come from config and follow OWASP guidance.
 */

// Algorithm.Argon2id is an ambient const enum, which isolatedModules cannot
// read at runtime; 2 is its value and is fixed by the argon2 specification.
const ARGON2ID = 2;

interface Argon2Options {
  algorithm: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

let optionsCache: Argon2Options | undefined;

function options(): Argon2Options {
  optionsCache ??= {
    algorithm: ARGON2ID,
    memoryCost: config.auth.argon2.memoryCost,
    timeCost: config.auth.argon2.timeCost,
    parallelism: config.auth.argon2.parallelism,
  };
  return optionsCache;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, options());
}

/**
 * Verify a password.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted record
 * must read as "wrong password", not as a server error that distinguishes this
 * account from others.
 */
export async function verifyPassword(plaintext: string, digest: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext, options());
  } catch {
    return false;
  }
}

/**
 * Equalise timing when no account matches.
 *
 * Without this, a missing account returns noticeably faster than a wrong
 * password, and that gap is enough to enumerate which emails are registered.
 *
 * The decoy hash is DERIVED at startup rather than hardcoded. A hand-written
 * constant is not a valid argon2 digest, so verification would reject it during
 * parsing and return almost instantly — burning none of the work this is
 * supposed to burn, and leaving the timing signal wide open.
 */
let decoyHash: Promise<string> | undefined;

function getDecoyHash(): Promise<string> {
  decoyHash ??= hash(randomBytes(32).toString('hex'), options());
  return decoyHash;
}

export async function burnPasswordVerification(plaintext: string): Promise<void> {
  await verifyPassword(plaintext, await getDecoyHash());
}

/**
 * Password policy.
 *
 * Length is weighted over composition rules, which mostly push people toward
 * predictable substitutions. The blocklist catches the handful of passwords
 * that appear in every credential-stuffing list.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwertyuiop',
  'iloveyou',
  'admin123',
  'letmein',
  'welcome1',
  'estate123',
]);

export function assertPasswordStrength(
  password: string,
  context: { email?: string; name?: string } = {},
): void {
  const problems: string[] = [];

  if (password.length < 10) problems.push('Use at least 10 characters.');
  if (password.length > 128) problems.push('Use no more than 128 characters.');
  if (!/[a-z]/.test(password)) problems.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(password)) problems.push('Include an uppercase letter.');
  if (!/\d/.test(password)) problems.push('Include a number.');

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('That password is too common.');
  }

  // A password containing the user's own email or name is trivially guessable
  // by anyone who knows them — which, in an estate, is everyone.
  const lowered = password.toLowerCase();
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && lowered.includes(localPart)) {
    problems.push('Do not include your email address.');
  }
  if (context.name && context.name.length >= 3 && lowered.includes(context.name.toLowerCase())) {
    problems.push('Do not include your name.');
  }

  if (problems.length > 0) {
    throw new ValidationError('That password is not strong enough.', [
      { field: 'password', message: problems.join(' ') },
    ]);
  }
}
