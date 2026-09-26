import { BaseRepository } from '@/core/db';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { verifyScan, type ScanResult } from '@/modules/credential';
import { movementRepository, movementService } from '@/modules/movement';
import { visitorService, visitorPassRepository } from '@/modules/visitor';
import { GateModel, type GateDoc } from './schema';

const log = createLogger('gate');

class GateRepository extends BaseRepository<GateDoc> {
  constructor() {
    super(GateModel);
  }

  findByCode(context: RequestContext, code: string): Promise<GateDoc | null> {
    return this.findOne(context, { code: code.trim().toUpperCase() });
  }
}

export const gateRepository = new GateRepository();

export interface UpdateGateInput {
  name?: string;
  code?: string;
  description?: string | null;
  direction?: GateDoc['direction'];
  status?: GateDoc['status'];
  opensAt?: string | null;
  closesAt?: string | null;
}

export interface ProcessScanInput {
  token: string;
  gateId: string;
  direction: 'in' | 'out';
  /** Party actually present, when it differs from the pass. */
  partySize?: number;
  notes?: string;
}

export interface ProcessScanResult extends ScanResult {
  movementId?: string;
  /** Set when a visitor pass changed state as a result. */
  passStatus?: string;
}

/**
 * Gate operations.
 *
 * `processScan` is the officer's whole interaction: verify, decide, record. It
 * always writes a movement — including for a denial — because the denials are
 * what an investigation is usually looking for, and an officer cannot be
 * expected to log them separately while someone is arguing at the barrier.
 */
export class GateService {
  async create(
    context: RequestContext,
    input: { name: string; code: string; description?: string; direction?: GateDoc['direction'] },
  ): Promise<GateDoc> {
    assertCan(context, PERMISSIONS.GATE_CREATE);

    if (await gateRepository.findByCode(context, input.code)) {
      throw new ConflictError(`A gate with the code ${input.code.toUpperCase()} already exists.`);
    }

    const gate = await gateRepository.create(context, {
      name: input.name.trim(),
      code: input.code.trim().toUpperCase(),
      ...(input.description ? { description: input.description } : {}),
      direction: input.direction ?? 'both',
      status: 'open',
      assignedOfficerIds: [],
      devices: [],
    });

    await auditService.record(context, {
      action: 'gate.created',
      resource: 'gate',
      resourceId: gate._id,
      after: { name: gate.name, code: gate.code },
    });

    return gate;
  }

  /**
   * Amend a gate.
   *
   * The code is what the officer's screen shows and what every movement was
   * recorded against, so a change to it is checked for a clash the same way
   * creation is. Closing a gate here is deliberate and permitted: a barrier
   * under repair must be closable without deleting it.
   */
  async update(context: RequestContext, gateId: string, input: UpdateGateInput): Promise<GateDoc> {
    assertCan(context, PERMISSIONS.GATE_UPDATE);

    const gate = await gateRepository.findByIdOrFail(context, gateId);

    const changes: Record<string, unknown> = {};

    if (input.name !== undefined) changes.name = input.name.trim();
    if (input.description !== undefined) changes.description = input.description?.trim() ?? null;
    if (input.direction !== undefined) changes.direction = input.direction;
    if (input.status !== undefined) changes.status = input.status;
    if (input.opensAt !== undefined) changes.opensAt = input.opensAt;
    if (input.closesAt !== undefined) changes.closesAt = input.closesAt;

    if (input.code !== undefined) {
      const code = input.code.trim().toUpperCase();

      if (code !== gate.code) {
        const clash = await gateRepository.findByCode(context, code);
        if (clash) throw new ConflictError(`A gate with the code ${code} already exists.`);
        changes.code = code;
      }
    }

    if (Object.keys(changes).length === 0) return gate;

    const updated = await gateRepository.updateById(context, gateId, { $set: changes });

    await auditService.record(context, {
      action: 'gate.updated',
      resource: 'gate',
      resourceId: gateId,
      before: { name: gate.name, code: gate.code, status: gate.status, direction: gate.direction },
      after: {
        name: updated.name,
        code: updated.code,
        status: updated.status,
        direction: updated.direction,
      },
    });

    return updated;
  }

