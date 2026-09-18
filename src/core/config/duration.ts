/**
 * Duration strings ("15m", "30d", "500ms") used throughout configuration.
 *
 * Config holds durations as human-readable strings because a reviewer reading
 * `JWT_ACCESS_TTL=15m` in a deploy diff can immediately tell whether it is
 * sane, whereas `900000` invites a misplaced zero that silently grants
 * 10-day access tokens.
 */

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type Unit = keyof typeof UNIT_MS;

const PATTERN = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Parse a duration string into milliseconds.
 *
 * @throws if the string is not a positive integer followed by ms|s|m|h|d.
 *         Throwing beats defaulting: a typo'd TTL that silently becomes 0 or
 *         Infinity is a security bug, not a formatting inconvenience.
 */
export function parseDuration(value: string): number {
  const match = PATTERN.exec(value.trim());

  if (!match) {
    throw new Error(
      `Invalid duration "${value}". Expected a positive integer followed by ms, s, m, h or d — for example "15m" or "30d".`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2] as Unit;

  if (amount <= 0) {
    throw new Error(`Invalid duration "${value}". Must be greater than zero.`);
  }

  return amount * UNIT_MS[unit];
}

/** True when the string is a well-formed duration. Used by the Zod schema. */
export function isValidDuration(value: string): boolean {
  const match = PATTERN.exec(value.trim());
  return match !== null && Number(match[1]) > 0;
}

/** Render milliseconds as a compact human string, for logs and error messages. */
export function formatDuration(ms: number): string {
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = UNIT_MS[unit];
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
