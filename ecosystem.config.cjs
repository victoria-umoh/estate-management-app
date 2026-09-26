/**
 * PM2 process file for a self-hosted deployment.
 *
 *   pnpm build                                           # first, every deploy
 *   pm2 start ecosystem.config.cjs --env production      # start everything
 *   pm2 reload ecosystem.config.cjs --env production     # after a new build
 *   pm2 save && pm2 startup                              # survive a reboot
 *
 * `.cjs` because package.json declares `"type": "module"`, and PM2 loads this
 * file with require().
 *
 * Three kinds of process live here:
 *
 *  - `estate-web`, the Next server. Restarted automatically whenever it exits,
 *    with an exponential back-off so a crash loop (a bad env var, the database
 *    unreachable) does not spin the CPU, and recycled if it outgrows its memory
 *    budget.
 *  - `estate-worker`, which sends queued email and SMS (QUEUE_DRIVER=bullmq).
 *  - One entry per scheduled job. Each runs once and exits, so autorestart is
 *    OFF — PM2 would otherwise rerun a billing job the moment it finished — and
 *    `cron_restart` starts it again on schedule instead. PM2 also runs each one
 *    once at `pm2 start`; every job is safe to repeat (billing is protected by
 *    the invoice's unique period index), so that is harmless.
 *
 * Configuration still comes from `.env` / `.env.local`, loaded by the scripts
 * themselves. Values set here or in the shell take precedence over those files.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- PM2 require()s this file
const path = require('node:path');

const cwd = __dirname;
const bin = path.join(cwd, 'node_modules', '.bin');

// The start script spawns `next` by name; PM2 does not run through pnpm, so the
// project's binaries have to be on PATH explicitly.
const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
const envProduction = { ...env, NODE_ENV: 'production' };

const shared = {
  cwd,
  env,
  env_production: envProduction,
  time: true,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
};

/** A job from scripts/run-job.ts, run on a cron schedule. */
function job(name, schedule) {
  return {
    ...shared,
    name: `estate-job-${name}`,
    script: path.join(bin, 'tsx'),
    args: `--import ./scripts/load-env.mjs scripts/run-job.ts ${name}`,
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: false,
    cron_restart: schedule,
    out_file: path.join(cwd, 'logs', `job-${name}.out.log`),
    error_file: path.join(cwd, 'logs', `job-${name}.err.log`),
  };
}

module.exports = {
  apps: [
    {
      ...shared,
      name: 'estate-web',
      script: 'scripts/next-with-env.mjs',
      args: 'start',
      // Listen on every interface, not just localhost, so a reverse proxy or
      // another machine can reach it. Beats HOST in the env files, which only
      // fill gaps. Firewall the port if nothing but the proxy should see it.
      env: { ...env, HOST: '0.0.0.0' },
      env_production: { ...envProduction, HOST: '0.0.0.0' },
      interpreter: 'node',
      // Fork, not cluster: the wrapper spawns Next as a child, which PM2's
      // cluster mode cannot share a port with. Scale by running more hosts
      // behind the proxy instead.
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      // Back off 100ms, 150ms, 225ms... up to 15s between restarts while the
      // process keeps dying, resetting once it stays up for 30s.
      exp_backoff_restart_delay: 100,
      min_uptime: '30s',
      max_restarts: 50,
      // A leak should cost one restart, not the host.
      max_memory_restart: '1G',

      // Let in-flight requests finish before the process is killed.
      kill_timeout: 10000,
      listen_timeout: 60000,

      watch: false,
      out_file: path.join(cwd, 'logs', 'web.out.log'),
      error_file: path.join(cwd, 'logs', 'web.err.log'),
    },

    // Sends queued email and SMS. Exits at once, cleanly, unless
    // QUEUE_DRIVER=bullmq — so it is stopped, not crash-looped, on a host
    // running the inline queue.
    {
      ...shared,
      name: 'estate-worker',
      script: path.join(bin, 'tsx'),
      args: '--import ./scripts/load-env.mjs scripts/worker.ts',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      stop_exit_codes: [0],
      exp_backoff_restart_delay: 100,
      min_uptime: '30s',
      max_memory_restart: '512M',
      kill_timeout: 30000,
      out_file: path.join(cwd, 'logs', 'worker.out.log'),
      error_file: path.join(cwd, 'logs', 'worker.err.log'),
    },

    job('overstay-sweep', '*/10 * * * *'),
    job('sla-sweep', '0 * * * *'),
    job('report-schedules', '*/15 * * * *'),
    job('billing-run', '0 6 * * *'),
    job('mark-overdue', '30 6 * * *'),
    job('dunning', '0 7 * * *'),
  ],
};
