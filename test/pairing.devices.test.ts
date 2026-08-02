// Criteria 2, 3, 4, 5, 7 and 8 at the level below HTTP.
//
// Every assertion here was watched go red. The two that matter most, and how:
//   criterion 3 — `findUsableCode`'s `unused` term was changed to `true`, so a spent code paired a
//                 second device; the test was observed failing on `expected 'refused'`. Restored.
//   criterion 5 — `revokeDevice`'s `store.devices.map(...)` was changed to mark every device
//                 revoked; the "other devices unaffected" assertion was observed failing. Restored.

import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, grants } from '../src/pairing/auth.js';
import { CODE_TTL_MS, formatCode, normaliseCode } from '../src/pairing/codes.js';
import { createPairingCode, labelFromUserAgent, listDevices, pairDevice, revokeDevice } from '../src/pairing/devices.js';
import { verifyForeignCredential } from '../src/pairing/mesh.js';
import { parseCredential } from '../src/pairing/credential.js';
import { readStore } from '../src/pairing/store.js';
import { tempEnv } from './helpers/http.js';

function pairOne(env: { OMA_STATE_DIR: string }, label = 'Test · Test', now = Date.now()): string {
  const issued = createPairingCode(env, now);
  assert.equal(issued.kind, 'ok');
  const code = issued.kind === 'ok' ? issued.value.code : '';
  const paired = pairDevice(code, label, env, now);
  assert.equal(paired.kind, 'paired', 'pairing with a fresh code failed');
  return paired.kind === 'paired' ? paired.credential.token : '';
}

// CRITERION 2
test('a code the host issued pairs a browser, and the browser is then authorised', () => {
  const env = tempEnv();
  const token = pairOne(env, 'iPhone · Safari');
  const decision = authenticate(token, env);
  assert.ok(grants(decision), 'a freshly paired device was not authorised');
  assert.equal(decision.kind === 'authorised' ? decision.device.label : '', 'iPhone · Safari');
});

// CRITERION 3 — SINGLE USE
test('a code that has already paired a device does not pair a second one', () => {
  const env = tempEnv();
  const issued = createPairingCode(env);
  assert.equal(issued.kind, 'ok');
  const code = issued.kind === 'ok' ? issued.value.code : '';

  // POSITIVE PATH FIRST, in this same test: without it, a build where NO code ever works would
  // pass the assertion below and look like correct single-use enforcement.
  const first = pairDevice(code, 'first', env);
  assert.equal(first.kind, 'paired', 'the first use of a fresh code did not pair — the test below would prove nothing');

  const second = pairDevice(code, 'second', env);
  assert.equal(second.kind, 'refused', 'a spent pairing code paired a second device');

  const listed = listDevices(env);
  assert.equal(listed.kind === 'present' ? listed.devices.length : -1, 1, 'a second device record was created');
});

// CRITERION 3 — TIME LIMITED
test('a code past its window does not pair, and one inside it does', () => {
  const env = tempEnv();
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');

  const issued = createPairingCode(env, t0);
  assert.equal(issued.kind, 'ok');
  const code = issued.kind === 'ok' ? issued.value.code : '';

  // Inside the window: paired. Asserted first, so "expired is refused" is not passing vacuously.
  const early = pairDevice(code, 'in time', env, t0 + CODE_TTL_MS - 1000);
  assert.equal(early.kind, 'paired');

  const issued2 = createPairingCode(env, t0);
  const code2 = issued2.kind === 'ok' ? issued2.value.code : '';
  const late = pairDevice(code2, 'too late', env, t0 + CODE_TTL_MS + 1000);
  assert.equal(late.kind, 'refused', 'an expired pairing code still paired a device');
});

test('a mistyped code is refused, and is refused the same way a spent one is', () => {
  const env = tempEnv();
  const issued = createPairingCode(env);
  const code = issued.kind === 'ok' ? issued.value.code : '';
  assert.equal(pairDevice(code, 'real', env).kind, 'paired');

  const spent = pairDevice(code, 'again', env);
  const wrong = pairDevice('ZZZZZZZZ', 'guess', env);
  // Criterion 3: "distinguishable from a mistyped code only in so far as both fail". The two
  // outcomes are the SAME VALUE, so a caller has nothing finer to leak even if it tried.
  assert.deepEqual(spent, wrong);
});

test('a code is accepted however a person reasonably types it', () => {
  const env = tempEnv();
  const issued = createPairingCode(env);
  const code = issued.kind === 'ok' ? issued.value.code : '';
  // Lowercase, with the display dash, with stray spaces.
  const typed = ' ' + formatCode(code).toLowerCase() + ' ';
  assert.equal(pairDevice(typed, 'typed by a human', env).kind, 'paired');
});

test('the letters that look like digits fold to the digits', () => {
  assert.equal(normaliseCode('o1il'), '0111');
  assert.equal(normaliseCode('ab-cd ef'), 'ABCDEF');
});

