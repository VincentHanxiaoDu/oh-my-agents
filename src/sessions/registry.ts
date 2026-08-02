// The session registry. Issue #1 defined the interface and shipped an honest empty implementation;
// Issue #2 implements PTY-backed sessions behind it, which is what that file said would happen.
//
// WHAT A REGISTRY IS HERE. Not a map in memory. A host that kept its sessions in memory could not
// satisfy criterion 6 — restart it and the map is gone. The registry is a READER OF A DIRECTORY:
// each session is a directory with a meta record, a transcript, an exit record if it ended, and a
// detached supervisor process. `list()` is a scan. That is why a new host process finds the
// sessions the old one started, and why nothing has to be handed between them.
//
// THREE-VALUED, LIKE EVERYTHING ELSE IN THIS PROJECT. `tailnet.ts`, `state.ts`, `status.ts` and
// `lock.ts` all keep "determined to be nothing" apart from "could not determine", and criterion 6
// is that same distinction wearing different words: an ended session and a live session are never
// presented identically, and a session whose fate cannot be established is neither.
//
//   live         the supervisor process is alive and left no exit record
//   terminated   an exit record exists — WITH THE REASON IT SAYS
//   undetermined no exit record, and no live supervisor. Something ended this session without
//                recording how: a SIGKILL, a machine that lost power, a full disk. Saying
//                "terminated: exited normally" here would be inventing a reason we do not have.

import { spawn } from 'node:child_process';
import { openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isProcessAlive } from '../host/lock.js';
import { hostLogFile, type PathEnv } from '../paths.js';
import {
  coerceExit,
  coerceMeta,
  isValidSessionId,
  sessionDir,
  sessionExitFile,
  sessionMetaFile,
  sessionsDir,
  type SessionExit,
  type SessionMeta,
} from './paths.js';

/** Live, ended, or unknown. Never collapsed to a boolean anywhere a person can see it. */
export type SessionState = 'live' | 'terminated' | 'undetermined';

export interface SessionSummary {
  /** Stable identifier. Opaque to the client; #2 decides its shape. */
  id: string;
  /** What a person calls this session in a list. */
  title: string;
  /** ISO-8601. */
  startedAt: string;
  /**
   * Whether the underlying process is still alive.
   *
   * KEPT FOR THE INTERFACE ISSUE #1 PUBLISHED, and it is `state === 'live'` — which means it is
   * FALSE for an undetermined session as well as for an ended one. That is the safe direction for a
   * boolean to be wrong in, but it is still a lossy field: anything shown to a person reads
   * `state`, not this.
   */
  alive: boolean;
  state: SessionState;
  /** Prose, always populated. For `live` it says so; for the other two it says what we know. */
  reason: string;
  /** Present only when `state` is `terminated`. */
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  command: string;
  args: string[];
  cwd: string;
}

export interface SessionRegistry {
  list(): SessionSummary[];
  get(id: string): SessionSummary | undefined;
  count(): number;
}

/**
 * The registry Issue #1 shipped: it owns no sessions, and says so truthfully.
 * Still exported and still used — by tests, and by any host configured to own none.
 */
export function createEmptyRegistry(): SessionRegistry {
  return {
    list: () => [],
    get: () => undefined,
    count: () => 0,
  };
}

/** Thrown by every seam this project leaves for a later Issue. Never caught into a plausible default. */
export class NotImplementedOnThisIssue extends Error {
  constructor(what: string, issue: string) {
    super(`${what} is not implemented on this Issue; it belongs to ${issue}. This host refuses rather than pretending.`);
    this.name = 'NotImplementedOnThisIssue';
  }
}

export interface PtyRegistry extends SessionRegistry {
  /** The environment this registry reads its state directory from. */
  readonly env: PathEnv & NodeJS.ProcessEnv;
}

export function createPtyRegistry(env: PathEnv & NodeJS.ProcessEnv = process.env): PtyRegistry {
  const read = (id: string): SessionSummary | undefined => {
    if (!isValidSessionId(id)) return undefined;
    let meta: SessionMeta | null;
    try {
      meta = coerceMeta(JSON.parse(readFileSync(sessionMetaFile(id, env), 'utf8')) as unknown);
    } catch {
      return undefined;
    }
    if (!meta) return undefined;
    return summarise(meta, readExit(id, env));
  };

  const list = (): SessionSummary[] => {
    let entries: string[];
    try {
      entries = readdirSync(sessionsDir(env));
    } catch {
      // No sessions directory means no sessions: this host has never started one.
      return [];
    }
    const out: SessionSummary[] = [];
    for (const entry of entries) {
      if (!isValidSessionId(entry)) continue;
      try {
        if (!statSync(sessionDir(entry, env)).isDirectory()) continue;
      } catch {
        continue;
      }
      const summary = read(entry);
      if (summary) out.push(summary);
    }
    // Newest first: the session a person is looking for is the one they just started.
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return out;
  };

  return {
    env,
    list,
    get: read,
    // `count` is what Issue #1's status command prints as "sessions: N". It counts LIVE ones: a
    // host reporting "3 sessions" when all three ended last week would be reporting a filesystem,
    // not a machine's state.
    count: () => list().filter((s) => s.state === 'live').length,
  };
}

