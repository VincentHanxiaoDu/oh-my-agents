// CRITERION 3 — the security boundary.
//
// These tests were each seen to fail before they were kept. The invariant test below was inverted
// (asserting that a LAN address IS bound) and observed red; `isTailscaleAddress` was made to return
// true unconditionally and the invariant test went red; the wildcard case was removed from
// `isWildcardAddress` and the wildcard test went red. Restored, all green.
//
// NOTHING HERE DEPENDS ON THE ENVIRONMENT. The resolver takes its local-address list as an
// argument, so these run identically on a laptop with Tailscale and on a CI runner without it.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeBindSet,
  isLoopbackAddress,
  isTailscaleAddress,
  isWildcardAddress,
  resolveBind,
} from '../src/host/bind.js';
import type { TailnetStatus } from '../src/host/tailnet.js';

const up = (addresses: string[]): TailnetStatus => ({
  kind: 'up',
  address: addresses[0] ?? '',
  addresses,
  hostname: 'box.example.ts.net',
  via: 'tailscale',
});

test('a tailnet address that is really on this machine is bound, alongside loopback', () => {
  const plan = resolveBind(up(['100.101.102.103']), { localAddresses: ['127.0.0.1', '100.101.102.103'] });
  assert.equal(plan.reachability, 'tailnet');
  assert.deepEqual(plan.addresses, ['127.0.0.1', '100.101.102.103']);
  assert.deepEqual(plan.tailnet, ['100.101.102.103']);
  assert.equal(plan.determination, 'determined');
});

test('loopback is always bound, so the host serves locally whatever else is true', () => {
  for (const status of [
    up(['100.64.0.1']),
    { kind: 'absent', reason: 'x' } as TailnetStatus,
    { kind: 'down', reason: 'x' } as TailnetStatus,
    { kind: 'undetermined', reason: 'x' } as TailnetStatus,
  ]) {
    const plan = resolveBind(status, { localAddresses: ['127.0.0.1', '100.64.0.1'] });
    assert.ok(plan.addresses.includes('127.0.0.1'), `loopback missing for ${status.kind}`);
  }
});

test('a wildcard offered as a tailnet address is refused, and the host falls back to loopback', () => {
  for (const wildcard of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*', '']) {
    const plan = resolveBind(up([wildcard]), { localAddresses: ['127.0.0.1', wildcard] });
    assert.equal(plan.reachability, 'local-only', `${wildcard} was not refused`);
    assert.deepEqual(plan.addresses, ['127.0.0.1']);
    assert.equal(plan.rejected.length, 1);
  }
});

