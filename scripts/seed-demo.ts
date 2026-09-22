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
 */
import { Types } from 'mongoose';
import { config } from '@/core/config';
import { connectToDatabase } from '@/core/db';
import { syncIndexes } from './sync-indexes-lib';
import { shutdownIntegrations } from '@/integrations/shutdown';
import { blindIndex } from '@/core/crypto';
import { systemContext } from '@/core/tenancy';
import { hashPassword } from '@/modules/auth';
import { emergencyService } from '@/modules/emergency';
import { estateService } from '@/modules/estate';
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

async function main(): Promise<void> {
  await connectToDatabase();

  // Indexes first. Mongoose runs with autoIndex off, so a fresh database has no
  // unique constraints until they are built — and seeding into one would
  // happily create two accounts with the same email, which is precisely what
  // the identity design forbids.
  await syncIndexes();

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

  await serviceRequestService.create(context, resident.membershipId, {
    category: 'streetlight',
    priority: 'normal',
    subject: 'Streetlight out on Palm Avenue',
    description: 'The light outside number 12 has been out for a week.',
    location: 'Outside 12B',
  });

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

  await shutdownIntegrations();
}

await main();
