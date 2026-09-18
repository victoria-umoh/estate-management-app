import { randomUUID } from 'node:crypto';
import { config } from '@/core/config';
import type {
  IdentityProvider,
  IdentityVerificationInput,
  IdentityVerificationResult,
} from './types';
import { isValidNinFormat } from './types';

/**
 * Offline verifier for development, demos and tests.
 *
 * Deterministic rather than always-pass, so the rejection path stays exercised:
 * a NIN whose last digit is 0 fails the match. The config schema refuses to
 * start in production with this provider selected, because it would let anyone
 * hold a verified-looking estate ID.
 */
export class MockIdentityProvider implements IdentityProvider {
  readonly name = 'mock';

  async verifyNin(input: IdentityVerificationInput): Promise<IdentityVerificationResult> {
    if (config.isProduction) {
      throw new Error('The mock identity provider must never be used in production.');
    }

    const digits = input.nin.replace(/\D/g, '');

    if (!isValidNinFormat(digits)) {
      return {
        verified: false,
        reference: `mock_${randomUUID()}`,
        reason: 'The NIN must be 11 digits.',
      };
    }

    // Simulate provider latency so callers cannot accidentally depend on an
    // instant response that the real provider will never give.
    await new Promise((resolve) => setTimeout(resolve, 15));

    if (digits.endsWith('0')) {
      return {
        verified: false,
        reference: `mock_${randomUUID()}`,
        reason: 'The details provided do not match the NIN record.',
        matched: { firstName: false, lastName: true },
      };
    }

    return {
      verified: true,
      reference: `mock_${randomUUID()}`,
      matched: {
        firstName: true,
        lastName: true,
        dateOfBirth: input.dateOfBirth !== undefined,
        phone: input.phone !== undefined,
      },
    };
  }
}
