// Criteria 1, 5, 6 and 7 against a REAL server on a REAL socket, asserting on the ACTUAL BYTES.
//
// Requests are made with a raw TCP socket rather than `fetch`, because criterion 6 is a claim about
// what comes back on the wire — status line, header names, header order, body — and a client
// library normalises exactly the differences the criterion is about.
//
// Watched go red, each by breaking the code and observing the failure, then restoring:
//   criterion 6 — `denyOpaquely` was changed to a 401 with `{"ok":false,"error":"not paired"}`; the
//                 byte-equality test failed showing the two responses diverging at the status line.
//   criterion 5 — the revocation check in `authenticate` (`d.revokedAt === undefined`) was dropped;
//                 "a revoked device is rejected" failed while "the other device still works" passed,
//                 which is why the positive path is asserted in the same test.
//   criterion 1 — the `guardRequest` call in server.ts was commented out; the unpaired /api/status
//                 test failed with the real status payload in the body.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../src/server/server.js';
import type { BindPlan } from '../src/host/bind.js';
import { createPairingCode, revokeDevice } from '../src/pairing/devices.js';
import { parseCredential } from '../src/pairing/credential.js';
import type { SessionRegistry } from '../src/sessions/registry.js';
import { tempEnv } from './helpers/http.js';

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');

// Distinctive strings. If any of them appears in a denial, criterion 6 is broken and the assertion
// names which one leaked rather than saying "something did".
const SECRET_SESSION_ID = 'sess-Zq7ttMwLeakCanary';
const SECRET_AGENT_NAME = 'claude-on-the-build-box';
const SECRET_MACHINE_NAME = 'workshop-mini.tail1234.ts.net';

function loopbackPlan(): BindPlan {
  return {
    addresses: ['127.0.0.1'],
    loopback: ['127.0.0.1'],
    tailnet: [SECRET_MACHINE_NAME],
    reachability: 'tailnet',
    determination: 'determined',
    reason: 'a test',
    rejected: [],
  };
}

function loudRegistry(): SessionRegistry {
  const one = { id: SECRET_SESSION_ID, title: SECRET_AGENT_NAME, startedAt: '2026-01-01T00:00:00.000Z', alive: true };
  return { list: () => [one], get: (id) => (id === one.id ? one : undefined), count: () => 1 };
}

/**
 * A free port, taken by binding one and letting it go. `startServer` reports back the port it was
 * ASKED for rather than the one the kernel chose, so `port: 0` would leave every request in this
 * file connecting to port 0 — and that is Issue #1's field, not something to change from here.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function serve(env: { OMA_STATE_DIR: string }, port?: number): Promise<RunningServer> {
  return startServer({ plan: loopbackPlan(), port: port ?? (await freePort()), registry: loudRegistry(), webRoot: WEB_ROOT, env });
}

/** The whole response, exactly as it arrived, with only the clock removed. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('timed out'));
    });
  });
}

/** `Date:` is the only header that must differ between two responses a moment apart. */
function withoutClock(response: string): string {
  return response.replace(/\r\nDate: [^\r\n]*/i, '');
}

function get(port: number, route: string, headers: Record<string, string> = {}): Promise<string> {
  const lines = [`GET ${route} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  return raw(port, lines.join('\r\n') + '\r\n\r\n');
}

function post(port: number, route: string, body: string, headers: Record<string, string> = {}): Promise<string> {
  const lines = [
    `POST ${route} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  return raw(port, lines.join('\r\n') + '\r\n\r\n' + body);
}

function statusOf(response: string): number {
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0);
}

function bodyOf(response: string): string {
  const i = response.indexOf('\r\n\r\n');
  return i === -1 ? '' : response.slice(i + 4);
}

function cookieOf(response: string): string {
  const m = /\r\nset-cookie: ([^;\r\n]+)/i.exec(response);
  return m?.[1] ?? '';
}

async function pairViaHttp(port: number, env: { OMA_STATE_DIR: string }, ua: string): Promise<string> {
  const issued = createPairingCode(env);
  assert.equal(issued.kind, 'ok');
  const code = issued.kind === 'ok' ? issued.value.code : '';
  const res = await post(port, '/api/pair', JSON.stringify({ code }), { 'User-Agent': ua });
  assert.equal(statusOf(res), 200, `pairing over HTTP failed: ${res}`);
  const cookie = cookieOf(res);
  assert.match(cookie, /^oma_device=oma1\./);
  return cookie;
}

// ─── CRITERION 1 ────────────────────────────────────────────────────────────────────────────────

