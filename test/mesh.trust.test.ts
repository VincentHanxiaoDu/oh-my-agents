// THE FAIL-CLOSED PROPERTY, AND THE TWO REFUSALS.
//
// Issue #5 found the sharp edge and this Issue does not blunt it: `verifyForeignCredential`
// establishes AUTHENTICITY, not current AUTHORISATION. Only the issuing host's store knows a device
// was revoked, so a peer that accepted a foreign credential on the HMAC alone would keep serving a
// revoked phone — which #5's criterion 5 forbids.
//
// HOW THIS BUILD ANSWERS THAT: IT DOES NOT ACCEPT FOREIGN DEVICE CREDENTIALS AT ALL. Every device
// is authenticated by the host it opened, against that host's own store, on every request. The
// tests below assert that from the outside — a credential issued by one host is refused by another,
// whether or not it has been revoked — and assert that the two undecided mechanisms still refuse.

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { callHost, startTestHost } from './helpers/mesh.js';
import { createPairingCode, pairDevice } from '../src/pairing/devices.js';
import { DEVICE_COOKIE, computeMac } from '../src/pairing/credential.js';
import { readStore } from '../src/pairing/store.js';
import { verifyForeignCredential, establishPeerTrust, propagateRevocation } from '../src/pairing/mesh.js';
import { meshCredentialSupplier, refuseToEstablishTrust, REFUSAL_NOTE } from '../src/mesh/trust.js';
import { main } from '../src/cli/main.js';
import { EXIT } from '../src/cli/exit-codes.js';

function getWithCookie(port: number, route: string, cookie: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, headers: { cookie, accept: 'application/json' }, timeout: 4000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timed out')); });
    req.end();
  });
}

test('a credential issued by one host is refused by another — no peer serves a foreign device', async (t) => {
  const a = await startTestHost({ name: 'r-a' });
  const b = await startTestHost({ name: 'r-b' });
  t.after(async () => { await a.stop(); await b.stop(); });

  const envA = { OMA_STATE_DIR: a.dir };
  const issued = createPairingCode(envA);
  assert.equal(issued.kind, 'ok');
  const paired = pairDevice(issued.kind === 'ok' ? issued.value.code : '', 'a phone', envA);
  assert.equal(paired.kind, 'paired');
  const cookie = `${DEVICE_COOKIE}=${paired.kind === 'paired' ? paired.credential.token : ''}`;

  // It works on the host that issued it. Asserted first, so the refusal below cannot be a
  // credential that never worked anywhere.
  const onIssuer = await getWithCookie(a.port, '/api/status', cookie);
  assert.equal(onIssuer.status, 200, 'the credential works on the host that issued it');

  // ── THE FAIL-CLOSED ASSERTION ──────────────────────────────────────────────────────────────────
  // WATCHED GO RED: wiring `verifyForeignCredential` into `authenticate()` with a shared mesh key
  // turns this 404 into a 200 — which is precisely the "peer serves a device it cannot check for
  // revocation" hole that Issue #5 named and that this build refuses to open.
  const onPeer = await getWithCookie(b.port, '/api/status', cookie);
  assert.equal(onPeer.status, 404, 'a host that did not issue the credential does not serve it');
  const unknownPath = await getWithCookie(b.port, '/no-such-thing-at-all', cookie);
  // And the refusal is the SAME opaque 404 an unknown path gets — Issue #5 criterion 6, unchanged.
  assert.equal(onPeer.status, unknownPath.status, 'same status as an unknown path');
  assert.equal(onPeer.body, unknownPath.body, 'same body, byte for byte');
});

