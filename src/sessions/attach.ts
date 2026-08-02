// Attaching to a session: the host side of the supervisor's socket.
//
// This is the module criterion 5 lives in. `attachSession` produces a stream that is, by
// construction, "recent scrollback, then live output, in order, with nothing duplicated and nothing
// dropped". The construction is four steps and the ORDER OF THEM IS THE POINT:
//
//   1. connect and SUBSCRIBE. From this instant the supervisor is sending us live output.
//   2. BUFFER every live byte that arrives. Do not deliver any of it yet.
//   3. read the transcript over [offset - budget, offset) and deliver that as the replay.
//   4. flush the buffer, then go live.
//
// Step 2 is what a naive implementation leaves out, and leaving it out is invisible on an idle
// session: with no output being produced during the read there is nothing to lose. Under load, the
// bytes produced while step 3 is reading the file are exactly the ones that vanish. So the tests
// for this drive continuous output across the detach and reattach.

import { open, type FileHandle } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { sessionSocketFile, sessionTranscriptFile, type SessionExit } from './paths.js';
import { FRAME, FrameReader, encodeFrame, type AckPayload } from './protocol.js';
import { alignTruncatedStart, scrollbackRange } from './scrollback.js';
import type { PathEnv } from '../paths.js';
import { coerceExit } from './paths.js';

export interface Attachment {
  /** What the supervisor said about the session when we attached. */
  info: AckPayload;
  /** Recent history, ending exactly at the byte the live stream begins with. */
  replay: Buffer;
  /** Live PTY bytes, in order, starting immediately after `replay`. */
  onOutput(fn: (chunk: Buffer) => void): void;
  /** The session ended while we were attached. */
  onExit(fn: (record: SessionExit) => void): void;
  onClose(fn: () => void): void;
  /** Keystrokes into the PTY. */
  write(bytes: Buffer): void;
  /**
   * Ctrl+C. Delivered as the BYTE 0x03 into the pseudo-terminal, which is what a terminal does:
   * the line discipline turns it into SIGINT for the foreground process group. Sending a signal to
   * the agent's pid instead would be a different thing — it would bypass the agent's own handling,
   * and it would not appear in the stream as `^C` the way the person expects.
   *
   * Nothing here closes the connection. Criterion 4 is that interrupting does not detach.
   */
  interrupt(): void;
  /** Ask the supervisor to signal the agent's process group. Used by "kill session", not by Ctrl+C. */
  signal(name: string): void;
  detach(): void;
}

export type AttachResult =
  | { kind: 'attached'; attachment: Attachment }
  | { kind: 'unreachable'; reason: string };

export interface AttachOptions {
  id: string;
  env: PathEnv;
  budgetBytes: number;
  connectTimeoutMs?: number;
}

