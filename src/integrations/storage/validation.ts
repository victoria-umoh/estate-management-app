import { createHash, randomBytes } from 'node:crypto';
import { ValidationError } from '@/core/errors';
import { config } from '@/core/config';

/**
 * Magic-number signatures.
 *
 * A client-supplied Content-Type is just a claim. Checking the actual leading
 * bytes is what stops a polyglot or renamed file being stored as an image and
 * later served as something executable.
 */
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
];

function detectMimeType(buffer: Buffer): string | undefined {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (buffer.length < offset + signature.bytes.length) continue;

    const matches = signature.bytes.every((byte, i) => buffer[offset + i] === byte);
    if (matches) return signature.mime;
  }
  return undefined;
}

/** Validate size, declared type, and actual file contents. */
export function validateUpload(input: { contentType: string; body: Buffer }): void {
  if (input.body.length === 0) {
    throw new ValidationError('The uploaded file is empty.');
  }

  if (input.body.length > config.storage.maxFileSizeBytes) {
    const limitMb = Math.floor(config.storage.maxFileSizeBytes / 1024 / 1024);
    throw new ValidationError(`Files must be ${limitMb}MB or smaller.`);
  }

  if (!config.storage.allowedMimeTypes.includes(input.contentType)) {
    throw new ValidationError(
      `Files of type ${input.contentType} are not accepted. Allowed: ${config.storage.allowedMimeTypes.join(', ')}.`,
    );
  }

  const detected = detectMimeType(input.body);
  if (!detected) {
    throw new ValidationError('The file contents are not a recognised image or PDF.');
  }

  if (detected !== input.contentType) {
    throw new ValidationError(
      `The file contents (${detected}) do not match the declared type (${input.contentType}).`,
    );
  }
}

/**
 * Build a storage key.
 *
 * The original filename is discarded rather than sanitised. It is attacker
 * controlled and only ever a source of traversal and encoding bugs; the real
 * name is kept as database metadata, where it is data rather than a path.
 */
export function buildStorageKey(prefix: string, filename: string): string {
  const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : 'bin';
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
  const safePrefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, '').replace(/\.{2,}/g, '');

  return `${safePrefix}/${Date.now()}-${randomBytes(12).toString('hex')}.${safeExtension}`;
}

export function checksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
