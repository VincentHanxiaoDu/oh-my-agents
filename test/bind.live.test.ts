// CRITERION 3, measured against the real network stack of whatever machine this runs on.
//
// THESE TESTS PROBE THEIR ENVIRONMENT, THEY DO NOT NAME IT. No interface name, no 100.x literal,
// no assumption that Tailscale is installed. Each one asks the machine what it actually has, and
// SKIPS WITH A STATED REASON when the machine cannot support the check. CI has no Tailscale and no
// routable LAN address, so the tailnet test will skip there and say so — a skip that explains
// itself is honest; a test that silently passes because its subject was absent is the failure this
// rule exists for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackAddress, isTailscaleAddress } from '../src/host/bind.js';
import { detectTailnet } from '../src/host/tailnet.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

function run(args: string[], stateDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, OMA_STATE_DIR: stateDir }, timeout: 60000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => resolve(p));
    });
  });
}

/** Try to open a TCP connection. Resolves with what happened; never throws. */
function tryConnect(host: string, port: number, timeoutMs = 3000): Promise<'connected' | string> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (result: 'connected' | string): void => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done('connected'));
    sock.once('timeout', () => done('ETIMEDOUT'));
    sock.once('error', (err) => done((err as NodeJS.ErrnoException).code ?? err.message));
  });
}

/** Every IPv4 address on this machine that is neither loopback nor inside Tailscale's space. */
function nonTailnetNonLoopbackIPv4(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family !== 'IPv4') continue;
      const a = e.address;
      if (isLoopbackAddress(a) || isTailscaleAddress(a)) continue;
      if (a.startsWith('169.254.')) continue; // link-local: not a path anyone would come in on
      out.push(a);
    }
  }
  return out;
}

test('a request arriving on a LAN-only interface does not reach the host', async (t) => {
  const lanAddresses = nonTailnetNonLoopbackIPv4();
  if (lanAddresses.length === 0) {
    t.skip(
      'SKIPPED, and here is why: this machine has no IPv4 address that is neither loopback nor a ' +
        'Tailscale address, so there is no LAN-only path to prove the host is absent from. This is ' +
        'the normal case on a CI runner. The check is not being asserted, and nothing here says ' +
        'criterion 3 holds on a machine that does have one.',
    );
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'oma-lan-'));
  const port = await freePort();
  t.after(async () => {
    await run(['stop'], dir);
  });

  const started = await run(['start', '--port', String(port)], dir);
  assert.equal(started.code, 0, started.stderr);

  // The control: the host IS serving on this port, over loopback. Without this, "nothing answered
  // on the LAN address" would also be true of a host that failed to start, and the test would pass
  // for the wrong reason.
  assert.equal(await tryConnect('127.0.0.1', port), 'connected', 'the host is not serving at all — this test would pass vacuously');

  for (const lan of lanAddresses) {
    const result = await tryConnect(lan, port);
    assert.notEqual(result, 'connected', `the host accepted a connection on the LAN address ${lan}:${port} — criterion 3 is broken`);
  }
});

test('when a tailnet is really up, the host binds it and the printed address answers', async (t) => {
  const status = await detectTailnet();
  if (status.kind !== 'up') {
    t.skip(
      `SKIPPED, and here is why: tailnet detection on this machine returned '${status.kind}' ` +
        `(${status.reason}). There is no tailnet address to bind or to fetch, so this check cannot ` +
        'be run here. It is not being asserted. CI has no Tailscale and will always land here.',
    );
    return;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'oma-ts-'));
  const port = await freePort();
  t.after(async () => {
    await run(['stop'], dir);
  });

  const started = await run(['start', '--port', String(port)], dir);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /^REACHABILITY: tailnet$/m);

  const printed = /http:\/\/(\[[^\]]+\]|[^\s/:]+):(\d+)\//.exec(started.stdout);
  assert.ok(printed, 'the banner printed no address');
  const host = printed![1]!.replace(/^\[|\]$/g, '');
  assert.ok(isTailscaleAddress(host), `the banner's primary address ${host} is not a Tailscale address`);

  // THE PRINTED ADDRESS IS THE ONE THAT WORKS — asserted by connecting to exactly what was printed.
  assert.equal(await tryConnect(host, Number(printed![2])), 'connected', `nothing answered on the printed address ${host}`);
});
