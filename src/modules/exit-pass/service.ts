import { Types } from 'mongoose';
import { generateShortCode } from '@/core/crypto';
import { BaseRepository, withTransaction, type PaginatedResult } from '@/core/db';
import { events } from '@/core/events';
import { AuthorizationError, ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan, can } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { credentialService } from '@/modules/credential';
import { estateRepository } from '@/modules/estate';
import { membershipRepository } from '@/modules/membership/repository';
import { movementService } from '@/modules/movement';
import { normalisePlate } from '@/modules/vehicle';
import { ExitPassModel, type ExitPassDoc, type ExitPassItem } from './schema';

const log = createLogger('exit-pass');

class ExitPassRepository extends BaseRepository<ExitPassDoc> {
  constructor() {
    super(ExitPassModel);
  }

  findByCode(context: RequestContext, code: string): Promise<ExitPassDoc | null> {
    return this.findOne(context, { code: code.trim().toUpperCase() });
  }

  findAwaitingApproval(context: RequestContext): Promise<ExitPassDoc[]> {
    return this.findMany(context, { status: 'pending' }, { sort: { createdAt: 1 } });
  }
}

export const exitPassRepository = new ExitPassRepository();

export interface CreateExitPassInput {
  /** Resolved from the session by the route, never taken from the body. */
  requestedByMembershipId: string;
  carrierName: string;
  carrierPhone?: string;
  destination: string;
  reason: string;
  vehiclePlate?: string;
  items: ExitPassItem[];
  validFrom?: Date;
  validUntil?: Date;
  notes?: string;
}

export interface ExitPassListFilters {
  status?: ExitPassDoc['status'];
  requestedByMembershipId?: string;
}

/** How long an unapproved or unused exit pass stays good for by default. */
const DEFAULT_VALIDITY_HOURS = 24;
const MAX_VALIDITY_DAYS = 7;

/**
 * Exit (removal) passes.
 *
 * The lifecycle is deliberately narrow: created → approved → used, with
 * rejection and cancellation as the two ways out. Every transition is checked
 * against the current status rather than trusted from the caller, because the
 * one thing this record must never do is authorise a second removal.
 */
export class ExitPassService {
  /**
   * A resident declares what they intend to remove.
   *
   * Whether this needs an approver is read from the estate's
   * `requireExitPassApproval` setting and then SNAPSHOTTED onto the pass, so a
   * later settings change cannot make an unapproved removal look authorised in
   * hindsight.
   */
  async create(
    context: RequestContext,
    input: CreateExitPassInput,
  ): Promise<{ pass: ExitPassDoc; token: string | null }> {
    assertCan(context, PERMISSIONS.EXIT_PASS_CREATE);
    await this.assertMayActFor(context, input.requestedByMembershipId);

    const items = this.validateItems(input.items);

    const validFrom = input.validFrom ?? new Date();
    const validUntil =
      input.validUntil ?? new Date(validFrom.getTime() + DEFAULT_VALIDITY_HOURS * 3_600_000);

    if (validUntil <= validFrom) {
      throw new UnprocessableError('The pass must expire after it becomes valid.');
    }
    if (validUntil.getTime() - validFrom.getTime() > MAX_VALIDITY_DAYS * 86_400_000) {
      throw new UnprocessableError(`An exit pass may not exceed ${MAX_VALIDITY_DAYS} days.`);
    }

    const requester = await membershipRepository.findByIdOrFail(
      context,
      input.requestedByMembershipId,
    );

    const estate = await estateRepository.findById(context.estateId);
    // Default to requiring approval when the estate record cannot be read: the
    // safe failure for "may these goods leave?" is "ask someone".
    const approvalRequired = estate?.settings.requireExitPassApproval ?? true;

    const pass = await exitPassRepository.create(context, {
      code: await this.uniqueCode(context),
      requestedByMembershipId: new Types.ObjectId(input.requestedByMembershipId),
      ...(requester.propertyId ? { propertyId: requester.propertyId } : {}),
      carrierName: input.carrierName.trim(),
      ...(input.carrierPhone ? { carrierPhone: input.carrierPhone } : {}),
      destination: input.destination.trim(),
      reason: input.reason.trim(),
      ...(input.vehiclePlate
        ? {
            vehiclePlate: input.vehiclePlate.toUpperCase(),
            vehiclePlateNormalised: normalisePlate(input.vehiclePlate),
          }
        : {}),
      items,
      validFrom,
      validUntil,
      status: 'pending',
      approvalRequired,
      createdBy: new Types.ObjectId(context.userId),
      ...(input.notes ? { notes: input.notes } : {}),
    });

    await auditService.record(context, {
      action: 'exit_pass.created',
      resource: 'exit_pass',
      resourceId: pass._id,
      metadata: {
        code: pass.code,
        approvalRequired,
        itemCount: items.length,
        totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
      },
    });

    events.emit('exitPass.created', {
      passId: pass._id.toHexString(),
      estateId: context.estateId,
      requestedBy: input.requestedByMembershipId,
      approvalRequired,
    });

    // An estate that does not require approval still gets a pass and a
    // credential — the manifest and the gate record are worth having on their
    // own, and the officer still checks the load against the list.
    if (!approvalRequired) {
      const { pass: activated, token } = await this.activate(context, pass, null);
      return { pass: activated, token };
    }

    return { pass, token: null };
  }

