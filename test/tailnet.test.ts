// Tailscale detection has FOUR answers and two of them mean "nothing", differently, and one means
// "I don't know". These tests exist because collapsing the last one into the others is the defect
// criterion 4 is written against.
//
// The prober is injected, so none of this depends on whether Tailscale is installed on the machine
// running the tests. See tailnet.live.test.ts for the part that does, and skips when it cannot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTailnet, isDetermined, type ProbeResult } from '../src/host/tailnet.js';

const probe = (r: Partial<ProbeResult>): (() => Promise<ProbeResult>) => async () => ({
  outcome: 'ok',
  stdout: '',
  stderr: '',
  code: 0,
  command: 'tailscale',
  ...r,
});

test('no tailscale binary anywhere is ABSENT — determined, and safe to say out loud', async () => {
  const status = await detectTailnet(probe({ outcome: 'missing' }));
  assert.equal(status.kind, 'absent');
  assert.equal(isDetermined(status), true);
});

test('a running backend with an address is UP', async () => {
  const status = await detectTailnet(
    probe({
      stdout: JSON.stringify({
        BackendState: 'Running',
        Self: { TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], DNSName: 'box.tail1234.ts.net.' },
      }),
    }),
  );
  assert.equal(status.kind, 'up');
  if (status.kind !== 'up') return;
  assert.equal(status.address, '100.101.102.103');
  assert.deepEqual(status.addresses, ['100.101.102.103', 'fd7a:115c:a1e0::1']);
  assert.equal(status.hostname, 'box.tail1234.ts.net');
});

test('a logged-out or stopped backend is DOWN — determined, and not the same as absent', async () => {
  for (const state of ['NeedsLogin', 'Stopped', 'NoState']) {
    const status = await detectTailnet(probe({ stdout: JSON.stringify({ BackendState: state }) }));
    assert.equal(status.kind, 'down', `${state} was not read as down`);
    assert.equal(isDetermined(status), true);
  }
});

test('running with no address yet is DOWN, not UP and not absent', async () => {
  const status = await detectTailnet(probe({ stdout: JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: [] } }) }));
  assert.equal(status.kind, 'down');
});

test('a CLI that fails saying tailscaled is not running is DOWN', async () => {
  const status = await detectTailnet(
    probe({ outcome: 'failed', code: 1, stderr: 'failed to connect to local tailscaled; is tailscaled running?' }),
  );
  assert.equal(status.kind, 'down');
});

test('a CLI that fails saying something unrecognised is UNDETERMINED, never absent and never down', async () => {
  const status = await detectTailnet(probe({ outcome: 'failed', code: 70, stderr: 'sandbox: operation not permitted' }));
  assert.equal(status.kind, 'undetermined');
  assert.equal(isDetermined(status), false);
});

test('a timeout or a throw while probing is UNDETERMINED', async () => {
  const status = await detectTailnet(async () => {
    throw new Error('ETIMEDOUT');
  });
  assert.equal(status.kind, 'undetermined');
  assert.match(status.kind === 'undetermined' ? status.reason : '', /ETIMEDOUT/);
});

test('output that is not JSON, or JSON without a backend state, is UNDETERMINED', async () => {
  assert.equal((await detectTailnet(probe({ stdout: 'not json at all' }))).kind, 'undetermined');
  assert.equal((await detectTailnet(probe({ stdout: '{}' }))).kind, 'undetermined');
  assert.equal((await detectTailnet(probe({ stdout: 'null' }))).kind, 'undetermined');
});

test('an unrecognised backend state is UNDETERMINED rather than guessed onto one side', async () => {
  const status = await detectTailnet(probe({ stdout: JSON.stringify({ BackendState: 'SomethingNewInV2' }) }));
  assert.equal(status.kind, 'undetermined');
});

test('ABSENT and UNDETERMINED are different values, which is the whole point', async () => {
  const absent = await detectTailnet(probe({ outcome: 'missing' }));
  const unknown = await detectTailnet(probe({ outcome: 'failed', code: 70, stderr: 'who knows' }));
  assert.notEqual(absent.kind, unknown.kind);
  assert.equal(isDetermined(absent), true);
  assert.equal(isDetermined(unknown), false);
});
