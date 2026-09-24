import type { ClientSession } from 'mongoose';
import { config } from '@/core/config';
import { withOptionalTransaction } from '@/core/db';
import { AuthorizationError, ConflictError, NotFoundError } from '@/core/errors';
import { createLogger } from '@/core/logging';
import { PERMISSIONS, assertCan } from '@/core/rbac';
import { systemContext, type RequestContext } from '@/core/tenancy';
import { auditService } from '@/modules/audit';
import { roleService } from '@/modules/role';
import { estateRepository } from './repository';
import type { EstateDoc } from './schema';
import { TRIAL_DAYS } from '@/core/entitlements';

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
   * All of it happens in ONE transaction — the estate document, its system
   * roles and the audit line. An estate without roles has no chairman, no
   * security officers and no way to admit anyone: it exists but is unusable,
   * and the failure surfaces later as a confusing permissions problem rather
   * than as a failed signup. Role seeding used to run after the transaction
   * committed, which left exactly that window open.
   *
   * A caller may pass its own `session` to make this one step of a larger
   * atomic operation — self-serve signup does, so that the estate and the
   * chairman who owns it can never exist without each other.
   */
  async create(
    input: CreateEstateInput,
    options: { session?: ClientSession } = {},
  ): Promise<EstateDoc> {
    const slug = input.slug.toLowerCase().trim();

    if (await estateRepository.findBySlug(slug)) {
      throw new ConflictError(`An estate with the identifier "${slug}" already exists.`);
    }

    return withOptionalTransaction(options.session, async (session) => {
      const estate = await estateRepository.create(
        {
          name: input.name.trim(),
          slug,
          address: input.address,
          contact: input.contact,
          status: 'trial',
          // Set at creation rather than by a later call, so there is no window
          // in which an estate exists on a trial that never ends.
          trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
          settings: {
            visitorOverstayGraceMinutes: config.visitors.overstayGraceMinutes,
            visitorPassMaxDurationDays: 7,
            requireResidentApproval: true,
            requireNinVerification: config.identity.requireNinVerification,
            requireExitPassApproval: true,
            temporaryPassMaxDurationDays: 30,
            allowLandlordTenantRegistration: true,
            idCardExpiryWarningDays: 30,
            currency: config.payments.defaultCurrency,
            timezone: 'Africa/Lagos',
          },
          stats: { propertyCount: 0, residentCount: 0, vehicleCount: 0 },
        },
        { session },
      );

      await roleService.seedSystemRoles(estate._id.toHexString(), { session });

      await auditService.record(systemContext(estate._id.toHexString()), {
        action: 'estate.created',
        resource: 'estate',
        resourceId: estate._id,
        after: { name: estate.name, slug: estate.slug },
        session,
      });

      log.info({ estateId: estate._id.toHexString(), slug }, 'estate created');
      return estate;
    });
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
