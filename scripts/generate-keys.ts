/**
 * Generates every cryptographic secret the platform needs, ready to paste into
 * `.env.local`.
 *
 *   pnpm keys:generate
 *
 * Each secret is independent on purpose: a leak of one must not compromise the
 * others. Notably the access and refresh JWT keys differ, so a stolen access
 * key cannot be used to mint long-lived sessions.
 */
import { randomBytes } from 'node:crypto';

const SECRETS = [
  ['JWT_ACCESS_SECRET', 'signs short-lived access tokens'],
  ['JWT_REFRESH_SECRET', 'signs refresh tokens — must differ from the access key'],
  ['ENCRYPTION_KEY', 'AES-256-GCM key for NIN and other sensitive fields'],
  ['ENCRYPTION_BLIND_INDEX_KEY', 'HMAC key for searchable blind indexes'],
  ['QR_SIGNING_SECRET', 'signs ID, vehicle and visitor-pass QR payloads'],
  ['CRON_SECRET', 'authenticates scheduled job routes'],
] as const;

console.log('# Generated %s — paste into .env.local', new Date().toISOString());
console.log('# Store these in a secret manager for production. Losing');
console.log('# ENCRYPTION_KEY makes encrypted data permanently unreadable.\n');

for (const [name, purpose] of SECRETS) {
  console.log(`# ${purpose}`);
  console.log(`${name}=${randomBytes(32).toString('hex')}`);
}