  /**
   * Amend the manifest.
   *
   * Only while the pass is still pending. Once it is valid at the gate the
   * manifest is evidence, and evidence the subject of the check can still edit
   * is not evidence — the same reasoning that makes ledger entries immutable.
   * A mistake after approval is corrected by cancelling and raising a new pass,
   * which leaves both versions in the record.
   */
  async updateManifest(
    context: RequestContext,
    passId: string,
    items: ExitPassItem[],
  ): Promise<ExitPassDoc> {
    assertCan(context, PERMISSIONS.EXIT_PASS_CREATE);

    const pass = await exitPassRepository.findByIdOrFail(context, passId);
    await this.assertMayActFor(context, pass.requestedByMembershipId.toHexString());

    if (pass.manifestLockedAt || pass.status !== 'pending') {
      throw new ConflictError(
        'The manifest cannot be changed once the pass is valid at the gate. Cancel it and raise a new one.',
      );
    }

    const validated = this.validateItems(items);

    const updated = await exitPassRepository.updateById(context, passId, {
      $set: { items: validated },
    });

    await auditService.record(context, {
      action: 'exit_pass.manifest_amended',
      resource: 'exit_pass',
      resourceId: passId,
      before: { items: pass.items },
      after: { items: validated },
    });

    return updated;
  }

  /** An approver authorises the removal. This is what makes the pass usable. */
  async approve(
    context: RequestContext,
    passId: string,
    note?: string,
  ): Promise<{ pass: ExitPassDoc; token: string }> {
    assertCan(context, PERMISSIONS.EXIT_PASS_APPROVE);

    const pass = await exitPassRepository.findByIdOrFail(context, passId);

    if (pass.status !== 'pending') {
      throw new ConflictError(`That exit pass is already ${pass.status}.`);
    }
    if (pass.validUntil.getTime() <= Date.now()) {
      throw new ConflictError('That exit pass has expired. Raise a new one.');
    }

    const { pass: approved, token } = await this.activate(context, pass, note ?? null);
    return { pass: approved, token };
  }

  /** An approver refuses the removal. */
  async reject(context: RequestContext, passId: string, reason: string): Promise<ExitPassDoc> {
    assertCan(context, PERMISSIONS.EXIT_PASS_APPROVE);

    const pass = await exitPassRepository.findByIdOrFail(context, passId);

    if (pass.status !== 'pending') {
      throw new ConflictError(`That exit pass is already ${pass.status}.`);
    }

    const updated = await exitPassRepository.updateById(context, passId, {
      $set: {
        status: 'rejected',
        decisionReason: reason,
        approvedBy: new Types.ObjectId(context.userId),
        approvedAt: new Date(),
      },
    });

    await auditService.record(context, {
      action: 'exit_pass.rejected',
      resource: 'exit_pass',
      resourceId: passId,
      metadata: { code: pass.code, reason },
    });

    return updated;
  }

  /**
   * Withdraw a pass.
   *
   * Open to the requesting household and to anyone who could have approved it.
   * A pass already used cannot be revoked — the goods have gone, and rewriting
   * the record to say otherwise would be the one thing this collection exists
   * to prevent.
   */
  async revoke(context: RequestContext, passId: string, reason?: string): Promise<ExitPassDoc> {
    const pass = await exitPassRepository.findByIdOrFail(context, passId);

    if (!can(context, PERMISSIONS.EXIT_PASS_APPROVE)) {
      assertCan(context, PERMISSIONS.EXIT_PASS_CREATE);
      await this.assertMayActFor(context, pass.requestedByMembershipId.toHexString());
    }

    if (pass.status === 'used') {
      throw new ConflictError('That exit pass has already been used and cannot be revoked.');
    }
    if (pass.status !== 'pending' && pass.status !== 'approved') {
      throw new ConflictError(`That exit pass is already ${pass.status}.`);
    }

    const updated = await exitPassRepository.updateById(context, passId, {
      $set: { status: 'cancelled', decisionReason: reason ?? null },
    });

    if (pass.credentialId) {
      await credentialService.revoke(
        context,
        pass.credentialId.toHexString(),
        reason ?? 'exit pass cancelled',
      );
    }

    await auditService.record(context, {
      action: 'exit_pass.cancelled',
      resource: 'exit_pass',
      resourceId: passId,
      metadata: { code: pass.code, ...(reason ? { reason } : {}) },
    });

    return updated;
  }

