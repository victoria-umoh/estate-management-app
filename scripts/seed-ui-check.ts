/**
 * Seed just enough for a manual walk-through of the security screens.
 *
 * Not the full demo seeder (that lands with the seed-data phase) — this exists
 * so the gate scanner, the security desk and the ID card can be exercised
 * against real data rather than only compiled.
 */
import { connectToDatabase, disconnectFromDatabase } from '@/core/db';
import { blindIndex } from '@/core/crypto';
import { systemContext } from '@/core/tenancy';
import { hashPassword } from '@/modules/auth';
import { estateService } from '@/modules/estate';
import { gateService } from '@/modules/gate';
import { MembershipModel } from '@/modules/membership/schema';
import { roleRepository, roleService } from '@/modules/role';
import { UserModel } from '@/modules/user/schema';
import { visitorService } from '@/modules/visitor';

const PASSWORD = 'Str0ngPassphrase!';

async function main(): Promise<void> {
  await connectToDatabase();

  const slug = `ui-check-${Date.now()}`;
  const estate = await estateService.create({
    name: 'Palm Grove Estate',
    slug,
    address: { line1: '1 Palm Avenue', city: 'Lekki', state: 'Lagos', country: 'Nigeria' },
    contact: { email: 'admin@palmgrove.example', phone: '+2348012345678' },
  });

  const estateId = estate._id.toHexString();
  const context = systemContext(estateId);

  await roleService.seedSystemRoles(estateId);
  // Both roles, deliberately. A chairman manages gates but does not work them —
  // `gate.operate` belongs to the security officer role — so a single-role
  // account cannot exercise the scanner. Real estates assign both to whoever
  // covers a shift, and the membership model supports it.
  const chairman = await roleRepository.findByCode(context, 'estate-chairman');
  const officer = await roleRepository.findByCode(context, 'security-officer');

  const email = `officer.${Date.now()}@example.com`;
  const phone = `+23480${String(Date.now()).slice(-8)}`;

  const user = await UserModel.create({
    firstName: 'Bola',
    lastName: 'Adeyemi',
    email,
    phone,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(phone, 'phone'),
    passwordHash: await hashPassword(PASSWORD),
    status: 'active',
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: new Date(),
  });

  const membership = await MembershipModel.create({
    estateId: estate._id,
    userId: user._id,
    category: 'estate-staff',
    status: 'active',
    residentCode: 'R-2026-00001',
    roleIds: [chairman?._id, officer?._id].filter(Boolean),
    approvedAt: new Date(),
  });

  const gate = await gateService.create(context, { name: 'Main Gate', code: 'MAIN' });

  const { pass, token } = await visitorService.createPass(context, {
    hostMembershipId: membership._id.toHexString(),
    visitorName: 'Chidi Okafor',
    visitorPhone: '+2348055555555',
    purpose: 'Family visit',
    partySize: 2,
    expectedArrival: new Date(Date.now() - 60_000),
    expectedDeparture: new Date(Date.now() + 3 * 3_600_000),
  });

  console.log(
    JSON.stringify(
      {
        email,
        password: PASSWORD,
        estateId,
        membershipId: membership._id.toHexString(),
        gateId: gate._id.toHexString(),
        visitorCode: pass.code,
        visitorToken: token,
      },
      null,
      2,
    ),
  );

  await disconnectFromDatabase();
}

await main();
