/**
 * Background job abstraction.
 *
 * Anything that must not be lost goes here rather than on the event bus: the
 * queue persists and retries, the bus does not. Sending an OTP, generating an
 * invoice run and sweeping for overstayed visitors all belong here.
 */
export interface JobPayloadMap {
  'notification.email': { to: string; templateId: string; data: Record<string, unknown> };
  'notification.sms': { to: string; templateId: string; data: Record<string, unknown> };
  'visitor.overstay-sweep': { estateId?: string };
  'billing.generate-invoices': { estateId?: string; period: string };
  'billing.payment-reminders': { estateId?: string };
  'subscription.dunning': Record<string, never>;
  'report.generate': { reportId: string; estateId: string; requestedBy: string };
  'credential.refresh-cache': { estateId: string; credentialId?: string };
  'document.scan': { documentId: string; estateId: string };
}

export type JobName = keyof JobPayloadMap;

export interface JobOptions {
  /** Delay before the job becomes eligible to run, in milliseconds. */
  delayMs?: number;
  attempts?: number;
  /** Collapses duplicate enqueues — e.g. one overstay sweep per estate. */
  dedupeKey?: string;
}

export type JobHandler<TName extends JobName> = (payload: JobPayloadMap[TName]) => Promise<void>;

export interface JobQueue {
  enqueue<TName extends JobName>(
    name: TName,
    payload: JobPayloadMap[TName],
    options?: JobOptions,
  ): Promise<void>;

  register<TName extends JobName>(name: TName, handler: JobHandler<TName>): void;

  close(): Promise<void>;
}
