/**
 * Masking for sensitive values rendered in the UI, logs and list responses.
 *
 * The full NIN is returned only by a dedicated endpoint that requires the
 * `resident.viewNin` permission and writes an audit entry. Everywhere else —
 * directories, search results, gate screens, exports — uses these.
 */

const BULLET = '•';

/**
 * Mask a NIN, keeping the last 4 digits so staff can confirm a match against a
 * physical slip without the full number ever being on screen.
 */
export function maskNin(nin: string): string {
  const digits = nin.replace(/\D/g, '');
  if (digits.length <= 4) return BULLET.repeat(digits.length);
  return BULLET.repeat(digits.length - 4) + digits.slice(-4);
}

/** Mask a phone number, keeping the last 3 digits. */
export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length <= 3) return BULLET.repeat(trimmed.length);
  const visible = trimmed.slice(-3);
  const hidden = trimmed.slice(0, -3).replace(/\S/g, BULLET);
  return hidden + visible;
}

/** Mask an email as `jo•••@example.com`, preserving the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return BULLET.repeat(email.length);

  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = Math.min(2, local.length);

  return local.slice(0, keep) + BULLET.repeat(Math.max(local.length - keep, 1)) + domain;
}

/** Mask an account number, keeping the last 4 digits. */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length <= 4) return BULLET.repeat(digits.length);
  return BULLET.repeat(digits.length - 4) + digits.slice(-4);
}
