// Shared machinery for the session tests: a real host, real detached supervisors, real sockets.
//
// NOTHING HERE IS A MOCK. The properties Issue #2 asserts — a session outliving its host, a seam
// between a replayed file and a live socket, two subscribers seeing one interleaved history — are
// properties of processes and file descriptors. A test double for any of them would be a test of
// the double.
//
// THE ENVIRONMENT IS PROBED, NOT NAMED. There is no hardcoded shell path, no assumed TERM, and no
// assumption that `claude` or any other agent runtime is installed — CI will not have one. The PTY
// program used throughout is `process.execPath`, which is by definition present, driven by a script
// this file writes. When the machine cannot allocate a pty at all, `skipIfNoPty` reports that as
// the reason for a SKIP rather than letting the suite fail for a reason that is not about the code.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { detectPtySupport } from '../../src/sessions/pty.js';
import { connectWebSocket, type WebSocketConnection } from '../../src/server/ws.js';
import { attachPathFor } from '../../src/server/seams.js';

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'main.js');

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Returns a skip reason when this machine cannot allocate a pseudo-terminal, or null when it can. */
export function skipIfNoPty(): string | null {
  const support = detectPtySupport();
  if (support.kind === 'available') return null;
  return `this machine cannot be shown to allocate a pseudo-terminal (${support.kind}): ${support.reason}`;
}

export interface Host {
  dir: string;
  port: number;
  /**
   * Supervisor pids this host started, remembered as they are started.
   *
   * The on-disk record is the normal way to find them, but one test deliberately CORRUPTS a
   * session's `meta.json` to prove an unreadable record is not counted as anything — and after it
   * does, that session's pid exists nowhere on disk. Remembering it here is what stops that test
   * from leaking a runaway process on every run.
   */
  spawnedPids: number[];
  stop(): Promise<void>;
  /** Stop the host process but leave the state directory — for the host-restart tests. */
  stopKeepingState(): Promise<void>;
  restart(): Promise<void>;
  api(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }>;
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

let nextPort = 18800 + Math.floor(Math.random() * 400);

export async function startHost(): Promise<Host> {
  const dir = await mkdtemp(path.join(tmpdir(), 'oma-session-'));
  const port = nextPort++;

  const host: Host = {
    dir,
    port,
    spawnedPids: [],
    async cli(args) {
      return runCli(dir, args);
    },
    async api(method, route, body) {
      return apiCall(port, method, route, body);
    },
    async restart() {
      const r = await runCli(dir, ['--port', String(port)]);
      if (r.code !== 0) throw new Error(`the host did not start: ${r.stderr}${r.stdout}`);
    },
    async stopKeepingState() {
      await runCli(dir, ['stop']);
    },
    async stop() {
      await runCli(dir, ['stop']);
      // AND THE SESSIONS, WHICH THE HOST DELIBERATELY DOES NOT TAKE WITH IT.
      //
      // Criterion 6 is that a supervisor outlives its host, so stopping the host leaves every
      // session this test started running — and the programs these tests run are infinite loops.
      // Deleting the state directory does not reap them; it only makes them unfindable. A suite
      // that leaks one runaway process per session per run eventually loads the machine enough
      // that the timing-sensitive seam tests fail for a reason that has nothing to do with the
      // code. So the harness ends what the harness began, using the same on-disk record a person
      // running `oh-my-agents kill` would.
      await killSupervisors(dir, host.spawnedPids);
      await rm(dir, { recursive: true, force: true });
    },
  };

  await host.restart();
  return host;
}

/** SIGKILL every supervisor recorded under `stateDir`, and the process group each one leads. */
async function killSupervisors(stateDir: string, remembered: number[]): Promise<void> {
  const pids = new Set<number>(remembered);
  let ids: string[] = [];
  try {
    ids = await readdir(path.join(stateDir, 'sessions'));
  } catch {
    /* this host never started a session; the remembered list may still have entries */
  }
  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(path.join(stateDir, 'sessions', id, 'meta.json'), 'utf8')) as {
        supervisorPid?: number;
      };
      if (typeof meta.supervisorPid === 'number') pids.add(meta.supervisorPid);
    } catch {
      /* an unreadable record: this pid can only come from the remembered list */
    }
  }
  for (const pid of pids) {
    // The supervisor first, so it stops restarting nothing, then its group — the pty pipeline is a
    // shell, a `cat`, a `script` and the agent, and killing one of four leaves three.
    for (const target of [pid, -pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        /* already gone, which is the desired state */
      }
    }
  }
}

