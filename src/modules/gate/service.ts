import { BaseRepository } from '@/core/db';
import { ConflictError, UnprocessableError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { verifyScan, type ScanResult } from '@/modules/credential';
import { movementService } from '@/modules/movement';
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
    input: { gateId: string; label: string; reason: string; notes?: string },
  ): Promise<void> {
    assertCan(context, PERMISSIONS.GATE_OPERATE);

    await movementService.record(context, {
      gateId: input.gateId,
      direction: 'in',
      subject: 'visitor',
      subjectLabel: input.label,
      admitted: false,
      denialReason: input.reason,
      method: 'manual',
      ...(input.notes ? { notes: input.notes } : {}),
    });

    await auditService.record(context, {
      action: 'gate.entry_denied',
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
