import type { ResidentCategory, MembershipStatus } from '@/modules/membership/schema';

/**
 * Resident views.
 *
 * Three shapes, deliberately distinct, because the difference between them is a
 * security boundary rather than a convenience:
 *
 *  - `ResidentListItem` — the directory. No contact details beyond what staff
 *    need to identify someone.
 *  - `ResidentDetail` — a single profile. Contact details present, NIN masked.
 *  - `GateIdentity` — what a gate screen shows. Deliberately minimal.
 *
 * Each is built by an explicit allow-list, never by spreading a database
 * document. A field added to the schema later cannot leak by being forgotten.
 */
export interface ResidentListItem {
  membershipId: string;
  userId: string;
  fullName: string;
  category: ResidentCategory;
  status: MembershipStatus;
  residentCode: string | null;
  unitNumber: string | null;
  photoUrl: string | null;
  verified: boolean;
  joinedAt: Date;
}

export interface ResidentDetail extends ResidentListItem {
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth?: Date;
  gender?: string;

  /** Always masked. The full value has its own endpoint and permission. */
  ninMasked: string | null;
  ninVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;

  emergencyContact: { name: string; phone: string; relationship: string } | null;

  property: {
    id: string;
    unitNumber: string;
    street: string;
    role: string;
    since: Date;
  } | null;

  approvedAt: Date | null;
  movedInAt: Date | null;
  /** Present only when the viewer may assign roles. */
  roleIds?: string[];
}

/**
 * What a gate screen is allowed to display.
 *
 * No email, no phone, no date of birth, no NIN. An officer needs to know that
 * this person belongs here and which house they are for — nothing else. The
 * gate terminal is shared between shifts and often unattended.
 */
export interface GateIdentity {
  membershipId: string;
  fullName: string;
  category: ResidentCategory;
  unitNumber: string | null;
  photoUrl: string | null;
  status: MembershipStatus;
  residentCode: string | null;
}
