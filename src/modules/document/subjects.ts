import type { Types, UpdateQuery } from 'mongoose';
import type { BaseRepository, TenantDocument } from '@/core/db';
import { NotFoundError } from '@/core/errors';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { changeRequestRepository } from '@/modules/change-request';
import { exitPassRepository } from '@/modules/exit-pass';
import { incidentRepository } from '@/modules/incident';
import { meService } from '@/modules/me';
import { membershipRepository } from '@/modules/membership/repository';
import { serviceRequestRepository } from '@/modules/service-request';
import { vehicleRepository } from '@/modules/vehicle';
import { DOCUMENT_SUBJECT_TYPES, type DocumentSubjectType } from './schema';

export { DOCUMENT_SUBJECT_TYPES, type DocumentSubjectType };

/**
 * Who may read a document, resolved from what it is attached to.
 *
 * This file is the whole point of the module. `document.view` answers "may this
 * caller read documents at all" and nothing more; a resident holds it so their
 * own vehicle papers appear on their own screen. If that were the only check, a
 * resident holding it could walk document ids and read the photographs attached
 * to every incident on the estate — which is the exact shape of the bug that
 * `incident.viewAll`, `invoice.viewAll` and `visitor.viewAll` were each
 * introduced to close, five times over.
 *
 * So every read re-asks the owning module's question: may you read the
 * incident, the vehicle, the exit pass, the resident? A refusal is a 404 rather
 * than a 403 — the alternative confirms to a stranger that a document exists on
 * a record they may not see, which is the disclosure, not the bytes.
 *
 * These checks go through the owning module's REPOSITORY, so the estate filter
 * is applied for free: a subject in another estate is already not found before
 * ownership is considered.
 */
export interface SubjectAccessor {
  /** Throws unless the caller may read this subject. */
  assertReadable(context: RequestContext, subjectId: string): Promise<void>;
  /**
   * The subject's own attachment array, where it has one.
   *
   * Several schemas shipped with `attachmentIds` or `documentIds` that nothing
   * populated. The document row is the source of truth either way; these are
   * kept in step so the existing detail screens and API responses stop
   * reporting zero attachments for records that have some.
   */
  attachmentField?: string;
  attach?: (
    context: RequestContext,
    subjectId: string,
    documentId: Types.ObjectId,
  ) => Promise<void>;
  detach?: (
    context: RequestContext,
    subjectId: string,
    documentId: Types.ObjectId,
  ) => Promise<void>;
  /** For error messages and audit metadata. */
  label: string;
}

/** A refusal from a subject check must read as "no such document". */
function notFound(): never {
  throw new NotFoundError('Document');
}

async function callerMembershipId(context: RequestContext): Promise<Types.ObjectId | null> {
  const membership = await meService.membership(context).catch(() => null);
  return membership?._id ?? null;
}

function sameMembership(a: Types.ObjectId | null, b: Types.ObjectId | null | undefined): boolean {
  return a !== null && b !== null && b !== undefined && a.equals(b);
}

/**
 * Push or pull the document id on the subject, without failing the operation.
 *
 * The attachment array is a convenience mirror, not the record. If a subject
 * has since been closed or removed the mirror update is a no-op, and that must
 * not fail an upload whose document row was written successfully.
 */
function mirror<TDoc extends TenantDocument>(repository: BaseRepository<TDoc>, field: string) {
  return {
    attachmentField: field,
    attach: async (context: RequestContext, subjectId: string, documentId: Types.ObjectId) => {
      await repository
        .updateById(context, subjectId, { $addToSet: { [field]: documentId } } as UpdateQuery<TDoc>)
        .catch(() => undefined);
    },
    detach: async (context: RequestContext, subjectId: string, documentId: Types.ObjectId) => {
      await repository
        .updateById(context, subjectId, { $pull: { [field]: documentId } } as UpdateQuery<TDoc>)
        .catch(() => undefined);
    },
  };
}

