/**
 * Identity (NIN) verification.
 *
 * Behind an interface so the live provider is a configuration choice rather
 * than a code change, and so development, demos and tests never need real
 * credentials or incur per-lookup cost.
 */
export interface IdentityVerificationInput {
  nin: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: Date;
  phone?: string;
}

export interface IdentityVerificationResult {
  verified: boolean;
  /** Provider's reference, retained for audit and dispute resolution. */
  reference: string;
  /** Present only on failure, and safe to show the user. */
  reason?: string;
  /**
   * Fields the provider confirmed. Never includes the NIN itself — we already
   * have it, and echoing it back would put it in one more place.
   */
  matched?: {
    firstName?: boolean;
    lastName?: boolean;
    dateOfBirth?: boolean;
    phone?: boolean;
  };
}

export interface IdentityProvider {
  readonly name: string;
  verifyNin(input: IdentityVerificationInput): Promise<IdentityVerificationResult>;
}

/** NIN format check. Cheap, and avoids spending a paid lookup on a typo. */
export function isValidNinFormat(nin: string): boolean {
  return /^\d{11}$/.test(nin.replace(/\D/g, ''));
}
