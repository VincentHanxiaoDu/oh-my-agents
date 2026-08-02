// Process lifecycle: starting the host detached, and being the host once detached.
//
// CRITERION 6 IS "THE HOST SURVIVES THE TERMINAL THAT STARTED IT BEING CLOSED". That is achieved by
// three things together, and all three are needed:
//
//   detached: true   puts the child in its own session and process group, so the SIGHUP the kernel
//                    sends to the terminal's foreground group when the terminal goes away does not
//                    reach it. Without this, closing the terminal kills the host.
//   stdio to a file  because a detached child whose stdout is the closed terminal's pty gets EIO on
//                    its first write and dies — later, mysteriously, and only for users who closed
//                    the terminal, which is exactly the case the criterion is about.
//   unref()          lets the parent exit without waiting, so the command RETURNS.
//
// WHAT THIS DELIBERATELY DOES NOT DO: install a launchd agent, a systemd unit, or anything else
// that would bring the host back after a REBOOT. Issue #1 says that is an unsettled product
// decision. See `refuseUnsettledPersistence` in the CLI — the flags that would imply it refuse.

import { spawn } from 'node:child_process';
import { openSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostLockFile, hostLogFile, hostStateFile, stateDir, type PathEnv } from '../paths.js';
import { acquireLock, isProcessAlive, readLock, releaseLock } from './lock.js';
import { detectTailnet, type TailnetStatus } from './tailnet.js';
import { resolveBind } from './bind.js';
import { renderBanner } from './banner.js';
import { readHostRecord, writeHostRecord, type HostRecord } from './state.js';
import { startServer } from '../server/server.js';
import { createEmptyRegistry } from '../sessions/registry.js';
import { writeFileSync } from 'node:fs';

export const DEFAULT_PORT = 8787;

export type StartResult =
  | { kind: 'started'; banner: string; record: HostRecord }
  | { kind: 'already-running'; pid: number; message: string }
  | { kind: 'undetermined'; message: string }
  | { kind: 'failed'; message: string };

export interface StartOptions {
  port: number;
  env?: PathEnv & NodeJS.ProcessEnv;
  /** Path to the compiled CLI entry point. Injected only by tests. */
  entry?: string;
  readyTimeoutMs?: number;
}

function defaultEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');
}

/** The parent side of `oh-my-agents start`. Returns once the child is serving, or gives up. */
export async function startDetached(opts: StartOptions): Promise<StartResult> {
  const env = opts.env ?? process.env;
  await mkdir(stateDir(env), { recursive: true });

  // The lock is taken BEFORE anything is spawned, and it is taken by this process — so two `start`
  // commands racing cannot both reach the spawn. The child's pid replaces ours below.
  const lock = acquireLock(process.pid, env);
  if (lock.kind === 'held') {
    return {
      kind: 'already-running',
      pid: lock.pid,
      message:
        `A host is already running on this machine (pid ${lock.pid}, started ${lock.startedAt || 'at an unrecorded time'}).\n` +
        `Not starting a second one — two hosts would serve the same sessions from two places.\n` +
        `Run 'oh-my-agents status' to see it, or 'oh-my-agents stop' to stop it first.`,
    };
  }
  if (lock.kind === 'undetermined') {
    return { kind: 'undetermined', message: lock.reason };
  }

  const logPath = hostLogFile(env);
  let child;
  try {
    const out = openSync(logPath, 'a');
    child = spawn(process.execPath, [opts.entry ?? defaultEntry(), '__daemon', '--port', String(opts.port)], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...(env.OMA_STATE_DIR ? { OMA_STATE_DIR: env.OMA_STATE_DIR } : {}) },
    });
    child.unref();
  } catch (err) {
    releaseLock(process.pid, env);
    return { kind: 'failed', message: `the host process could not be spawned: ${String(err)}` };
  }

  const childPid = child.pid;
  if (typeof childPid !== 'number') {
    releaseLock(process.pid, env);
    return { kind: 'failed', message: 'the host process was spawned without a pid' };
  }

  // Hand the lock to the child, so that when this parent exits the lock still names a live process.
  try {
    writeFileSync(hostLockFile(env), JSON.stringify({ pid: childPid, startedAt: new Date().toISOString() }) + '\n');
  } catch (err) {
    return { kind: 'failed', message: `the lock could not be handed to the host process: ${String(err)}` };
  }

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 20000);
  while (Date.now() < deadline) {
    const read = await readHostRecord(env);
    if (read.kind === 'present' && read.record.pid === childPid) {
      const plan = {
        addresses: read.record.addresses,
        loopback: read.record.addresses.filter((a) => a === '127.0.0.1' || a === '::1'),
        tailnet: read.record.tailnetAddresses,
        reachability: read.record.reachability,
        determination: read.record.determination,
        reason: read.record.reason,
        rejected: [],
      };
      return { kind: 'started', banner: renderBanner({ plan, port: read.record.port, pid: childPid }), record: read.record };
    }
    if (!isProcessAlive(childPid)) {
      releaseLockIfOurs(childPid, env);
      return {
        kind: 'failed',
        message: `the host process exited before it began serving. Its output is in ${logPath}.`,
      };
    }
    await sleep(100);
  }

  return {
    kind: 'undetermined',
    message:
      `The host process (pid ${childPid}) is alive but has not reported that it is serving.\n` +
      `This host cannot tell whether it will. Its output is in ${logPath}.`,
  };
}

function releaseLockIfOurs(pid: number, env: PathEnv): void {
  const existing = readLock(env);
  if (existing !== 'absent' && existing !== 'unreadable' && existing.pid === pid) {
    try {
      unlinkSync(hostLockFile(env));
    } catch {
      /* exiting anyway */
    }
  }
}

/** The child side: this process IS the host. Returns only when it is asked to stop. */
export async function runDaemon(opts: { port: number; env?: PathEnv & NodeJS.ProcessEnv; detect?: () => Promise<TailnetStatus> }): Promise<void> {
  const env = opts.env ?? process.env;
  const status = await (opts.detect ? opts.detect() : detectTailnet());
  const plan = resolveBind(status);

  const registry = createEmptyRegistry();
  const startedAt = new Date().toISOString();
  const server = await startServer({ plan, port: opts.port, registry, startedAt });

  const record: HostRecord = {
    schema: 1,
    pid: process.pid,
    port: opts.port,
    addresses: plan.addresses,
    tailnetAddresses: plan.tailnet,
    reachability: plan.reachability,
    determination: plan.determination,
    reason: plan.reason,
    startedAt,
  };
  await writeHostRecord(record, env);

  // The banner also goes to the log, so a user who lost the terminal can still find the address.
  process.stdout.write(renderBanner({ plan, port: opts.port, pid: process.pid }) + '\n');

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void server.close().then(() => {
      try {
        unlinkSync(hostStateFile(env));
      } catch {
        /* already gone */
      }
      releaseLock(process.pid, env);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // SIGHUP is IGNORED, not handled: it is what a closing terminal sends, and criterion 6 says the
  // host keeps serving. `detached: true` already means it should not arrive; ignoring it means that
  // if it arrives by some other route (a user's `kill -HUP`, a session leader we did not expect)
  // the default action — terminate — does not quietly end the host.
  process.on('SIGHUP', () => {
    process.stdout.write('received SIGHUP and ignoring it: this host is meant to outlive its terminal.\n');
  });

  await new Promise<void>(() => {
    /* serve until signalled */
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