export function runCli(stateDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, OMA_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** `oh-my-agents attach`, with a pipe for stdin — the machine's-own-terminal client. */
export function spawnCliAttach(stateDir: string, id: string): ChildProcess {
  return spawn(process.execPath, [CLI, 'attach', id], {
    env: { ...process.env, OMA_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function apiCall(port: number, method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A client of the attach WebSocket that records everything it was sent, in order. */
export interface Client {
  connection: WebSocketConnection;
  chunks: Buffer[];
  events: any[];
  text(): string;
  waitForText(pattern: RegExp, timeoutMs?: number): Promise<string>;
  waitForEvent(type: string, timeoutMs?: number): Promise<any>;
  close(): void;
  /** Cut the socket with no close handshake — what a lost network looks like. */
  drop(): void;
}

export async function attachClient(port: number, id: string): Promise<Client> {
  const result = await connectWebSocket({ host: '127.0.0.1', port, path: attachPathFor(id) });
  if (result.kind !== 'connected') throw new Error(`could not attach: ${JSON.stringify(result)}`);
  const conn = result.connection;
  const chunks: Buffer[] = [];
  const events: any[] = [];
  conn.on('binary', (d: Buffer) => chunks.push(d));
  conn.on('text', (t: string) => {
    try {
      events.push(JSON.parse(t));
    } catch {
      /* not our protocol; ignored */
    }
  });

  const client: Client = {
    connection: conn,
    chunks,
    events,
    text: () => Buffer.concat(chunks).toString('utf8'),
    async waitForText(pattern, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = client.text();
        if (pattern.test(text)) return text;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern} in:\n${JSON.stringify(text)}`);
        await sleep(25);
      }
    },
    async waitForEvent(type, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((e) => e.type === type);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for a '${type}' event; saw ${JSON.stringify(events)}`);
        await sleep(25);
      }
    },
    close: () => conn.close(1000, 'test done'),
    drop: () => conn.destroy(),
  };
  return client;
}

/**
 * A PTY program that emits `#N#` forever, one line every `intervalMs`.
 *
 * It is `process.execPath` — the Node running this test, which is by definition installed — driving
 * a script passed with `-e`. Nothing about the machine is assumed: not a shell, not `yes`, not
 * `seq`, not a locale, not an agent runtime.
 */
export function counterProgram(intervalMs = 2): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `let i = 0; setInterval(() => { i++; process.stdout.write('#' + i + '#\\n'); }, ${intervalMs});`,
    ],
  };
}

/** Every `#N#` in a stream, in the order it appeared. Partial tokens at a truncated start are ignored. */
export function counters(text: string): number[] {
  return [...text.matchAll(/#(\d+)#/g)].map((m) => Number(m[1]));
}

export async function newSession(host: Host, command: string, args: string[]): Promise<string> {
  const res = await host.api('POST', '/api/sessions', { command, args });
  if (res.status !== 201) throw new Error(`the session was not started: ${JSON.stringify(res.json)}`);
  const id = res.json.session.id as string;
  // Remembered NOW, while the record is certainly readable. See `Host.spawnedPids`.
  try {
    const meta = JSON.parse(await readFile(path.join(host.dir, 'sessions', id, 'meta.json'), 'utf8')) as {
      supervisorPid?: number;
    };
    if (typeof meta.supervisorPid === 'number') host.spawnedPids.push(meta.supervisorPid);
  } catch {
    /* nothing to remember; `stop()` falls back to the directory scan */
  }
  return id;
}
