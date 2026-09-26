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
import { loadEnvFiles } from './env-files.mjs';

const command = process.argv[2];
if (!command) {
  console.error('Usage: node scripts/next-with-env.mjs <dev|start|build>');
  process.exit(1);
}

loadEnvFiles();

const port = process.env.PORT ?? '3000';
const host = process.env.HOST ?? 'localhost';

const args = [command];
if (command !== 'build') args.push('--port', port, '--hostname', host);

const child = spawn('next', [...args, ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

// Pass shutdown on to Next, so a process manager stopping this wrapper stops
// the server too. Otherwise Next is orphaned still holding the port, and the
// restart that follows dies on EADDRINUSE.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
