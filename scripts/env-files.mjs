/**
 * Load env files, with correct precedence.
 *
 * Order of authority, strongest first: a real shell variable, then
 * `.env.local`, then `.env`. That matches Next's own behaviour and the ordinary
 * expectation that a local override file actually overrides.
 *
 * The implementation relies on a specific, verified property of
 * `process.loadEnvFile`: it does NOT overwrite a variable that is already set.
 * So the STRONGEST source is loaded first and later files only fill gaps — and
 * variables already present from the shell survive untouched, with no snapshot
 * or restore needed.
 *
 * Loading in the opposite order would silently invert the precedence, making
 * `.env` beat `.env.local` and a shell `PORT=4000` beat nothing at all.
 */
import { existsSync } from 'node:fs';

export function loadEnvFiles() {
  // Strongest first. `loadEnvFile` fills only what is missing, so anything
  // already set — by the shell, or by an earlier file — is preserved.
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;

    try {
      process.loadEnvFile(file);
    } catch {
      // A malformed file should surface from config validation with a useful
      // message, not as a cryptic loader crash.
    }
  }
}