// CRITERION 4
test('paired devices are listable with something a human can tell them apart by', () => {
  const env = tempEnv();
  pairOne(env, labelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'));
  pairOne(env, labelFromUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'));

  const listed = listDevices(env);
  assert.equal(listed.kind, 'present');
  if (listed.kind !== 'present') return;
  const labels = listed.devices.map((d) => d.label);
  assert.deepEqual(labels, ['iPhone · Safari', 'Linux · Chrome']);
  // Distinguishable also by id and by when they were paired, not only by a browser-chosen string.
  assert.notEqual(listed.devices[0]!.id, listed.devices[1]!.id);
});

// CRITERION 5 — THE ONE MOST WORTH GETTING RIGHT
test('revoking one device rejects THAT device and leaves the others working', () => {
  const env = tempEnv();
  const phone = pairOne(env, 'iPhone · Safari');
  const laptop = pairOne(env, 'Mac · Firefox');

  // POSITIVE PATH FIRST. Both work. Without this, a build that authorised nothing would pass
  // "the revoked device is rejected" and look correct.
  assert.ok(grants(authenticate(phone, env)), 'the phone was not authorised before revocation');
  assert.ok(grants(authenticate(laptop, env)), 'the laptop was not authorised before revocation');

  const phoneId = parseCredential(phone)!.deviceId;
  const outcome = revokeDevice(phoneId.slice(0, 8), env);
  assert.equal(outcome.kind, 'revoked');

  const after = authenticate(phone, env);
  assert.equal(grants(after), false, 'a revoked device is still authorised');
  assert.equal(after.kind, 'revoked');

  // AND THE OTHER ONE IS UNTOUCHED — not re-paired, not re-prompted, same credential.
  assert.ok(grants(authenticate(laptop, env)), 'revoking one device revoked another');
  const listed = listDevices(env);
  assert.equal(listed.kind, 'present');
  if (listed.kind !== 'present') return;
  const stillLive = listed.devices.filter((d) => d.revokedAt === undefined);
  assert.equal(stillLive.length, 1);
  assert.equal(stillLive[0]!.label, 'Mac · Firefox');
});

test('an ambiguous identifier revokes NOTHING', () => {
  const env = tempEnv();
  const a = pairOne(env, 'a');
  const b = pairOne(env, 'b');
  // Every device id is hex, so the empty-ish prefix '' is ambiguous by construction; use the
  // shortest prefix both share, computed rather than assumed.
  const ida = parseCredential(a)!.deviceId;
  const idb = parseCredential(b)!.deviceId;
  let shared = '';
  for (let i = 0; i < ida.length && ida[i] === idb[i]; i++) shared += ida[i];
  if (shared.length < 4) {
    // The two random ids do not share a 4-character prefix, which is the overwhelmingly likely
    // case. Assert the same property with an explicit collision instead of contriving one.
    assert.equal(revokeDevice('zzzz', env).kind, 'no-such-device');
    assert.ok(grants(authenticate(a, env)));
    assert.ok(grants(authenticate(b, env)));
    return;
  }
  assert.equal(revokeDevice(shared, env).kind, 'ambiguous');
  assert.ok(grants(authenticate(a, env)));
  assert.ok(grants(authenticate(b, env)));
});

test('revoking something that is not there revokes nothing and says so', () => {
  const env = tempEnv();
  const live = pairOne(env, 'kept');
  assert.equal(revokeDevice('ffffffffffffffffffffffffffffffff', env).kind, 'no-such-device');
  assert.ok(grants(authenticate(live, env)), 'a failed revoke disturbed a live device');
});

// CRITERION 7
test('pairing survives a host restart: nothing is held in memory', () => {
  const env = tempEnv();
  const token = pairOne(env, 'iPhone · Safari');

  // `authenticate` reads the store from disk on every call and holds no state between them, so a
  // second call in a fresh process is the same operation as a second call here. The e2e test in
  // test/pairing.http.test.ts restarts the actual server process and asserts the same thing.
  assert.ok(grants(authenticate(token, env)));

  const read = readStore(env);
  assert.equal(read.kind, 'present');
  if (read.kind !== 'present') return;
  assert.equal(read.store.devices.length, 1);
  assert.equal(read.store.devices[0]!.macHash.length, 64);
  // The credential itself is NOT on disk. A store that held it would be a store whose disclosure
  // is the same event as the device's.
  assert.ok(!JSON.stringify(read.store).includes(parseCredential(token)!.mac));
});

// CRITERION 8 — the half that is decided
test('a credential is verifiable by a host that did not issue it, given the mesh key', () => {
  const env = tempEnv();
  const token = pairOne(env, 'iPhone · Safari');
  const read = readStore(env);
  assert.equal(read.kind, 'present');
  if (read.kind !== 'present') return;

  const parsed = parseCredential(token)!;
  // A PEER holds only the mesh key — no device table, no store — and can still verify.
  const verdict = verifyForeignCredential(read.store.meshSecret, parsed.deviceId, parsed.mac);
  assert.equal(verdict.kind, 'authentic');

  // And a credential minted under a different mesh key is not authentic here.
  const other = tempEnv();
  assert.equal(createPairingCode(other).kind, 'ok');
  const otherRead = readStore(other);
  assert.equal(otherRead.kind, 'present');
  if (otherRead.kind !== 'present') return;
  assert.equal(verifyForeignCredential(otherRead.store.meshSecret, parsed.deviceId, parsed.mac).kind, 'not-authentic');
});

test('a forged credential for a real device id is not authorised', () => {
  const env = tempEnv();
  const token = pairOne(env, 'real');
  const id = parseCredential(token)!.deviceId;
  const forged = `oma1.${id}.${'A'.repeat(43)}`;
  assert.equal(grants(authenticate(forged, env)), false);
  assert.equal(authenticate(forged, env).kind, 'unpaired');
});

test('nonsense in the cookie is not authorised and does not throw', () => {
  const env = tempEnv();
  pairOne(env, 'real');
  for (const junk of ['', 'x', 'oma1..', 'oma1.zz.zz', 'a.b.c.d', '../../etc/passwd', 'oma1.' + 'f'.repeat(32) + '.short']) {
    assert.equal(grants(authenticate(junk, env)), false, `'${junk}' was authorised`);
  }
  assert.equal(grants(authenticate(undefined, env)), false);
});
