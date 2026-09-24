/**
 * Comments on a service request.
 *
 * The property under test is the visibility rule, which is the same one
 * incident comments use: a resident may follow their own ticket, staff may
 * comment on any, and an internal note is for staff only — a resident marking
 * their own comment internal would hide it from the people fixing the problem.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { ServiceRequestModel } from './schema';
import { serviceRequestService } from './service';

setupTestDatabase();

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

const REQUESTER = new mongoose.Types.ObjectId().toHexString();
const NEIGHBOUR = new mongoose.Types.ObjectId().toHexString();

function ctx(permissions: string[], estateId = ESTATE_A): RequestContext {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    estateId,
    roles: ['resident'],
    permissions: new Set(permissions),
    correlationId: 'corr',
    isPlatformAdmin: false,
  };
}

/** What every resident holds, per the base role. */
const RESIDENT = [
  PERMISSIONS.SERVICE_REQUEST_VIEW,
  PERMISSIONS.SERVICE_REQUEST_CREATE,
  PERMISSIONS.SERVICE_REQUEST_COMMENT,
];
const STAFF = [
  ...RESIDENT,
  PERMISSIONS.SERVICE_REQUEST_VIEW_ALL,
  PERMISSIONS.SERVICE_REQUEST_ASSIGN,
  PERMISSIONS.SERVICE_REQUEST_RESOLVE,
  PERMISSIONS.SERVICE_REQUEST_CLOSE,
];

const resident = () => ctx(RESIDENT);
const staff = () => ctx(STAFF);

beforeEach(async () => {
  await ServiceRequestModel.syncIndexes();
});

async function makeTicket() {
  return serviceRequestService.create(resident(), REQUESTER, {
    category: 'water',
    subject: 'No supply since Tuesday',
    description: 'The tank has been empty for three days.',
  });
}

describe('commenting on a ticket', () => {
  it('lets the requester comment on their own ticket', async () => {
    const ticket = await makeTicket();

    const comment = await serviceRequestService.comment(
      resident(),
      ticket._id.toHexString(),
      REQUESTER,
      'Still no water this morning.',
    );

    expect(comment.body).toBe('Still no water this morning.');
    expect(comment.internal).toBe(false);
  });

  it('lets staff comment on any ticket', async () => {
    const ticket = await makeTicket();

    await expect(
      serviceRequestService.comment(
        staff(),
        ticket._id.toHexString(),
        NEIGHBOUR,
        'Plumber booked for Thursday.',
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a resident commenting on somebody else ticket', async () => {
    const ticket = await makeTicket();

    await expect(
      serviceRequestService.comment(
        resident(),
        ticket._id.toHexString(),
        NEIGHBOUR,
        'What is happening here?',
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires serviceRequest.comment', async () => {
    const ticket = await makeTicket();

    await expect(
      serviceRequestService.comment(
        ctx([PERMISSIONS.SERVICE_REQUEST_VIEW]),
        ticket._id.toHexString(),
        REQUESTER,
        'Anything?',
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('downgrades an internal note from a resident', async () => {
    const ticket = await makeTicket();

    const comment = await serviceRequestService.comment(
      resident(),
      ticket._id.toHexString(),
      REQUESTER,
      'Please hurry.',
      { internal: true },
    );

    expect(comment.internal).toBe(false);
  });

  it('honours an internal note from staff', async () => {
    const ticket = await makeTicket();

    const comment = await serviceRequestService.comment(
      staff(),
      ticket._id.toHexString(),
      NEIGHBOUR,
      'Contractor has not been paid for the last job.',
      { internal: true },
    );

    expect(comment.internal).toBe(true);
  });

  it('refuses a comment on a closed ticket', async () => {
    const ticket = await makeTicket();
    await serviceRequestService.close(staff(), ticket._id.toHexString(), REQUESTER);

    await expect(
      serviceRequestService.comment(
        resident(),
        ticket._id.toHexString(),
        REQUESTER,
        'One more thing.',
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('treats a ticket in another estate as not found', async () => {
    const ticket = await makeTicket();

    await expect(
      serviceRequestService.comment(
        ctx(STAFF, ESTATE_B),
        ticket._id.toHexString(),
        REQUESTER,
        'Hello.',
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('reading comments', () => {
  async function ticketWithBothKinds() {
    const ticket = await makeTicket();
    const id = ticket._id.toHexString();

    await serviceRequestService.comment(resident(), id, REQUESTER, 'Still no water.');
    await serviceRequestService.comment(staff(), id, NEIGHBOUR, 'Plumber booked.');
    await serviceRequestService.comment(staff(), id, NEIGHBOUR, 'Contractor in dispute.', {
      internal: true,
    });

    return id;
  }

  it('hides internal notes from the resident', async () => {
    const id = await ticketWithBothKinds();

    const comments = await serviceRequestService.comments(resident(), id, REQUESTER);
    expect(comments).toHaveLength(2);
    expect(comments.every((comment) => !comment.internal)).toBe(true);
  });

  it('shows staff everything, oldest first', async () => {
    const id = await ticketWithBothKinds();

    const comments = await serviceRequestService.comments(staff(), id, NEIGHBOUR);
    expect(comments).toHaveLength(3);
    expect(comments.map((comment) => comment.body)).toEqual([
      'Still no water.',
      'Plumber booked.',
      'Contractor in dispute.',
    ]);
  });

  it('refuses a resident reading a ticket they did not raise', async () => {
    const id = await ticketWithBothKinds();

    await expect(
      serviceRequestService.comments(resident(), id, NEIGHBOUR),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('does not leak comments across estates', async () => {
    const id = await ticketWithBothKinds();

    await expect(
      serviceRequestService.comments(ctx(STAFF, ESTATE_B), id, NEIGHBOUR),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
