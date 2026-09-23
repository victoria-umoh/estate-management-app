import { config } from '@/core/config';
import { createLogger } from '@/core/logging';
import type { DeliveryResult, EmailMessage, EmailProvider } from './types';

const log = createLogger('notifications:resend');

const BASE_URL = 'https://api.resend.com';

/**
 * Resend email delivery.
 *
 * Called over plain `fetch` rather than the SDK: one endpoint, one shape, and
 * the SDK would pull a dependency into every runtime that merely imports the
 * notification module.
 *
 * Failures are RETURNED, not thrown. A bounced verification email must not roll
 * back the registration that asked for it — the in-app record already exists,
 * and the queue retries the send.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const from = `${config.email.fromName} <${config.email.fromAddress}>`;

    let response: Response;

    try {
      response = await fetch(`${BASE_URL}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.email.resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: [message.replyTo] } : {}),
          ...(message.attachments?.length
            ? {
                attachments: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  content: attachment.content.toString('base64'),
                  content_type: attachment.contentType,
                })),
              }
            : {}),
          ...(message.tags
            ? {
                tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
              }
            : {}),
        }),
        // Bounded, so a hanging provider cannot hold a queue worker — or a
        // registration request — open indefinitely.
        signal: AbortSignal.timeout(config.notifications.providerTimeoutMs),
      });
    } catch (error) {
      log.error({ err: error }, 'resend request failed');
      return { delivered: false, error: 'Email provider unreachable.' };
    }

    const body = (await response.json().catch(() => null)) as
      | { id?: string; message?: string; name?: string }
      | null;

    if (!response.ok) {
      // The recipient address is logged, the message body never is: it may
      // carry a reset token or a verification link.
      log.error({ status: response.status, reason: body?.message ?? body?.name }, 'resend error');
      return { delivered: false, error: body?.message ?? `Provider returned ${response.status}.` };
    }

    return { delivered: true, ...(body?.id ? { providerMessageId: body.id } : {}) };
  }
}
