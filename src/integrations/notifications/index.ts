import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import { ConsoleEmailProvider, ConsoleSmsProvider } from './console-provider';
import type { EmailProvider, SmsProvider } from './types';

export type {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  SmsMessage,
  SmsProvider,
} from './types';
export {
  ConsoleEmailProvider,
  ConsoleSmsProvider,
  type RecordedEmail,
  type RecordedSms,
} from './console-provider';

const log = createLogger('notifications');

let emailInstance: EmailProvider | undefined;
let emailPending: Promise<EmailProvider> | undefined;

let smsInstance: SmsProvider | undefined;
let smsPending: Promise<SmsProvider> | undefined;

/**
 * The configured email provider.
 *
 * Async because the real adapters are loaded by dynamic import — `require()` is
 * CommonJS and throws under plain Node ESM, which would break every job, script
 * and route that sends a message.
 */
export function getEmailProvider(): Promise<EmailProvider> {
  emailPending ??= buildEmail();
  return emailPending;
}

export function getSmsProvider(): Promise<SmsProvider> {
  smsPending ??= buildSms();
  return smsPending;
}

async function buildEmail(): Promise<EmailProvider> {
  if (emailInstance) return emailInstance;

  // Falls back to console when the driver is selected but unconfigured, rather
  // than constructing a client that will fail on first use with an opaque
  // upstream error. Config validation already refuses `console` in production,
  // so this cannot silently swallow real mail on a live deploy.
  if (config.email.driver === 'resend' && config.email.resendApiKey) {
    const { ResendEmailProvider } = await import('./resend');
    emailInstance = new ResendEmailProvider();
  } else {
    if (config.email.driver !== 'console') {
      log.warn({ driver: config.email.driver }, 'email driver unconfigured; using console');
    }
    emailInstance = new ConsoleEmailProvider();
  }

  log.debug({ provider: emailInstance.name }, 'email provider initialised');
  return emailInstance;
}

async function buildSms(): Promise<SmsProvider> {
  if (smsInstance) return smsInstance;

  if (config.sms.driver === 'termii' && config.sms.termii.apiKey) {
    const { TermiiSmsProvider } = await import('./termii');
    smsInstance = new TermiiSmsProvider();
  } else {
    if (config.sms.driver !== 'console') {
      log.warn({ driver: config.sms.driver }, 'sms driver unconfigured; using console');
    }
    smsInstance = new ConsoleSmsProvider();
  }

  log.debug({ provider: smsInstance.name }, 'sms provider initialised');
  return smsInstance;
}

export function setEmailProvider(provider: EmailProvider | undefined): void {
  emailInstance = provider;
  emailPending = provider ? Promise.resolve(provider) : undefined;
}

export function setSmsProvider(provider: SmsProvider | undefined): void {
  smsInstance = provider;
  smsPending = provider ? Promise.resolve(provider) : undefined;
}
