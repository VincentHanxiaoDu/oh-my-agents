// The session subcommands: `sessions`, `new`, `attach`, `kill`.
//
// `attach` IS THE HALF OF CRITERION 2 THAT IS EASY TO FORGET. The criterion is not "the browser can
// type"; it is that input from the browser and input typed AT THIS MACHINE'S OWN TERMINAL reach the
// same session and produce ONE interleaved history. That is only true if the terminal client is not
// a privileged special case — so it is not one. It connects to the same WebSocket on the same host
// over loopback, sends the same binary frames, and receives the same stream. Two subscribers of one
// supervisor, one pseudo-terminal, one echo.
//
// Everything here talks to the host over loopback rather than reaching into the state directory. A
// second writer poking at session files behind the host's back is how two views start to diverge.

import http from 'node:http';
import { EXIT } from './exit-codes.js';
import { readHostRecord } from '../host/state.js';
import { connectWebSocket, type WebSocketConnection } from '../server/ws.js';
import { attachPathFor } from '../server/seams.js';
import type { SessionSummary } from '../sessions/registry.js';

/** Ctrl+], the detach key. Chosen because it is what telnet and screen have used for decades. */
const DETACH_BYTE = 0x1d;

interface HostAddress {
  host: string;
  port: number;
}

type HostLookup = { kind: 'found'; address: HostAddress } | { kind: 'error'; code: number; message: string };

async function findHost(): Promise<HostLookup> {
  const read = await readHostRecord();
  if (read.kind === 'absent') {
    return { kind: 'error', code: EXIT.NOT_RUNNING, message: 'NOT RUNNING — no host is serving on this machine.' };
  }
  if (read.kind === 'undetermined') {
    return {
      kind: 'error',
      code: EXIT.UNDETERMINED,
      message: `COULD NOT DETERMINE whether a host is running: ${read.reason}\nThis is NOT the same answer as "not running".`,
    };
  }
  // Loopback, always. The host is on this machine; going via its tailnet address would leave the
  // machine and come back, and would fail on a host that is bound loopback-only.
  return { kind: 'found', address: { host: '127.0.0.1', port: read.record.port } };
}

async function api(
  address: HostAddress,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { ok: false, error: text };
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

/**
 * Render one session.
 *
 * THE THREE STATES ARE THREE DIFFERENT LINES, and none of them can be mistaken for another. This is
 * criterion 6 at the surface a person actually reads: "ended" carries its reason, "cannot tell"
 * says so in those words, and neither looks like "live".
 */
export function renderSession(s: SessionSummary): string {
  const mark = s.state === 'live' ? 'LIVE        ' : s.state === 'terminated' ? 'ENDED       ' : 'UNDETERMINED';
  const lines = [`${mark}  ${s.id}  ${s.title}`, `              started ${s.startedAt}`];
  if (s.state === 'terminated') lines.push(`              ${s.reason} (at ${s.endedAt})`);
  if (s.state === 'undetermined') lines.push(`              ${s.reason}`);
  return lines.join('\n');
}

export async function cmdSessions(): Promise<number> {
  const found = await findHost();
  if (found.kind === 'error') {
    process.stderr.write(found.message + '\n');
    return found.code;
  }
  const res = await api(found.address, 'GET', '/api/sessions');
  const body = res.json as { ok?: boolean; sessions?: SessionSummary[]; error?: string };
  if (!body.ok || !body.sessions) {
    process.stderr.write(`the host answered ${res.status}: ${body.error ?? 'no sessions in the answer'}\n`);
    return EXIT.ERROR;
  }
  if (body.sessions.length === 0) {
    process.stdout.write('no sessions on this machine.\n');
    return EXIT.OK;
  }
  for (const s of body.sessions) process.stdout.write(renderSession(s) + '\n');
  return EXIT.OK;
}

export async function cmdNew(argv: string[]): Promise<number> {
  const rest = argv.filter((a) => a !== '--');
  const command = rest[0];
  if (command === undefined) {
    process.stderr.write('usage: oh-my-agents new <command> [args...]\n');
    return EXIT.ERROR;
  }
  const found = await findHost();
  if (found.kind === 'error') {
    process.stderr.write(found.message + '\n');
    return found.code;
  }
  const res = await api(found.address, 'POST', '/api/sessions', { command, args: rest.slice(1) });
  const body = res.json as { ok?: boolean; session?: SessionSummary; error?: string; pty?: { kind?: string } };
  if (!body.ok || !body.session) {
    process.stderr.write(`the session was not started: ${body.error ?? `the host answered ${res.status}`}\n`);
    // A machine that cannot allocate a pty and a host that could not tell whether it can are
    // different answers, and they get different exit codes.
    if (body.pty?.kind === 'undetermined') return EXIT.UNDETERMINED;
    return EXIT.ERROR;
  }
  process.stdout.write(`${body.session.id}\n`);
  return EXIT.OK;
}

export async function cmdKill(argv: string[]): Promise<number> {
  const id = argv[0];
  if (id === undefined) {
    process.stderr.write('usage: oh-my-agents kill <session-id>\n');
    return EXIT.ERROR;
  }
  const found = await findHost();
  if (found.kind === 'error') {
    process.stderr.write(found.message + '\n');
    return found.code;
  }
  const res = await api(found.address, 'POST', `/api/sessions/${id}/signal`, { signal: 'SIGTERM' });
  const body = res.json as { ok?: boolean; error?: string; state?: string };
  if (!body.ok) {
    process.stderr.write(`${body.error ?? `the host answered ${res.status}`}\n`);
    return body.state === 'undetermined' ? EXIT.UNDETERMINED : EXIT.ERROR;
  }
  process.stdout.write(`SIGTERM sent to ${id}.\n`);
  return EXIT.OK;
}

/**
 * Attach this terminal to a session.
 *
 * Raw mode is what makes Ctrl+C work the way criterion 4 asks. In raw mode this process is handed
 * the BYTE 0x03 rather than having the kernel turn it into a SIGINT for us — so it goes down the
 * socket, into the session's pseudo-terminal, and interrupts THE AGENT. Nothing here detaches, and
 * the byte this process leaves on is Ctrl+] instead.
 */
export async function cmdAttach(argv: string[]): Promise<number> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (id === undefined) {
    process.stderr.write('usage: oh-my-agents attach <session-id>\n');
    return EXIT.ERROR;
  }
  const found = await findHost();
  if (found.kind === 'error') {
    process.stderr.write(found.message + '\n');
    return found.code;
  }

  const result = await connectWebSocket({
    host: found.address.host,
    port: found.address.port,
    path: attachPathFor(id),
  });
  if (result.kind === 'refused') {
    process.stderr.write(`the host refused the attach (${result.status}): ${result.body.trim()}\n`);
    return EXIT.ERROR;
  }
  if (result.kind === 'failed') {
    process.stderr.write(`could not attach: ${result.reason}\n`);
    return EXIT.ERROR;
  }

  return runTerminalAttach(result.connection, id);
}

