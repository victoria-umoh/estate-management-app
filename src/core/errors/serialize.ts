import { ZodError } from 'zod';
import { ErrorCode } from './codes';
import { AppError, InternalError, ValidationError, type ErrorDetail, isAppError } from './errors';

/** The `error` object as it appears in an API response. */
export interface SerializedError {
  code: string;
  message: string;
  details?: ErrorDetail[];
  /** Correlation ID, so a user can quote it to support and we can find the log. */
  requestId?: string;
}

interface MongoDuplicateKeyError {
  code: 11000;
  keyPattern?: Record<string, unknown>;
}

function isMongoDuplicateKeyError(error: unknown): error is MongoDuplicateKeyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}

/**
 * Convert any thrown value into an AppError.
 *
 * Anything unrecognised becomes a generic InternalError: an unexpected throw
 * may carry a connection string, a raw Paystack payload or a stack trace, and
 * none of that may reach a client. The original is preserved on `cause` for the
 * logger and for Sentry.
 */
export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new ValidationError(
      'The submitted data is invalid.',
      error.issues.map((issue) => ({
        field: issue.path.join('.') || undefined,
        message: issue.message,
      })),
    );
  }

  // A unique-index violation is a user-visible conflict, not a server fault —
  // it is how duplicate phone numbers, plates and NIN blind indexes surface.
  if (isMongoDuplicateKeyError(error)) {
    const field = Object.keys(error.keyPattern ?? {})
      .filter((k) => k !== 'estateId')
      .join(', ');
    return new AppError(
      ErrorCode.DUPLICATE_RESOURCE,
      409,
      field ? `That ${field} is already registered.` : 'That record already exists.',
      { cause: error },
    );
  }

  return new InternalError('Something went wrong on our end.', error);
}

/**
 * Serialise an error for the response body.
 *
 * In production, non-operational errors are replaced with a generic message:
 * a bug's message can embed internal detail, and error text is the classic
 * path for it to escape.
 */
export function serializeError(
  error: AppError,
  options: { requestId?: string; exposeInternals: boolean },
): SerializedError {
  const hideMessage = !error.isOperational && !options.exposeInternals;

  return {
    code: error.code,
    message: hideMessage ? 'Something went wrong on our end.' : error.message,
    ...(error.details.length > 0 && !hideMessage ? { details: error.details } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
}