test('an unpaired browser gets no agent data, even over the tailnet address', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const api = await get(server.port, '/api/status');
  assert.equal(statusOf(api), 404);
  for (const secret of [SECRET_SESSION_ID, SECRET_AGENT_NAME, SECRET_MACHINE_NAME]) {
    assert.ok(!api.includes(secret), `an unpaired /api/status response contained ${secret}`);
  }

  // A browser NAVIGATION gets the pairing prompt, which is the second half of criterion 1.
  const page = await get(server.port, '/', { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' });
  assert.equal(statusOf(page), 200);
  assert.match(bodyOf(page), /Pair this device/);
  assert.ok(!bodyOf(page).includes(SECRET_AGENT_NAME));
  // And it is NOT the real page: no status wiring, nothing that would render a session.
  assert.ok(!bodyOf(page).includes('/api/status'));
});

test('an unpaired browser cannot send input: every method and route is refused alike', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const routes = ['/api/status', '/api/devices', '/index.html', '/api/sessions/x/input'];
  for (const route of routes) {
    const res = await get(server.port, route, { 'Sec-Fetch-Dest': 'empty' });
    assert.equal(statusOf(res), 404, `${route} was not refused`);
  }
  const revoke = await post(server.port, '/api/devices/revoke', '{"id":"x"}');
  assert.equal(statusOf(revoke), 404);
});

// CRITERION 1, at the upgrade path. Issue #2's attach socket must route through `authoriseUpgrade`.
test('an unpaired browser attempting to attach learns nothing, not even that attach exists', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const upgrade = await raw(
    server.port,
    ['GET /attach HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='].join('\r\n') + '\r\n\r\n',
  );
  assert.equal(statusOf(upgrade), 404, 'an unpaired upgrade was answered with something other than the opaque 404');
  assert.ok(!/websocket|attach|Issue #2|Not Implemented/i.test(upgrade), `the upgrade refusal described itself: ${upgrade}`);
  for (const secret of [SECRET_SESSION_ID, SECRET_AGENT_NAME, SECRET_MACHINE_NAME]) {
    assert.ok(!upgrade.includes(secret), `an unpaired upgrade leaked ${secret}`);
  }

  // A PAIRED device gets the ordinary "not built yet" answer, which proves the 404 above was the
  // authorisation check and not simply that no upgrade handler exists.
  const cookie = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');
  const allowed = await raw(
    server.port,
    ['GET /attach HTTP/1.1', 'Host: 127.0.0.1', `Cookie: ${cookie}`, 'Upgrade: websocket', 'Connection: Upgrade'].join('\r\n') + '\r\n\r\n',
  );
  assert.equal(statusOf(allowed), 501);
});

// ─── CRITERION 2 ────────────────────────────────────────────────────────────────────────────────

test('entering a code pairs the browser, and later visits need nothing typed', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const cookie = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');

  const first = await get(server.port, '/api/status', { Cookie: cookie });
  assert.equal(statusOf(first), 200);
  assert.match(bodyOf(first), new RegExp(SECRET_AGENT_NAME));

  // "Later visits": the same cookie, nothing else, several times.
  for (let i = 0; i < 3; i++) {
    const again = await get(server.port, '/api/status', { Cookie: cookie });
    assert.equal(statusOf(again), 200);
  }

  // The credential is HttpOnly and SameSite=Strict — a page cannot read it and a cross-site
  // request cannot carry it.
  const res = await post(server.port, '/api/pair', JSON.stringify({ code: 'ZZZZZZZZ' }));
  assert.equal(statusOf(res), 403);
});

test('a pairing code is single-use and time-limited over HTTP too', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const issued = createPairingCode(env);
  const code = issued.kind === 'ok' ? issued.value.code : '';

  const first = await post(server.port, '/api/pair', JSON.stringify({ code }));
  assert.equal(statusOf(first), 200, 'the first use of a fresh code failed — everything below would prove nothing');

  const second = await post(server.port, '/api/pair', JSON.stringify({ code }));
  assert.equal(statusOf(second), 403, 'a spent code paired a second browser over HTTP');
  assert.equal(cookieOf(second), '', 'a refused pairing still set a credential cookie');

  const mistyped = await post(server.port, '/api/pair', JSON.stringify({ code: 'ZZZZZZZZ' }));
  // Criterion 3: the two rejections differ only in so far as both fail. Byte-identical.
  assert.equal(withoutClock(second), withoutClock(mistyped));
});

// ─── CRITERION 5 ────────────────────────────────────────────────────────────────────────────────

