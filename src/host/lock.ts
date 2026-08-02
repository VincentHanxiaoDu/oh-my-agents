// The single-instance lock (criterion 7).
//
// TWO MECHANISMS, DELIBERATELY, BECAUSE EACH ONE ALONE HAS A HOLE:
//
//   the lock file  catches the second `start` BEFORE it does any work, so the user gets a sentence
//                  instead of a stack trace — but a lock file can go stale when a machine loses
//                  power, and a stale lock that refuses forever is worse than no lock.
//   the port bind  is the real mutex: the kernel arbitrates it and cannot be raced. It is what
//                  makes "two hosts serving the same sessions" impossible rather than unlikely.
//
// So the lock file is a courtesy with a staleness rule, and the port is the truth. The staleness
// rule is: a lock naming a pid that is not alive is stale and may be taken. A lock we cannot READ
// or PARSE is not stale and is not held — it is UNDETERMINED, and we refuse with a distinct exit
// code rather than either taking it (two hosts) or reporting a running host (a claim we cannot
// support).

import { closeSync, openSync, writeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { hostLockFile, stateDir, type PathEnv } from '../paths.js';

export interface LockContents {
  pid: number;
  startedAt: string;
}

export type AcquireResult =
  | { kind: 'acquired'; path: string }
  | { kind: 'held'; pid: number; startedAt: string }
  | { kind: 'undetermined'; reason: string };

/** Is this pid a live process? EPERM means alive and not ours, which is still alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(env: PathEnv = process.env): LockContents | 'absent' | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(hostLockFile(env), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'unreadable';
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return 'unreadable';
    return { pid: v.pid, startedAt: typeof v.startedAt === 'string' ? v.startedAt : '' };
  } catch {
    return 'unreadable';
  }
}

export function acquireLock(pid: number, env: PathEnv = process.env): AcquireResult {
  mkdirSync(stateDir(env), { recursive: true });
  const file = hostLockFile(env);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' is O_CREAT|O_EXCL: the kernel guarantees exactly one caller wins. Two `start`
      // invocations racing at the same millisecond therefore cannot both proceed.
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid, startedAt: new Date().toISOString() }) + '\n');
      } finally {
        closeSync(fd);
      }
      return { kind: 'acquired', path: file };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { kind: 'undetermined', reason: `the lock file could not be created (${(err as NodeJS.ErrnoException).code ?? String(err)})` };
      }
    }

    const existing = readLock(env);
    if (existing === 'absent') continue; // It vanished between the two calls; try once more.
    if (existing === 'unreadable') {
      return {
        kind: 'undetermined',
        reason: `a lock file exists at ${file} but this host cannot tell whose it is. It has NOT been taken and no host has been shown to be running. Remove it by hand if you are sure nothing is serving.`,
      };
    }
    if (isProcessAlive(existing.pid)) {
      return { kind: 'held', pid: existing.pid, startedAt: existing.startedAt };
    }
    // Stale: the owner is gone. Take it, once.
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { kind: 'undetermined', reason: `a stale lock at ${file} could not be removed (${(err as NodeJS.ErrnoException).code ?? String(err)})` };
      }
    }
  }

  return { kind: 'undetermined', reason: 'the lock could not be acquired and could not be shown to be held' };
}

/** Release only if we still own it — never delete a lock a different host has since taken. */
export function releaseLock(pid: number, env: PathEnv = process.env): void {
  const existing = readLock(env);
  if (existing === 'absent' || existing === 'unreadable') return;
  if (existing.pid !== pid) return;
  try {
    unlinkSync(hostLockFile(env));
  } catch {
    // Nothing to do: we are almost certainly exiting.
  }
}
