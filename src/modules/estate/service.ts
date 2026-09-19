import { config } from '@/core/config';
import { withTransaction } from '@/core/db';
import { AuthorizationError, ConflictError, NotFoundError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { roleService } from '@/modules/role';
import { estateRepository } from './repository';
import type { EstateDoc } from './schema';

const log = createLogger('estate');

export interface CreateEstateInput {
  name: string;
  slug: string;
  address: EstateDoc['address'];
  contact: EstateDoc['contact'];
}

export class EstateService {
  /**
   * Register a new estate and seed its roles.
   *
   * Both happen in one transaction: an estate without roles has no chairman, no
   * security officers and no way to admit anyone — it would exist but be
   * unusable, and the failure would surface later as a confusing permissions
   * problem rather than as a failed signup.
   */
  async create(input: CreateEstateInput): Promise<EstateDoc> {
    const slug = input.slug.toLowerCase().trim();

    if (await estateRepository.findBySlug(slug)) {
      throw new ConflictError(`An estate with the identifier "${slug}" already exists.`);
    }

    const estate = await withTransaction(async (session) =>
      estateRepository.create(
        {
          name: input.name.trim(),
          slug,
          address: input.address,
          contact: input.contact,
          status: 'trial',
          settings: {
            visitorOverstayGraceMinutes: config.visitors.overstayGraceMinutes,
            visitorPassMaxDurationDays: 7,
            requireResidentApproval: true,
            requireNinVerification: config.identity.requireNinVerification,
            requireExitPassApproval: true,
            allowLandlordTenantRegistration: true,
            idCardExpiryWarningDays: 30,
            currency: config.payments.defaultCurrency,
            timezone: 'Africa/Lagos',
          },
          stats: { propertyCount: 0, residentCount: 0, vehicleCount: 0 },
        },
        { session },
      ),
    );

    // Seeded outside the transaction above because role seeding is itself
    // transactional and idempotent; a retry is safe and cheap.
    await roleService.seedSystemRoles(estate._id.toHexString());

    await auditService.record(systemContext(estate._id.toHexString()), {
      action: 'estate.created',
      resource: 'estate',
      resourceId: estate._id,
      after: { name: estate.name, slug: estate.slug },
    });

    log.info({ estateId: estate._id.toHexString(), slug }, 'estate created');
    return estate;
  }

  /** The caller's own estate. */
  async getCurrent(context: RequestContext): Promise<EstateDoc> {
    const estate = await estateRepository.findById(context.estateId);
    if (!estate || estate.deletedAt) throw new NotFoundError('Estate');
    return estate;
  }

  /**
   * Update operational settings.
   *
   * These change how the platform behaves — the overstay grace period decides
   * when security is alerted, and approval flags decide who gets through the
   * gate — so every change is audited with its before and after.
   */
  async updateSettings(
    context: RequestContext,
    settings: Partial<EstateDoc['settings']>,
  ): Promise<EstateDoc> {
    assertCan(context, PERMISSIONS.ESTATE_SETTINGS_MANAGE);

    const before = await this.getCurrent(context);

    const updated = await estateRepository.updateById(context.estateId, {
      $set: Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [`settings.${key}`, value]),
      ),
    });

    await auditService.record(context, {
      action: 'estate.settings_updated',
      resource: 'estate',
      resourceId: context.estateId,
      before: before.settings as unknown as Record<string, unknown>,
      after: updated.settings as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async updateProfile(
    context: RequestContext,
    input: Partial<Pick<EstateDoc, 'name' | 'address' | 'contact' | 'logoUrl'>>,
  ): Promise<EstateDoc> {
    assertCan(context, PERMISSIONS.ESTATE_UPDATE);

    const before = await this.getCurrent(context);
    const updated = await estateRepository.updateById(context.estateId, { $set: input });

    await auditService.record(context, {
      action: 'estate.updated',
      resource: 'estate',
      resourceId: context.estateId,
      before: { name: before.name, contact: before.contact },
      after: { name: updated.name, contact: updated.contact },
    });

    return updated;
  }

  /**
   * Cross-estate listing, for platform staff.
   *
   * Requires both the platform flag and the permission, so a mis-seeded role
   * alone cannot open this.
   */
  async listAll(context: RequestContext): Promise<EstateDoc[]> {
    if (!context.isPlatformAdmin) {
      throw new AuthorizationError('This action is restricted to platform administrators.');
    }
    assertCan(context, PERMISSIONS.PLATFORM_ESTATE_VIEW);

    return estateRepository.findMany({ deletedAt: null }, { sort: { createdAt: -1 } });
  }
}

export const estateService = new EstateService();
