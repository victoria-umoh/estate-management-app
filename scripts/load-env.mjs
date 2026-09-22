/**
 * Preload for tsx scripts.
 *
 * tsx does not read env files on its own, so any script booting the application
 * outside Next — seeds, jobs, benchmarks — would fail config validation with a
 * message that looks like missing configuration rather than a missing loader.
 *
 * Used as `tsx --import ./scripts/load-env.mjs`.
 */
import { loadEnvFiles } from './env-files.mjs';

loadEnvFiles();
