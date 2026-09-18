import { z } from 'zod';

/**
 * API contracts for authentication.
 *
 * These schemas are the single definition of each shape: the route kernel
 * validates with them, forms reuse them, and the OpenAPI spec is generated from
 * them. One definition means the client and server cannot drift.
 */

/** Normalise to E.164 so the same line has exactly one representation. */
const phone = z
  .string()
  .trim()
  .regex(/^(\+?234|0)?[789]\d{9}$/, 'Enter a valid Nigerian phone number.')
  .transform((value) => {
    const digits = value.replace(/\D/g, '');
    const national = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0+/, '');
    return `+234${national}`;
  });

const email = z.string().trim().toLowerCase().email('Enter a valid email address.');

const nin = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, ''))
  .refine((value) => value.length === 11, 'A NIN is 11 digits.');

const password = z.string().min(10, 'Use at least 10 characters.').max(128);

export const RegisterDto = z.object({
  firstName: z.string().trim().min(2).max(80),
  middleName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().min(2).max(80),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.enum(['male', 'female', 'other', 'undisclosed']).optional(),
  email,
  phone,
  password,
  /** Estate being joined. Determines which administrators review the request. */
  estateId: z.string().min(1),
  category: z.enum([
    'homeowner',
    'landlord',
    'tenant',
    'dependant',
    'family-member',
    'domestic-staff',
    'estate-staff',
    'security-personnel',
    'contractor',
    'other',
  ]),
  propertyId: z.string().optional(),
  emergencyContact: z
    .object({
      name: z.string().trim().min(2).max(80),
      phone,
      relationship: z.string().trim().min(2).max(40),
    })
    .optional(),
});
export type RegisterInput = z.infer<typeof RegisterDto>;

export const LoginDto = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
  /** Optional when the user belongs to exactly one estate. */
  estateId: z.string().optional(),
  /** Stable per-install identifier, so sessions can be listed per device. */
  deviceId: z.string().max(128).optional(),
  deviceName: z.string().max(120).optional(),
  /** Required only once two-factor authentication is enabled. */
  totpCode: z.string().trim().max(20).optional(),
});
export type LoginInput = z.infer<typeof LoginDto>;

export const RefreshDto = z.object({ refreshToken: z.string().min(1) });

export const VerifyEmailDto = z.object({ token: z.string().min(1) });

export const RequestOtpDto = z.object({ phone });

export const VerifyOtpDto = z.object({ phone, code: z.string().trim().min(4).max(10) });

export const VerifyNinDto = z.object({ nin });

export const ForgotPasswordDto = z.object({ email });

export const ResetPasswordDto = z.object({
  token: z.string().min(1),
  password,
});

export const ChangePasswordDto = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

export const SelectEstateDto = z.object({ estateId: z.string().min(1) });
