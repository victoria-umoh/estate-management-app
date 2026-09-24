import { z } from 'zod';

/**
 * Self-serve signup input.
 *
 * Note what is NOT here: no slug, no plan code, no trial length, no role, no
 * membership status. Every one of those is decided server-side. A signup form
 * that could name its own plan would be a free Enterprise licence, and one that
 * could name its own slug would be a way to squat another estate's identifier
 * or to collide with a reserved path.
 */
export const SignupDto = z.object({
  estateName: z.string().trim().min(3).max(120),

  address: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    country: z.string().trim().min(2).max(80).default('Nigeria'),
    postalCode: z.string().trim().max(20).optional(),
  }),

  /** The chairman. The first and, until they invite anyone, only member. */
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().min(7).max(20),
  password: z.string().min(1).max(200),
});

export type SignupInput = z.infer<typeof SignupDto>;

export const SignupVerifyDto = z.object({
  token: z.string().trim().min(16).max(200),
});

/**
 * Ask for the verification link again.
 *
 * Only the address: everything else about the pending estate is already
 * stored, and accepting more here would let a caller change it without
 * holding the link.
 */
export const SignupResendDto = z.object({
  email: z.string().trim().toLowerCase().email(),
});
