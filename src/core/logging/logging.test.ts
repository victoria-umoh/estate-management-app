import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { enrichLogContext, getCorrelationId, getLogContext, withLogContext } from './context';
import { REDACT_PATHS } from './redact';

/** Capture log output by writing to an in-memory stream. */
function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk));
    },
  };

  const log = pino(
    { redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' }, base: undefined },
    stream as never,
  );

  return { log, lines };
}

describe('log redaction', () => {
  it.each([
    ['password', { password: 'hunter2' }],
    ['nin', { nin: '12345678901' }],
    ['otp', { otp: '123456' }],
    ['refreshToken', { refreshToken: 'rt_secret' }],
    ['totpSecret', { totpSecret: 'JBSWY3DP' }],
    ['cardNumber', { cardNumber: '4111111111111111' }],
    ['accountNumber', { accountNumber: '0123456789' }],
  ])('redacts a top-level %s', (_label, payload) => {
    const { log, lines } = captureLogger();
    log.info(payload, 'test');

    const output = JSON.stringify(lines[0]);
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(Object.values(payload)[0]);
  });

  it('redacts nested identity fields', () => {
    const { log, lines } = captureLogger();
    log.info({ resident: { name: 'Ada', nin: '12345678901' } }, 'created');

    const output = JSON.stringify(lines[0]);
    expect(output).not.toContain('12345678901');
    // Non-sensitive fields must survive, or logs become useless.
    expect(output).toContain('Ada');
  });

  it('redacts auth headers on request objects', () => {
    const { log, lines } = captureLogger();
    log.info({ req: { headers: { authorization: 'Bearer abc123', 'user-agent': 'curl' } } }, 'req');

    const output = JSON.stringify(lines[0]);
    expect(output).not.toContain('abc123');
    expect(output).toContain('curl');
  });

  it('redacts the webhook signature header', () => {
    const { log, lines } = captureLogger();
    log.info({ req: { headers: { 'x-paystack-signature': 'sig_secret' } } }, 'webhook');
    expect(JSON.stringify(lines[0])).not.toContain('sig_secret');
  });

  it('redacts ciphertext envelopes', () => {
    const { log, lines } = captureLogger();
    log.info({ ct: 'base64ciphertext', iv: 'aaa' }, 'encrypted');
    expect(JSON.stringify(lines[0])).not.toContain('base64ciphertext');
  });
});

describe('log context propagation', () => {
  it('returns nothing outside a request', () => {
    expect(getLogContext()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();
  });

  it('exposes the context inside the scope', () => {
    withLogContext({ correlationId: 'req-1', estateId: 'e1' }, () => {
      expect(getCorrelationId()).toBe('req-1');
      expect(getLogContext()?.estateId).toBe('e1');
    });
  });

  it('survives async boundaries', async () => {
    await withLogContext({ correlationId: 'req-async' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getCorrelationId()).toBe('req-async');
    });
  });

  it('isolates concurrent requests from each other', async () => {
    const seen = await Promise.all([
      withLogContext({ correlationId: 'req-a' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getCorrelationId();
      }),
      withLogContext({ correlationId: 'req-b' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getCorrelationId();
      }),
    ]);

    expect(seen).toEqual(['req-a', 'req-b']);
  });

  // Requests log before they authenticate; enrichment attributes those lines too.
  it('allows enrichment after authentication', () => {
    withLogContext({ correlationId: 'req-1' }, () => {
      enrichLogContext({ userId: 'u1', estateId: 'e1' });
      expect(getLogContext()).toMatchObject({
        correlationId: 'req-1',
        userId: 'u1',
        estateId: 'e1',
      });
    });
  });

  it('does not leak enrichment out of its scope', () => {
    withLogContext({ correlationId: 'req-1' }, () => enrichLogContext({ userId: 'u1' }));
    expect(getLogContext()).toBeUndefined();
  });
});
