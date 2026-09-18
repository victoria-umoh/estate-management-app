import { config } from '@/core/config';
import { UpstreamError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import type {
  IdentityProvider,
  IdentityVerificationInput,
  IdentityVerificationResult,
} from './types';

const log = createLogger('identity:dojah');

interface DojahResponse {
  entity?: {
    first_name?: string;
    last_name?: string;
    date_of_birth?: string;
    phone_number?: string;
  };
}

/** Dojah NIN lookup. Activated by IDENTITY_DRIVER=dojah. */
export class DojahIdentityProvider implements IdentityProvider {
  readonly name = 'dojah';

  async verifyNin(input: IdentityVerificationInput): Promise<IdentityVerificationResult> {
    const nin = input.nin.replace(/\D/g, '');
    const reference = `dojah_${Date.now()}`;

    let response: Response;
    try {
      response = await fetch(`${config.identity.dojah.baseUrl}/api/v1/kyc/nin?nin=${nin}`, {
        headers: {
          AppId: config.identity.dojah.appId!,
          Authorization: config.identity.dojah.apiKey!,
        },
        // Bounded, so a hanging provider cannot hold a registration request open.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Never log the NIN itself.
      log.error({ err: error }, 'dojah request failed');
      throw new UpstreamError('identity verification', error);
    }

    if (!response.ok) {
      if (response.status === 404) {
        return { verified: false, reference, reason: 'That NIN was not found.' };
      }
      throw new UpstreamError('identity verification');
    }

    const body = (await response.json()) as DojahResponse;
    const entity = body.entity;

    if (!entity) return { verified: false, reference, reason: 'That NIN was not found.' };

    const matched = {
      firstName: normalise(entity.first_name) === normalise(input.firstName),
      lastName: normalise(entity.last_name) === normalise(input.lastName),
    };

    // Both names must match. A NIN that belongs to someone else is precisely
    // the case this check exists to catch.
    const verified = matched.firstName && matched.lastName;

    return {
      verified,
      reference,
      matched,
      ...(verified ? {} : { reason: 'The details provided do not match the NIN record.' }),
    };
  }
}

function normalise(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}