export async function attachSession(opts: AttachOptions): Promise<AttachResult> {
  const sockPath = sessionSocketFile(opts.id, opts.env);

  let socket: Socket;
  try {
    socket = await connect(sockPath, opts.connectTimeoutMs ?? 5000);
  } catch (err) {
    return {
      kind: 'unreachable',
      reason: `the session's supervisor did not answer on ${sockPath} (${String(err)})`,
    };
  }

  const reader = new FrameReader();
  let info: AckPayload | null = null;

  // ── STEP 2: the buffer that makes the seam correct. Live output that arrives between the ACK and
  // the moment the replay has been handed to the caller is held here, not dropped and not delivered
  // early. It is flushed, in arrival order, the instant the caller is ready.
  let pending: Buffer[] | null = [];
  let outputFn: ((chunk: Buffer) => void) | null = null;
  let exitFn: ((r: SessionExit) => void) | null = null;
  let closeFn: (() => void) | null = null;
  let pendingExit: SessionExit | null = null;

  const deliver = (chunk: Buffer): void => {
    if (pending) pending.push(chunk);
    else outputFn?.(chunk);
  };

  const ackReady = new Promise<AckPayload>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (err) {
        reject(err);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME.ACK && info === null) {
          try {
            info = JSON.parse(frame.payload.toString('utf8')) as AckPayload;
          } catch (err) {
            reject(err);
            socket.destroy();
            return;
          }
          resolve(info);
        } else if (frame.type === FRAME.OUTPUT) {
          deliver(Buffer.from(frame.payload));
        } else if (frame.type === FRAME.EXIT) {
          const record = coerceExit(JSON.parse(frame.payload.toString('utf8')) as unknown);
          if (record) {
            if (pending) pendingExit = record;
            else exitFn?.(record);
          }
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => {
      closeFn?.();
      reject(new Error('the supervisor closed the connection before acknowledging the attach'));
    });
    // ── STEP 1
    socket.write(encodeFrame(FRAME.SUBSCRIBE));
  });

  let ack: AckPayload;
  try {
    ack = await ackReady;
  } catch (err) {
    socket.destroy();
    return { kind: 'unreachable', reason: `the session's supervisor did not acknowledge the attach: ${String(err)}` };
  }

  // ── STEP 3
  const replay = await readScrollback(sessionTranscriptFile(opts.id, opts.env), ack.offset, opts.budgetBytes);

  const attachment: Attachment = {
    info: ack,
    replay,
    onOutput(fn) {
      outputFn = fn;
      // ── STEP 4: flush what arrived during step 3, in order, then stop buffering. Assigning
      // `pending = null` AFTER the flush and in the same synchronous block is what stops a chunk
      // arriving mid-flush from being delivered out of order.
      const queued = pending ?? [];
      pending = null;
      for (const chunk of queued) fn(chunk);
      if (pendingExit) {
        const record = pendingExit;
        pendingExit = null;
        queueMicrotask(() => exitFn?.(record));
      }
    },
    onExit(fn) {
      exitFn = fn;
    },
    onClose(fn) {
      closeFn = fn;
    },
    write(bytes) {
      if (!socket.destroyed) socket.write(encodeFrame(FRAME.INPUT, bytes));
    },
    interrupt() {
      if (!socket.destroyed) socket.write(encodeFrame(FRAME.INPUT, Buffer.from([0x03])));
    },
    signal(name) {
      if (!socket.destroyed) socket.write(encodeFrame(FRAME.SIGNAL, JSON.stringify({ signal: name })));
    },
    detach() {
      socket.destroy();
    },
  };

  return { kind: 'attached', attachment };
}

/**
 * The last `budget` bytes of the transcript, ending EXACTLY at `offset`.
 *
 * Reading to `offset` rather than to the end of the file is not a detail. By the time this runs the
 * file has probably grown past `offset` — and every one of those extra bytes is already on its way
 * to us as a live frame. Reading to end-of-file would send them twice.
 */
export async function readScrollback(file: string, offset: number, budget: number): Promise<Buffer> {
  const { start, end, truncated } = scrollbackRange(offset, budget);
  const length = end - start;
  if (length <= 0) return Buffer.alloc(0);

  let fh: FileHandle;
  try {
    fh = await open(file, 'r');
  } catch {
    // No transcript is not an error: a session that has produced nothing yet has none.
    return Buffer.alloc(0);
  }
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return alignTruncatedStart(buf.subarray(0, bytesRead), truncated);
  } finally {
    await fh.close();
  }
}

/**
 * Connect to the supervisor's socket, RETRYING WHILE IT IS STILL COMING UP.
 *
 * A session is spawned and attached to in the same gesture — the browser posts `/api/sessions` and
 * opens the attach socket on the response. The supervisor is a separate process that has to be
 * scheduled, read its meta record, probe for a pty, mkfifo, and only then `listen`. Between the
 * spawn returning a pid and that `listen`, the socket file DOES NOT EXIST, and a connect against it
 * fails instantly with ENOENT. Failing the attach there would report "the supervisor did not
 * answer" about a supervisor that is starting normally — a race the person sees as a broken button.
 *
 * So ENOENT and ECONNREFUSED are treated as "not yet", not as "no": they are retried until
 * `timeoutMs` is spent, and only then reported. Every other error is final and reported at once —
 * EACCES on somebody else's state directory is not a condition that improves by waiting.
 */
function connect(path: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;

  const attempt = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(path);
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      const timer = setTimeout(() => {
        socket.removeListener('error', onError);
        socket.destroy();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, Math.max(1, deadline - Date.now()));
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(socket);
      });
      socket.once('error', onError);
    });

  const notYet = (err: unknown): boolean => {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ECONNREFUSED';
  };

  const retry = async (): Promise<Socket> => {
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        if (!notYet(err) || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };

  return retry();
}
