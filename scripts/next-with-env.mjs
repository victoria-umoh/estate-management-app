/**
 * Launch Next with PORT and HOST taken from the env file.
 *
 * Next reads `.env.local` only after its server has already bound a port, so a
 * PORT written there is ignored by `next dev` on its own. This loader reads the
 * env file first, then passes the value through as a CLI flag — which is the
 * one place Next honours it.
 *
 *   node scripts/next-with-env.mjs dev
 *   node scripts/next-with-env.mjs start
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const command = process.argv[2];
if (!command) {
  console.error('Usage: node scripts/next-with-env.mjs <dev|start|build>');
  process.exit(1);
}

// Later files do not override values already set, matching Next's own
// precedence: a real shell variable always wins over an env file.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // A malformed env file should surface from config validation with a
      // useful message, not as a cryptic loader crash here.
    }
  }
}

const port = process.env.PORT ?? '3000';
const host = process.env.HOST ?? 'localhost';

const args = [command];
if (command !== 'build') args.push('--port', port, '--hostname', host);

const child = spawn('next', [...args, ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
