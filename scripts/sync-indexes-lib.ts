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
import mongoose, { type Model } from 'mongoose';

// Imported for their side effect of registering the model, then listed
// explicitly so a new collection cannot be forgotten silently.
import { AccessCredentialModel } from '@/modules/credential/schema';
import { AccountTokenModel } from '@/modules/auth/account-token.schema';
import { AnnouncementModel } from '@/modules/announcement';
import { AuditLogModel } from '@/modules/audit';
import { ChangeRequestModel } from '@/modules/change-request';
import { DependantModel } from '@/modules/household';
import { EmergencyModel } from '@/modules/emergency/schema';
import { EstateModel } from '@/modules/estate';
import {
  FeeCategoryModel,
  InvoiceModel,
  PaymentModel,
  WebhookEventModel,
} from '@/modules/finance/schema';
import { LedgerEntryModel } from '@/modules/finance/ledger.schema';
import { ExitPassModel } from '@/modules/exit-pass/schema';
import { GateModel } from '@/modules/gate/schema';
import { IncidentCommentModel, IncidentModel } from '@/modules/incident';
import { MembershipModel } from '@/modules/membership/schema';
import { MovementModel } from '@/modules/movement';
import { NotificationModel, NotificationPreferenceModel } from '@/modules/notification';
import { PropertyModel, PropertyOccupancyModel } from '@/modules/property';
import { ReportScheduleModel } from '@/modules/report/schedule.schema';
import { RoleModel } from '@/modules/role';
import { ServiceRequestCommentModel, ServiceRequestModel } from '@/modules/service-request';
import { SessionModel } from '@/modules/auth';
import { TemporaryPassModel } from '@/modules/temporary-pass/schema';
import { UserModel } from '@/modules/user/schema';
import { VehicleModel } from '@/modules/vehicle';
import { VisitorPassModel } from '@/modules/visitor/schema';

 
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
  ExitPassModel,
  TemporaryPassModel,
  MovementModel,
  IncidentModel,
  IncidentCommentModel,
  EmergencyModel,
  ServiceRequestModel,
  ServiceRequestCommentModel,
  NotificationModel,
  NotificationPreferenceModel,
  AnnouncementModel,
  AuditLogModel,
  AccountTokenModel,
  FeeCategoryModel,
  InvoiceModel,
  PaymentModel,
  WebhookEventModel,
  LedgerEntryModel,
  ReportScheduleModel,
];

/**
 * Fail if a registered model is missing from the list above.
 *
 * The list is explicit so a reviewer can see what gets indexed — but "listed
 * explicitly so a new collection cannot be forgotten silently" is only true if
 * something checks. It was not checked, and the entire finance module was
 * omitted: seven unique constraints existed in the schemas and in no database.
 * Among them the one the payment webhook's idempotency rests on, so a duplicate
 * delivery could have been credited twice in production while every test
 * passed, because the test harness syncs its models directly.
 *
 * Mongoose registers a model on import, and every model in this list is
 * imported above, so anything registered and absent here is an omission.
 */
function assertEveryModelListed(): string[] {
  const listed = new Set(MODELS.map((model) => model.modelName));

  return Object.keys(mongoose.models).filter((name) => !listed.has(name));
}

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

  const unlisted = assertEveryModelListed();
  if (unlisted.length > 0) {
    // Loud, and a failure: a collection whose indexes are never built is a
    // collection whose unique constraints do not exist.
    for (const name of unlisted) {
      if (!options.quiet) {
        console.error(`  FAIL  ${name.padEnd(24)} registered but not in the sync list`);
      }
      failures.push(name);
    }
  }

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
