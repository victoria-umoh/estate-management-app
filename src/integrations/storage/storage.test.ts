import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalStorageAdapter } from './local-adapter';
import { buildStorageKey, validateUpload } from './validation';

/** Minimal files with correct magic numbers. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, ...Array(64).fill(0)]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(64).fill(0)]);

const ROOT = join(process.cwd(), 'tmp', 'test-uploads');
afterAll(() => rm(ROOT, { recursive: true, force: true }));

describe('upload validation', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['pdf', PDF, 'application/pdf'],
  ])('accepts a valid %s', (_label, body, contentType) => {
    expect(() => validateUpload({ body, contentType })).not.toThrow();
  });

  it('rejects an empty file', () => {
    expect(() => validateUpload({ body: Buffer.alloc(0), contentType: 'image/png' })).toThrow(
      /empty/i,
    );
  });

  it('rejects a file over the size limit', () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    expect(() => validateUpload({ body: oversized, contentType: 'image/png' })).toThrow(
      /MB or smaller/,
    );
  });

  it('rejects a disallowed content type', () => {
    expect(() => validateUpload({ body: PNG, contentType: 'application/x-msdownload' })).toThrow(
      /not accepted/,
    );
  });

  // A declared Content-Type is just a claim. These are the cases that matter:
  // an executable or script renamed to look like an image.
  describe('magic-number enforcement', () => {
    it('rejects contents that do not match the declared type', () => {
      expect(() => validateUpload({ body: PDF, contentType: 'image/png' })).toThrow(
        /do not match the declared type/,
      );
    });

    it('rejects an executable claiming to be an image', () => {
      const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Array(64).fill(0)]);
      expect(() => validateUpload({ body: elf, contentType: 'image/png' })).toThrow();
    });

    it('rejects an HTML/script payload claiming to be a PDF', () => {
      const html = Buffer.from('<script>alert(1)</script>'.padEnd(64, ' '));
      expect(() => validateUpload({ body: html, contentType: 'application/pdf' })).toThrow(
        /not a recognised/,
      );
    });
  });
});

describe('buildStorageKey', () => {
  it('discards the original filename', () => {
    const key = buildStorageKey('estate-1/residents/r-1', 'my passport scan.png');
    expect(key).not.toContain('my passport scan');
    expect(key).toMatch(/^estate-1\/residents\/r-1\/\d+-[a-f0-9]{24}\.png$/);
  });

  it('is unique per call, so uploads cannot overwrite each other', () => {
    const a = buildStorageKey('p', 'f.png');
    const b = buildStorageKey('p', 'f.png');
    expect(a).not.toBe(b);
  });

  // The filename is attacker-controlled; it must never influence the path.
  it.each([
    ['traversal in the filename', 'p', '../../../etc/passwd'],
    ['traversal in the prefix', '../../etc', 'f.png'],
    ['null byte', 'p', 'f.png\0.sh'],
  ])('neutralises %s', (_label, prefix, filename) => {
    const key = buildStorageKey(prefix, filename);
    expect(key).not.toContain('..');
    expect(key).not.toContain('\0');
  });

  it('falls back to a safe extension for suspicious ones', () => {
    expect(buildStorageKey('p', 'file.php5678901234')).toMatch(/\.bin$/);
    expect(buildStorageKey('p', 'noextension')).toMatch(/\.bin$/);
  });
});

describe('LocalStorageAdapter', () => {
  const storage = new LocalStorageAdapter(ROOT);

  it('round-trips a file', async () => {
    const stored = await storage.upload({
      prefix: 'estate-1/docs',
      filename: 'scan.png',
      contentType: 'image/png',
      body: PNG,
    });

    expect(stored.size).toBe(PNG.length);
    expect(stored.checksum).toHaveLength(64);
    expect(await storage.exists(stored.key)).toBe(true);
    expect(await storage.download(stored.key)).toEqual(PNG);
  });

  it('deletes a file', async () => {
    const stored = await storage.upload({
      prefix: 'estate-1/docs',
      filename: 'x.png',
      contentType: 'image/png',
      body: PNG,
    });

    await storage.delete(stored.key);
    expect(await storage.exists(stored.key)).toBe(false);
  });

  it('reports a missing file as not found', async () => {
    await expect(storage.download('estate-1/does-not-exist.png')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // Last line of defence: even a crafted key must not escape the storage root.
  it('refuses to read outside the storage root', async () => {
    await expect(storage.download('../../../../etc/passwd')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('validates on upload, so invalid files never reach disk', async () => {
    await expect(
      storage.upload({
        prefix: 'p',
        filename: 'evil.png',
        contentType: 'image/png',
        body: Buffer.from('<script>alert(1)</script>'),
      }),
    ).rejects.toThrow();
  });
});
