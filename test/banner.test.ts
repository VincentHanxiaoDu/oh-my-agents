// CRITERION 4 — the loopback-only case and the tailnet case must be distinguishable FROM THE
// STARTUP OUTPUT ALONE. So this asserts on the output a person and a script both read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBanner, primaryUrl } from '../src/host/banner.js';
import { resolveBind } from '../src/host/bind.js';
import type { TailnetStatus } from '../src/host/tailnet.js';

const plan = (status: TailnetStatus, local: string[]) => resolveBind(status, { localAddresses: local });

const tailnetPlan = plan(
  { kind: 'up', address: '100.101.102.103', addresses: ['100.101.102.103'], hostname: null, via: 'tailscale' },
  ['127.0.0.1', '100.101.102.103'],
);
const absentPlan = plan({ kind: 'absent', reason: 'no tailscale binary was found on this machine' }, ['127.0.0.1']);
const downPlan = plan({ kind: 'down', reason: 'Tailscale is installed and its backend state is Stopped' }, ['127.0.0.1']);
const unknownPlan = plan({ kind: 'undetermined', reason: 'the probe timed out' }, ['127.0.0.1']);

test('the tailnet banner prints the address that works from another device', () => {
  const out = renderBanner({ plan: tailnetPlan, port: 8787, pid: 42 });
  assert.match(out, /^REACHABILITY: tailnet$/m);
  assert.match(out, /http:\/\/100\.101\.102\.103:8787\//);
  assert.equal(primaryUrl(tailnetPlan, 8787), 'http://100.101.102.103:8787/');
});

test('the loopback-only banner says plainly that only local access is available', () => {
  for (const p of [absentPlan, downPlan]) {
    const out = renderBanner({ plan: p, port: 8787, pid: 42 });
    assert.match(out, /^REACHABILITY: local-only$/m);
    assert.match(out, /LOCAL ACCESS ONLY/);
    assert.match(out, /this machine only/);
    // It must not offer an address that suggests remote reach.
    assert.ok(!/100\.\d+\.\d+\.\d+/.test(out), 'a loopback-only banner named a tailnet-shaped address');
  }
});

test('the two cases are distinguishable from the startup output alone', () => {
  const a = renderBanner({ plan: tailnetPlan, port: 8787, pid: 1 });
  const b = renderBanner({ plan: absentPlan, port: 8787, pid: 1 });
  const marker = (s: string): string => /^REACHABILITY: (.+)$/m.exec(s)![1]!;
  assert.notEqual(marker(a), marker(b));
  assert.equal(marker(a), 'tailnet');
  assert.equal(marker(b), 'local-only');
});

test('COULD NOT DETERMINE is its own banner and never claims Tailscale is absent', () => {
  const out = renderBanner({ plan: unknownPlan, port: 8787, pid: 1 });
  assert.match(out, /^DETERMINATION: undetermined$/m);
  assert.match(out, /COULD NOT DETERMINE/);
  assert.ok(!/no tailscale binary/i.test(out));
  // And it differs from the determined-absent banner, which is the distinction the rule protects.
  const absent = renderBanner({ plan: absentPlan, port: 8787, pid: 1 });
  assert.match(absent, /^DETERMINATION: determined$/m);
  assert.notEqual(out, absent);
});

test('the banner says the host has left the terminal, which is what criterion 6 promises', () => {
  const out = renderBanner({ plan: tailnetPlan, port: 8787, pid: 99 });
  assert.match(out, /pid 99/);
  assert.match(out, /closing it will not stop it/);
});

test('a refused address is named in the banner rather than silently dropped', () => {
  const p = plan(
    { kind: 'up', address: '192.168.1.5', addresses: ['192.168.1.5'], hostname: null, via: 'tailscale' },
    ['127.0.0.1', '192.168.1.5'],
  );
  const out = renderBanner({ plan: p, port: 8787, pid: 1 });
  assert.match(out, /Addresses this host refused to bind/);
  assert.match(out, /192\.168\.1\.5/);
  assert.match(out, /^REACHABILITY: local-only$/m);
});
