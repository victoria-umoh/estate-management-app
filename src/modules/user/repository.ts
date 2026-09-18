import { PlatformRepository } from '@/core/db';
import { blindIndex } from '@/core/crypto';
import { UserModel, type UserDoc } from './schema';

/**
 * User accounts.
 *
 * Extends PlatformRepository because users are global — see the note there.
 * Lookups go through blind indexes rather than raw values, so the query itself
 * never carries a readable NIN or an un-normalised phone number.
 */
export class UserRepository extends PlatformRepository<UserDoc> {
  constructor() {
    super(UserModel);
  }

  findByEmail(email: string): Promise<UserDoc | null> {
    return this.findOne({ emailIndex: blindIndex(email, 'email'), deletedAt: null });
  }

  findByPhone(phone: string): Promise<UserDoc | null> {
    return this.findOne({ phoneIndex: blindIndex(phone, 'phone'), deletedAt: null });
  }

  findByNin(nin: string): Promise<UserDoc | null> {
    return this.findOne({ ninIndex: blindIndex(nin, 'nin'), deletedAt: null });
  }

  /**
   * Fetch a user together with the fields marked `select: false`.
   *
   * Used only by the login and 2FA paths. Everywhere else the defaults apply,
   * so a password hash cannot reach a response by accident.
   */
  findByEmailWithSecrets(email: string): Promise<UserDoc | null> {
    return this.findOne(
      { emailIndex: blindIndex(email, 'email'), deletedAt: null },
      { select: '+passwordHash +twoFactorSecret +twoFactorBackupCodes' },
    );
  }

  findByIdWithSecrets(id: string): Promise<UserDoc | null> {
    return this.findById(id, { select: '+passwordHash +twoFactorSecret +twoFactorBackupCodes' });
  }

  /**
   * Find any account already using one of these identifiers.
   *
   * A single query across all three indexes, so registration can report the
   * specific clash rather than a generic failure.
   */
  async findDuplicate(identifiers: {
    email?: string;
    phone?: string;
    nin?: string;
  }): Promise<{ user: UserDoc; field: 'email' | 'phone' | 'nin' } | null> {
    const clauses: Array<Record<string, string>> = [];

    if (identifiers.email) clauses.push({ emailIndex: blindIndex(identifiers.email, 'email') });
    if (identifiers.phone) clauses.push({ phoneIndex: blindIndex(identifiers.phone, 'phone') });
    if (identifiers.nin) clauses.push({ ninIndex: blindIndex(identifiers.nin, 'nin') });

    if (clauses.length === 0) return null;

    const user = await this.findOne({ $or: clauses, deletedAt: null });
    if (!user) return null;

    if (identifiers.email && user.emailIndex === blindIndex(identifiers.email, 'email')) {
      return { user, field: 'email' };
    }
    if (identifiers.phone && user.phoneIndex === blindIndex(identifiers.phone, 'phone')) {
      return { user, field: 'phone' };
    }
    return { user, field: 'nin' };
  }
}

export const userRepository = new UserRepository();
