import { createLogger } from '@/core/logging';
import { getEmailProvider, getSmsProvider } from '@/integrations/notifications';
import { getQueue } from '@/integrations/queue';

const log = createLogger('notification:jobs');

/**
 * Wire the outbound job handlers.
 *
 * Email and SMS are sent from the QUEUE, not from the request that triggered
 * them. Two reasons: a resident's payment must not wait on an SMS gateway, and
 * a transient provider failure should be retried by something that persists —
 * which the queue does and the event bus deliberately does not.
 *
 * Idempotent: registering twice would otherwise double-send every message.
 */
let registered = false;

export async function registerNotificationJobs(): Promise<void> {
  if (registered) return;
  registered = true;

  const queue = await getQueue();

  queue.register('notification.email', async (payload) => {
    const provider = await getEmailProvider();

    const result = await provider.send({
      to: payload.to,
      subject: String(payload.data.subject ?? ''),
      text: String(payload.data.text ?? ''),
    });

    if (!result.delivered) {
      // Thrown so the queue retries. Nothing above this catches it: the request
      // that caused the notification finished long ago.
      throw new Error(`Email delivery failed: ${result.error ?? 'unknown reason'}`);
    }

    log.debug({ templateId: payload.templateId, provider: provider.name }, 'email dispatched');
  });

  queue.register('notification.sms', async (payload) => {
    const provider = await getSmsProvider();

    const result = await provider.send({
      to: payload.to,
      body: String(payload.data.body ?? ''),
    });

    if (!result.delivered) {
      throw new Error(`SMS delivery failed: ${result.error ?? 'unknown reason'}`);
    }

    log.debug({ templateId: payload.templateId, provider: provider.name }, 'sms dispatched');
  });
}

/** Test helper — allows a suite to re-register against a fresh queue. */
export function resetNotificationJobs(): void {
  registered = false;
}
