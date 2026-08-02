// RFC 6455, the subset this product uses, implemented here rather than installed.
//
// A WebSocket library would be a third dependency, and the argument in ARCHITECTURE.md against a
// linter applies harder to a transport: what runs would be chosen at install time by the machine.
// The subset that is actually needed is small and it is all here — handshake, masking, the three
// data opcodes, ping/pong, close, and fragmentation. What is NOT here is deliberate: no
// permessage-deflate (PTY output is already small and a compressor is a second place to have a
// buffer bug), no subprotocol negotiation, no extensions.
//
// BINARY FRAMES CARRY PTY BYTES AND TEXT FRAMES CARRY JSON CONTROL MESSAGES. That split is why
// nothing is base64-encoded anywhere: escape sequences reach the browser as the bytes the agent
// emitted, which is what criterion 7 needs, and a control message is never mistaken for output
// because it is a different opcode rather than a different prefix.

import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

// RFC 6455 §1.3, byte for byte. A typo here is not a compile error and not a local failure — both
// ends of a hand-written implementation agree on a wrong constant perfectly well. It is only a real
// browser that rejects the handshake, which is the one place it is expensive to find out. There is
// a test asserting the RFC's own worked example against this line.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** A frame larger than this is refused rather than buffered. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  return upgrade === 'websocket' && connection.split(',').some((c) => c.trim() === 'upgrade');
}

/**
 * Frames a message. `mask` is required for the CLIENT side and forbidden for the server side by the
 * RFC — a server that masks, or a client that does not, is rejected by conforming peers, and
 * browsers are conforming peers.
 */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) head.push((mask ? 0x80 : 0) | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    head.push((mask ? 0x80 : 0) | 127);
    const hi = Math.floor(len / 2 ** 32);
    head.push((hi >> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff);
    head.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ key[i % 4]!;
  return Buffer.concat([Buffer.from(head), key, masked]);
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Incremental, because a socket delivers whatever the kernel had, not whole frames. */
class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): ParsedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: ParsedFrame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) break;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) break;
        const big = this.buf.readBigUInt64BE(off);
        if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('websocket frame is larger than this host accepts');
        len = Number(big);
        off += 8;
      }
      if (len > MAX_MESSAGE_BYTES) throw new Error('websocket frame is larger than this host accepts');
      let key: Buffer | null = null;
      if (masked) {
        if (this.buf.length < off + 4) break;
        key = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) break;
      const raw = this.buf.subarray(off, off + len);
      let payload: Buffer;
      if (key) {
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = raw[i]! ^ key[i % 4]!;
      } else {
        payload = Buffer.from(raw);
      }
      out.push({ fin, opcode, payload });
      this.buf = this.buf.subarray(off + len);
    }
    return out;
  }
}

export interface WsEvents {
  binary: (data: Buffer) => void;
  text: (data: string) => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
}

/** One WebSocket connection, either end. */
export class WebSocketConnection extends EventEmitter {
  private parser = new FrameParser();
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  /** Set when the frame stream is unparseable. Nothing further is read from it. */
  private broken = false;

