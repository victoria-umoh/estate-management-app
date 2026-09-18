import { config } from '@/core/config';
import { MockIdentityProvider } from './mock-provider';
import type { IdentityProvider } from './types';

export type {
  IdentityProvider,
  IdentityVerificationInput,
  IdentityVerificationResult,
} from './types';
export { isValidNinFormat } from './types';
export { MockIdentityProvider } from './mock-provider';

import type * as DojahModule from './dojah-provider';

let instance: IdentityProvider | undefined;

export function getIdentityProvider(): IdentityProvider {
  if (instance) return instance;

  switch (config.identity.driver) {
    case 'dojah': {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DojahIdentityProvider } = require('./dojah-provider') as typeof DojahModule;
      instance = new DojahIdentityProvider();
      break;
    }
    case 'prembly':
      // Prembly exposes the same shape as Dojah; the adapter lands with real
      // credentials. Until then, selecting it must fail loudly rather than
      // silently falling back to the mock.
      throw new Error('The Prembly identity adapter is not implemented yet.');
    default:
      instance = new MockIdentityProvider();
  }

  return instance;
}

export function setIdentityProvider(provider: IdentityProvider | undefined): void {
  instance = provider;
}
