import pino, { type Logger } from 'pino';
import { config } from '@/core/config';
import { getLogContext } from './context';
import { REDACT_PATHS, REDACT_PLACEHOLDER } from './redact';

export {
  withLogContext,
  getLogContext,
  getCorrelationId,
  enrichLogContext,
  type LogContext,
} from './context';
export { REDACT_PATHS } from './redact';

/**
 * Application logger.
 *
 * Structured JSON by default so lines are queryable in an aggregator; pretty
 * only when explicitly enabled for local work. Every line is automatically
 * stamped with the active correlation ID, user and estate via a mixin, so call
 * sites cannot forget to include them.
 */
export const logger: Logger = pino({
  level: config.observability.logLevel,

  redact: {
    paths: [...REDACT_PATHS],
    censor: REDACT_PLACEHOLDER,
  },

  base: {
    service: config.observability.otel.serviceName,
    env: config.env.NODE_ENV,
  },

  // Attached to every line, so request attribution never depends on the caller
  // remembering to pass it.
  mixin() {
    const context = getLogContext();
    if (!context) return {};

    return {
      correlationId: context.correlationId,
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.estateId ? { estateId: context.estateId } : {}),
      ...(context.route ? { route: context.route } : {}),
    };
  },

  formatters: {
    level: (label) => ({ level: label }),
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  ...(config.observability.logPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
          },
        },
      }
    : {}),
});

/**
 * Child logger tagged with a subsystem name, e.g. `logger.child({ module: 'payments' })`.
 * Lets one module's output be filtered without changing the global level.
 */
export function createLogger(module: string): Logger {
  return logger.child({ module });
}