  constructor(
    private readonly socket: Duplex,
    /** True on the client side: the RFC requires clients, and only clients, to mask. */
    private readonly maskOutgoing: boolean,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    // A HALF-CLOSE IS A CLOSE, HERE. An upgraded socket is handed to us with `allowHalfOpen`, so a
    // peer that vanishes — a closed tab, a killed process, a train entering a tunnel — delivers
    // `end` and then nothing: no `close`, ever, unless we end our side too. Without this line the
    // host accumulates dead sockets, keeps its subscription to the supervisor open, and
    // `oh-my-agents stop` hangs for ten seconds waiting for connections that will never finish.
    // This was measured, not anticipated.
    socket.on('end', () => socket.end());
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', 1006, 'the connection dropped');
      }
    });
  }

  private onData(chunk: Buffer): void {
    // Once the framing is unparseable there is no way back into sync, and every further byte would
    // raise the same error again. Report it once, then stop reading.
    if (this.broken) return;
    let frames: ParsedFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.broken = true;
      this.emit('error', err as Error);
      this.close(1009, 'frame too large');
      return;
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.PING:
          this.raw(OPCODE.PONG, frame.payload);
          break;
        case OPCODE.PONG:
          break;
        case OPCODE.CLOSE: {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
          if (!this.closed) {
            this.closed = true;
            this.raw(OPCODE.CLOSE, frame.payload.subarray(0, 2));
            this.emit('close', code, reason);
          }
          this.socket.end();
          break;
        }
        case OPCODE.CONTINUATION:
          this.fragments.push(frame.payload);
          if (frame.fin) this.emitMessage(this.fragmentOpcode, Buffer.concat(this.fragments));
          break;
        default:
          if (frame.fin) {
            this.emitMessage(frame.opcode, frame.payload);
          } else {
            this.fragmentOpcode = frame.opcode;
            this.fragments = [frame.payload];
          }
      }
    }
  }

  /**
   * A MESSAGE THAT ARRIVES BEFORE ANYBODY IS LISTENING IS HELD, NOT DROPPED.
   *
   * Both ends of this handshake finish by handing back a connection whose caller then attaches its
   * handlers. Between those two moments the socket is already live — and `head`, the bytes that
   * arrived in the SAME TCP SEGMENT as the handshake, is unshifted into it. Under load a busy peer
   * routinely coalesces its first frames with the 101, so `head` is not the rare case it looks
   * like. An `emit` with no listener is a silently discarded message, and what it discards is the
   * FIRST thing said on the connection: the `session` and `attached` events an attach opens with.
   *
   * This was found by a test that only failed when the whole suite ran at once, which is exactly
   * the load that makes the coalescing likely.
   */
  private earlyMessages: Array<{ event: 'binary' | 'text'; payload: Buffer | string }> = [];

  private emitMessage(opcode: number, payload: Buffer): void {
    this.fragments = [];
    if (opcode === OPCODE.BINARY) this.deliver('binary', payload);
    else if (opcode === OPCODE.TEXT) this.deliver('text', payload.toString('utf8'));
  }

  /**
   * Set the first time a message listener is attached — the moment the caller has finished wiring
   * itself up. Queueing stops for good then, rather than being decided per message: a consumer that
   * legitimately listens to only one of the two kinds must not have the other kind pile up in front
   * of it forever. The window this queue exists for opens at construction and closes here.
   */
  private wired = false;

  private deliver(event: 'binary' | 'text', payload: Buffer | string): void {
    // The second condition is not redundant: between `wired` being set and the queue being drained
    // there is a turn of the event loop, and a message emitted directly during it would arrive
    // BEFORE the ones already held. On an attach that is live output overtaking the replay it
    // belongs after — the seam of criterion 5, broken by an ordering bug rather than a byte one.
    if (!this.wired || this.earlyMessages.length > 0) {
      this.earlyMessages.push({ event, payload });
      return;
    }
    this.emit(event, payload as never);
  }

  override on(event: string | symbol, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    if (!this.wired && (event === 'binary' || event === 'text')) {
      this.wired = true;
      // Drained on a later turn, so the caller can finish attaching the REST of its listeners
      // first. Attaching `binary` and `text` is two statements, and a flush between them would
      // deliver every held `text` to nobody.
      queueMicrotask(() => {
        // Shifted one at a time rather than swapped out wholesale, so a message that arrives DURING
        // the drain lands at the back of the same queue and is delivered in its turn.
        while (this.earlyMessages.length > 0) {
          const m = this.earlyMessages.shift()!;
          this.emit(m.event, m.payload as never);
        }
      });
    }
    return this;
  }

  private raw(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload, this.maskOutgoing));
  }

  sendBinary(data: Buffer): void {
    if (this.closed) return;
    this.raw(OPCODE.BINARY, data);
  }

  sendText(data: string): void {
    if (this.closed) return;
    this.raw(OPCODE.TEXT, Buffer.from(data, 'utf8'));
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) {
      this.socket.end();
      return;
    }
    this.closed = true;
    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.raw(OPCODE.CLOSE, payload);
    this.socket.end();
  }

  /** Cut the connection without a close handshake — what a lost network looks like. */
  destroy(): void {
    this.socket.destroy();
  }
}

/**
 * Complete the server side of the handshake and return the connection, or refuse in words.
 * A refused upgrade gets an HTTP response, not a dropped socket: a dropped socket is
 * indistinguishable from a bug in the client, and costs whoever is debugging it an afternoon.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key'];
  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (!isWebSocketUpgrade(req) || typeof key !== 'string' || version !== '13') {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n' +
        'this endpoint speaks WebSocket version 13\n',
    );
    return null;
  }
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  );
  const conn = new WebSocketConnection(socket, false);
  if (head.length > 0) socket.unshift(head);
  return conn;
}

export type ConnectResult =
  | { kind: 'connected'; connection: WebSocketConnection }
  | { kind: 'refused'; status: number; body: string }
  | { kind: 'failed'; reason: string };

/**
 * The client side. Used by `oh-my-agents attach` — the command a person runs AT THE MACHINE'S OWN
 * TERMINAL — and by the tests. It goes through the host's HTTP server exactly as the browser does,
 * which is why criterion 2's "one interleaved history" is structural rather than something that has
 * to be kept true: there is one path into the PTY and both ends use it.
 */
export function connectWebSocket(opts: { host: string; port: number; path: string; headers?: Record<string, string> }): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      host: opts.host,
      port: opts.port,
      path: opts.path,
      headers: {
        ...opts.headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    req.on('upgrade', (res, socket, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        resolve({ kind: 'failed', reason: 'the host returned a Sec-WebSocket-Accept that does not match' });
        return;
      }
      const conn = new WebSocketConnection(socket, true);
      if (head.length > 0) socket.unshift(head);
      resolve({ kind: 'connected', connection: conn });
    });

    // A plain response means the upgrade was REFUSED and said why — the body is that reason, and it
    // is surfaced rather than flattened into "connection failed".
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ kind: 'refused', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ kind: 'failed', reason: String(err) }));
    req.end();
  });
}
