/**
 * Demo data for a preview.
 *
 * Builds one estate with enough going on to be worth looking at: residents, a
 * property, a registered vehicle, visitors both inside and overstaying, an open
 * incident and a live emergency. Every screen then shows real content rather
 * than an empty state.
 *
 * Refuses to run against NODE_ENV=production.
 *
 *   pnpm seed:demo
 *   pnpm seed:demo --reset   # wipe the previous demo estate first
 *
 * The demo accounts use fixed addresses (admin@example.com and friends) which
 * are unique platform-wide, so a second run without --reset collides on the
 * email index. That is the index working correctly; --reset is how you rerun.
 */
import mongoose, { Types } from 'mongoose';
import { config } from '@/core/config';
import { connectToDatabase } from '@/core/db';
import { syncIndexes } from './sync-indexes-lib';
import { shutdownIntegrations } from '@/integrations/shutdown';
import { blindIndex } from '@/core/crypto';
import { systemContext } from '@/core/tenancy';
import { hashPassword } from '@/modules/auth';
import { emergencyService } from '@/modules/emergency';
import { estateService } from '@/modules/estate';
import { feeCategoryService, invoiceService, paymentService } from '@/modules/finance';
import { gateService } from '@/modules/gate';
import { incidentService } from '@/modules/incident';
import { MembershipModel } from '@/modules/membership/schema';
import { propertyService } from '@/modules/property';
import { roleRepository, roleService } from '@/modules/role';
import { serviceRequestService } from '@/modules/service-request';
import { UserModel } from '@/modules/user/schema';
import { vehicleService } from '@/modules/vehicle';
import { VisitorPassModel } from '@/modules/visitor/schema';
import { visitorService } from '@/modules/visitor';

if (config.isProduction) {
  console.error('The demo seeder must never run against production.');
  process.exit(1);
}

const PASSWORD = config.seed.demoPassword;

interface SeededPerson {
  email: string;
  membershipId: string;
  name: string;
}