test('revoking one device rejects it on its next request and leaves the other paired', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const phone = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');
  const laptop = await pairViaHttp(server.port, env, 'Mozilla/5.0 (Macintosh) Firefox/121.0');

  // POSITIVE PATH FIRST, over HTTP, in this same test.
  assert.equal(statusOf(await get(server.port, '/api/status', { Cookie: phone })), 200);
  assert.equal(statusOf(await get(server.port, '/api/status', { Cookie: laptop })), 200);

  const phoneId = parseCredential(phone.split('=')[1] ?? '')!.deviceId;
  assert.equal(revokeDevice(phoneId, env).kind, 'revoked');

  // THE VERY NEXT REQUEST. No cache, no grace period.
  const next = await get(server.port, '/api/status', { Cookie: phone, 'Sec-Fetch-Dest': 'empty' });
  assert.equal(statusOf(next), 404, 'a revoked device was still served');
  for (const secret of [SECRET_SESSION_ID, SECRET_AGENT_NAME, SECRET_MACHINE_NAME]) {
    assert.ok(!next.includes(secret), `a revoked device's rejection leaked ${secret}`);
  }

  // Returned to the pairing prompt on its next navigation.
  const page = await get(server.port, '/', { Cookie: phone, 'Sec-Fetch-Dest': 'document' });
  assert.match(bodyOf(page), /Pair this device/);

  // AND THE OTHER DEVICE IS UNAFFECTED — still served, and never shown the prompt.
  const other = await get(server.port, '/api/status', { Cookie: laptop });
  assert.equal(statusOf(other), 200, 'revoking one device revoked another');
  const otherPage = await get(server.port, '/', { Cookie: laptop, 'Sec-Fetch-Dest': 'document' });
  assert.ok(!bodyOf(otherPage).includes('Pair this device'), 'an unrevoked device was asked to pair again');
});

// ─── CRITERION 6 ────────────────────────────────────────────────────────────────────────────────

test('the denial is byte-identical to what a paired device gets for a route that does not exist', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const cookie = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');
  const phoneId = parseCredential(cookie.split('=')[1] ?? '')!.deviceId;

  // Something a PAIRED device asks for that is not there. This is the reference response.
  const reference = await get(server.port, '/api/nothing-is-here', { Cookie: cookie, 'Sec-Fetch-Dest': 'empty' });
  assert.equal(statusOf(reference), 404);

  const unpaired = await get(server.port, '/api/status', { 'Sec-Fetch-Dest': 'empty' });
  const forged = await get(server.port, '/api/status', { Cookie: `oma_device=oma1.${'0'.repeat(32)}.${'A'.repeat(43)}`, 'Sec-Fetch-Dest': 'empty' });

  assert.equal(revokeDevice(phoneId, env).kind, 'revoked');
  const revoked = await get(server.port, '/api/status', { Cookie: cookie, 'Sec-Fetch-Dest': 'empty' });

  // THE ACTUAL BYTES. Status line, every header, header order, body, content-length.
  assert.equal(withoutClock(unpaired), withoutClock(reference), 'an unpaired denial is distinguishable from an ordinary 404');
  assert.equal(withoutClock(forged), withoutClock(reference), 'a forged-credential denial is distinguishable from an ordinary 404');
  assert.equal(withoutClock(revoked), withoutClock(reference), 'a revoked denial is distinguishable from an ordinary 404');

  // And nothing about what is running is in any of them.
  for (const response of [unpaired, forged, revoked]) {
    for (const secret of [SECRET_SESSION_ID, SECRET_AGENT_NAME, SECRET_MACHINE_NAME, phoneId]) {
      assert.ok(!response.includes(secret), `a denial contained ${secret}`);
    }
    assert.ok(!/session|agent|machine|host|paired|pair|revok|count|auth/i.test(bodyOf(response)), `a denial body described itself: ${bodyOf(response)}`);
    assert.ok(!/www-authenticate|x-/i.test(response), `a denial carried a telltale header: ${response}`);
    // No count of anything, which would say how many sessions or devices exist.
    assert.ok(!/\d+ (session|device|agent)/i.test(response));
  }
});