function readExit(id: string, env: PathEnv): SessionExit | null {
  try {
    return coerceExit(JSON.parse(readFileSync(sessionExitFile(id, env), 'utf8')) as unknown);
  } catch {
    return null;
  }
}

/** The three-valued answer, in one place so it cannot be decided differently in two callers. */
export function summarise(meta: SessionMeta, exit: SessionExit | null): SessionSummary {
  const base = {
    id: meta.id,
    title: meta.title,
    startedAt: meta.startedAt,
    command: meta.command,
    args: meta.args,
    cwd: meta.cwd,
  };

  if (exit) {
    return {
      ...base,
      alive: false,
      state: 'terminated',
      reason: exit.reason,
      endedAt: exit.endedAt,
      exitCode: exit.exitCode,
      signal: exit.signal,
    };
  }

  if (isProcessAlive(meta.supervisorPid)) {
    return { ...base, alive: true, state: 'live', reason: 'the agent is running' };
  }

  return {
    ...base,
    alive: false,
    state: 'undetermined',
    reason:
      `this session left no exit record and its supervisor (pid ${meta.supervisorPid}) is gone, so ` +
      'what happened to it CANNOT BE DETERMINED. It is not known to have ended and it is not ' +
      'running. Its transcript is still on disk and can be read.',
  };
}

export type SpawnResult =
  | { kind: 'spawned'; summary: SessionSummary }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string };

export interface SpawnOptions {
  command: string;
  args?: string[];
  title?: string;
  cwd?: string;
  env?: PathEnv & NodeJS.ProcessEnv;
  /** The compiled CLI entry point. Injected only by tests. */
  entry?: string;
}

function defaultEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');
}

/** Ids are short, lowercase, and collision-resistant. NOT a secret — authentication is Issue #5. */
export function newSessionId(): string {
  return `s${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.toLowerCase();
}

/**
 * Spawn a PTY-backed agent session, DETACHED FROM THIS HOST.
 *
 * `detached: true` plus `unref()` is not a nicety here: it is criterion 6. The supervisor must not
 * be in this process's process group, or stopping the host would take every session with it.
 *
 * This replaces Issue #1's refusing seam of the same name. Its signature changed — it takes an
 * options object and returns a result rather than throwing — because the refusing version could
 * not have had a useful one.
 */
/**
 * Written to a temp name and renamed. The supervisor reads this file the moment it starts, which is
 * concurrent with the host rewriting it with the real supervisor pid; a non-atomic rewrite gives
 * the supervisor half a JSON document and it refuses to start for a reason that is not real.
 */
async function writeMeta(meta: SessionMeta, env: PathEnv): Promise<void> {
  const target = sessionMetaFile(meta.id, env);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n');
  await rename(tmp, target);
}

export async function spawnSession(registry: PtyRegistry, opts: SpawnOptions): Promise<SpawnResult> {
  const env = opts.env ?? registry.env;
  const command = opts.command.trim();
  if (command === '') return { kind: 'refused', reason: 'a session needs a command to run' };

  const id = newSessionId();
  await mkdir(sessionDir(id, env), { recursive: true, mode: 0o700 });

  const meta: SessionMeta = {
    schema: 1,
    id,
    title: opts.title?.trim() || command,
    command,
    args: opts.args ?? [],
    cwd: opts.cwd ?? env.HOME ?? process.cwd(),
    startedAt: new Date().toISOString(),
    // Overwritten below with the supervisor's real pid. Written first because the supervisor reads
    // its own meta record on startup and must find one.
    supervisorPid: process.pid,
  };
  await writeMeta(meta, env);

  let pid: number | undefined;
  try {
    const out = openSync(hostLogFile(env), 'a');
    const child = spawn(process.execPath, [opts.entry ?? defaultEntry(), '__session', '--id', id], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ...(env.OMA_STATE_DIR ? { OMA_STATE_DIR: env.OMA_STATE_DIR } : {}) },
    });
    child.unref();
    pid = child.pid;
  } catch (err) {
    return { kind: 'failed', reason: `the session supervisor could not be spawned: ${String(err)}` };
  }
  if (typeof pid !== 'number') return { kind: 'failed', reason: 'the session supervisor was spawned without a pid' };

  meta.supervisorPid = pid;
  await writeMeta(meta, env);

  const summary = registry.get(id);
  if (!summary) return { kind: 'failed', reason: 'the session was spawned but its record could not be read back' };
  return { kind: 'spawned', summary };
}