test('a LAN address offered as a tailnet address is refused even when it is really on this machine', () => {
  // This is the case that matters: the address IS assigned locally, so an "is it on an interface?"
  // check alone would accept it and put the host on somebody's office LAN.
  for (const lan of ['192.168.1.20', '10.0.0.5', '172.16.4.4', '169.254.10.10']) {
    const plan = resolveBind(up([lan]), { localAddresses: ['127.0.0.1', lan] });
    assert.equal(plan.reachability, 'local-only', `${lan} was not refused`);
    assert.deepEqual(plan.tailnet, []);
    assert.match(plan.rejected[0]!.reason, /outside Tailscale's own address space/);
  }
});

test('a public address offered as a tailnet address is refused', () => {
  for (const pub of ['8.8.8.8', '203.0.113.9', '2606:4700::1111']) {
    const plan = resolveBind(up([pub]), { localAddresses: ['127.0.0.1', pub] });
    assert.equal(plan.reachability, 'local-only', `${pub} was not refused`);
  }
});

test('a Tailscale-shaped address that is NOT on this machine is refused', () => {
  const plan = resolveBind(up(['100.90.90.90']), { localAddresses: ['127.0.0.1'] });
  assert.equal(plan.reachability, 'local-only');
  assert.match(plan.rejected[0]!.reason, /not assigned to any interface/);
});

test('an IPv6 tailnet address is matched regardless of case and zone id', () => {
  const plan = resolveBind(up(['FD7A:115C:A1E0::1234%utun3']), {
    localAddresses: ['127.0.0.1', '::1', 'fd7a:115c:a1e0::1234'],
  });
  assert.equal(plan.reachability, 'tailnet');
  assert.ok(plan.tailnet.includes('fd7a:115c:a1e0::1234'));
});

test('THE INVARIANT: no input to the resolver ever produces a non-loopback, non-Tailscale bind', () => {
  // Every address the product could ever be handed, plus junk, crossed with every local-address
  // set that could make it look plausible. The assertion is on the OUTPUT, independently of how
  // the resolver decided — it re-derives loopback and Tailscale-space membership from the
  // definitions rather than calling the resolver's own predicates.
  const candidates = [
    '0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*', '', ' ', 'localhost', 'not-an-ip', '999.999.999.999',
    '127.0.0.1', '127.0.0.53', '::1',
    '192.168.0.1', '10.1.2.3', '172.20.30.40', '169.254.1.1', '100.63.255.255', '100.128.0.1',
    '8.8.8.8', '1.1.1.1', '203.0.113.7', '2606:4700::1111', 'fe80::1', 'fc00::1',
    '100.64.0.0', '100.127.255.255', '100.101.102.103',
    'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0::2', 'fd7a:115c:a1e1::1',
  ];
  const localSets: string[][] = [
    [],
    ['127.0.0.1'],
    ['127.0.0.1', '::1'],
    ['127.0.0.1', '::1', ...candidates],
  ];

  const isInTailscaleSpace = (a: string): boolean => {
    const s = a.trim().toLowerCase().split('%')[0]!;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (m) {
      const o = m.slice(1).map(Number);
      if (o.some((n) => n > 255)) return false;
      return o[0] === 100 && o[1]! >= 64 && o[1]! <= 127;
    }
    return s.startsWith('fd7a:115c:a1e0:');
  };
  const isLoop = (a: string): boolean => a === '::1' || /^127\./.test(a);
  // The comparison against the local set has to normalise too. It did not, and this test failed on
  // a correct resolver because the CLI spelling was `FD7A:...` and the bind was `fd7a:...` — the
  // test was wrong, not the code, and it is recorded here so the next reader does not re-fix it.
  const localHas = (set: string[], a: string): boolean =>
    set.some((x) => x.trim().toLowerCase().split('%')[0] === a);

  let sawATailnetBind = false;
  for (const local of localSets) {
    for (const c of candidates) {
      const statuses: TailnetStatus[] = [
        up([c]),
        up([c, c]),
        up([c, '100.101.102.103']),
        { kind: 'absent', reason: c },
        { kind: 'down', reason: c },
        { kind: 'undetermined', reason: c },
      ];
      for (const status of statuses) {
        const plan = resolveBind(status, { localAddresses: local });
        assert.ok(plan.addresses.length > 0, 'the bind set must never be empty');
        for (const addr of plan.addresses) {
          assert.ok(
            isLoop(addr) || (isInTailscaleSpace(addr) && localHas(local, addr)),
            `resolveBind(${JSON.stringify(status)}, ${JSON.stringify(local)}) produced '${addr}', which is neither loopback nor a locally-assigned Tailscale address`,
          );
          assert.ok(!isWildcardAddress(addr), `resolveBind produced the wildcard '${addr}'`);
        }
        if (plan.tailnet.length > 0) sawATailnetBind = true;
      }
    }
  }
  // A test that never once reached the interesting branch would pass vacuously, which is the exact
  // failure this project treats as worse than a red.
  assert.ok(sawATailnetBind, 'no input in this table ever produced a tailnet bind — the invariant was proved over the empty case');
});

test('assertSafeBindSet refuses a set the resolver could not have produced', () => {
  assert.throws(() => assertSafeBindSet([]), /bind set is empty/);
  assert.throws(() => assertSafeBindSet(['0.0.0.0']), /wildcard/);
  assert.throws(() => assertSafeBindSet(['127.0.0.1', '192.168.1.5']), /neither loopback nor a Tailscale address/);
  assertSafeBindSet(['127.0.0.1', '::1', '100.101.102.103']);
});

test('the address predicates say what they are named', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.53'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.0.1'), false);
  assert.equal(isTailscaleAddress('100.64.0.0'), true);
  assert.equal(isTailscaleAddress('100.127.255.255'), true);
  assert.equal(isTailscaleAddress('100.63.255.255'), false);
  assert.equal(isTailscaleAddress('100.128.0.1'), false);
  assert.equal(isTailscaleAddress('fd7a:115c:a1e0::1'), true);
  assert.equal(isTailscaleAddress('fd7a:115c:a1e1::1'), false);
});
