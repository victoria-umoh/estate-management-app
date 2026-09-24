/**
 * Gate administration.
 *
 * The property under test is that the gate outlives its own record. Every
 * movement ever recorded names a gate, so removing one is a soft delete — and
 * it is refused mid-shift, because an officer whose next scan fails has no way
 * to know why.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { MovementModel } from '@/modules/movement';
import { GateModel } from './schema';
import { gateRepository, gateService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

function ctx(permissions: string[], estateId = ESTATE_A): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-manager'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const admin = () => ctx(['*']);
const editor = () => ctx([PERMISSIONS.GATE_VIEW, PERMISSIONS.GATE_UPDATE]);
const remover = () => ctx([PERMISSIONS.GATE_VIEW, PERMISSIONS.GATE_DELETE]);

beforeEach(async () => {
  await GateModel.syncIndexes();
});

const makeGate = (code = 'MAIN') =>
  gateService.create(admin(), { name: 'Main Gate', code, direction: 'both' });

describe('updating a gate', () => {
  it('amends the name, direction and operating window', async () => {
    const gate = await makeGate();

    const updated = await gateService.update(editor(), gate._id.toHexString(), {
      name: 'Front Gate',
      direction: 'entry-only',
      opensAt: '06:00',
      closesAt: '22:00',
    });

    expect(updated.name).toBe('Front Gate');
    expect(updated.direction).toBe('entry-only');
    expect(updated.opensAt).toBe('06:00');
  });

  it('closes a gate without removing it, so a barrier under repair stays on file', async () => {
    const gate = await makeGate();

    const updated = await gateService.update(editor(), gate._id.toHexString(), {
      status: 'maintenance',
    });

    expect(updated.status).toBe('maintenance');
    expect(await gateRepository.findById(editor(), gate._id)).not.toBeNull();
  });

  it('uppercases a new code and refuses one already in use', async () => {
    const main = await makeGate('MAIN');
    await makeGate('SIDE');

    const updated = await gateService.update(editor(), main._id.toHexString(), { code: 'rear' });
    expect(updated.code).toBe('REAR');

    await expect(
      gateService.update(editor(), main._id.toHexString(), { code: 'SIDE' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('accepts the gate own code unchanged', async () => {
    const gate = await makeGate('MAIN');

    await expect(
      gateService.update(editor(), gate._id.toHexString(), { code: 'main', name: 'Main' }),
    ).resolves.toMatchObject({ code: 'MAIN', name: 'Main' });
  });

  it('requires gate.update', async () => {
    const gate = await makeGate();

    await expect(
      gateService.update(ctx([PERMISSIONS.GATE_VIEW]), gate._id.toHexString(), { name: 'X' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('treats a gate in another estate as not found', async () => {
    const gate = await makeGate();
    const foreign = ctx([PERMISSIONS.GATE_VIEW, PERMISSIONS.GATE_UPDATE], ESTATE_B);

    await expect(
      gateService.update(foreign, gate._id.toHexString(), { name: 'X' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records the change in the audit trail', async () => {
    const gate = await makeGate();
    await gateService.update(editor(), gate._id.toHexString(), { name: 'Front Gate' });

    expect(await AuditLogModel.countDocuments({ action: 'gate.updated' })).toBe(1);
  });
});

describe('deleting a gate', () => {
  async function recordMovementAt(gateId: string, occurredAt: Date) {
    await MovementModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      gateId: new mongoose.Types.ObjectId(gateId),
      officerId: new mongoose.Types.ObjectId(),
      direction: 'in',
      subject: 'visitor',
      subjectLabel: 'Visitor',
      admitted: true,
      method: 'qr',
      occurredAt,
    });
  }

  it('soft deletes, leaving the row for the movement log to resolve against', async () => {
    const gate = await makeGate();

    await gateService.remove(remover(), gate._id.toHexString(), 'Decommissioned');

    const row = await GateModel.findById(gate._id).lean();
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await gateRepository.findById(remover(), gate._id)).toBeNull();
  });

  it('refuses while the gate has been used today, and says how much', async () => {
    const gate = await makeGate();
    await recordMovementAt(gate._id.toHexString(), new Date());

    await expect(
      gateService.remove(remover(), gate._id.toHexString(), 'Decommissioned'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('1 movement today'),
    });
  });

  it('allows the delete when the last movement was yesterday', async () => {
    const gate = await makeGate();
    const yesterday = new Date(Date.now() - 36 * 3_600_000);
    await recordMovementAt(gate._id.toHexString(), yesterday);

    await expect(
      gateService.remove(remover(), gate._id.toHexString(), 'Decommissioned'),
    ).resolves.toBeUndefined();
  });

  it('frees the code for reuse', async () => {
    const gate = await makeGate('MAIN');
    await gateService.remove(remover(), gate._id.toHexString(), 'Rebuilt');

    await expect(makeGate('MAIN')).resolves.toBeDefined();
  });

  it('requires gate.delete', async () => {
    const gate = await makeGate();

    await expect(
      gateService.remove(editor(), gate._id.toHexString(), 'Decommissioned'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records the reason in the audit trail', async () => {
    const gate = await makeGate();
    await gateService.remove(remover(), gate._id.toHexString(), 'Replaced by the service gate');

    const entry = await AuditLogModel.findOne({ action: 'gate.deleted' }).lean();
    expect(entry?.reason).toBe('Replaced by the service gate');
  });
});
