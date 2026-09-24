/**
 * Strip metadata from images.
 *
 * A resident photographing a damaged gate with their phone uploads the gate,
 * the timestamp, the handset model and — routinely — the GPS coordinates it was
 * taken at. Those coordinates are usually their own front door. Nothing in this
 * product ever reads EXIF, so the cheapest correct thing is to not keep it.
 *
 * This is a container-level edit, not a re-encode: the image data is copied
 * through byte for byte and only the metadata segments are dropped. That keeps
 * it dependency-free and lossless, at the cost of handling three formats by
 * hand rather than all of them. A format not handled here is passed through
 * unchanged and reported as such, so the caller never records "stripped" for a
 * file that was not.
 */

export interface StripResult {
  body: Buffer;
  stripped: boolean;
}

export function stripImageMetadata(body: Buffer, contentType: string): StripResult {
  switch (contentType) {
    case 'image/jpeg':
      return stripJpeg(body);
    case 'image/png':
      return stripPng(body);
    case 'image/webp':
      return stripWebp(body);
    default:
      return { body, stripped: false };
  }
}

/**
 * JPEG: drop APP1–APPF.
 *
 * APP1 carries EXIF and XMP — the GPS block lives there. APP0 (JFIF) is kept
 * because it carries pixel density rather than provenance, and some decoders
 * are unhappy without it.
 */
function stripJpeg(body: Buffer): StripResult {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return { body, stripped: false };

  const kept: Buffer[] = [body.subarray(0, 2)];
  let offset = 2;
  let stripped = false;

  while (offset + 4 <= body.length) {
    if (body[offset] !== 0xff) break;

    const marker = body[offset + 1]!;

    // Start of scan: everything from here is entropy-coded image data with no
    // further segment structure to walk. Copy the remainder verbatim.
    if (marker === 0xda) {
      kept.push(body.subarray(offset));
      offset = body.length;
      break;
    }

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(body.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = body.readUInt16BE(offset + 2);
    // A length under 2 would not advance, and is malformed. Stop rather than
    // loop: the validator has already confirmed this is a JPEG, so the safe
    // response is to keep what we have rather than to reject a real photo.
    if (length < 2 || offset + 2 + length > body.length) {
      kept.push(body.subarray(offset));
      offset = body.length;
      break;
    }

    const isMetadataSegment = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (isMetadataSegment) stripped = true;
    else kept.push(body.subarray(offset, offset + 2 + length));

    offset += 2 + length;
  }

  if (offset < body.length) kept.push(body.subarray(offset));

  return stripped ? { body: Buffer.concat(kept), stripped: true } : { body, stripped: false };
}

const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** PNG: walk the chunk list and drop the textual and EXIF chunks. */
function stripPng(body: Buffer): StripResult {
  if (body.length < 8) return { body, stripped: false };

  const kept: Buffer[] = [body.subarray(0, 8)];
  let offset = 8;
  let stripped = false;

  while (offset + 12 <= body.length) {
    const length = body.readUInt32BE(offset);
    const type = body.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > body.length) break;

    if (PNG_METADATA_CHUNKS.has(type)) stripped = true;
    else kept.push(body.subarray(offset, end));

    offset = end;
    if (type === 'IEND') break;
  }

  if (offset < body.length) kept.push(body.subarray(offset));

  return stripped ? { body: Buffer.concat(kept), stripped: true } : { body, stripped: false };
}

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);

/** WebP: a RIFF container. Drop the EXIF and XMP chunks and restate the size. */
function stripWebp(body: Buffer): StripResult {
  if (body.length < 12 || body.toString('ascii', 0, 4) !== 'RIFF') {
    return { body, stripped: false };
  }

  const kept: Buffer[] = [body.subarray(12, 12)];
  let offset = 12;
  let stripped = false;

  while (offset + 8 <= body.length) {
    const type = body.toString('ascii', offset, offset + 4);
    const length = body.readUInt32LE(offset + 4);
    // RIFF chunks are padded to an even length.
    const end = offset + 8 + length + (length % 2);
    if (end > body.length) break;

    if (WEBP_METADATA_CHUNKS.has(type)) stripped = true;
    else kept.push(body.subarray(offset, end));

    offset = end;
  }

  if (!stripped) return { body, stripped: false };

  const payload = Buffer.concat(kept);
  const header = Buffer.from(body.subarray(0, 12));
  // The RIFF size counts everything after the size field itself: the 'WEBP'
  // fourCC plus the chunks that survived.
  header.writeUInt32LE(4 + payload.length, 4);

  return { body: Buffer.concat([header, payload]), stripped: true };
}
