import type { TokenSubject } from '@/core/crypto';

/**
 * The outcome of a gate scan.
 *
 * Always a result, never an exception. At a gate, a refused scan is an ordinary
 * event that must be shown to the officer and written to the log — not an error
 * that unwinds the request.
 */
export type DenialReason =
  | 'malformed'
  | 'bad-signature'
  | 'expired-token'
  | 'unknown-credential'
  | 'wrong-estate'
  | 'revoked'
  | 'suspended'
  | 'blacklisted'
  | 'not-yet-valid'
  | 'window-closed';

export interface VerifiedCredential {
  credentialId: string;
  subject: TokenSubject;
  subjectId: string;
  display: {
    primaryLabel: string;
    secondaryLabel?: string | null;
    unitNumber?: string | null;
    category?: string | null;
    photoUrl?: string | null;
  };
  validUntil?: Date | null;
}

export interface ScanResult {
  admitted: boolean;
  credential?: VerifiedCredential;
  reason?: DenialReason;
  /** Shown verbatim to the officer. Short, plain, unambiguous. */
  message: string;
  /** True when the answer came from cache. Surfaced for the benchmark. */
  cached?: boolean;
}

/** Officer-facing wording. Deliberately blunt: this is read at speed. */
export const DENIAL_MESSAGES: Record<DenialReason, string> = {
  malformed: 'Not a valid pass.',
  'bad-signature': 'Not a valid pass.',
  'expired-token': 'This pass has expired.',
  'unknown-credential': 'Pass not recognised.',
  'wrong-estate': 'This pass is for another estate.',
  revoked: 'This pass has been cancelled.',
  suspended: 'Access suspended. Refer to the estate office.',
  blacklisted: 'DO NOT ADMIT. Refer to security.',
  'not-yet-valid': 'This pass is not valid yet.',
  'window-closed': 'This pass is outside its valid time.',
};
