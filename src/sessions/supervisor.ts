// One session, one supervisor process. This is the body of `oh-my-agents __session`.
//
// IT IS A SEPARATE PROCESS BECAUSE CRITERION 6 SAYS SO. "The session survives a host restart" is
// not achievable by a host that owns the PTY: when that process dies the PTY master closes, the
// agent gets SIGHUP, and no amount of on-disk state brings it back. So the host does not own it.
// The host spawns a detached supervisor, and thereafter is a CLIENT of it over a unix socket. Kill
// the host, start a new one, and the supervisor has not noticed: the agent never saw an interruption
// because nothing it was connected to went away.
//
// The supervisor also owns the transcript, and that ownership is what makes criterion 5 provable.
// See `serve()` below — the ACK and the subscriber registration happen in ONE synchronous block,
// and appends are `writeSync`, so there is no instant at which a byte is neither in the file before
// the acknowledged offset nor on the wire after it.

import { spawnSync } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, openSync, readFileSync, writeFileSync, writeSync, type WriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import { unlinkSync } from 'node:fs';
import {
  coerceMeta,
  sessionAgentStatusFile,
  sessionExitFile,
  sessionMetaFile,
  sessionInputFifo,
  sessionSocketFile,
  sessionTranscriptFile,
  type SessionExit,
  type SessionMeta,
} from './paths.js';
import { FRAME, FrameReader, sendFrame, type AckPayload } from './protocol.js';
import { detectPtySupport, ptyEnv, spawnUnderPty } from './pty.js';
import type { PathEnv } from '../paths.js';

/** Ctrl+C. Sent as a BYTE INTO THE PTY, not as a signal — see `interrupt` handling in the host. */
export const CTRL_C = Buffer.from([0x03]);

export interface SupervisorOptions {
  id: string;
  env: PathEnv & NodeJS.ProcessEnv;
}

/** Create the named pipe carrying keystrokes. `mkfifo(1)` because Node has no mkfifo(3). */
export function makeFifo(path: string): { ok: true } | { ok: false; reason: string } {
  if (existsSync(path)) return { ok: true };
  const r = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: `mkfifo could not be run: ${String(r.error)}` };
  if (r.status !== 0) return { ok: false, reason: `mkfifo failed: ${(r.stderr || '').trim() || `status ${r.status}`}` };
  return { ok: true };
}

/**
 * Run as the supervisor for session `id` until its agent exits. Returns the process exit code.
 *
 * This function never returns while the agent lives, and it always writes an exit record before it
 * returns. An absent exit record therefore MEANS something: it is the difference between "ended"
 * and "cannot tell", which criterion 6 requires be different answers.
 */
