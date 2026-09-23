import { randomInt } from 'node:crypto';

/**
 * The alphabet for codes a human reads aloud and another human types.
 *
 * No O/0, I/1 or S/5, because a pass code is read over a phone, copied from a
 * screenshot, and typed by an officer at a barrier in poor light. A code that is
 * technically unique but practically confusable costs more than the entropy it
 * saves.
 *
 * Shared by every pass type deliberately: visitor, exit and temporary codes are
 * all typed into the same field on the same handset by the same officer, so
 * they must all be unambiguous in the same way. A second alphabet somewhere
 * else is how the O/0 problem comes back.
 */
export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

/** A random, unambiguous, upper-case code. Six characters ≈ 30 bits. */
export function generateShortCode(length = 6): string {
  let code = '';
  for (let index = 0; index < length; index++) {
    code += SHORT_CODE_ALPHABET[randomInt(0, SHORT_CODE_ALPHABET.length)];
  }
  return code;
}