function runTerminalAttach(conn: WebSocketConnection, id: string): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    let code: number = EXIT.OK;
    let settled = false;

    const restore = (): void => {
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(wasRaw);
        } catch {
          /* the terminal went away first */
        }
      }
      stdin.pause();
      stdin.removeListener('data', onInput);
    };

    const finish = (exitCode: number, message?: string): void => {
      if (settled) return;
      settled = true;
      restore();
      if (message) process.stderr.write('\n' + message + '\n');
      resolve(exitCode);
    };

    const onInput = (chunk: Buffer): void => {
      const detachAt = chunk.indexOf(DETACH_BYTE);
      if (detachAt !== -1) {
        if (detachAt > 0) conn.sendBinary(chunk.subarray(0, detachAt));
        conn.close(1000, 'detached from a terminal');
        finish(EXIT.OK, `detached from ${id}. The agent is still running.`);
        return;
      }
      conn.sendBinary(chunk);
    };

    conn.on('binary', (data: Buffer) => process.stdout.write(data));
    conn.on('text', (text: string) => {
      let msg: { type?: string; reason?: string; state?: string };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'error') {
        code = msg.state === 'undetermined' ? EXIT.UNDETERMINED : EXIT.ERROR;
        finish(code, msg.reason ?? 'the host reported an error');
      } else if (msg.type === 'not-live') {
        // The transcript above this line is real history. What follows says, unambiguously, that it
        // is history — a person must never mistake a replayed dead session for a live one.
        code = msg.state === 'undetermined' ? EXIT.UNDETERMINED : EXIT.NOT_RUNNING;
        finish(code, `THIS SESSION IS NOT LIVE (${msg.state}): ${msg.reason ?? ''}`);
      } else if (msg.type === 'exit') {
        finish(EXIT.OK, `the session ended: ${(msg as { reason?: string }).reason ?? ''}`);
      }
    });
    conn.on('close', () => finish(code));
    conn.on('error', (err: Error) => finish(EXIT.ERROR, `the connection failed: ${String(err)}`));

    if (stdin.isTTY) {
      try {
        stdin.setRawMode(true);
      } catch {
        process.stderr.write('this terminal would not go into raw mode; keystrokes are line-buffered.\n');
      }
    }
    stdin.resume();
    stdin.on('data', onInput);
    if (stdin.isTTY) {
      process.stderr.write(`attached to ${id}. Ctrl+] detaches; Ctrl+C interrupts the agent.\n`);
    }
  });
}