export async function runSupervisor(opts: SupervisorOptions): Promise<number> {
  const { id, env } = opts;

  const metaRaw = await readFile(sessionMetaFile(id, env), 'utf8');
  const meta = coerceMeta(JSON.parse(metaRaw) as unknown);
  if (!meta) {
    process.stderr.write(`session ${id}: its meta.json is not in a shape this version understands\n`);
    return 1;
  }

  const support = detectPtySupport();
  if (support.kind !== 'available') {
    writeExit(id, env, {
      schema: 1,
      endedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      reason:
        support.kind === 'absent'
          ? `this machine cannot allocate a pseudo-terminal: ${support.reason}`
          : `this machine could not be shown to allocate a pseudo-terminal: ${support.reason}`,
    });
    process.stderr.write(`session ${id}: ${support.reason}\n`);
    return 1;
  }

  const fifoPath = sessionInputFifo(id, env);
  const fifo = makeFifo(fifoPath);
  if (!fifo.ok) {
    writeExit(id, env, {
      schema: 1,
      endedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      reason: `the session's input pipe could not be created: ${fifo.reason}`,
    });
    return 1;
  }

  // O_RDWR, and held open for the life of the supervisor. A FIFO opened read-only would block until
  // a writer arrived, and would deliver EOF to `cat` the moment the last writer left — which would
  // end the agent's stdin the first time a browser tab closed. Holding a writer open forever is how
  // a detach stops being an EOF (criterion 5: detaching does not stop the agent).
  const fifoFd = openSync(fifoPath, 'r+');
  const fifoWriter: WriteStream = createWriteStream('', { fd: fifoFd });
  fifoWriter.on('error', () => {
    /* a closed pipe must not take the supervisor down; the agent's exit is the event that matters */
  });

  const transcriptFd = openSync(sessionTranscriptFile(id, env), 'a');

  const statusPath = sessionAgentStatusFile(id, env);
  const pty = spawnUnderPty({
    flavour: support.flavour,
    fifo: fifoPath,
    statusFile: statusPath,
    command: meta.command,
    args: meta.args,
    cwd: meta.cwd,
    env: ptyEnv(env),
  });

  const state = new SupervisorState(id, meta, transcriptFd);

  const onChunk = (chunk: Buffer): void => state.append(chunk);
  pty.child.stdout?.on('data', onChunk);
  pty.child.stderr?.on('data', onChunk);

  const server = net.createServer((socket) => state.serve(socket, fifoWriter, pty.child));
  server.on('error', (err) => {
    process.stderr.write(`session ${id}: control socket error: ${String(err)}\n`);
  });

  const sockPath = sessionSocketFile(id, env);
  try {
    unlinkSync(sockPath);
  } catch {
    /* nothing stale to remove */
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve());
  });

  // A supervisor outlives the terminal AND the host that spawned it. SIGHUP is ignored for the same
  // reason the host ignores it, and SIGTERM ends the AGENT first so an exit record is written.
  process.on('SIGHUP', () => {
    /* deliberately ignored: the point of this process is to outlive whatever spawned it */
  });
  const stopAgent = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pty.child.pid!, signal);
    } catch {
      try {
        pty.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  process.on('SIGTERM', () => stopAgent('SIGTERM'));
  process.on('SIGINT', () => stopAgent('SIGTERM'));

  // THE AGENT ENDS EXACTLY ONCE, and it can be noticed by either of two routes: the status file
  // the agent's wrapper writes, or the pipeline's own exit. Whichever arrives first is the answer;
  // `finish` is guarded so the second one changes nothing. Without the guard a session would get
  // two exit records and its subscribers two EXIT frames, and the second would overwrite the first
  // with a status that describes the PIPELINE rather than the agent.
  const code = await new Promise<number>((resolve) => {
    let finished = false;
    const finish = (record: SessionExit, exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearInterval(statusPoll);
      writeExit(id, env, record);
      state.broadcastExit(record);
      server.close();
      // The pipeline outlives the agent — `cat` is still blocked on a FIFO that will never reach
      // EOF — so it is taken down deliberately rather than waited for.
      stopAgent('SIGTERM');
      try {
        closeSync(transcriptFd);
      } catch {
        /* closing on the way out */
      }
      try {
        unlinkSync(sockPath);
      } catch {
        /* best effort */
      }
      // A moment for the EXIT frames to leave the socket buffers before the process goes.
      setTimeout(() => resolve(exitCode), 50);
    };

    // Polled rather than watched: `fs.watch` on a single file has different semantics on every
    // platform this could run on, and the thing being waited for happens once in a session's life.
    const statusPoll = setInterval(() => {
      let raw: string;
      try {
        raw = readFileSync(statusPath, 'utf8').trim();
      } catch {
        return; // not there yet: the agent is still running
      }
      const status = Number(raw);
      if (!Number.isInteger(status)) return;
      // A shell reports a signal death as 128 + the signal number, and there is no other place that
      // information exists by the time it reaches this file.
      const signal = status > 128 && status < 128 + 64 ? signalName(status - 128) : null;
      finish(
        {
          schema: 1,
          endedAt: new Date().toISOString(),
          exitCode: signal ? null : status,
          signal,
          reason: signal
            ? `the agent was terminated by ${signal}`
            : status === 0
              ? 'the agent exited normally'
              : `the agent exited with status ${status}`,
        },
        status,
      );
    }, 100);

    pty.child.on('exit', (exitCode, signal) => {
      finish(
        {
          schema: 1,
          endedAt: new Date().toISOString(),
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          reason:
            signal !== null && signal !== undefined
              ? `the agent was terminated by ${signal}`
              : exitCode === 0
                ? 'the agent exited normally'
                : `the agent exited with status ${exitCode}`,
        },
        exitCode ?? 0,
      );
    });
    pty.child.on('error', (err) => {
      finish(
        {
          schema: 1,
          endedAt: new Date().toISOString(),
          exitCode: null,
          signal: null,
          reason: `the agent could not be run: ${String(err)}`,
        },
        1,
      );
    });
  });

  return code;
}

/** The name of signal number `n`, or null when this platform does not have one by that number. */
function signalName(n: number): string | null {
  for (const [name, num] of Object.entries(os.constants.signals)) {
    if (num === n) return name;
  }
  return null;
}

function writeExit(id: string, env: PathEnv, record: SessionExit): void {
  try {
    writeFileSync(sessionExitFile(id, env), JSON.stringify(record, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`session ${id}: the exit record could not be written: ${String(err)}\n`);
  }
}

/** Subscribers, the transcript, and the atomic handoff between them. */
class SupervisorState {
  private subscribers = new Set<Socket>();
  /** Bytes appended to the transcript. Only ever advanced immediately after a successful write. */
  private written = 0;
  private ended: SessionExit | null = null;

  constructor(
    private readonly id: string,
    private readonly meta: SessionMeta,
    private readonly transcriptFd: number,
  ) {}

  /**
   * SYNCHRONOUS ON PURPOSE, ALL OF IT.
   *
   * `writeSync` then advance the counter then broadcast, with no `await` anywhere between them.
   * Node runs this to completion before it can accept a new connection, so a subscriber that is
   * acknowledged at offset N can never be registered "half way through" a chunk. Make this async
   * — a `writeFile`, a stream `.write` with a callback — and the counter and the file disagree for
   * a few microseconds, which is exactly the window a reattach under load lands in.
   */
  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    let off = 0;
    while (off < chunk.length) {
      try {
        off += writeSync(this.transcriptFd, chunk, off, chunk.length - off);
      } catch (err) {
        process.stderr.write(`session ${this.id}: transcript append failed: ${String(err)}\n`);
        break;
      }
    }
    this.written += off;
    for (const s of this.subscribers) sendFrame(s, FRAME.OUTPUT, chunk.subarray(0, off));
  }

  serve(socket: Socket, fifoWriter: WriteStream, child: { pid?: number | undefined }): void {
    socket.on('error', () => this.subscribers.delete(socket));
    socket.on('close', () => this.subscribers.delete(socket));

    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (err) {
        socket.destroy(err as Error);
        return;
      }
      for (const frame of frames) {
        switch (frame.type) {
          case FRAME.SUBSCRIBE: {
            // ── THE SEAM ──────────────────────────────────────────────────────────────────────
            // These two statements are one indivisible step as far as the output stream is
            // concerned: `append` cannot interleave between them, because neither yields. The
            // offset the client is told is therefore exactly the boundary between what it must
            // replay from the file and what it will receive on this socket.
            const ack: AckPayload = {
              offset: this.written,
              title: this.meta.title,
              startedAt: this.meta.startedAt,
              command: this.meta.command,
              args: this.meta.args,
            };
            sendFrame(socket, FRAME.ACK, JSON.stringify(ack));
            this.subscribers.add(socket);
            // ──────────────────────────────────────────────────────────────────────────────────
            if (this.ended) sendFrame(socket, FRAME.EXIT, JSON.stringify(this.ended));
            break;
          }
          case FRAME.INPUT:
            // Written to the PTY, NOT echoed to subscribers here. The pseudo-terminal's own line
            // discipline echoes it back down the output stream, which is why input typed in a
            // browser and input typed at this machine's terminal land in ONE interleaved history
            // (criterion 2) rather than two views that each echo their own half.
            fifoWriter.write(frame.payload);
            break;
          case FRAME.SIGNAL: {
            let signal = 'SIGTERM';
            try {
              const parsed = JSON.parse(frame.payload.toString('utf8')) as { signal?: unknown };
              if (typeof parsed.signal === 'string') signal = parsed.signal;
            } catch {
              /* keep the default */
            }
            if (!/^SIG[A-Z0-9]+$/.test(signal)) break;
            try {
              if (typeof child.pid === 'number') process.kill(-child.pid, signal as NodeJS.Signals);
            } catch {
              /* the agent is already gone; its exit record is the answer */
            }
            break;
          }
          default:
            // An unknown frame type is ignored rather than fatal: a newer host talking to an older
            // supervisor across a host upgrade must not take the session down.
            break;
        }
      }
    });
  }

  broadcastExit(record: SessionExit): void {
    this.ended = record;
    const payload = JSON.stringify(record);
    for (const s of this.subscribers) {
      sendFrame(s, FRAME.EXIT, payload);
      s.end();
    }
    this.subscribers.clear();
  }
}

/** Used by the host before spawning: make sure the session directory exists. */
export async function ensureSessionDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
