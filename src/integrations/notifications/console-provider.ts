import { randomUUID } from 'node:crypto';
import { createLogger } from '@/core/logging';
import type {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  SmsMessage,
  SmsProvider,
} from './types';

const log = createLogger('notifications:console');

/**
 * Offline providers, for development and tests.
 *
 * They log rather than send, and — importantly — they REMEMBER what they were
 * asked to send. A mock that only logs lets a test assert that `send()` did not
 * throw, which is the one thing a broken notification path is very good at.
 * Recording the message means a test can assert the resident was actually
 * addressed, on the right channel, with the right words.
 *
 * `sent` is bounded: a long-running dev server would otherwise accumulate every
 * message it ever pretended to send.
 */
const MAX_RECORDED = 500;

export interface RecordedEmail extends EmailMessage {
  at: Date;
}

export interface RecordedSms extends SmsMessage {
  at: Date;
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  readonly sent: RecordedEmail[] = [];

  async send(message: EmailMessage): Promise<DeliveryResult> {
    this.sent.push({ ...message, at: new Date() });
    if (this.sent.length > MAX_RECORDED) this.sent.shift();

    // warn, not info: in development this is the only visible trace of a
    // verification link or a reset token, and it must not be filtered out by a
    // default log level.
    log.warn({ to: message.to, subject: message.subject }, `EMAIL (not sent)\n${message.text}`);

    return { delivered: true, providerMessageId: `console_${randomUUID()}` };
  }

  /** Test helper. */
  clear(): void {
    this.sent.length = 0;
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  readonly sent: RecordedSms[] = [];

  async send(message: SmsMessage): Promise<DeliveryResult> {
    this.sent.push({ ...message, at: new Date() });
    if (this.sent.length > MAX_RECORDED) this.sent.shift();

    log.warn({ to: message.to }, `SMS (not sent)\n${message.body}`);

    return { delivered: true, providerMessageId: `console_${randomUUID()}` };
  }

  clear(): void {
    this.sent.length = 0;
  }
}
