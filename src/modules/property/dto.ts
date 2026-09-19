import { z } from 'zod';

export const PropertyTypeEnum = z.enum([
  'detached',
  'semi-detached',
  'terrace',
  'duplex',
  'bungalow',
  'apartment',
  'studio',
  'shop',
  'office',
  'land',
  'other',
]);

export const CreatePropertyDto = z.object({
  unitNumber: z.string().trim().min(1).max(20),
  block: z.string().trim().max(40).optional(),
  street: z.string().trim().min(2).max(120),
  type: PropertyTypeEnum,
  bedrooms: z.number().int().min(0).max(50).optional(),
  maxOccupants: z.number().int().min(1).max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const ListPropertiesDto = z.object({
  occupancyStatus: z
    .enum(['vacant', 'owner-occupied', 'tenant-occupied', 'under-construction', 'unavailable'])
    .optional(),
  street: z.string().trim().max(120).optional(),
  search: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const AssignOccupantDto = z.object({
  membershipId: z.string().min(1),
  role: z.enum(['owner', 'landlord', 'tenant']),
  leaseStartDate: z.coerce.date().optional(),
  leaseEndDate: z.coerce.date().optional(),
  occupantCount: z.number().int().min(1).max(100).optional(),
});

export const TransferOwnershipDto = z.object({
  toMembershipId: z.string().min(1),
  /** End sitting tenancies as part of the sale. */
  endExistingTenancies: z.boolean().default(false),
});
