/**
 * Documents.
 *
 * An upload endpoint is where an outsider gets to put bytes of their choosing
 * on your infrastructure, and a download endpoint is where those bytes get
 * served back. So the cases that matter here are not the happy path: they are
 * the file whose extension and contents disagree, the file that fills the disk,
 * the document belonging to another estate, and the document belonging to the
 * household next door.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDatabase } from '@tests/helpers/database';
import { blindIndex } from '@/core/crypto';
import { PERMISSIONS } from '@/core/rbac';
import type { RequestContext } from '@/core/tenancy';
import { LocalStorageAdapter, setStorage } from '@/integrations/storage';
import { AuditLogModel } from '@/modules/audit';
import { IncidentModel } from '@/modules/incident/schema';
import { MembershipModel } from '@/modules/membership/schema';
import { UserModel } from '@/modules/user/schema';
import { VehicleModel } from '@/modules/vehicle/schema';
import { DocumentModel } from './schema';
import { DocumentService, documentService, type UploadDocumentInput } from './service';

setupTestDatabase();

const ROOT = join(process.cwd(), 'tmp', 'document-tests');
const storage = new LocalStorageAdapter(ROOT);
setStorage(storage);

afterAll(async () => {
  setStorage(undefined);
  await rm(ROOT, { recursive: true, force: true });
});

const ESTATE_A = new mongoose.Types.ObjectId().toHexString();
const ESTATE_B = new mongoose.Types.ObjectId().toHexString();

// ---------------------------------------------------------------------------
// Fixtures. Real magic numbers, because that is the thing under test.
// ---------------------------------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(64).fill(0)]);

/** A JPEG carrying an APP1 EXIF block — the segment GPS coordinates live in. */
function jpegWithExif(): Buffer {
  const exif = Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    Buffer.from('GPSLatitude 6.5244 GPSLongitude 3.3792 Make ACME'),
  ]);

  const length = Buffer.alloc(2);
  length.writeUInt16BE(exif.length + 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1]),
    length,
    exif,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from(Array(64).fill(0x42)),
    Buffer.from([0xff, 0xd9]),
  ]);
}

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

const RESIDENT_PERMISSIONS = [
  PERMISSIONS.DOCUMENT_VIEW,
  PERMISSIONS.DOCUMENT_UPLOAD,
  PERMISSIONS.DOCUMENT_DOWNLOAD,
  PERMISSIONS.DOCUMENT_DELETE,
  PERMISSIONS.INCIDENT_VIEW,
  PERMISSIONS.VEHICLE_VIEW,
  PERMISSIONS.RESIDENT_VIEW,
];

const STAFF_PERMISSIONS = [...RESIDENT_PERMISSIONS, PERMISSIONS.INCIDENT_VIEW_ALL];

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

  return { userId: user._id.toHexString(), membershipId: membership._id };
}

async function makeIncident(reporterMembershipId: mongoose.Types.ObjectId, estateId = ESTATE_A) {
  const incident = await IncidentModel.create({
    estateId: new mongoose.Types.ObjectId(estateId),
    reference: `INC-2026-${Math.floor(Math.random() * 90000) + 10000}`,
    category: 'theft',
    severity: 'high',
    severityRank: 3,
    title: 'Generator stolen from block C',
    description: 'The backup generator was taken overnight.',
    reportedByMembershipId: reporterMembershipId,
    occurredAt: new Date(),
    status: 'open',
  });

  return incident._id.toHexString();
}

let owner: { userId: string; membershipId: mongoose.Types.ObjectId };
let neighbour: { userId: string; membershipId: mongoose.Types.ObjectId };
let incidentId: string;

beforeEach(async () => {
  owner = await makeMembership();
  neighbour = await makeMembership();
  incidentId = await makeIncident(owner.membershipId);
});

const asOwner = () => ctx(owner.userId, RESIDENT_PERMISSIONS);
const asNeighbour = () => ctx(neighbour.userId, RESIDENT_PERMISSIONS);

