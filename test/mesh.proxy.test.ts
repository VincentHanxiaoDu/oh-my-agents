// CRITERION 3: attaching to an agent on another machine behaves like attaching locally.
//
// ─── WHAT IS AND IS NOT DEMONSTRATED HERE, SAID PLAINLY ──────────────────────────────────────────
//
// The attach socket is ISSUE #2 and is NOT on this branch: `handleAttachUpgrade` still refuses and
// the registry is still the interface plus an empty implementation. Building a second PTY here to
// demonstrate criterion 3 would duplicate #2 and produce a conflict, so it is not built.
//
// What IS built and what this file exercises is the OTHER half — the route from the host a person
// opened to the host that owns the agent. The stand-in below is a real HTTP server that completes a
// real upgrade and then behaves the way an attach behaves: it streams output unprompted, it echoes
// what is sent to it, and it reacts to an interrupt byte. It stands in AT THE UPGRADE BOUNDARY,
// which is exactly where #2 will plug in.
//
// So this proves: the upgrade reaches the owning host, the 101 comes back to the browser, output
// streams, input arrives, and an interrupt gets through — over a socket that went through the
// proxy. It does NOT prove that #2's PTY works over it, because #2's PTY does not exist yet.

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { proxyUpgrade, resolveTarget } from '../src/mesh/proxy.js';
import { meshCredentialSupplier } from '../src/mesh/trust.js';
import { callHost, startTestHost, type TestHost } from './helpers/mesh.js';
import { createPairingCode, pairDevice } from '../src/pairing/devices.js';
import { DEVICE_COOKIE } from '../src/pairing/credential.js';

