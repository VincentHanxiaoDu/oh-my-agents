// Named seams for the Issues that stack on this project's first one.
//
// Each is a real exported symbol with the signature the later Issue needs. `requireAuth` and
// `proxyToPeer` still REFUSE — the alternative, a permissive default, is what produces the failure
// this project is built against: a host that appears to have authentication because a function
// called `authenticate` exists and returns true. Neither of them is touched here; `requireAuth`
// belongs to Issue #5, which is being built in parallel with this one.
//
// `handleAttachUpgrade` was the seam for Issue #2 and IS Issue #2, so it is implemented below.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { NotImplementedOnThisIssue, type PtyRegistry } from '../sessions/registry.js';
import { attachSession, readScrollback } from '../sessions/attach.js';
import { scrollbackBudgetBytes } from '../sessions/scrollback.js';
import { isValidSessionId, sessionTranscriptFile } from '../sessions/paths.js';
import { acceptUpgrade } from './ws.js';

/** SEAM FOR ISSUE #5: pairing / authentication middleware in front of every route. NOT MINE. */
export function requireAuth(_req: IncomingMessage, _res: ServerResponse): never {
  throw new NotImplementedOnThisIssue('request authentication', 'Issue #5 (pair a device with a host)');
}

/** SEAM FOR ISSUE #3: proxying a request to a peer host on the same tailnet. NOT MINE. */
export function proxyToPeer(_peerId: string, _req: IncomingMessage, _res: ServerResponse): never {
  throw new NotImplementedOnThisIssue('peer proxying', 'Issue #3 (one view over several hosts)');
}

/** The path an attach arrives on. Exported so the client and the router cannot drift apart. */
export const ATTACH_PATH = /^\/api\/sessions\/([a-z0-9][a-z0-9-]{0,63})\/attach$/;

export function attachPathFor(id: string): string {
  return `/api/sessions/${id}/attach`;
}

export interface AttachContext {
  registry: PtyRegistry;
  budgetBytes?: number;
}

/**
 * ISSUE #2: the WebSocket upgrade that carries a terminal attach.
 *
 * The whole of criteria 1–5 passes through this function.
 *
 *  1. live output, no polling — output is pushed as binary frames as the supervisor produces it.
 *  2. input from the browser — binary frames the other way, written into the same PTY that this
 *     machine's own terminal writes into via `oh-my-agents attach`. One PTY, one line discipline,
 *     one echo: the interleaving is structural rather than something that has to be kept true.
 *  3. two devices — nothing here is exclusive. Each connection is an independent subscriber of the
 *     same supervisor, and the supervisor broadcasts. Neither can evict the other.
 *  4. interrupt without detaching — `{"type":"interrupt"}` writes 0x03 into the PTY and returns.
 *     There is deliberately NO code path from an interrupt to a close.
 *  5. the seam — `attachSession` buffers live output from the instant it subscribes and flushes it
 *     after the replay, so what leaves this socket is scrollback-then-live with no gap and no
 *     repeat. See src/sessions/attach.ts, which is where that is done and explained.
 */
export function handleAttachUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: AttachContext): void {
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const match = ATTACH_PATH.exec(url.pathname);
  if (!match) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nno attach endpoint at this path\n');
    return;
  }
  const id = match[1]!;
  if (!isValidSessionId(id)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nthat is not a session id\n');
    return;
  }

  const conn = acceptUpgrade(req, socket, head);
  if (!conn) return;

  void (async (): Promise<void> => {
    const budget = ctx.budgetBytes ?? scrollbackBudgetBytes(ctx.registry.env);
    const summary = ctx.registry.get(id);
    if (!summary) {
      conn.sendJson({ type: 'error', reason: `there is no session called ${id} on this machine` });
      conn.close(1008, 'no such session');
      return;
    }

    // AN ENDED SESSION AND A LIVE SESSION ARE NEVER PRESENTED IDENTICALLY (criterion 6). A session
    // that is not live cannot be attached to — but its history can still be read, and the client is
    // told WHICH of the two non-live answers this is, with the reason.
    if (summary.state !== 'live') {
      conn.sendJson({ type: 'session', session: summary });
      const replay = await readHistoryOnly(id, ctx.registry.env, budget);
      if (replay.length > 0) conn.sendBinary(replay);
      conn.sendJson({
        type: 'not-live',
        state: summary.state,
        reason: summary.reason,
        ...(summary.endedAt ? { endedAt: summary.endedAt } : {}),
      });
      conn.close(1000, summary.state);
      return;
    }

    const result = await attachSession({ id, env: ctx.registry.env, budgetBytes: budget });

    if (result.kind === 'unreachable') {
      // The registry said live and the supervisor did not answer. That is a THIRD thing, and it is
      // reported as itself rather than as "the session ended".
      conn.sendJson({
        type: 'error',
        state: 'undetermined',
        reason: `this session is recorded as running but its supervisor did not answer: ${result.reason}`,
      });
      conn.close(1011, 'supervisor unreachable');
      return;
    }

    const attachment = result.attachment;

    conn.sendJson({ type: 'session', session: summary });
    conn.sendJson({ type: 'attached', info: attachment.info, replayBytes: attachment.replay.length });
    // The replay and the live stream are the same kind of message on purpose. A client that has to
    // join two differently-shaped streams is a client with a seam of its own to get wrong.
    if (attachment.replay.length > 0) conn.sendBinary(attachment.replay);
    attachment.onOutput((chunk) => conn.sendBinary(chunk));
    attachment.onExit((record) => {
      conn.sendJson({ type: 'exit', ...record });
      conn.close(1000, 'the session ended');
    });
    attachment.onClose(() => conn.close(1011, 'the supervisor connection closed'));

    conn.on('binary', (data: Buffer) => attachment.write(data));
    conn.on('text', (text: string) => {
      let msg: { type?: unknown; signal?: unknown };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'interrupt') {
        // Ctrl+C, and NOTHING ELSE HAPPENS. The connection is not closed, the attachment is not
        // torn down, the supervisor is not signalled. Criterion 4 is that interrupting leaves the
        // person exactly where they were.
        attachment.interrupt();
      } else if (msg.type === 'signal' && typeof msg.signal === 'string') {
        attachment.signal(msg.signal);
      }
    });

    // Detaching — a closed tab, a train going into a tunnel — drops this socket and this
    // subscription. It does not touch the supervisor, the PTY, or the agent (criterion 5).
    conn.on('close', () => attachment.detach());
    conn.on('error', () => attachment.detach());
  })();
}

/** History for a session that is no longer live: read the transcript, subscribe to nothing. */
async function readHistoryOnly(id: string, env: PtyRegistry['env'], budget: number): Promise<Buffer> {
  const file = sessionTranscriptFile(id, env);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return Buffer.alloc(0);
  }
  return readScrollback(file, size, budget);
}