test('the mesh key is per host, so a foreign credential is not even authentic elsewhere', async (t) => {
  const a = await startTestHost({ name: 'k-a' });
  const b = await startTestHost({ name: 'k-b' });
  t.after(async () => { await a.stop(); await b.stop(); });

  const storeA = readStore({ OMA_STATE_DIR: a.dir });
  const storeB = readStore({ OMA_STATE_DIR: b.dir });
  assert.equal(storeA.kind, 'present');
  assert.equal(storeB.kind, 'present');
  const secretA = storeA.kind === 'present' ? storeA.store.meshSecret : '';
  const secretB = storeB.kind === 'present' ? storeB.store.meshSecret : '';
  assert.notEqual(secretA, secretB, 'two hosts do not share a mesh key on this branch');

  // `verifyForeignCredential` still works exactly as Issue #5 built it — against the key it is
  // given. Nothing here changed it; what changed is that no request path calls it.
  const deviceId = 'c'.repeat(32);
  assert.equal(verifyForeignCredential(secretA, deviceId, computeMac(secretA, deviceId)).kind, 'authentic');
  assert.equal(verifyForeignCredential(secretB, deviceId, computeMac(secretA, deviceId)).kind, 'not-authentic');
});

test('the two undecided mechanisms refuse rather than defaulting', async () => {
  // The supplier a shipped host uses. It grants nothing, for every peer, and names the decision.
  const credential = await meshCredentialSupplier({})({ address: '100.64.0.3:8787', hostId: null });
  assert.equal(credential.kind, 'none');
  assert.equal(credential.reason, REFUSAL_NOTE);
  assert.match(REFUSAL_NOTE, /OPEN PRODUCT DECISION on Issue #3/);

  // Issue #5's seams are untouched and still throw.
  assert.throws(() => establishPeerTrust('peer', '100.64.0.3:8787'), /NotImplementedOnThisIssue|not implemented/);
  assert.throws(() => propagateRevocation('device'), /NotImplementedOnThisIssue|not implemented/);
  assert.throws(() => refuseToEstablishTrust('peer', '100.64.0.3:8787'), /not implemented/);
});

test('flags that would settle how hosts trust each other refuse with exit code 6', async () => {
  const stderr: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stderr.push(s);
    return true;
  };
  try {
    for (const flag of ['--share-mesh-key', '--mesh-key=abc', '--trust-on-join', '--accept-foreign-credentials', '--propagate-revocations']) {
      stderr.length = 0;
      const code = await main([flag]);
      assert.equal(code, EXIT.REFUSED_UNSETTLED_DECISION, `${flag} refuses with exit 6`);
      const said = stderr.join('');
      assert.match(said, /OPEN PRODUCT DECISION on Issue #3/, `${flag} names the Issue that owns the decision`);
      // A refusal that does not say what the build does instead sends a person looking for a bug.
      assert.match(said, /revoked/i, `${flag} says why the refusal is the closed failure`);
    }
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
});

test('nothing in the mesh requires a relay, a tunnel or a process outside the hosts — criterion 8', async (t) => {
  // Two hosts, joined, listing each other. The only processes involved are the two hosts and the
  // test; there is no broker to start, no discovery service, no account and no third address.
  const hosts: { address: string }[] = [];
  const supplier = (await import('./helpers/mesh.js')).supplierFor(() => real);
  const a = await startTestHost({ name: 'n-a', supplier, sessions: [{ id: 's', title: 'x', startedAt: '2026-01-01T00:00:00.000Z', alive: true }] });
  const b = await startTestHost({ name: 'n-b', supplier });
  const real = [a, b];
  hosts.push(a, b);
  t.after(async () => { await a.stop(); await b.stop(); });

  await callHost(b, '/api/peers/join', { method: 'POST', body: JSON.stringify({ address: a.address }) });
  const view = (await callHost(b, '/api/mesh')).json() as { hosts: { address: string }[]; agents: unknown[] };
  assert.equal(view.hosts.length, 2, 'b sees itself and a');
  assert.equal(view.agents.length, 1, "and a's agent, fetched from a directly");

  // The addresses in play are exactly the two hosts'. Nothing else was contacted.
  const addresses = new Set(view.hosts.map((h) => h.address));
  assert.deepEqual([...addresses].sort(), [a.address, b.address].sort(), 'only the hosts themselves are involved');
});