function upload(context: RequestContext, overrides: Partial<UploadDocumentInput> = {}) {
  return documentService.upload(context, {
    subjectType: 'incident',
    subjectId: incidentId,
    filename: 'evidence.png',
    contentType: 'image/png',
    body: PNG,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('the type allow-list', () => {
  it('stores a file whose contents match its declared type', async () => {
    const document = await upload(asOwner());

    expect(document.contentType).toBe('image/png');
    expect(document.size).toBe(PNG.length);
    expect(await storage.exists(document.storageKey)).toBe(true);
  });

  // The case the whole check exists for: the name and the Content-Type say
  // image, the bytes say something else entirely.
  it('refuses contents that disagree with the declared type', async () => {
    await expect(upload(asOwner(), { body: PDF })).rejects.toThrow(
      /do not match the declared type/,
    );
  });

  it('refuses a script renamed to look like an image', async () => {
    await expect(
      upload(asOwner(), {
        filename: 'photo.png',
        body: Buffer.from('<script>fetch("/api/v1/me").then((r) => r.json())</script>'),
      }),
    ).rejects.toThrow(/not a recognised/);
  });

  it('refuses a type that is not on the allow-list at all', async () => {
    await expect(
      upload(asOwner(), { contentType: 'text/html', body: Buffer.from('<h1>hi</h1>') }),
    ).rejects.toThrow(/not accepted/);
  });

  it('writes nothing when the file is refused', async () => {
    await expect(upload(asOwner(), { body: PDF })).rejects.toThrow();
    expect(await DocumentModel.countDocuments({})).toBe(0);
  });
});

describe('size and quota caps', () => {
  it('names the per-file limit when a single file is too large', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);

    await expect(upload(asOwner(), { body: oversized })).rejects.toThrow(/MB or smaller/);
  });

  it('names the estate quota, and what is left, when the estate is full', async () => {
    // A quota just large enough for one of these files and not two.
    const tiny = new DocumentService(PNG.length + 10);

    await tiny.upload(asOwner(), {
      subjectType: 'incident',
      subjectId: incidentId,
      filename: 'first.png',
      contentType: 'image/png',
      body: PNG,
    });

    await expect(
      tiny.upload(asOwner(), {
        subjectType: 'incident',
        subjectId: incidentId,
        filename: 'second.png',
        contentType: 'image/png',
        body: PNG,
      }),
    ).rejects.toThrow(/document storage[\s\S]*is free/);
  });

  it('distinguishes the two limits, so the message says which was hit', async () => {
    const tiny = new DocumentService(PNG.length + 10);
    const oversized = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);

    // Per-file, not quota — even though it would also blow the quota.
    await expect(
      tiny.upload(asOwner(), {
        subjectType: 'incident',
        subjectId: incidentId,
        filename: 'huge.png',
        contentType: 'image/png',
        body: oversized,
      }),
    ).rejects.toThrow(/MB or smaller/);
  });

  it('frees quota again when a document is deleted', async () => {
    const tiny = new DocumentService(PNG.length + 10);

    const first = await tiny.upload(asOwner(), {
      subjectType: 'incident',
      subjectId: incidentId,
      filename: 'first.png',
      contentType: 'image/png',
      body: PNG,
    });

    await tiny.remove(asOwner(), first._id.toHexString());

    await expect(
      tiny.upload(asOwner(), {
        subjectType: 'incident',
        subjectId: incidentId,
        filename: 'second.png',
        contentType: 'image/png',
        body: PNG,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('the stored key', () => {
  it('is generated here, so a crafted filename cannot choose a path', async () => {
    const document = await upload(asOwner(), { filename: '../../../etc/cron.d/payload.png' });

    expect(document.storageKey).not.toContain('..');
    expect(document.storageKey).toContain(`${ESTATE_A}/incident/${incidentId}/`);
    expect(document.storageKey).toMatch(/\/\d+-[a-f0-9]{24}\.png$/);
  });

  it('keeps the original name as display text only', async () => {
    const document = await upload(asOwner(), { filename: '../../evidence"; drop.png' });

    expect(document.filename).not.toContain('"');
    expect(document.filename).not.toContain('/');
  });
});

describe('image metadata', () => {
  // A resident photographing a damaged gate uploads their own front door's
  // coordinates along with it.
  it('drops EXIF from a JPEG on the way in', async () => {
    const document = await upload(asOwner(), {
      filename: 'gate.jpg',
      contentType: 'image/jpeg',
      body: jpegWithExif(),
    });

    const stored = await storage.download(document.storageKey);

    expect(document.metadataStripped).toBe(true);
    expect(stored.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(document.size).toBeLessThan(jpegWithExif().length);
  });

  it('leaves a PDF alone and says so', async () => {
    const document = await upload(asOwner(), {
      filename: 'lease.pdf',
      contentType: 'application/pdf',
      body: PDF,
    });

    expect(document.metadataStripped).toBe(false);
  });
});

describe('tenant isolation', () => {
  it('does not return another estate’s document', async () => {
    const document = await upload(asOwner());
    const other = await makeMembership(ESTATE_B);

    await expect(
      documentService.detail(
        ctx(other.userId, STAFF_PERMISSIONS, ESTATE_B),
        document._id.toHexString(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not let another estate download it', async () => {
    const document = await upload(asOwner());
    const other = await makeMembership(ESTATE_B);

    await expect(
      documentService.download(
        ctx(other.userId, STAFF_PERMISSIONS, ESTATE_B),
        document._id.toHexString(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('counts quota per estate, not globally', async () => {
    const tiny = new DocumentService(PNG.length + 10);

    await tiny.upload(asOwner(), {
      subjectType: 'incident',
      subjectId: incidentId,
      filename: 'a.png',
      contentType: 'image/png',
      body: PNG,
    });

    const other = await makeMembership(ESTATE_B);
    const otherIncident = await makeIncident(other.membershipId, ESTATE_B);

    await expect(
      tiny.upload(ctx(other.userId, RESIDENT_PERMISSIONS, ESTATE_B), {
        subjectType: 'incident',
        subjectId: otherIncident,
        filename: 'b.png',
        contentType: 'image/png',
        body: PNG,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('reading is gated on the subject, not on document.view', () => {
  // The bug this module exists to avoid: every resident holds `document.view`
  // so their own papers appear on their own screen. If that were the only
  // check, walking document ids would read every incident photograph on the
  // estate.
  it('hides a document on an incident the caller may not read', async () => {
    const document = await upload(asOwner());

    await expect(
      documentService.detail(asNeighbour(), document._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses the download for the same reason, before touching storage', async () => {
    const document = await upload(asOwner());

    await expect(
      documentService.download(asNeighbour(), document._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets staff who may read every incident read its documents', async () => {
    const document = await upload(asOwner());
    const staff = await makeMembership();

    await expect(
      documentService.detail(ctx(staff.userId, STAFF_PERMISSIONS), document._id.toHexString()),
    ).resolves.toMatchObject({ filename: 'evidence.png' });
  });

  it('refuses an upload onto a subject the caller may not read', async () => {
    await expect(
      documentService.upload(asNeighbour(), {
        subjectType: 'incident',
        subjectId: incidentId,
        filename: 'planted.png',
        contentType: 'image/png',
        body: PNG,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('applies the same rule to a vehicle', async () => {
    const vehicle = await VehicleModel.create({
      estateId: new mongoose.Types.ObjectId(ESTATE_A),
      plateNumber: 'ABC-123-XY',
      plateNormalised: 'ABC123XY',
      make: 'Toyota',
      model: 'Corolla',
      colour: 'silver',
      type: 'car',
      ownerMembershipId: owner.membershipId,
      status: 'active',
    });

    const document = await documentService.upload(asOwner(), {
      subjectType: 'vehicle',
      subjectId: vehicle._id.toHexString(),
      filename: 'insurance.pdf',
      contentType: 'application/pdf',
      body: PDF,
    });

    await expect(
      documentService.detail(asNeighbour(), document._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });

    // And the orphaned array on the vehicle is now populated.
    const reloaded = await VehicleModel.findById(vehicle._id);
    expect(reloaded?.documentIds.map(String)).toContain(document._id.toHexString());
  });
});

describe('download is a separate act from view', () => {
  it('refuses a caller holding document.view but not document.download', async () => {
    const document = await upload(asOwner());
    const viewer = ctx(
      owner.userId,
      RESIDENT_PERMISSIONS.filter((permission) => permission !== PERMISSIONS.DOCUMENT_DOWNLOAD),
    );

    await expect(
      documentService.download(viewer, document._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  // A pattern of refused downloads is the signal worth keeping, so the refusal
  // is audited before it is thrown.
  it('audits the refusal', async () => {
    const document = await upload(asOwner());
    const viewer = ctx(
      owner.userId,
      RESIDENT_PERMISSIONS.filter((permission) => permission !== PERMISSIONS.DOCUMENT_DOWNLOAD),
    );

    await documentService.download(viewer, document._id.toHexString()).catch(() => undefined);

    const entry = await AuditLogModel.findOne({ action: 'document.download.denied' });
    expect(entry).toMatchObject({ outcome: 'failure' });
  });

  it('audits every successful download too', async () => {
    const document = await upload(asOwner());

    const file = await documentService.download(asOwner(), document._id.toHexString());

    expect(file.body).toEqual(PNG);
    expect(await AuditLogModel.countDocuments({ action: 'document.downloaded' })).toBe(1);
  });

  // Never the stored type: an uploaded file served inline from this origin is
  // stored XSS against the session that opens it.
  it('hands back an inert content type regardless of what was stored', async () => {
    const document = await upload(asOwner(), {
      filename: 'lease.pdf',
      contentType: 'application/pdf',
      body: PDF,
    });

    const file = await documentService.download(asOwner(), document._id.toHexString());
    expect(file.contentType).toBe('application/octet-stream');
  });
});

describe('deleting', () => {
  it('purges the bytes and keeps the row for the trail', async () => {
    const document = await upload(asOwner());

    await documentService.remove(asOwner(), document._id.toHexString());

    expect(await storage.exists(document.storageKey)).toBe(false);

    const row = await DocumentModel.findById(document._id);
    expect(row?.deletedAt).toBeTruthy();
    expect(row?.purgedAt).toBeTruthy();
    expect(await AuditLogModel.countDocuments({ action: 'document.deleted' })).toBe(1);
  });

  it('removes it from the subject’s attachment list', async () => {
    const document = await upload(asOwner());

    expect((await IncidentModel.findById(incidentId))?.attachmentIds.map(String)).toContain(
      document._id.toHexString(),
    );

    await documentService.remove(asOwner(), document._id.toHexString());

    expect((await IncidentModel.findById(incidentId))?.attachmentIds.map(String)).not.toContain(
      document._id.toHexString(),
    );
  });

  it('is gone from reads afterwards', async () => {
    const document = await upload(asOwner());
    await documentService.remove(asOwner(), document._id.toHexString());

    await expect(
      documentService.detail(asOwner(), document._id.toHexString()),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('requires document.delete', async () => {
    const document = await upload(asOwner());
    const viewer = ctx(
      owner.userId,
      RESIDENT_PERMISSIONS.filter((permission) => permission !== PERMISSIONS.DOCUMENT_DELETE),
    );

    await expect(documentService.remove(viewer, document._id.toHexString())).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('listing', () => {
  it('returns a subject’s documents to someone who may read the subject', async () => {
    await upload(asOwner());
    await upload(asOwner(), { filename: 'second.png' });

    const items = await documentService.listForSubject(asOwner(), 'incident', incidentId);
    expect(items).toHaveLength(2);
  });

  it('refuses the subject list to someone who may not read the subject', async () => {
    await upload(asOwner());

    await expect(
      documentService.listForSubject(asNeighbour(), 'incident', incidentId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // The estate-wide list ignores the subject by definition, so it is not
  // offered to the permission every resident holds.
  it('does not let a plain resident enumerate the estate', async () => {
    await upload(asOwner());

    await expect(
      documentService.list(ctx(owner.userId, [PERMISSIONS.DOCUMENT_VIEW])),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('gives the estate-wide list to someone who may already read every household', async () => {
    await upload(asOwner());

    const result = await documentService.list(
      ctx(owner.userId, [PERMISSIONS.DOCUMENT_VIEW, PERMISSIONS.RESIDENT_VIEW_ALL]),
    );

    expect(result.total).toBe(1);
  });
});
