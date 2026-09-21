/**
 * Incidents, emergencies and service requests.
 *
 * Grouped because they share a shape — report, assign, resolve, close — and the
 * interesting behaviour is in where each one deliberately differs: an emergency
 * must never fail to save, an incident must never be edited after closing, and
 * a ticket must not be marked satisfactory by the person who fixed it.
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { events } from '@/core/events';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { AuditLogModel } from '@/modules/audit';
import { emergencyService } from '@/modules/emergency';
import { EmergencyModel } from '@/modules/emergency/schema';
import { MembershipModel } from '@/modules/membership/schema';
import { serviceRequestService } from '@/modules/service-request';
import { ServiceRequestModel } from '@/modules/service-request/schema';
import { UserModel } from '@/modules/user/schema';
import { IncidentModel } from './schema';
import { incidentService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

let residentUserId: string;
let residentMembershipId: string;
let officerMembershipId: string;

function ctx(userId: string, permissions: string[], estateId = ESTATE_A): RequestContext {
  return {
    userId,
    estateId,
    roles: ['resident'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

const RESIDENT = [
  PERMISSIONS.INCIDENT_VIEW,
  PERMISSIONS.INCIDENT_CREATE,
  PERMISSIONS.EMERGENCY_CREATE,
  PERMISSIONS.EMERGENCY_VIEW,
  PERMISSIONS.SERVICE_REQUEST_VIEW,
  PERMISSIONS.SERVICE_REQUEST_CREATE,
];

const STAFF = [...RESIDENT, '*'];

async function makeMembership(estateId = ESTATE_A) {
  const email = `u${Math.random().toString(36).slice(2)}@example.com`;
  const user = await UserModel.create({
    firstName: 'Ada',
    lastName: 'Okonkwo',
    email,
    phone: `+23480${Math.floor(Math.random() * 100000000)}`,
    emailIndex: blindIndex(email, 'email'),
    phoneIndex: blindIndex(`${Math.random()}`, 'phone'),
    passwordHash: 'x',
    status: 'active',
  });

  const membership = await MembershipModel.create({
    estateId: new mongoose.Types.ObjectId(estateId),
    userId: user._id,
    category: 'homeowner',
    status: 'active',
    roleIds: [],
  });

  return { userId: user._id.toHexString(), membershipId: membership._id.toHexString() };
}

beforeEach(async () => {
  await IncidentModel.syncIndexes();
  await EmergencyModel.syncIndexes();
  await ServiceRequestModel.syncIndexes();

  const resident = await makeMembership();
  residentUserId = resident.userId;
  residentMembershipId = resident.membershipId;
  officerMembershipId = (await makeMembership()).membershipId;
});

afterEach(() => events.removeAllHandlers());

const resident = () => ctx(residentUserId, RESIDENT);
const staff = () => ctx(new mongoose.Types.ObjectId().toHexString(), STAFF);

const theftReport = {
  category: 'theft' as const,
  title: 'Generator stolen from block C',
  description: 'The backup generator was taken overnight.',
  severity: 'high' as const,
};

describe('reporting an incident', () => {
  it('creates an incident with a quotable reference', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, theftReport);

    expect(incident.status).toBe('open');
    expect(incident.reference).toMatch(/^INC-\d{4}-\d{5}$/);
  });

  it('numbers references sequentially per estate', async () => {
    const first = await incidentService.report(resident(), residentMembershipId, theftReport);
    const second = await incidentService.report(resident(), residentMembershipId, theftReport);

    expect(first.reference).toMatch(/00001$/);
    expect(second.reference).toMatch(/00002$/);
  });

  it('restarts numbering in a different estate', async () => {
    await incidentService.report(resident(), residentMembershipId, theftReport);

    const other = await makeMembership(ESTATE_B);
    const inB = await incidentService.report(
      ctx(other.userId, RESIDENT, ESTATE_B),
      other.membershipId,
      theftReport,
    );

    expect(inB.reference).toMatch(/00001$/);
  });

  // "A man in a blue shirt" is the most accurate thing a reporter can say, and
  // forcing a resident id would lose it.
  it('accepts unidentified people and vehicles as free text', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, {
      ...theftReport,
      involvedPersons: [{ label: 'Tall man in a blue shirt' }],
      involvedVehicles: [{ plate: 'abc-123-xy' }],
    });

    expect(incident.involvedPersons[0]).toMatchObject({
      label: 'Tall man in a blue shirt',
      membershipId: null,
    });
    expect(incident.involvedVehicles[0]?.plate).toBe('ABC-123-XY');
  });

  it('emits an event and records the report', async () => {
    const handler = vi.fn();
    events.on('incident.created', handler);

    await incidentService.report(resident(), residentMembershipId, theftReport);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(await AuditLogModel.countDocuments({ action: 'incident.created' })).toBe(1);
  });

  it('requires incident.create', async () => {
    await expect(
      incidentService.report(ctx(residentUserId, []), residentMembershipId, theftReport),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the incident lifecycle', () => {
  async function openIncident() {
    return incidentService.report(resident(), residentMembershipId, theftReport);
  }

  it('runs assign to investigate to resolve to close', async () => {
    const incident = await openIncident();
    const id = incident._id.toHexString();

    expect((await incidentService.assign(staff(), id, officerMembershipId)).status).toBe(
      'assigned',
    );
    expect((await incidentService.setStatus(staff(), id, 'investigating')).status).toBe(
      'investigating',
    );

    const resolved = await incidentService.resolve(
      staff(),
      id,
      officerMembershipId,
      'Recovered and returned.',
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('Recovered and returned.');

    expect((await incidentService.close(staff(), id)).status).toBe('closed');
  });

  it('rejects an invalid transition with both ends named', async () => {
    const incident = await openIncident();
    const id = incident._id.toHexString();

    await incidentService.assign(staff(), id, officerMembershipId);
    await incidentService.resolve(staff(), id, officerMembershipId, 'Done');
    await incidentService.close(staff(), id);

    // Closed is terminal: reopening means raising a new incident that
    // references this one, so the original timeline stays intact.
    await expect(incidentService.setStatus(staff(), id, 'investigating')).rejects.toThrow(
      /closed.*investigating/,
    );
  });

  it('refuses a transition to the status it already holds', async () => {
    const incident = await openIncident();
    await expect(
      incidentService.setStatus(staff(), incident._id.toHexString(), 'open'),
    ).rejects.toThrow(/already open/);
  });

  // Escalation implies the original severity was understated.
  it('raises severity on escalation', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, {
      ...theftReport,
      severity: 'low',
    });

    const escalated = await incidentService.escalate(
      staff(),
      incident._id.toHexString(),
      'Repeat occurrence',
    );

    expect(escalated.status).toBe('escalated');
    expect(escalated.severity).toBe('high');
  });

  it('leaves an already-critical severity alone on escalation', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, {
      ...theftReport,
      severity: 'critical',
    });

    const escalated = await incidentService.escalate(staff(), incident._id.toHexString(), 'x');
    expect(escalated.severity).toBe('critical');
  });

  // A resident holds none of these, so the resident context is the one that
  // must be refused.
  it.each(['assign', 'resolve', 'close', 'escalate'])(
    'requires a permission to %s',
    async (action) => {
      const incident = await openIncident();
      const id = incident._id.toHexString();
      const without = resident();

      const attempt = {
        assign: () => incidentService.assign(without, id, officerMembershipId),
        resolve: () => incidentService.resolve(without, id, officerMembershipId, 'x'),
        close: () => incidentService.close(without, id),
        escalate: () => incidentService.escalate(without, id, 'x'),
      }[action as 'assign'];

      await expect(attempt()).rejects.toMatchObject({ statusCode: 403 });
    },
  );
});

describe('incident comments', () => {
  it('lets the reporter comment on their own incident', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, theftReport);

    const comment = await incidentService.comment(
      resident(),
      incident._id.toHexString(),
      residentMembershipId,
      'I have the serial number.',
    );

    expect(comment.internal).toBe(false);
  });

  it('refuses a resident commenting on someone else incident', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, theftReport);
    const other = await makeMembership();

    await expect(
      incidentService.comment(
        ctx(other.userId, RESIDENT),
        incident._id.toHexString(),
        other.membershipId,
        'Nosy comment',
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  // A resident marking their own comment internal would hide it from the very
  // people handling the case.
  it('ignores an internal flag from a resident', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, theftReport);

    const comment = await incidentService.comment(
      resident(),
      incident._id.toHexString(),
      residentMembershipId,
      'Trying to hide this',
      { internal: true },
    );

    expect(comment.internal).toBe(false);
  });

  it('hides internal notes from the reporter but shows them to staff', async () => {
    const incident = await incidentService.report(resident(), residentMembershipId, theftReport);
    const id = incident._id.toHexString();

    await incidentService.comment(resident(), id, residentMembershipId, 'Public update');
    await incidentService.comment(staff(), id, officerMembershipId, 'Suspect identified', {
      internal: true,
    });

    expect(await incidentService.comments(resident(), id, residentMembershipId)).toHaveLength(1);
    expect(await incidentService.comments(staff(), id, officerMembershipId)).toHaveLength(2);
  });
});

describe('listing incidents', () => {
  // A critical incident must not be pushed down the list by a newer noise
  // complaint.
  it('orders by severity before recency', async () => {
    await incidentService.report(resident(), residentMembershipId, {
      ...theftReport,
      severity: 'low',
      title: 'Noise',
    });
    await incidentService.report(resident(), residentMembershipId, {
      ...theftReport,
      severity: 'critical',
      title: 'Fire',
    });

    const page = await incidentService.list(staff());
    expect(page.items[0]?.title).toBe('Fire');
  });

  it('filters by status, category and severity', async () => {
    await incidentService.report(resident(), residentMembershipId, theftReport);

    expect((await incidentService.list(staff(), { category: 'theft' })).total).toBe(1);
    expect((await incidentService.list(staff(), { category: 'fire' })).total).toBe(0);
    expect((await incidentService.list(staff(), { status: 'open' })).total).toBe(1);
  });

  it('cannot see another estate incidents', async () => {
    await incidentService.report(resident(), residentMembershipId, theftReport);
    expect((await incidentService.list(ctx(residentUserId, STAFF, ESTATE_B))).total).toBe(0);
  });
});

describe('emergencies', () => {
  // This record is created by someone in trouble, possibly one-handed. The one
  // thing that must not happen is the save failing because a field was missing.
  it('raises an alert with nothing but a type', async () => {
    const emergency = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'medical',
    });

    expect(emergency.status).toBe('triggered');
    expect(emergency.reference).toMatch(/^EMG-\d{4}-\d{5}$/);
    expect(emergency.description).toBeNull();
    expect(emergency.location).toBeNull();
  });

  it('captures whatever detail was given', async () => {
    const emergency = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'fire',
      description: 'Smoke from the kitchen',
      location: 'Block C, flat 4',
      coordinates: { lat: 6.4, lng: 3.4 },
      contactPhone: '+2348011111111',
    });

    expect(emergency.description).toBe('Smoke from the kitchen');
    expect(emergency.coordinates).toMatchObject({ lat: 6.4, lng: 3.4 });
  });

  it('emits immediately so responders are told', async () => {
    const handler = vi.fn();
    events.on('emergency.triggered', handler);

    await emergencyService.trigger(resident(), residentMembershipId, { type: 'security' });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler.mock.calls[0]![0].payload.type).toBe('security');
  });

  // The number an estate is judged on, stored rather than derived so a later
  // timestamp correction cannot quietly improve a past figure.
  it('records response time on acknowledgement', async () => {
    const emergency = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'medical',
    });

    const acknowledged = await emergencyService.acknowledge(
      staff(),
      emergency._id.toHexString(),
      officerMembershipId,
    );

    expect(acknowledged.status).toBe('acknowledged');
    expect(acknowledged.responseTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(acknowledged.acknowledgedAt).toBeInstanceOf(Date);
  });

  it('refuses a second acknowledgement', async () => {
    const emergency = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'medical',
    });
    const id = emergency._id.toHexString();

    await emergencyService.acknowledge(staff(), id, officerMembershipId);
    await expect(
      emergencyService.acknowledge(staff(), id, officerMembershipId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // A resident who fears being blamed for a false alarm is a resident who
  // hesitates next time, and the hesitation is the real danger.
  it('treats a false alarm as an outcome, not a deletion', async () => {
    const emergency = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'fire',
    });
    const id = emergency._id.toHexString();

    await emergencyService.acknowledge(staff(), id, officerMembershipId);
    const resolved = await emergencyService.resolve(staff(), id, officerMembershipId, {
      outcome: 'Burnt toast',
      falseAlarm: true,
    });

    expect(resolved.status).toBe('false-alarm');
    expect(await EmergencyModel.countDocuments({ _id: emergency._id })).toBe(1);
  });

  it('lists everything not yet closed', async () => {
    await emergencyService.trigger(resident(), residentMembershipId, { type: 'medical' });
    const second = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'fire',
    });

    await emergencyService.acknowledge(staff(), second._id.toHexString(), officerMembershipId);
    await emergencyService.resolve(staff(), second._id.toHexString(), officerMembershipId, {
      outcome: 'Handled',
    });

    expect(await emergencyService.listActive(staff())).toHaveLength(1);
  });

  it('records trigger, acknowledgement and resolution in the trail', async () => {
    const emergency = await emergencyService.trigger(resident(), residentMembershipId, {
      type: 'medical',
    });
    const id = emergency._id.toHexString();

    await emergencyService.acknowledge(staff(), id, officerMembershipId);
    await emergencyService.resolve(staff(), id, officerMembershipId, { outcome: 'Ambulance came' });

    const actions = await AuditLogModel.find({ resource: 'emergency' })
      .sort({ createdAt: 1 })
      .lean();

    expect(actions.map((entry) => entry.action)).toEqual([
      'emergency.triggered',
      'emergency.acknowledged',
      'emergency.resolved',
    ]);
  });
});

describe('service requests', () => {
  const brokenLight = {
    category: 'streetlight' as const,
    subject: 'Streetlight out on Palm Avenue',
    description: 'The light outside number 12 has been out for a week.',
  };

  it('sets an SLA target from the priority', async () => {
    const urgent = await serviceRequestService.create(resident(), residentMembershipId, {
      ...brokenLight,
      priority: 'urgent',
    });
    const low = await serviceRequestService.create(resident(), residentMembershipId, {
      ...brokenLight,
      priority: 'low',
    });

    const urgentHours = (urgent.dueAt.getTime() - Date.now()) / 3_600_000;
    const lowHours = (low.dueAt.getTime() - Date.now()) / 3_600_000;

    expect(urgentHours).toBeGreaterThan(3);
    expect(urgentHours).toBeLessThan(5);
    expect(lowHours).toBeGreaterThan(160);
  });

  it('issues a quotable ticket number', async () => {
    const request = await serviceRequestService.create(
      resident(),
      residentMembershipId,
      brokenLight,
    );
    expect(request.ticketNumber).toMatch(/^SR-\d{4}-\d{5}$/);
  });

  it('runs assign to in-progress to resolve to close', async () => {
    const request = await serviceRequestService.create(
      resident(),
      residentMembershipId,
      brokenLight,
    );
    const id = request._id.toHexString();

    await serviceRequestService.assign(staff(), id, { department: 'Maintenance' });
    await serviceRequestService.setStatus(staff(), id, 'in-progress');
    await serviceRequestService.resolve(staff(), id, officerMembershipId, 'Bulb replaced');

    const closed = await serviceRequestService.close(resident(), id, residentMembershipId, 5);

    expect(closed.status).toBe('closed');
    expect(closed.satisfactionRating).toBe(5);
  });

  // A ticket closed by the person who fixed it, with no resident confirmation,
  // is how "resolved" quietly diverges from "fixed".
  it('accepts a rating only from the requester', async () => {
    const request = await serviceRequestService.create(
      resident(),
      residentMembershipId,
      brokenLight,
    );
    const id = request._id.toHexString();

    await serviceRequestService.resolve(staff(), id, officerMembershipId, 'Done');
    const closed = await serviceRequestService.close(staff(), id, officerMembershipId, 5);

    expect(closed.satisfactionRating).toBeNull();
  });

  it('refuses a resident closing someone else ticket', async () => {
    const request = await serviceRequestService.create(
      resident(),
      residentMembershipId,
      brokenLight,
    );
    const other = await makeMembership();

    await expect(
      serviceRequestService.close(
        ctx(other.userId, RESIDENT),
        request._id.toHexString(),
        other.membershipId,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('records whether resolution met the SLA', async () => {
    const request = await serviceRequestService.create(
      resident(),
      residentMembershipId,
      brokenLight,
    );

    await serviceRequestService.resolve(
      staff(),
      request._id.toHexString(),
      officerMembershipId,
      'Fixed',
    );

    const entry = await AuditLogModel.findOne({ action: 'service_request.resolved' }).lean();
    expect(entry?.metadata).toMatchObject({ withinSla: true });
  });

  describe('SLA escalation', () => {
    async function overdueTicket() {
      const request = await serviceRequestService.create(
        resident(),
        residentMembershipId,
        brokenLight,
      );

      await ServiceRequestModel.updateOne(
        { _id: request._id },
        { $set: { dueAt: new Date(Date.now() - 3_600_000) } },
      );

      return request;
    }

    it('escalates a ticket past its target', async () => {
      const request = await overdueTicket();

      expect((await serviceRequestService.escalateOverdue()).escalated).toBe(1);

      const updated = await ServiceRequestModel.findById(request._id).lean();
      expect(updated?.escalatedAt).toBeInstanceOf(Date);
      expect(updated?.priority).toBe('high');
    });

    // A queue that re-notifies every cycle is a queue people stop reading.
    it('escalates each ticket only once', async () => {
      await overdueTicket();

      expect((await serviceRequestService.escalateOverdue()).escalated).toBe(1);
      expect((await serviceRequestService.escalateOverdue()).escalated).toBe(0);
    });

    it('ignores tickets already resolved', async () => {
      const request = await overdueTicket();
      await serviceRequestService.resolve(
        staff(),
        request._id.toHexString(),
        officerMembershipId,
        'Fixed',
      );

      expect((await serviceRequestService.escalateOverdue()).escalated).toBe(0);
    });

    it('finds overdue tickets by filter', async () => {
      await overdueTicket();
      expect((await serviceRequestService.list(staff(), { overdue: true })).total).toBe(1);
    });
  });
});