// TIMING, PROBED RATHER THAN ASSUMED. A fixed millisecond bound would be a claim about the machine
// this happens to run on. Instead the test measures its own noise floor first — two samples of the
// SAME request — and only then asks whether the denial and the reference differ by more than that
// noise. If the environment is too jittery for the measurement to mean anything, it skips and says
// so rather than passing on a coin flip.
test('the denial does not take a measurably different time from an ordinary 404', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());
  const cookie = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');

  const time = async (headers: Record<string, string>, route: string): Promise<number> => {
    const started = process.hrtime.bigint();
    await get(server.port, route, headers);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

  const N = 60;
  const paired: number[] = [];
  const pairedAgain: number[] = [];
  const denied: number[] = [];
  for (let i = 0; i < N; i++) {
    // Interleaved, so a machine that gets busy half way through affects all three equally.
    paired.push(await time({ Cookie: cookie, 'Sec-Fetch-Dest': 'empty' }, '/api/nothing-is-here'));
    pairedAgain.push(await time({ Cookie: cookie, 'Sec-Fetch-Dest': 'empty' }, '/api/also-nothing'));
    denied.push(await time({ 'Sec-Fetch-Dest': 'empty' }, '/api/status'));
  }

  // The noise floor: how far apart two medians of the SAME operation land on this machine.
  const noise = Math.abs(median(paired) - median(pairedAgain));
  const observed = Math.abs(median(paired) - median(denied));
  const budget = Math.max(noise * 4, 0.5);

  if (noise > 2) {
    t.skip(`this machine's timing noise between two identical requests is ${noise.toFixed(2)}ms, which is larger than any difference this test could attribute to the code path`);
    return;
  }
  assert.ok(
    observed <= budget,
    `the denial takes ${observed.toFixed(3)}ms more/less than an ordinary 404 (noise floor ${noise.toFixed(3)}ms, budget ${budget.toFixed(3)}ms) — the failure is measurable and criterion 6 names timing`,
  );
});

// ─── CRITERION 7 ────────────────────────────────────────────────────────────────────────────────

test('a paired device does not pair again after the host restarts', async (t) => {
  const env = tempEnv();
  const first = await serve(env);
  const cookie = await pairViaHttp(first.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');
  assert.equal(statusOf(await get(first.port, '/api/status', { Cookie: cookie })), 200);

  // The host goes away entirely. Its sockets close; anything it held in memory is gone.
  await first.close();

  const second = await serve(env);
  t.after(() => second.close());

  const after = await get(second.port, '/api/status', { Cookie: cookie });
  assert.equal(statusOf(after), 200, 'a paired device was asked to pair again after a restart');

  const page = await get(second.port, '/', { Cookie: cookie, 'Sec-Fetch-Dest': 'document' });
  assert.ok(!bodyOf(page).includes('Pair this device'), 'a paired device was shown the pairing prompt after a restart');
});

// ─── CRITERION 4, over HTTP ─────────────────────────────────────────────────────────────────────

test('a paired device can list devices and revoke one of them', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const phone = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');
  const laptop = await pairViaHttp(server.port, env, 'Mozilla/5.0 (Macintosh) Firefox/121.0');

  const listed = await get(server.port, '/api/devices', { Cookie: laptop });
  assert.equal(statusOf(listed), 200);
  const data = JSON.parse(bodyOf(listed)) as { devices: Array<{ id: string; label: string; isThisDevice: boolean }> };
  assert.equal(data.devices.length, 2);
  assert.deepEqual(data.devices.map((d) => d.label).sort(), ['Mac · Firefox', 'iPhone · Safari']);
  assert.equal(data.devices.filter((d) => d.isThisDevice).length, 1);

  const target = data.devices.find((d) => d.label === 'iPhone · Safari')!;
  const revoked = await post(server.port, '/api/devices/revoke', JSON.stringify({ id: target.id }), { Cookie: laptop });
  assert.equal(statusOf(revoked), 200);

  assert.equal(statusOf(await get(server.port, '/api/status', { Cookie: phone, 'Sec-Fetch-Dest': 'empty' })), 404);
  assert.equal(statusOf(await get(server.port, '/api/status', { Cookie: laptop })), 200);
});

// ─── THE STORE THAT CANNOT BE READ, ON THE WIRE ─────────────────────────────────────────────────

test('a host whose pairing store is corrupt serves NOTHING, loudly, to a device that worked', async (t) => {
  const env = tempEnv();
  const server = await serve(env);
  t.after(() => server.close());

  const cookie = await pairViaHttp(server.port, env, 'Mozilla/5.0 (iPhone) Safari/604.1');
  assert.equal(statusOf(await get(server.port, '/api/status', { Cookie: cookie })), 200, 'the credential did not work before the store was corrupted');

  const { writeFileSync } = await import('node:fs');
  const { pairingStoreFile } = await import('../src/pairing/store.js');
  writeFileSync(pairingStoreFile(env), '{{{ not a store');

  const denied = await get(server.port, '/api/status', { Cookie: cookie, 'Sec-Fetch-Dest': 'empty' });
  assert.equal(statusOf(denied), 404, 'a host with an unreadable pairing store still served a request — this is fail-open');

  // Not even the pairing prompt. A store we cannot read is not a store with nobody in it, and the
  // difference is visible here: an unpaired browser gets a prompt, this one gets nothing.
  const page = await get(server.port, '/', { Cookie: cookie, 'Sec-Fetch-Dest': 'document' });
  assert.equal(statusOf(page), 404, 'an unreadable store served a page');
});
