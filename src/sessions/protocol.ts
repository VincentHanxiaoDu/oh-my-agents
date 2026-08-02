// The wire between a session's supervisor and whoever is talking to it.
//
// It is a unix socket rather than anything reachable, because a session supervisor is not a network
// service: the only process that should be able to type into somebody's agent is the host on the
// same machine, and filesystem permissions on the state directory say so without a second auth
// story. (Authentication of BROWSERS is Issue #5 and lives in front of the host, not here.)
//
// Frames are length-prefixed and typed. A newline-delimited protocol would be wrong: PTY output is
// arbitrary bytes and contains newlines by definition, and a protocol whose delimiter appears in
// its payload is a protocol that eventually mangles somebody's terminal.
//
//   uint32be length (of type + payload)   uint8 type   payload…
//
// THE ONE FRAME THAT CARRIES THE WHOLE OF CRITERION 5 is `ACK`. Its `offset` is the exact number of
// transcript bytes that existed at the instant this subscriber was registered. The supervisor
// guarantees — by doing both in one synchronous block, and by appending with `writeSync` — that
// every byte before `offset` is in the transcript file and every byte from `offset` onward arrives
// as an `OUTPUT` frame on this connection. Replay `[offset-budget, offset)` and concatenate: no
// byte appears twice, no byte is missing. That is the seam, and it is a property of this frame.

import type { Socket } from 'node:net';

export const FRAME = {
  /** client → supervisor: register for live output. Answered by exactly one ACK. */
  SUBSCRIBE: 0x01,
  /** client → supervisor: bytes to write into the PTY, verbatim. */
  INPUT: 0x02,
  /** client → supervisor: JSON `{signal}` — deliver a signal to the agent's process group. */
  SIGNAL: 0x03,
  /** supervisor → client: JSON `{offset, meta}`. */
  ACK: 0x81,
  /** supervisor → client: raw PTY bytes. */
  OUTPUT: 0x82,
  /** supervisor → client: JSON SessionExit. The session ended; this connection is about to close. */
  EXIT: 0x83,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

/** A frame's payload is capped so a wedged peer cannot make a supervisor allocate without bound. */
export const MAX_FRAME_PAYLOAD = 4 * 1024 * 1024;

export function encodeFrame(type: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(body.length + 1, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, body]);
}

export interface Frame {
  type: number;
  payload: Buffer;
}

/**
 * Incremental frame reader. Sockets deliver whatever the kernel had; a reader that assumes one
 * `data` event is one frame works on a laptop and fails under load, which is the exact condition
 * criterion 5 is tested under.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len - 1 > MAX_FRAME_PAYLOAD) throw new Error(`frame length ${len} is out of range`);
      if (this.buf.length < 4 + len) break;
      const type = this.buf.readUInt8(4);
      out.push({ type, payload: this.buf.subarray(5, 4 + len) });
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export function sendFrame(socket: Socket, type: number, payload?: Buffer | string): void {
  if (socket.destroyed) return;
  socket.write(encodeFrame(type, payload));
}

export interface AckPayload {
  /** Transcript length, in bytes, at the instant this subscriber was registered. */
  offset: number;
  title: string;
  startedAt: string;
  command: string;
  args: string[];
}