async function createPerson(
  estateId: string,
  input: {
    firstName: string;
    lastName: string;
    handle: string;
    category: string;
    roleCodes: string[];
  },
): Promise<SeededPerson> {
  const context = systemContext(estateId);
  const email = `${input.handle}@example.com`;
  const phone = `+23480${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

  const user = await UserModel.create({
    firstName: input.firstName,
    lastName: input.lastName,
    email,
    phone,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(phone, 'phone'),
    passwordHash: await hashPassword(PASSWORD),
    status: 'active',
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
  });

  const roles = await Promise.all(
    input.roleCodes.map((code) => roleRepository.findByCode(context, code)),
  );

  const membership = await MembershipModel.create({
    estateId: new Types.ObjectId(estateId),
    userId: user._id,
    category: input.category,
    status: 'active',
    roleIds: roles.filter(Boolean).map((role) => role!._id),
    approvedAt: new Date(),
  });

  return {
    email,
    membershipId: membership._id.toHexString(),
    name: `${input.firstName} ${input.lastName}`,
  };
}

/**
 * Remove everything a previous demo run created.
 *
 * Scoped to the demo estates by name, so it cannot touch a real tenant that
 * happens to share the database — and it wipes users last, since the estates it
 * finds are what identify which users belong to the demo.
 */
async function resetDemoData(): Promise<void> {
  const { EstateModel } = await import('@/modules/estate');
  const estates = await EstateModel.find({ name: config.seed.estateName }, { _id: 1 }).lean();

  if (estates.length === 0) {
    console.log('  Nothing to reset.');
    return;
  }

  const estateIds = estates.map((estate) => estate._id);
  const memberships = await MembershipModel.find({ estateId: { $in: estateIds } }, { userId: 1 })
    .lean();
  const userIds = memberships.map((membership) => membership.userId);

  const db = mongoose.connection.db;
  if (!db) throw new Error('Not connected.');

  // Every tenant-scoped collection carries estateId, so one filter clears them
  // all without needing to name each model.
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  let removed = 0;

  for (const { name } of collections) {
    if (name === 'users') continue;
    const result = await db.collection(name).deleteMany({ estateId: { $in: estateIds } });
    removed += result.deletedCount;
  }

  removed += (await db.collection('estates').deleteMany({ _id: { $in: estateIds } })).deletedCount;
  removed += (await db.collection('users').deleteMany({ _id: { $in: userIds } })).deletedCount;

  console.log(`  Reset: removed ${removed} documents from ${estates.length} demo estate(s).`);
}

async function main(): Promise<void> {
  await connectToDatabase();

  // Indexes first. Mongoose runs with autoIndex off, so a fresh database has no
  // unique constraints until they are built — and seeding into one would
  // happily create two accounts with the same email, which is precisely what
  // the identity design forbids.
  await syncIndexes();

  if (process.argv.includes('--reset')) await resetDemoData();

  const slug = `palm-grove-${Date.now().toString(36)}`;
  const estate = await estateService.create({
    name: config.seed.estateName,
    slug,
    address: { line1: '1 Palm Avenue', city: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    contact: { email: 'admin@palmgrove.example', phone: '+2348012345678' },
  });

  const estateId = estate._id.toHexString();
  const context = systemContext(estateId);

  await roleService.seedSystemRoles(estateId);

  // One account that can reach every screen. A chairman manages gates but does
  // not work them — `gate.operate` belongs to the officer role — so the demo
  // account carries both, as a real person covering a shift would.
  const admin = await createPerson(estateId, {
    firstName: 'Bola',
    lastName: 'Adeyemi',
    handle: 'admin',
    category: 'estate-staff',
    roleCodes: ['estate-chairman', 'security-officer'],
  });

  const resident = await createPerson(estateId, {
    firstName: 'Ada',
    lastName: 'Okonkwo',
    handle: 'resident',
    category: 'homeowner',
    roleCodes: ['homeowner'],
  });

  const officer = await createPerson(estateId, {
    firstName: 'Musa',
    lastName: 'Ibrahim',
    handle: 'officer',
    category: 'security-personnel',
    roleCodes: ['security-officer'],
  });

  // A tenant, so the tenancy register has something in it. Without one that
  // screen seeds empty, which proves nothing about whether it works.
  const tenant = await createPerson(estateId, {
    firstName: 'Ngozi',
    lastName: 'Eze',
    handle: 'tenant',
    category: 'tenant',
    roleCodes: ['tenant'],
  });

  // --- Property, with the resident as owner ---------------------------------
  const property = await propertyService.create(context, {
    unitNumber: '12B',
    street: 'Palm Avenue',
    type: 'duplex',
    bedrooms: 4,
    maxOccupants: 6,
  });

  await propertyService.assignOccupant(context, {
    propertyId: property._id.toHexString(),
    membershipId: resident.membershipId,
    role: 'owner',
  });

  await MembershipModel.updateOne(
    { _id: resident.membershipId },
    { $set: { propertyId: property._id, residentCode: 'R-2026-00001' } },
  );

  // --- A let unit, with a tenancy awaiting approval -------------------------
  // Left unapproved on purpose: the register opens on "pending", and an
  // administrator's first question there is what is waiting for a signature.
  const letUnit = await propertyService.create(context, {
    unitNumber: '7A',
    street: 'Palm Avenue',
    type: 'apartment',
    bedrooms: 2,
    maxOccupants: 4,
  });

  await propertyService.assignOccupant(context, {
    propertyId: letUnit._id.toHexString(),
    membershipId: tenant.membershipId,
    role: 'tenant',
    leaseStartDate: new Date(),
    leaseEndDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    occupantCount: 2,
  });

  await MembershipModel.updateOne(
    { _id: tenant.membershipId },
    { $set: { propertyId: letUnit._id, residentCode: 'R-2026-00002' } },
  );

  // --- Gates ----------------------------------------------------------------
  const mainGate = await gateService.create(context, { name: 'Main Gate', code: 'MAIN' });
  await gateService.create(context, {
    name: 'Service Gate',
    code: 'SERV',
    direction: 'both',
  });

  // --- A registered, verified vehicle ---------------------------------------
  const vehicle = await vehicleService.register(context, {
    ownerMembershipId: resident.membershipId,
    plateNumber: 'ABC-123-XY',
    make: 'Toyota',
    model: 'Corolla',
    colour: 'Silver',
    type: 'car',
  });
  await vehicleService.verify(context, vehicle._id.toHexString(), 'Homeowner', '12B');

  // Belongs to somebody else. A demo estate with one household's data in every
  // collection is how four separate "any resident can read the whole estate"
  // leaks went unnoticed: the leaky list and the correct one returned the same
  // rows, so nothing looked wrong.
  const chairmanCar = await vehicleService.register(context, {
    ownerMembershipId: admin.membershipId,
    plateNumber: 'CHR-001-LA',
    make: 'Peugeot',
    model: '508',
    colour: 'Navy',
    type: 'car',
  });
  await vehicleService.verify(context, chairmanCar._id.toHexString(), 'Chairman', '1A');

  // A blacklisted one, so the gate's strongest refusal is visible.
  const blocked = await vehicleService.register(context, {
    ownerMembershipId: resident.membershipId,
    plateNumber: 'XYZ-999-ZZ',
    make: 'Honda',
    model: 'Accord',
    colour: 'Black',
    type: 'car',
  });
  await vehicleService.verify(context, blocked._id.toHexString(), 'Homeowner', '12B');
  await vehicleService.setBlacklist(
    context,
    blocked._id.toHexString(),
    true,
    'Reported stolen — do not admit',
  );

  // --- Visitors -------------------------------------------------------------
  // Hosted by the chairman, so a resident reading the estate-wide list instead
  // of their own is visible rather than indistinguishable.
  await visitorService.createPass(context, {
    hostMembershipId: admin.membershipId,
    visitorName: 'Funmi Adeleke',
    purpose: 'Committee meeting',
    expectedArrival: new Date(Date.now() + 2 * 3_600_000),
    expectedDeparture: new Date(Date.now() + 5 * 3_600_000),
  });

  // One expected and waiting at the gate.
  const expected = await visitorService.createPass(context, {
    hostMembershipId: resident.membershipId,
    visitorName: 'Chidi Okafor',
    visitorPhone: '+2348055555555',
    purpose: 'Family visit',
    partySize: 2,
    expectedArrival: new Date(Date.now() - 30 * 60_000),
    expectedDeparture: new Date(Date.now() + 4 * 3_600_000),
  });

  // One already inside and overdue, so the overstay path is visible on the desk.
  const overstaying = await visitorService.createPass(context, {
    hostMembershipId: resident.membershipId,
    visitorName: 'Ngozi Bello',
    visitorPhone: '+2348066666666',
    purpose: 'Contractor — plumbing',
    partySize: 1,
    expectedArrival: new Date(Date.now() - 6 * 3_600_000),
    expectedDeparture: new Date(Date.now() + 3_600_000),
  });

  await gateService.processScan(context, {
    token: overstaying.token,
    gateId: mainGate._id.toHexString(),
    direction: 'in',
  });

  // Rewound after check-in, because the pass had to be valid to get in.
  await VisitorPassModel.updateOne(
    { _id: overstaying.pass._id },
    { $set: { expectedDeparture: new Date(Date.now() - 2 * 3_600_000) } },
  );

  // A refused scan, so the activity log shows both outcomes.
  await gateService.processScan(context, {
    token: 'v1.forged.signature',
    gateId: mainGate._id.toHexString(),
    direction: 'in',
  });

  // --- Incident, emergency and a service request ----------------------------
  // Reported by the chairman, so the incident narrowing has something to narrow.
  await incidentService.report(context, admin.membershipId, {
    category: 'property-damage',
    severity: 'medium',
    title: 'Clubhouse window cracked',
    description: 'Found this morning; no sign of forced entry.',
    location: 'Clubhouse',
  });

  await incidentService.report(context, resident.membershipId, {
    category: 'suspicious-activity',
    severity: 'high',
    title: 'Unknown vehicle circling block C',
    description: 'A dark saloon has passed the block four times in twenty minutes.',
    location: 'Block C, Palm Avenue',
    involvedVehicles: [{ plate: 'UNKNOWN' }],
  });

  await emergencyService.trigger(context, resident.membershipId, {
    type: 'medical',
    description: 'Elderly resident has fallen',
    location: '12B Palm Avenue',
  });

  // Another household's ticket, for the same reason as the car above.
  await serviceRequestService.create(context, admin.membershipId, {
    category: 'water',
    priority: 'high',
    subject: 'Burst pipe behind the clubhouse',
    description: 'Water pooling against the wall since this morning.',
    location: 'Clubhouse, rear',
  });

  await serviceRequestService.create(context, resident.membershipId, {
    category: 'streetlight',
    priority: 'normal',
    subject: 'Streetlight out on Palm Avenue',
    description: 'The light outside number 12 has been out for a week.',
    location: 'Outside 12B',
  });

  // --- Money ----------------------------------------------------------------
  // Two fees on different bases, so the billing run exercises both the
  // one-invoice-per-unit and one-invoice-per-member paths.
  const dues = await feeCategoryService.create(context, {
    code: 'dues',
    name: 'Monthly estate dues',
    description: 'Security, grounds and shared utilities.',
    amount: 5_000_000,
    frequency: 'monthly',
    basis: 'property',
  });

  await feeCategoryService.create(context, {
    code: 'waste',
    name: 'Waste collection',
    amount: 750_000,
    frequency: 'monthly',
    basis: 'property',
  });

  // One invoice already settled in cash, one still owing and one overdue, so
  // every status on the finance screen has something behind it.
  const settled = await invoiceService.create(context, {
    membershipId: resident.membershipId,
    lines: [{ feeCategoryId: dues._id.toHexString(), description: dues.name, unitAmount: dues.amount }],
    dueAt: new Date(Date.now() - 30 * 86_400_000),
  });
  await invoiceService.issue(context, settled._id.toHexString());
  await paymentService.recordManual(context, {
    invoiceId: settled._id.toHexString(),
    membershipId: resident.membershipId,
    amount: dues.amount,
    note: 'Bank transfer, reference 8841002',
  });

  const owing = await invoiceService.create(context, {
    membershipId: resident.membershipId,
    lines: [
      { feeCategoryId: dues._id.toHexString(), description: dues.name, unitAmount: dues.amount },
      { description: 'Waste collection', unitAmount: 750_000 },
    ],
    dueAt: new Date(Date.now() + 10 * 86_400_000),
  });
  await invoiceService.issue(context, owing._id.toHexString());

  const late = await invoiceService.create(context, {
    membershipId: resident.membershipId,
    lines: [{ description: 'Gate repair levy', unitAmount: 1_200_000 }],
    dueAt: new Date(Date.now() - 5 * 86_400_000),
  });
  await invoiceService.issue(context, late._id.toHexString());
  await invoiceService.markOverdue(context);

  console.log(`\n  Estate: ${estate.name}  (${slug})`);
  console.log(`  Password for all accounts: ${PASSWORD}\n`);
  console.log('  Accounts');
  console.log(`    ${admin.email.padEnd(26)} chairman + security officer  (${admin.name})`);
  console.log(`    ${resident.email.padEnd(26)} homeowner                    (${resident.name})`);
  console.log(`    ${officer.email.padEnd(26)} security officer             (${officer.name})`);
  console.log('\n  To try at the gate');
  console.log(
    `    visitor code   ${expected.pass.code}   (${expected.pass.visitorName}, expected)`,
  );
  console.log(`    plate          ABC-123-XY    (registered)`);
  console.log(`    plate          XYZ-999-ZZ    (blacklisted)`);
  console.log(`\n  ${overstaying.pass.visitorName} is already inside and overdue.\n`);
  console.log('  Finance');
  console.log(`    ${settled.number}  paid in full`);
  console.log(`    ${owing.number}  ${formatNaira(owing.total)} due`);
  console.log(`    ${late.number}  ${formatNaira(late.total)} overdue\n`);

  await shutdownIntegrations();
}

function formatNaira(minorUnits: number): string {
  return `NGN ${(minorUnits / 100).toLocaleString()}`;
}

await main();
