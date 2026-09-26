import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import type { DeliveryResult, SmsMessage, SmsProvider } from './types';

const log = createLogger('notifications:termii');

/**
 * Termii SMS delivery.
 *
 * Nigerian carriers are the primary route here, which is why Termii rather than
 * a US-first provider: it holds the registered sender IDs and the DND-route
 * agreements that decide whether a message actually reaches an MTN or Glo
 * handset at all.
 *
 * Two Termii details worth knowing:
 *
 *  - The API key travels in the JSON BODY, not a header. It is therefore never
 *    logged here, because the body is never logged here.
 *  - Termii rejects a leading `+`. Numbers are stored E.164, so it is stripped
 *    on the way out rather than at every call site.
 *
 * Like the email adapter, failures are returned rather than thrown.
 */
export class TermiiSmsProvider implements SmsProvider {
  readonly name = 'termii';

  async send(message: SmsMessage): Promise<DeliveryResult> {
    const baseUrl = config.sms.termii.baseUrl.replace(/\/+$/, '');

    let response: Response;

    try {
      response = await fetch(`${baseUrl}/api/sms/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: message.to.replace(/^\+/, ''),
          from: config.sms.senderId,
          sms: message.body,
          type: 'plain',
          // `dnd` routes around the Do-Not-Disturb list most Nigerian numbers
          // are on by default. `generic` is cheaper but silently drops those
          // messages, which for an emergency alert is the worst possible
          // failure: it looks like a success.
          channel: config.sms.termii.channel,
          api_key: config.sms.termii.apiKey,
        }),
        signal: AbortSignal.timeout(config.notifications.providerTimeoutMs),
      });
    } catch (error) {
      log.error({ err: error }, 'termii request failed');
      return { delivered: false, error: 'SMS provider unreachable.' };
    }

    const body = (await response.json().catch(() => null)) as {
      message_id?: string;
      message?: string;
      code?: string;
    } | null;

    // Termii answers 200 with an error message for some rejections, so the
    // status alone is not proof of acceptance.
    const accepted = response.ok && Boolean(body?.message_id);

    if (!accepted) {
      log.error({ status: response.status, reason: body?.message }, 'termii error');
      return { delivered: false, error: body?.message ?? `Provider returned ${response.status}.` };
    }

    return { delivered: true, providerMessageId: body!.message_id! };
  }
}
