// Where a session's files live, and the two records that describe it.
//
// Everything here is under `stateDir()` from src/paths.ts. Issue #1 said plainly: later Issues put
// their files under the same directory using the same helper, and do not invent a second location.
// So this file NAMES paths and does not resolve a root of its own.
//
// THE FILE LAYOUT IS THE PERSISTENCE MECHANISM, not an implementation detail. Criterion 6 says a
// session survives the HOST process restarting. It does that because the session is not owned by
// the host at all: each session is a detached supervisor process with its own directory, and the
// host is a reader and a client of it. When the host dies and comes back it re-reads this directory
// and finds the sessions still running. Nothing is handed between host processes in memory, because
// nothing can be.

import path from 'node:path';
import { stateDir, type PathEnv } from '../paths.js';

/** The directory holding every session this machine owns. */
export function sessionsDir(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'sessions');
}

/** One session's directory. `id` is validated by `isValidSessionId` before it ever reaches here. */
export function sessionDir(id: string, env: PathEnv = process.env): string {
  return path.join(sessionsDir(env), id);
}

/** What the session is: written once at spawn, never rewritten. */
export function sessionMetaFile(id: string, env: PathEnv = process.env): string {
  return path.join(sessionDir(id, env), 'meta.json');
}

/** The raw PTY byte stream, appended to for the life of the session. */
export function sessionTranscriptFile(id: string, env: PathEnv = process.env): string {
  return path.join(sessionDir(id, env), 'transcript');
}

/**
 * Written by the supervisor when, and only when, it OBSERVED the session end. Its presence is the
 * difference between "this session ended, here is why" and "I cannot tell what happened to it".
 */
export function sessionExitFile(id: string, env: PathEnv = process.env): string {
  return path.join(sessionDir(id, env), 'exit.json');
}

/** The unix socket the supervisor serves: input in, live output out. */
export function sessionSocketFile(id: string, env: PathEnv = process.env): string {
  return path.join(sessionDir(id, env), 'ctl.sock');
}

/**
 * A named pipe carrying keystrokes into the PTY.
 *
 * It exists because of a real, measured constraint rather than a preference: `script(1)` calls
 * `tcgetattr` on its stdin, and Node's `stdio: 'pipe'` is a socketpair on macOS, on which that call
 * fails with EOPNOTSUPP and `script` exits 1 before running anything. A FIFO read by `cat` into a
 * shell pipeline gives `script` a real pipe(2), which it tolerates. See `src/sessions/pty.ts`.
 */
export function sessionInputFifo(id: string, env: PathEnv = process.env): string {
  return path.join(sessionDir(id, env), 'in.fifo');
}

/**
 * Where the agent writes its own exit status, as `<code>` or `<128+signal>` on one line.
 *
 * IT EXISTS BECAUSE THE PIPELINE CANNOT REPORT IT. The agent runs as `cat FIFO | script … agent`,
 * and `cat` is blocked reading a FIFO the supervisor deliberately holds open forever (that is what
 * makes a detach not an EOF — criterion 5). So `cat` never reaches EOF, the pipeline's shell never
 * finishes waiting, and the supervisor's `exit` event NEVER FIRES even though the agent died
 * seconds ago. Without this file the session reports `live` for a process that has ended, which is
 * exactly the confusion criterion 6 forbids.
 *
 * So the agent is wrapped in a one-line shell that records `$?` here as its last act. The
 * supervisor watches for this file, and its appearance is the authoritative "the agent ended".
 */
export function sessionAgentStatusFile(id: string, env: PathEnv = process.env): string {
  return path.join(sessionDir(id, env), 'agent-status');
}

export interface SessionMeta {
  schema: 1;
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  /** The detached supervisor. Its liveness is how a restarted host tells live from gone. */
  supervisorPid: number;
}

export interface SessionExit {
  schema: 1;
  endedAt: string;
  exitCode: number | null;
  signal: string | null;
  /** Prose, for a person. Never empty — an ended session always says why it ended. */
  reason: string;
}

/**
 * Session ids are used as a directory name and as a URL path segment, so they are constrained to
 * something that cannot be either of those things in disguise. A traversal through a session id
 * would reach the whole filesystem of a host that is, by design, reachable from every device on
 * somebody's tailnet.
 */
export function isValidSessionId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !id.includes('--');
}

export function coerceMeta(value: unknown): SessionMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) return null;
  if (typeof v.id !== 'string' || !isValidSessionId(v.id)) return null;
  if (typeof v.title !== 'string') return null;
  if (typeof v.command !== 'string') return null;
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === 'string')) return null;
  if (typeof v.cwd !== 'string') return null;
  if (typeof v.startedAt !== 'string') return null;
  if (typeof v.supervisorPid !== 'number' || !Number.isInteger(v.supervisorPid) || v.supervisorPid <= 0) return null;
  return {
    schema: 1,
    id: v.id,
    title: v.title,
    command: v.command,
    args: v.args as string[],
    cwd: v.cwd,
    startedAt: v.startedAt,
    supervisorPid: v.supervisorPid,
  };
}

export function coerceExit(value: unknown): SessionExit | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) return null;
  if (typeof v.endedAt !== 'string') return null;
  if (v.exitCode !== null && typeof v.exitCode !== 'number') return null;
  if (v.signal !== null && typeof v.signal !== 'string') return null;
  if (typeof v.reason !== 'string' || v.reason === '') return null;
  return {
    schema: 1,
    endedAt: v.endedAt,
    exitCode: v.exitCode as number | null,
    signal: v.signal as string | null,
    reason: v.reason,
  };
}