  /**
   * What the officer sees at the barrier.
   *
   * Read-only, and it always answers — an unusable pass returns `usable: false`
   * with the manifest still attached, because the officer needs to see what was
   * declared even when they are about to refuse it.
   */
  async verifyAtGate(
    context: RequestContext,
    code: string,
  ): Promise<{
    usable: boolean;
    message: string;
    pass: ExitPassDoc | null;
  }> {
    assertCan(context, PERMISSIONS.EXIT_PASS_VERIFY);

    const pass = await exitPassRepository.findByCode(context, code);

    if (!pass) {
      return { usable: false, message: 'Exit pass not recognised.', pass: null };
    }
    if (pass.status === 'used') {
      return { usable: false, message: 'This exit pass has already been used.', pass };
    }
    if (pass.status === 'pending') {
      return { usable: false, message: 'This exit pass has not been approved.', pass };
    }
    if (pass.status !== 'approved') {
      return { usable: false, message: `This exit pass is ${pass.status}.`, pass };
    }

    const now = Date.now();
    if (pass.validFrom.getTime() > now) {
      return { usable: false, message: 'This exit pass is not valid yet.', pass };
    }
    if (pass.validUntil.getTime() <= now) {
      return { usable: false, message: 'This exit pass has expired.', pass };
    }

    return {
      usable: true,
      message: 'Check the load against the manifest, then close the pass.',
      pass,
    };
  }

  /**
   * The goods have left. Close the pass.
   *
   * This is the single-use point, and it is enforced by re-reading the status
   * rather than by trusting the caller: two officers scanning the same code at
   * two gates must not both succeed.
   */
  async close(
    context: RequestContext,
    passId: string,
    input: { gateId: string; notes?: string },
  ): Promise<ExitPassDoc> {
    assertCan(context, PERMISSIONS.EXIT_PASS_CLOSE);

    const pass = await exitPassRepository.findByIdOrFail(context, passId);

    if (pass.status === 'used') {
      throw new ConflictError('That exit pass has already been used.');
    }
    if (pass.status !== 'approved') {
      throw new ConflictError(`That exit pass is ${pass.status} and cannot be used.`);
    }
    if (pass.validUntil.getTime() <= Date.now()) {
      throw new ConflictError('That exit pass has expired.');
    }

    // Conditional on the status we just read, so a concurrent close loses the
    // race rather than producing a second exit against one authorisation.
    const updated = await exitPassRepository.updateOne(
      context,
      { _id: pass._id, status: 'approved' },
      {
        $set: {
          status: 'used',
          usedAt: new Date(),
          usedGateId: new Types.ObjectId(input.gateId),
          usedBy: new Types.ObjectId(context.userId),
        },
      },
    );

    if (!updated) {
      throw new ConflictError('That exit pass has already been used.');
    }

    const itemSummary = pass.items
      .map((item) => `${item.quantity} × ${item.description}`)
      .join('; ');

    await movementService.record(context, {
      gateId: input.gateId,
      direction: 'out',
      subject: 'exit-pass',
      subjectId: pass._id.toHexString(),
      ...(pass.credentialId ? { credentialId: pass.credentialId.toHexString() } : {}),
      subjectLabel: pass.carrierName,
      vehiclePlate: pass.vehiclePlate ?? null,
      admitted: true,
      method: 'code',
      // The manifest is copied into the gate log for the same reason the log
      // copies a visitor's name: the record of what left must survive the pass.
      notes: [`Removal: ${itemSummary}`, input.notes].filter(Boolean).join(' — ').slice(0, 1000),
    });

    // The pass is spent. Revoking stops the QR working for a second load.
    if (pass.credentialId) {
      await credentialService
        .revoke(context, pass.credentialId.toHexString(), 'exit pass used')
        .catch((error: unknown) => {
          log.error({ err: error, passId }, 'failed to revoke credential on exit pass close');
        });
    }

    await auditService.record(context, {
      action: 'exit_pass.used',
      resource: 'exit_pass',
      resourceId: passId,
      metadata: { code: pass.code, gateId: input.gateId, items: itemSummary },
    });

    events.emit('exitPass.used', {
      passId: pass._id.toHexString(),
      estateId: context.estateId,
      gateId: input.gateId,
    });

    return updated;
  }

