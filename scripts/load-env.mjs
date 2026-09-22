/**
 * Load env files before a script runs.
 *
 * tsx does not read `.env.local` on its own, so any script booting the
 * application outside Next — seeds, jobs, benchmarks — would fail config
 * validation with a message that looks like missing configuration rather than a
 * missing loader.
 *
 * Preloaded via `tsx --import ./scripts/load-env.mjs`. A real shell variable
 * still wins, matching Next's own precedence.
 */
import { existsSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;

  try {
    process.loadEnvFile(file);
  } catch {
    // A malformed file should surface from config validation with a useful
    // message, not as a cryptic loader crash.
  }
}
