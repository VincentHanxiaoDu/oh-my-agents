// The WebSocket implementation, which is in this repository rather than installed.
//
// Writing a transport by hand puts the burden of proving it right on this file. The cases here are
// the ones that separate "worked on my laptop" from "worked": a payload split across TCP reads, two
// messages in one read, the three length encodings, masking in the direction the RFC requires it,
// and a fragmented message.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { acceptKey, encodeFrame, isWebSocketUpgrade, OPCODE, WebSocketConnection } from '../src/server/ws.js';

test('the handshake accept value is the one RFC 6455 specifies', () => {
  // The example key and result from the RFC itself.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('an upgrade is recognised only when both headers say so', () => {
  const req = (headers: Record<string, string>): any => ({ headers });
  assert.equal(isWebSocketUpgrade(req({ upgrade: 'websocket', connection: 'Upgrade' })), true);
  assert.equal(isWebSocketUpgrade(req({ upgrade: 'WebSocket', connection: 'keep-alive, Upgrade' })), true);
  assert.equal(isWebSocketUpgrade(req({ upgrade: 'websocket', connection: 'keep-alive' })), false);
  assert.equal(isWebSocketUpgrade(req({ connection: 'Upgrade' })), false);
  assert.equal(isWebSocketUpgrade(req({})), false);
});

/** A connection whose socket is a pipe we control, so the bytes on the wire are inspectable. */
function pair(maskOutgoing: boolean): { conn: WebSocketConnection; socket: PassThrough; sent: Buffer[] } {
  const socket = new PassThrough();
  const sent: Buffer[] = [];
  socket.on('data', (c: Buffer) => sent.push(c));
  const conn = new WebSocketConnection(socket as never, maskOutgoing);
  return { conn, socket, sent };
}

test('a server never masks and a client always does', () => {
  const server = pair(false);
  server.conn.sendText('hi');
  assert.equal((server.sent[0]![1]! & 0x80) === 0, true, 'the server masked a frame');

  const client = pair(true);
  client.conn.sendText('hi');
  assert.equal((client.sent[0]![1]! & 0x80) !== 0, true, 'the client sent an unmasked frame');
  // And the masked bytes are not the plaintext.
  assert.notEqual(client.sent[0]!.subarray(6).toString('utf8'), 'hi');
});

test('all three length encodings round-trip', () => {
  for (const size of [0, 5, 125, 126, 127, 200, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, 0xab);
    for (const mask of [false, true]) {
      const frame = encodeFrame(OPCODE.BINARY, payload, mask);
      const { conn, socket } = pair(false);
      const got: Buffer[] = [];
      conn.on('binary', (d: Buffer) => got.push(d));
      socket.write(frame);
      assert.equal(got.length, 1, `size ${size} mask ${mask}: expected one message`);
      assert.equal(Buffer.compare(got[0]!, payload), 0, `size ${size} mask ${mask}: payload changed`);
    }
  }
});

test('a message split across reads is reassembled, and two in one read are both delivered', () => {
  const { conn, socket } = pair(false);
  const got: string[] = [];
  conn.on('text', (t: string) => got.push(t));

  const a = encodeFrame(OPCODE.TEXT, Buffer.from('first message'), true);
  const b = encodeFrame(OPCODE.TEXT, Buffer.from('second'), true);

  // Byte at a time: the worst case a kernel can hand a reader.
  for (const byte of a) socket.write(Buffer.from([byte]));
  assert.deepEqual(got, ['first message']);

  // Two whole frames in one read.
  socket.write(Buffer.concat([b, b]));
  assert.deepEqual(got, ['first message', 'second', 'second']);
});

test('a fragmented message is delivered once, whole', () => {
  const { conn, socket } = pair(false);
  const got: Buffer[] = [];
  conn.on('binary', (d: Buffer) => got.push(d));

  // FIN=0 BINARY, then FIN=0 CONTINUATION, then FIN=1 CONTINUATION.
  socket.write(Buffer.concat([Buffer.from([0x02, 0x03]), Buffer.from('abc')]));
  socket.write(Buffer.concat([Buffer.from([0x00, 0x03]), Buffer.from('def')]));
  assert.equal(got.length, 0, 'an incomplete message was delivered early');
  socket.write(Buffer.concat([Buffer.from([0x80, 0x03]), Buffer.from('ghi')]));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.toString('utf8'), 'abcdefghi');
});

test('a ping is answered with a pong carrying the same payload', () => {
  const { conn, socket, sent } = pair(false);
  void conn;
  socket.write(Buffer.concat([Buffer.from([0x89, 0x04]), Buffer.from('ping')]));
  const pong = sent[sent.length - 1]!;
  assert.equal(pong[0], 0x80 | OPCODE.PONG);
  assert.equal(pong.subarray(2).toString('utf8'), 'ping');
});

test('a close frame is reported once, with its code', () => {
  const { conn, socket } = pair(false);
  const closes: Array<[number, string]> = [];
  conn.on('close', (code: number, reason: string) => closes.push([code, reason]));
  const payload = Buffer.alloc(2 + 4);
  payload.writeUInt16BE(1001, 0);
  payload.write('gone', 2);
  socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
  assert.deepEqual(closes, [[1001, 'gone']]);
  // The socket dying afterwards must not produce a second close event.
  socket.destroy();
  assert.equal(closes.length, 1);
});

test('an oversized declared length is refused rather than allocated', () => {
  const { conn, socket } = pair(false);
  const errors: Error[] = [];
  conn.on('error', (e: Error) => errors.push(e));
  const head = Buffer.alloc(10);
  head[0] = 0x82;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt('9007199254740991'), 2);
  socket.write(head);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /larger than this host accepts/);
});

// ── The bug this file did not have a case for ───────────────────────────────────────────────────
//
// Both `acceptUpgrade` and `connectWebSocket` finish by handing a connection back to a caller that
// then attaches its handlers. The socket is live in between, and `head` — the bytes that arrived in
// the SAME TCP segment as the handshake — is unshifted into it. An `emit` with no listener drops
// its message silently, and what it drops is the FIRST thing said on the connection.
//
// This surfaced as an attach that reported nothing at all, but ONLY when the whole suite ran at
// once: load is what makes a peer coalesce its first frames with the 101.

test('messages that arrive before a listener is attached are held, not dropped', async () => {
  const { conn, socket } = pair(false);

  // Everything the peer said before this end had wired itself up.
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from('the session'), true));
  socket.write(encodeFrame(OPCODE.TEXT, Buffer.from('attached'), true));
  socket.write(encodeFrame(OPCODE.BINARY, Buffer.from('replay'), true));

  const texts: string[] = [];
  const binaries: string[] = [];
  conn.on('text', (t: string) => texts.push(t));
  // Attached as a SECOND statement, which is how every caller does it. A flush that happened on the
  // first listener would deliver the binary message to nobody.
  conn.on('binary', (d: Buffer) => binaries.push(d.toString('utf8')));

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(texts, ['the session', 'attached']);
  assert.deepEqual(binaries, ['replay']);
});

test('live output cannot overtake the replay it belongs after', async () => {
  const { conn, socket } = pair(false);

  socket.write(encodeFrame(OPCODE.BINARY, Buffer.from('1-replay'), true));

  const got: string[] = [];
  conn.on('binary', (d: Buffer) => got.push(d.toString('utf8')));
  // Arrives after the listener exists but before the held message has been drained — the window a
  // direct emit would jump the queue in.
  socket.write(encodeFrame(OPCODE.BINARY, Buffer.from('2-live'), true));

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, ['1-replay', '2-live'], 'the seam was reordered');
});