  /**
   * List passes.
   *
   * Residents hold `exitPass.view` for their own passes, so the permission
   * alone cannot separate them from staff. Anyone who cannot approve sees only
   * their own household's passes, whatever they ask for.
   */
  async list(
    context: RequestContext,
    filters: ExitPassListFilters,
    callerMembershipId: string,
    pagination: { page?: number; limit?: number } = {},
  ): Promise<PaginatedResult<ExitPassDoc>> {
    assertCan(context, PERMISSIONS.EXIT_PASS_VIEW);

    const isStaff = can(context, PERMISSIONS.EXIT_PASS_APPROVE);

    const filter: Record<string, unknown> = {};
    if (filters.status) filter.status = filters.status;

    if (isStaff) {
      if (filters.requestedByMembershipId) {
        filter.requestedByMembershipId = new Types.ObjectId(filters.requestedByMembershipId);
      }
    } else {
      filter.requestedByMembershipId = new Types.ObjectId(callerMembershipId);
    }

    return exitPassRepository.paginate(context, filter, pagination, { sort: { createdAt: -1 } });
  }

  /** Close the window on approved passes nobody used. */
  async expireLapsed(context: RequestContext): Promise<number> {
    return exitPassRepository.updateMany(
      context,
      { status: { $in: ['pending', 'approved'] }, validUntil: { $lte: new Date() } },
      { $set: { status: 'expired' } },
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Make a pass valid at the gate: issue the credential and lock the manifest.
   *
   * Both happen in one transaction because a credential that opens a gate
   * against an editable manifest is worse than no pass at all.
   */
  private async activate(
    context: RequestContext,
    pass: ExitPassDoc,
    note: string | null,
  ): Promise<{ pass: ExitPassDoc; token: string }> {
    return withTransaction(async (session) => {
      const { token, credential } = await credentialService.issue(context, {
        subject: 'exit-pass',
        subjectId: pass._id.toHexString(),
        display: {
          primaryLabel: pass.carrierName,
          secondaryLabel: `Removal → ${pass.destination}`,
          unitNumber: null,
          category: `Exit pass · ${pass.items.length} item${pass.items.length === 1 ? '' : 's'}`,
          photoUrl: null,
        },
        validFrom: pass.validFrom,
        validUntil: pass.validUntil,
      });

      const updated = await exitPassRepository.updateById(
        context,
        pass._id,
        {
          $set: {
            status: 'approved',
            credentialId: credential._id,
            manifestLockedAt: new Date(),
            approvedBy: new Types.ObjectId(context.userId),
            approvedAt: new Date(),
            decisionReason: note,
          },
        },
        { session },
      );

      await auditService.record(context, {
        action: 'exit_pass.approved',
        resource: 'exit_pass',
        resourceId: pass._id,
        metadata: {
          code: pass.code,
          approvalRequired: pass.approvalRequired,
          itemCount: pass.items.length,
        },
        session,
      });

      events.emit('exitPass.approved', {
        passId: pass._id.toHexString(),
        estateId: context.estateId,
        approvedBy: context.userId,
      });

      return { pass: updated, token };
    });
  }

  /**
   * A manifest with nothing on it authorises anything.
   *
   * Rejected rather than defaulted, because "1 item" invented by the server is
   * exactly the entry an officer cannot check a load against.
   */
  private validateItems(items: ExitPassItem[]): ExitPassItem[] {
    if (!items || items.length === 0) {
      throw new UnprocessableError('An exit pass must list at least one item.');
    }
    if (items.length > 100) {
      throw new UnprocessableError('An exit pass may not list more than 100 items.');
    }

    return items.map((item) => {
      const description = item.description?.trim() ?? '';
      if (description.length < 2) {
        throw new UnprocessableError('Every item needs a description.');
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new UnprocessableError('Every item needs a whole quantity of at least one.');
      }

      return {
        quantity: item.quantity,
        description,
        identifyingMark: item.identifyingMark?.trim() || null,
        estimatedValue: item.estimatedValue ?? null,
      };
    });
  }

  /** A resident acts for their own household; staff act for anyone. */
  private async assertMayActFor(context: RequestContext, membershipId: string): Promise<void> {
    if (can(context, PERMISSIONS.EXIT_PASS_APPROVE) || can(context, PERMISSIONS.RESIDENT_UPDATE)) {
      return;
    }

    const membership = await membershipRepository.findByIdOrFail(context, membershipId);
    if (membership.userId.toHexString() !== context.userId) {
      throw new AuthorizationError('You can only raise exit passes for your own household.');
    }
  }

  /** Retry on collision rather than trusting six characters to never repeat. */
  private async uniqueCode(context: RequestContext): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateShortCode();
      if (!(await exitPassRepository.findByCode(context, code))) return code;
    }

    throw new ConflictError('Could not allocate an exit pass code. Please try again.');
  }
}

export const exitPassService = new ExitPassService();
