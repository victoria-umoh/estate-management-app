/**
 * Create every index the application depends on.
 *
 * Mongoose is configured with `autoIndex: false`, because building indexes
 * implicitly on first model use causes surprise index builds under production
 * load. The consequence is that indexes must be created deliberately — and if
 * this never runs, a fresh database has **no unique constraints at all**.
 *
 * That is not a performance footnote. Without them, the same email, NIN,
 * phone number or number plate can be registered twice, and the duplicate
 * detection that the identity design rests on silently does nothing.
 *
 * Run after every deploy, and before seeding.
 *
 *   pnpm db:indexes
 */
import type { Model } from 'mongoose';

// Imported for their side effect of registering the model, then listed
// explicitly so a new collection cannot be forgotten silently.
import { AccessCredentialModel } from '@/modules/credential/schema';
import { AuditLogModel } from '@/modules/audit';
import { ChangeRequestModel } from '@/modules/change-request';
import { DependantModel } from '@/modules/household';
import { EmergencyModel } from '@/modules/emergency/schema';
import { EstateModel } from '@/modules/estate';
import { GateModel } from '@/modules/gate/schema';
import { IncidentCommentModel, IncidentModel } from '@/modules/incident';
import { MembershipModel } from '@/modules/membership/schema';
import { MovementModel } from '@/modules/movement';
import { PropertyModel, PropertyOccupancyModel } from '@/modules/property';
import { RoleModel } from '@/modules/role';
import { ServiceRequestModel } from '@/modules/service-request';
import { SessionModel } from '@/modules/auth';
import { UserModel } from '@/modules/user/schema';
import { VehicleModel } from '@/modules/vehicle';
import { VisitorPassModel } from '@/modules/visitor/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODELS: Array<Model<any>> = [
  UserModel,
  MembershipModel,
  SessionModel,
  RoleModel,
  EstateModel,
  PropertyModel,
  PropertyOccupancyModel,
  DependantModel,
  ChangeRequestModel,
  VehicleModel,
  AccessCredentialModel,
  GateModel,
  VisitorPassModel,
  MovementModel,
  IncidentModel,
  IncidentCommentModel,
  EmergencyModel,
  ServiceRequestModel,
  AuditLogModel,
];

/**
 * Build every index, returning a summary.
 *
 * Exported so the seeder can guarantee constraints exist before writing — a
 * fresh database has none, and seeding into one silently permits duplicates.
 */
export async function syncIndexes(options: { quiet?: boolean } = {}): Promise<{
  indexes: number;
  unique: number;
  failures: string[];
}> {
  let indexes = 0;
  let unique = 0;
  const failures: string[] = [];

  for (const model of MODELS) {
    try {
      const dropped = await model.syncIndexes();
      const present = await model.listIndexes();
      const uniqueCount = present.filter((index) => index.unique).length;

      indexes += present.length;
      unique += uniqueCount;

      if (!options.quiet) {
        console.log(
          `    ok  ${model.collection.name.padEnd(24)} ${String(present.length).padStart(2)} indexes` +
            `${uniqueCount > 0 ? `, ${uniqueCount} unique` : ''}` +
            `${dropped.length > 0 ? `  (dropped ${dropped.length} stale)` : ''}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.quiet) {
        console.error(`  FAIL  ${model.collection.name.padEnd(24)} ${message}`);
      }
      failures.push(model.collection.name);
    }
  }

  return { indexes, unique, failures };
}

export const MODEL_COUNT = MODELS.length;
