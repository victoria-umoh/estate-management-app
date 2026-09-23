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
let rootLogger: Logger | undefined;

function getRootLogger(): Logger {
  rootLogger ??= buildLogger();
  return rootLogger;
}

/**
 * Build the logger, falling back to JSON if the pretty transport will not load.
 *
 * `pino-pretty` runs in a worker thread, and inside Next's bundled server graph
 * pino cannot resolve the target — it throws during construction.
 * `getRootLogger` is called from bootstrap, which the route kernel runs on the
 * first request after every recompile, so the throw surfaced as a 500 on
 * whichever route happened to be first. Roughly one request per compile cycle
 * failed for no reason a reader could see.
 *
 * A preference about log formatting must never be able to take the request path
 * down. If the transport will not build, log JSON and say so once.
 */
function buildLogger(): Logger {
  try {
    return pino(loggerOptions(config.observability.logPretty));
  } catch {
    // Deliberately console: the logger is what failed to build.
    console.warn(
      'LOG_PRETTY is set but pino-pretty could not be loaded here, so logs will be JSON.',
    );
    return pino(loggerOptions(false));
  }
}

function loggerOptions(pretty: boolean): pino.LoggerOptions {
  return {
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

    ...(pretty
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
  };
}

/**
 * Application logger.
 *
 * A Proxy, because the underlying pino instance needs configuration to be
 * constructed and modules create loggers at import time. Deferring construction
 * to first use keeps a production build from demanding runtime secrets simply
 * to compile.
 */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, property) {
    const instance = getRootLogger();
    return Reflect.get(instance, property, instance);
  },
});

const childLoggers = new Map<string, Logger>();

/**
 * Child logger tagged with a subsystem name, so one module's output can be
 * filtered without changing the global level.
 */
export function createLogger(module: string): Logger {
  return new Proxy({} as Logger, {
    get(_target, property) {
      let child = childLoggers.get(module);
      if (!child) {
        child = getRootLogger().child({ module });
        childLoggers.set(module, child);
      }
      return Reflect.get(child, property, child);
    },
  });
}