export const SUBJECT_ACCESSORS: Record<DocumentSubjectType, SubjectAccessor> = {
  incident: {
    label: 'incident',
    ...mirror(incidentRepository, 'attachmentIds'),
    async assertReadable(context, subjectId) {
      assertCan(context, PERMISSIONS.INCIDENT_VIEW);

      const incident = await incidentRepository.findById(context, subjectId);
      if (!incident) notFound();
      if (can(context, PERMISSIONS.INCIDENT_VIEW_ALL)) return;

      // Mirrors `incidentService.detailFor`: the reporter and anyone named in
      // the report may follow it; nobody else may.
      const me = await callerMembershipId(context);
      const involved =
        sameMembership(me, incident.reportedByMembershipId) ||
        incident.involvedPersons.some((person) => sameMembership(me, person.membershipId));

      if (!involved) notFound();
    },
  },

  'service-request': {
    label: 'service request',
    ...mirror(serviceRequestRepository, 'attachmentIds'),
    async assertReadable(context, subjectId) {
      assertCan(context, PERMISSIONS.SERVICE_REQUEST_VIEW);

      const request = await serviceRequestRepository.findById(context, subjectId);
      if (!request) notFound();
      if (can(context, PERMISSIONS.SERVICE_REQUEST_VIEW_ALL)) return;

      const me = await callerMembershipId(context);
      const involved =
        sameMembership(me, request.requestedByMembershipId) ||
        sameMembership(me, request.assignedToMembershipId);

      if (!involved) notFound();
    },
  },

  'change-request': {
    label: 'change request',
    ...mirror(changeRequestRepository, 'documentIds'),
    async assertReadable(context, subjectId) {
      assertCan(context, PERMISSIONS.RESIDENT_VIEW);

      const request = await changeRequestRepository.findById(context, subjectId);
      if (!request) notFound();

      // The reviewer sees the evidence, because approving a NIN change without
      // the slip is approving nothing. Otherwise it is the submitter's own.
      if (can(context, PERMISSIONS.RESIDENT_APPROVE)) return;
      if (request.userId.toHexString() !== context.userId) notFound();
    },
  },

  vehicle: {
    label: 'vehicle',
    ...mirror(vehicleRepository, 'documentIds'),
    async assertReadable(context, subjectId) {
      assertCan(context, PERMISSIONS.VEHICLE_VIEW);

      const vehicle = await vehicleRepository.findById(context, subjectId);
      if (!vehicle) notFound();
      if (can(context, PERMISSIONS.VEHICLE_VIEW_ALL) || can(context, PERMISSIONS.VEHICLE_VERIFY)) {
        return;
      }

      if (!sameMembership(await callerMembershipId(context), vehicle.ownerMembershipId)) {
        notFound();
      }
    },
  },

  // No attachment array on the schema; the document row carries the link.
  'exit-pass': {
    label: 'exit pass',
    async assertReadable(context, subjectId) {
      assertCan(context, PERMISSIONS.EXIT_PASS_VIEW);

      const pass = await exitPassRepository.findById(context, subjectId);
      if (!pass) notFound();
      if (
        can(context, PERMISSIONS.EXIT_PASS_APPROVE) ||
        can(context, PERMISSIONS.RESIDENT_VIEW_ALL)
      ) {
        return;
      }

      if (!sameMembership(await callerMembershipId(context), pass.requestedByMembershipId)) {
        notFound();
      }
    },
  },

  resident: {
    label: 'resident',
    async assertReadable(context, subjectId) {
      assertCan(context, PERMISSIONS.RESIDENT_VIEW);

      const membership = await membershipRepository.findById(context, subjectId);
      if (!membership) notFound();

      // `resident.view` is the directory — names and unit numbers. A lease or a
      // NIN slip is not directory data, so the narrow permission is not enough
      // to read another household's file.
      if (can(context, PERMISSIONS.RESIDENT_VIEW_ALL)) return;
      if (membership.userId.toHexString() !== context.userId) notFound();
    },
  },
};

export function accessorFor(subjectType: DocumentSubjectType): SubjectAccessor {
  const accessor = SUBJECT_ACCESSORS[subjectType];
  if (!accessor) notFound();
  return accessor;
}
