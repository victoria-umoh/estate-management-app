import { ErrorCode, type ErrorCodeValue } from './codes';

export interface ErrorDetail {
  /** Dot-path of the offending field, e.g. `vehicle.plateNumber`. */
  field?: string;
  message: string;
}

/**
 * Base class for every error the application raises deliberately.
 *
 * `message` is assumed to be SAFE TO SHOW A USER. Anything sensitive — a Mongo
 * error, an upstream payment body, a stack trace — belongs in `cause`, which is
 * logged but never serialised into a response.
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;
  readonly details: ErrorDetail[];

  /**
   * Operational errors are expected conditions (bad input, missing record) and
   * are logged at `warn`. Non-operational errors indicate a bug, are logged at
   * `error`, and are reported to Sentry.
   */
  readonly isOperational: boolean;

  constructor(
    code: ErrorCodeValue,
    statusCode: number,
    message: string,
    options: { details?: ErrorDetail[]; cause?: unknown; isOperational?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details ?? [];
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is invalid.', details: ErrorDetail[] = []) {
    super(ErrorCode.VALIDATION_FAILED, 400, message, { details });
  }
}

export class AuthenticationError extends AppError {
  constructor(
    message = 'Authentication is required.',
    code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
  ) {
    super(code, 401, message);
  }
}

export class AuthorizationError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code: ErrorCodeValue = ErrorCode.FORBIDDEN,
  ) {
    super(code, 403, message);
  }
}

/**
 * Also the correct response for a resource that exists in ANOTHER estate.
 *
 * Returning 403 there would confirm the record exists, letting an attacker
 * enumerate other estates' residents, plates and invoice references by probing
 * IDs. 404 leaks nothing.
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(ErrorCode.NOT_FOUND, 404, `${resource} not found.`);
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'That conflicts with the current state.',
    code: ErrorCodeValue = ErrorCode.CONFLICT,
  ) {
    super(code, 409, message);
  }
}

export class DuplicateResourceError extends ConflictError {
  constructor(resource: string, field?: string) {
    super(
      `A ${resource} with that ${field ?? 'value'} already exists.`,
      ErrorCode.DUPLICATE_RESOURCE,
    );
  }
}

export class InvalidStateTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super(`Cannot move from "${from}" to "${to}".`, ErrorCode.INVALID_STATE_TRANSITION);
  }
}

export class UnprocessableError extends AppError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.UNPROCESSABLE) {
    super(code, 422, message);
  }
}

export class RateLimitError extends AppError {
  /** Seconds until the caller may retry; surfaced as the Retry-After header. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Too many requests. Please slow down.') {
    super(ErrorCode.RATE_LIMITED, 429, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 402: the request is well-formed, but the estate's plan does not allow it. */
export class PlanRestrictionError extends AppError {
  constructor(message: string, code: ErrorCodeValue = ErrorCode.FEATURE_NOT_IN_PLAN) {
    super(code, 402, message);
  }
}

/**
 * Something went wrong that the user cannot act on. The real cause is logged
 * and reported; the client sees a generic message.
 */
export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our end.', cause?: unknown) {
    super(ErrorCode.INTERNAL_ERROR, 500, message, { cause, isOperational: false });
  }
}

/** A third party (Paystack, Termii, the NIN provider) failed or timed out. */
export class UpstreamError extends AppError {
  readonly provider: string;

  constructor(provider: string, cause?: unknown) {
    super(ErrorCode.UPSTREAM_ERROR, 502, `The ${provider} service is unavailable right now.`, {
      cause,
      isOperational: true,
    });
    this.provider = provider;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
