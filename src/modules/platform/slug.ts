import { InternalError } from '@/core/errors';
import { estateRepository } from '@/modules/estate';

/**
 * Estate identifiers, derived server-side.
 *
 * A slug is never taken from a request. It is a platform-wide unique identifier
 * that appears in support tooling and in URLs, so a requester who could choose
 * one could squat another estate's name, collide with a reserved path, or plant
 * something that looks official.
 *
 * Shared by self-serve signup and by platform-staff provisioning so the two
 * cannot drift into different rules.
 */

/**
 * Slugs the product needs for itself.
 *
 * An estate calling itself `api` or `admin` is a trap waiting to be sprung.
 */
const RESERVED = new Set([
  'api',
  'admin',
  'app',
  'auth',
  'dashboard',
  'login',
  'logout',
  'platform',
  'pricing',
  'signup',
  'static',
  'support',
  'system',
  'www',
]);

/**
 * Reduce an estate name to a URL-safe stem.
 *
 * Deliberately lossy: anything outside `[a-z0-9-]` is dropped rather than
 * transliterated, and the result is capped well below the field's limit so a
 * uniqueness suffix always fits. A name that reduces to nothing — punctuation,
 * or a script this does not handle — falls back to a generic stem rather than
 * producing an empty slug.
 */
export function slugifyEstateName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    // Combining marks, left behind by the decomposition above.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

  return base.length >= 3 && !RESERVED.has(base) ? base : `estate-${base}`.slice(0, 48);
}

/**
 * A stem nobody else holds.
 *
 * The plain slug is tried once, then suffixed with random material. This races
 * — two signups for "Palm Grove" can both see the name free — which is why
 * `estateService.create` checks again inside its transaction and the whole
 * operation rolls back rather than producing a duplicate. Six attempts is far
 * past the point where a collision means something other than bad luck.
 */
export async function allocateEstateSlug(estateName: string): Promise<string> {
  const base = slugifyEstateName(estateName);

  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 7)}`;
    if (!(await estateRepository.findBySlug(candidate))) return candidate;
  }

  throw new InternalError('Could not allocate an identifier for the new estate.');
}
