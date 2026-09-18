import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  AuthorizationError,
  InternalError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  isAppError,
  normalizeError,
  serializeError,
} from './index';
import { ErrorCode } from './codes';

describe('AppError', () => {
  it('carries a code, status and operational flag', () => {
    const error = new ValidationError('Bad input', [{ field: 'nin', message: 'required' }]);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(error.isOperational).toBe(true);
    expect(error.details).toHaveLength(1);
    expect(isAppError(error)).toBe(true);
  });

  it('treats internal errors as non-operational and preserves the cause', () => {
    const cause = new Error('connection string mongodb://user:pass@host');
    const error = new InternalError('Something went wrong on our end.', cause);
    expect(error.isOperational).toBe(false);
    expect(error.cause).toBe(cause);
  });

  it('exposes retry-after on rate limit errors', () => {
    expect(new RateLimitError(30).retryAfterSeconds).toBe(30);
  });
});

describe('normalizeError', () => {
  it('passes AppErrors through unchanged', () => {
    const original = new AuthorizationError();
    expect(normalizeError(original)).toBe(original);
  });

  it('converts a ZodError into a field-level validation error', () => {
    const schema = z.object({ email: z.string().email(), age: z.number().min(18) });
    const parsed = schema.safeParse({ email: 'nope', age: 12 });

    const error = normalizeError(parsed.success ? null : parsed.error);
    expect(error.statusCode).toBe(400);
    expect(error.details.map((d) => d.field)).toEqual(['email', 'age']);
  });

  it('converts a Mongo duplicate-key error into a 409, ignoring the tenant key', () => {
    const error = normalizeError({ code: 11000, keyPattern: { estateId: 1, plateNumber: 1 } });
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe(ErrorCode.DUPLICATE_RESOURCE);
    // estateId is an implementation detail of tenancy and must not be named
    // back to the user.
    expect(error.message).toContain('plateNumber');
    expect(error.message).not.toContain('estateId');
  });

  it.each([
    ['a raw Error', new Error('ECONNREFUSED 10.0.0.5:27017')],
    ['a thrown string', 'kaboom'],
    ['null', null],
  ])('wraps %s as a non-operational internal error', (_label, thrown) => {
    const error = normalizeError(thrown);
    expect(error.statusCode).toBe(500);
    expect(error.isOperational).toBe(false);
    expect(error.cause).toBe(thrown);
  });
});

describe('serializeError', () => {
  it('includes the message and details for operational errors', () => {
    const body = serializeError(new ValidationError('Bad input', [{ message: 'required' }]), {
      requestId: 'req-1',
      exposeInternals: false,
    });
    expect(body).toEqual({
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Bad input',
      details: [{ message: 'required' }],
      requestId: 'req-1',
    });
  });

  // The whole point: an unexpected throw must not leak its message to a client.
  it('hides non-operational messages when internals are not exposed', () => {
    const leaky = new InternalError('mongodb://admin:hunter2@10.0.0.5/estate', new Error('x'));
    const body = serializeError(leaky, { exposeInternals: false });

    expect(body.message).toBe('Something went wrong on our end.');
    expect(body.message).not.toContain('hunter2');
  });

  it('shows the real message in development, where it aids debugging', () => {
    const leaky = new InternalError('actual cause detail');
    expect(serializeError(leaky, { exposeInternals: true }).message).toBe('actual cause detail');
  });

  it('never exposes the cause chain in the response body', () => {
    const body = serializeError(new InternalError('x', new Error('secret')), {
      exposeInternals: true,
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('cross-tenant access', () => {
  // Returning 403 would confirm the record exists, letting an attacker
  // enumerate other estates' data by probing IDs.
  it('reports another estate resource as 404, not 403', () => {
    const error = new NotFoundError('Resident');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Resident not found.');
  });

  it('keeps a generic 403 free of resource detail', () => {
    expect(new AuthorizationError().message).not.toMatch(/resident|property|estate/i);
  });
});

describe('error code stability', () => {
  // These strings are a public API contract that clients branch on.
  it('keeps codes as stable uppercase identifiers', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('has no duplicate code values', () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it('uses the AppError base for custom status codes', () => {
    expect(new AppError(ErrorCode.CONFLICT, 409, 'x').statusCode).toBe(409);
  });
});
