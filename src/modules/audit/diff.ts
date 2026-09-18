/**
 * Field-level change diffing for the audit trail.
 *
 * The trail must record THAT a NIN changed without becoming a second database
 * of NINs. Sensitive fields are therefore reduced to a marker, and the diff
 * records the fact of the change rather than its content.
 */

const SENSITIVE_FIELD =
  /(nin|bvn|password|passwordHash|token|secret|otp|cvv|pin|accountNumber|cardNumber|twoFactorSecret)/i;

const REDACTED = '[REDACTED]';
const SET = '[SET]';
const CLEARED = '[CLEARED]';

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

function isSensitive(field: string): boolean {
  return SENSITIVE_FIELD.test(field);
}

/**
 * Reduce a value to something safe to store.
 *
 * Encrypted envelopes and long strings are collapsed rather than copied: an
 * audit entry holding ciphertext is both useless and an extra place for it to
 * leak from.
 */
function safeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  if (typeof value === 'object') {
    // An encryption envelope, from core/crypto.
    if ('ct' in (value as object) && 'iv' in (value as object)) return REDACTED;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return `[${value.length} items]`;
    return '[object]';
  }

  if (typeof value === 'string' && value.length > 200) {
    return `${value.slice(0, 200)}…`;
  }

  return value;
}

/**
 * Compute what changed between two versions of a record.
 *
 * Only fields that actually differ are recorded. An audit entry listing every
 * field of an unchanged document buries the one line that mattered.
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: { ignore?: readonly string[] } = {},
): FieldChange[] {
  const ignore = new Set(['updatedAt', 'createdAt', '__v', ...(options.ignore ?? [])]);
  const changes: FieldChange[] = [];

  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

  for (const field of fields) {
    if (ignore.has(field)) continue;

    const from = before?.[field];
    const to = after?.[field];

    if (equivalent(from, to)) continue;

    if (isSensitive(field)) {
      // Record that it changed, and in which direction, never the values.
      changes.push({
        field,
        from: from === null || from === undefined ? null : REDACTED,
        to: to === null || to === undefined ? CLEARED : SET,
      });
      continue;
    }

    changes.push({ field, from: safeValue(from), to: safeValue(to) });
  }

  return changes;
}

function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();

  // Ids arrive as ObjectId in one version and string in the other often enough
  // that comparing their string forms avoids a stream of phantom changes.
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  return false;
}

/** Redact a metadata object before it is attached to an audit entry. */
export function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    result[key] = isSensitive(key) ? REDACTED : safeValue(value);
  }

  return result;
}