/** The stand-in for the host that owns the agent. Real socket, real upgrade, controllable. */
async function startStandIn(): Promise<{ address: string; close(): Promise<void>; sawInterrupt: () => boolean }> {
  let interrupted = false;
  const sockets = new Set<Duplex>();
  const server = http.createServer();
  server.on('upgrade', (_req, socket, head) => {
    // Kept so teardown can end them. Node detaches an upgraded socket from the server's connection
    // set while still counting it, so neither `close()` nor `closeAllConnections()` can end one —
    // the same thing `src/server/server.ts` has to work around.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: agent-attach\r\nconnection: Upgrade\r\n\r\n');
    // Whatever the client sent past the request line, and then unprompted output — an attach
    // starts streaming before the client says anything, and that is the half a request/response
    // proxy would get wrong.
    if (head.length > 0) socket.write('head:' + head.toString('utf8'));
    socket.write('OUT:hello from the agent\n');
    socket.on('data', (chunk: Buffer) => {
      if (chunk.includes(0x03)) {
        interrupted = true;
        socket.write('INTERRUPTED\n');
        return;
      }
      socket.write('ECHO:' + chunk.toString('utf8'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    address: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => r());
        setImmediate(() => r());
        // An upgraded socket is still one of the server's connections, and `close()` waits for
        // every one of them. Without this the suite hangs on teardown rather than failing.
        server.closeAllConnections();
      }),
    sawInterrupt: () => interrupted,
  };
}

/**
 * A reader that accumulates EVERYTHING the socket has ever sent.
 *
 * A per-call listener would drop whatever arrived in the same TCP segment as the thing it was
 * waiting for — and on a proxied attach the 101 and the first line of output routinely arrive
 * together, which made the first version of this test report that output never streamed when in
 * fact it had already been read and thrown away.
 */
function reader(socket: net.Socket): (want: string, timeoutMs?: number) => Promise<string> {
  let seen = '';
  const waiters: { want: string; resolve: (s: string) => void }[] = [];
  socket.on('data', (c: Buffer) => {
    seen += c.toString('utf8');
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (seen.includes(w.want)) {
        waiters.splice(i, 1);
        w.resolve(seen);
      }
    }
  });
  return (want: string, timeoutMs = 5000) =>
    new Promise<string>((resolve, reject) => {
      if (seen.includes(want)) {
        resolve(seen);
        return;
      }
      const waiter = { want, resolve: (s: string) => { clearTimeout(timer); resolve(s); } };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`never saw ${JSON.stringify(want)}; saw ${JSON.stringify(seen)}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
}

test('an attach naming another machine is relayed to it: output streams, input arrives, interrupt works', async (t) => {
  const standIn = await startStandIn();
  // The host the person OPENS. Its supplier is injected — how a host would come to hold a
  // credential for a peer in production is Issue #3's open decision and is not answered here.
  const opened: TestHost = await startTestHost({
    name: 'p-opened',
    supplier: () => ({ kind: 'operator', proof: 'a stand-in credential; the real one is an open decision' }),
  });
  t.after(async () => {
    await opened.stop().catch(() => undefined);
    await standIn.close();
  });

  const joined = await callHost(opened, '/api/peers/join', { method: 'POST', body: JSON.stringify({ address: standIn.address }) });
  assert.equal(joined.status, 200, 'the owning host was joined');

  // A REAL PAIRED DEVICE. Issue #5's upgrade authorisation reads the device cookie and nothing
  // else, so the proxied attach is behind pairing exactly as a local one would be.
  const env = { OMA_STATE_DIR: opened.dir };
  const issued = createPairingCode(env);
  assert.equal(issued.kind, 'ok', 'the test host issued a pairing code');
  const paired = pairDevice(issued.kind === 'ok' ? issued.value.code : '', 'the test device', env);
  assert.equal(paired.kind, 'paired', 'the test device paired with the host it opened');
  const cookie = paired.kind === 'paired' ? `${DEVICE_COOKIE}=${paired.credential.token}` : '';

  const socket = net.connect(opened.port, '127.0.0.1');
  const read = reader(socket);
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write(
    `GET /attach?host=${encodeURIComponent(standIn.address)}&session=s1 HTTP/1.1\r\n` +
      `host: 127.0.0.1:${opened.port}\r\n` +
      `upgrade: agent-attach\r\nconnection: Upgrade\r\ncookie: ${cookie}\r\n\r\n`,
  );

  // THE SAME LIVE ATTACH AS LOCAL, in three parts.
  // 1. The 101 comes back from the OWNING host, through the opened one.
  const handshake = await read('101 Switching Protocols');
  assert.match(handshake, /upgrade: agent-attach/i, 'the owning host\'s own handshake headers came back');

  // 2. Output streams without the client asking for it.
  await read('OUT:hello from the agent');

  // 3. Input reaches the agent, and the agent's answer comes back.
  socket.write('type this\n');
  const echoed = await read('ECHO:type this');
  assert.match(echoed, /ECHO:type this/, 'input written to the opened host reached the agent on the other machine');

  // 4. Interrupt. A raw ETX byte, which is what an interrupt is on a terminal, and it must not be
  //    buffered, framed or swallowed by the hop in between.
  socket.write(Buffer.from([0x03]));
  await read('INTERRUPTED');
  assert.equal(standIn.sawInterrupt(), true, 'the interrupt reached the machine that owns the agent');

  socket.destroy();
});

test('a proxied attach FAILS CLOSED when this host holds no credential for the peer', async () => {
  // The shipped supplier. This is what happens in production today, and it is the correct failure:
  // a live terminal on another machine is not granted by a mechanism nobody decided on.
  const target = resolveTarget('127.0.0.1:1');
  assert.ok(target, 'the address parses');
  const credential = await meshCredentialSupplier({})({ address: '127.0.0.1:1', hostId: null });
  assert.equal(credential.kind, 'none', 'the shipped supplier grants nothing');

  const socket = new net.Socket();
  const outcome = await proxyUpgrade(
    target,
    credential,
    { url: '/attach', method: 'GET', headers: {} } as unknown as http.IncomingMessage,
    socket,
    Buffer.alloc(0),
  );
  // WATCHED GO RED: making `proxyUpgrade` fall through to `request()` on a `none` credential turns
  // this into an `unreachable` (it tries, and 127.0.0.1:1 refuses), which would mean the refusal
  // had been replaced by an attempt.
  assert.equal(outcome.kind, 'refused', 'no credential means no socket is opened at all');
  assert.match(outcome.reason, /OPEN PRODUCT DECISION on Issue #3/, 'and it says which decision is missing');
});

test('an attach naming a machine that is not joined is denied opaquely', async (t) => {
  const opened = await startTestHost({ name: 'p-unknown' });
  t.after(() => opened.stop());

  const env = { OMA_STATE_DIR: opened.dir };
  const issued = createPairingCode(env);
  const paired = pairDevice(issued.kind === 'ok' ? issued.value.code : '', 'the test device', env);
  const cookie = paired.kind === 'paired' ? `${DEVICE_COOKIE}=${paired.credential.token}` : '';

  const socket = net.connect(opened.port, '127.0.0.1');
  const read = reader(socket);
  await new Promise<void>((r) => socket.once('connect', () => r()));
  socket.write(
    `GET /attach?host=100.64.0.99:8787 HTTP/1.1\r\nhost: 127.0.0.1:${opened.port}\r\n` +
      `upgrade: agent-attach\r\nconnection: Upgrade\r\ncookie: ${cookie}\r\n\r\n`,
  );
  const answer = await read('\r\n\r\n');
  // The same 404 an unknown path gets. A paired device asking about a machine this host has not
  // joined learns nothing about whether that machine exists.
  assert.match(answer, /^HTTP\/1\.1 404 Not Found/, 'an unjoined machine is not confirmed or denied, it is 404');
  assert.doesNotMatch(answer, /100\.64\.0\.99/, 'and the answer does not echo the address back');
  socket.destroy();
});