  /**
   * Remove a gate.
   *
   * A soft delete, because every movement ever recorded names a gate and the
   * log has to keep resolving. Refused while the gate has been used today: the
   * officers on that shift are still scanning at it, and removing it mid-shift
   * turns the next scan into an error nobody at the barrier can explain. A gate
   * being decommissioned is closed first, then removed tomorrow.
   */
  async remove(context: RequestContext, gateId: string, reason: string): Promise<void> {
    assertCan(context, PERMISSIONS.GATE_DELETE);

    const gate = await gateRepository.findByIdOrFail(context, gateId);

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const today = await movementRepository.countSince(context, gateId, since);
    if (today > 0) {
      throw new ConflictError(
        `Gate ${gate.code} has recorded ${today} movement${today === 1 ? '' : 's'} today. Close it and remove it once the shift has ended.`,
      );
    }

    await gateRepository.softDelete(context, gateId);

    await auditService.record(context, {
      action: 'gate.deleted',
      resource: 'gate',
      resourceId: gateId,
      reason,
      before: { name: gate.name, code: gate.code, status: gate.status },
    });

    log.info({ gateId, code: gate.code }, 'gate removed');
  }

  /**
   * Verify a scan and record the outcome.
   *
   * The movement is written whatever the decision, so the log reflects what
   * actually happened at the barrier rather than only the successes.
   */
  async processScan(context: RequestContext, input: ProcessScanInput): Promise<ProcessScanResult> {
    assertCan(context, PERMISSIONS.GATE_OPERATE);

    const gate = await gateRepository.findByIdOrFail(context, input.gateId);

    if (gate.status !== 'open') {
      throw new UnprocessableError(`Gate ${gate.code} is currently ${gate.status}.`);
    }
    if (
      (gate.direction === 'entry-only' && input.direction === 'out') ||
      (gate.direction === 'exit-only' && input.direction === 'in')
    ) {
      throw new UnprocessableError(`Gate ${gate.code} is ${gate.direction}.`);
    }

    const result = await verifyScan(input.token, context.estateId);

    // --- Denied ---------------------------------------------------------------
    if (!result.admitted || !result.credential) {
      const movement = await movementService.record(context, {
        gateId: input.gateId,
        direction: input.direction,
        subject: 'visitor',
        subjectLabel: result.credential?.display.primaryLabel ?? 'Unrecognised pass',
        admitted: false,
        denialReason: result.reason ?? 'unknown',
        method: 'qr',
        ...(input.notes ? { notes: input.notes } : {}),
      });

      log.warn(
        { gate: gate.code, reason: result.reason, officerId: context.userId },
        'entry denied',
      );

      return { ...result, movementId: movement._id.toHexString() };
    }

    // --- Admitted -------------------------------------------------------------
    const credential = result.credential;

    const movement = await movementService.record(context, {
      gateId: input.gateId,
      direction: input.direction,
      subject: credential.subject,
      subjectId: credential.subjectId,
      credentialId: credential.credentialId,
      subjectLabel: credential.display.primaryLabel,
      unitNumber: credential.display.unitNumber ?? null,
      vehiclePlate: credential.subject === 'vehicle' ? credential.display.primaryLabel : null,
      admitted: true,
      method: 'qr',
      ...(input.partySize ? { partySize: input.partySize } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });

    // Visitor passes carry presence state, so the dashboard can answer "who is
    // inside" without replaying the whole log.
    let passStatus: string | undefined;

    if (credential.subject === 'visitor' || credential.subject === 'temporary-pass') {
      const pass =
        input.direction === 'in'
          ? await visitorService.checkIn(context, credential.subjectId, input.gateId)
          : await visitorService.checkOut(context, credential.subjectId, input.gateId);

      passStatus = pass.status;
    }

    return {
      ...result,
      movementId: movement._id.toHexString(),
      ...(passStatus ? { passStatus } : {}),
    };
  }

  /**
   * Admit someone by their short code, when a QR will not scan.
   *
   * A dirty windscreen, a cracked phone, a guest who never received the
   * message. The code is checked against the pass rather than the credential,
   * so this path deliberately does not require a working token.
   */
  async admitByCode(
    context: RequestContext,
    input: { code: string; gateId: string; direction: 'in' | 'out'; notes?: string },
  ): Promise<ProcessScanResult> {
    assertCan(context, PERMISSIONS.GATE_OPERATE);

    const pass = await visitorPassRepository.findByCode(context, input.code);

    if (!pass) {
      const movement = await movementService.record(context, {
        gateId: input.gateId,
        direction: input.direction,
        subject: 'visitor',
        subjectLabel: `Code ${input.code.toUpperCase()}`,
        admitted: false,
        denialReason: 'unknown-credential',
        method: 'code',
      });

      return {
        admitted: false,
        reason: 'unknown-credential',
        message: 'Pass not recognised.',
        movementId: movement._id.toHexString(),
      };
    }

    const now = Date.now();
    const usable =
      (input.direction === 'in' && pass.status === 'pending') ||
      (input.direction === 'out' && pass.status === 'inside');

    if (!usable || pass.expectedDeparture.getTime() <= now) {
      const movement = await movementService.record(context, {
        gateId: input.gateId,
        direction: input.direction,
        subject: 'visitor',
        subjectId: pass._id.toHexString(),
        subjectLabel: pass.visitorName,
        admitted: false,
        denialReason: pass.status === 'inside' ? 'already-inside' : pass.status,
        method: 'code',
      });

      return {
        admitted: false,
        reason: 'window-closed',
        message: `This pass is ${pass.status}.`,
        movementId: movement._id.toHexString(),
      };
    }

    const movement = await movementService.record(context, {
      gateId: input.gateId,
      direction: input.direction,
      subject: 'visitor',
      subjectId: pass._id.toHexString(),
      credentialId: pass.credentialId?.toHexString(),
      subjectLabel: pass.visitorName,
      admitted: true,
      method: 'code',
      partySize: pass.partySize,
      ...(input.notes ? { notes: input.notes } : {}),
    });

    const updated =
      input.direction === 'in'
        ? await visitorService.checkIn(context, pass._id.toHexString(), input.gateId)
        : await visitorService.checkOut(context, pass._id.toHexString(), input.gateId);

    return {
      admitted: true,
      message: 'Admit.',
      movementId: movement._id.toHexString(),
      passStatus: updated.status,
      credential: {
        credentialId: pass.credentialId?.toHexString() ?? '',
        subject: 'visitor',
        subjectId: pass._id.toHexString(),
        display: {
          primaryLabel: pass.visitorName,
          secondaryLabel: pass.purpose,
          unitNumber: null,
          category: `Visitor · party of ${pass.partySize}`,
          photoUrl: null,
        },
        validUntil: pass.expectedDeparture,
      },
    };
  }

  /** Record a denial the officer made on their own judgement. */
  async recordManualDenial(
    context: RequestContext,
    input: {
      gateId: string;
      label: string;
      reason: string;
      notes?: string;
      /** Defaults to entry, the common case; an exit refusal is a held item or person. */
      direction?: 'in' | 'out';
    },
  ): Promise<void> {
    assertCan(context, PERMISSIONS.GATE_OPERATE);
    const direction = input.direction ?? 'in';

    await movementService.record(context, {
      gateId: input.gateId,
      direction,
      subject: 'visitor',
      subjectLabel: input.label,
      admitted: false,
      denialReason: input.reason,
      method: 'manual',
      ...(input.notes ? { notes: input.notes } : {}),
    });

    await auditService.record(context, {
      action: direction === 'in' ? 'gate.entry_denied' : 'gate.exit_denied',
      resource: 'gate',
      resourceId: input.gateId,
      metadata: { label: input.label, reason: input.reason },
    });
  }

  async list(context: RequestContext): Promise<GateDoc[]> {
    assertCan(context, PERMISSIONS.GATE_VIEW);
    return gateRepository.findMany(context, {}, { sort: { code: 1 } });
  }
}

export const gateService = new GateService();
