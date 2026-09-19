import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { RoleModel } from '@/modules/role';
import { estateRepository } from './repository';
import { EstateModel } from './schema';
import { estateService } from './service';

setupTestDatabase();

const validEstate = {
  name: 'Palm Grove Estate',
  slug: 'palm-grove',
  address: {
    line1: '1 Palm Avenue',
    city: 'Lekki',
    state: 'Lagos',
    country: 'Nigeria',
  },
  contact: { email: 'admin@palmgrove.example', phone: '+2348012345678' },
};

function ctx(
  estateId: string,
  permissions: string[] = ['*'],
  isPlatformAdmin = false,
): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['estate-chairman'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin,
  };
}

beforeEach(async () => {
  await EstateModel.syncIndexes();
  await RoleModel.syncIndexes();
});

describe('creating an estate', () => {
  it('creates it on a trial with sensible defaults', async () => {
    const estate = await estateService.create(validEstate);

    expect(estate.status).toBe('trial');
    expect(estate.settings.requireResidentApproval).toBe(true);
    expect(estate.settings.currency).toBe('NGN');
    expect(estate.stats.propertyCount).toBe(0);
  });

  // An estate without roles has no chairman, no officers and no way to admit
  // anyone. It would exist but be unusable.
  it('seeds every system role', async () => {
    const estate = await estateService.create(validEstate);
    expect(await RoleModel.countDocuments({ estateId: estate._id })).toBe(11);
  });

  it('rejects a duplicate slug', async () => {
    await estateService.create(validEstate);
    await expect(estateService.create(validEstate)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('normalises the slug', async () => {
    const estate = await estateService.create({ ...validEstate, slug: '  Palm-Grove  ' });
    expect(estate.slug).toBe('palm-grove');
  });

  it('records creation in the audit trail', async () => {
    await estateService.create(validEstate);
    expect(await AuditLogModel.countDocuments({ action: 'estate.created' })).toBe(1);
  });

  it('finds an estate by slug', async () => {
    await estateService.create(validEstate);
    expect((await estateRepository.findBySlug('palm-grove'))?.name).toBe('Palm Grove Estate');
  });
});

describe('settings', () => {
  // These decide when security is alerted and who gets through the gate, so
  // each change is audited with its before and after.
  it('updates settings and records the change', async () => {
    const estate = await estateService.create(validEstate);
    const context = ctx(estate._id.toHexString());

    const updated = await estateService.updateSettings(context, {
      visitorOverstayGraceMinutes: 30,
      requireExitPassApproval: false,
    });

    expect(updated.settings.visitorOverstayGraceMinutes).toBe(30);
    expect(updated.settings.requireExitPassApproval).toBe(false);
    // Untouched settings survive a partial update.
    expect(updated.settings.requireResidentApproval).toBe(true);

    const entry = await AuditLogModel.findOne({ action: 'estate.settings_updated' }).lean();
    expect(entry?.changes?.map((c) => c.field)).toEqual(
      expect.arrayContaining(['visitorOverstayGraceMinutes', 'requireExitPassApproval']),
    );
  });

  it('requires estate.settingsManage', async () => {
    const estate = await estateService.create(validEstate);

    await expect(
      estateService.updateSettings(ctx(estate._id.toHexString(), [PERMISSIONS.ESTATE_VIEW]), {
        visitorOverstayGraceMinutes: 30,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('tenant isolation', () => {
  it('returns only the caller own estate', async () => {
    const a = await estateService.create(validEstate);
    const b = await estateService.create({ ...validEstate, slug: 'other-estate' });

    const fromA = await estateService.getCurrent(ctx(a._id.toHexString()));
    expect(fromA._id.toHexString()).toBe(a._id.toHexString());
    expect(fromA._id.toHexString()).not.toBe(b._id.toHexString());
  });

  it('scopes settings updates to the caller own estate', async () => {
    const a = await estateService.create(validEstate);
    const b = await estateService.create({ ...validEstate, slug: 'other-estate' });

    await estateService.updateSettings(ctx(a._id.toHexString()), {
      visitorOverstayGraceMinutes: 15,
    });

    const untouched = await estateRepository.findById(b._id);
    expect(untouched?.settings.visitorOverstayGraceMinutes).toBe(60);
  });
});

describe('cross-estate listing', () => {
  // Requires both the platform flag and the permission, so a mis-seeded role
  // alone cannot open this door.
  it('requires the platform flag as well as the permission', async () => {
    const estate = await estateService.create(validEstate);
    const id = estate._id.toHexString();

    await expect(
      estateService.listAll(ctx(id, [PERMISSIONS.PLATFORM_ESTATE_VIEW], false)),
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(estateService.listAll(ctx(id, [], true))).rejects.toMatchObject({
      statusCode: 403,
    });

    await expect(
      estateService.listAll(ctx(id, [PERMISSIONS.PLATFORM_ESTATE_VIEW], true)),
    ).resolves.toHaveLength(1);
  });
});
