// The commands a person actually runs: real processes, real exit codes.
//
// Watched go red: the "an open decision is refused" test was inverted to expect 0 and observed
// failing, and `--device-ttl` was temporarily removed from the refusing list and the test observed
// failing with exit 1 (unknown command) instead of 6.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseCode } from '../src/pairing/codes.js';
import { pairingStoreFile } from '../src/pairing/store.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stateDir: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, OMA_STATE_DIR: stateDir }, timeout: 60000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'oma-cli-'));
}

function codeFrom(stdout: string): string {
  const m = /^\s{4}([0-9A-Z]{4}-[0-9A-Z]{4})\s*$/m.exec(stdout);
  assert.ok(m, `no pairing code in the output:\n${stdout}`);
  return m![1]!;
}

// CRITERION 2
test('`pair` prints a code on demand, and says what it is good for', async () => {
  const dir = tmp();
  const result = await run(['pair'], dir);
  assert.equal(result.code, 0, result.stderr);
  const code = codeFrom(result.stdout);
  assert.equal(normaliseCode(code).length, 8);
  assert.match(result.stdout, /works ONCE/);
  assert.match(result.stdout, /expires in \d+ minutes/);
  // And it says out loud that nothing expires the DEVICE, which is the open decision.
  assert.match(result.stdout, /nothing expires it on its own/);
});

test('two `pair` runs produce two different codes', async () => {
  const dir = tmp();
  const a = codeFrom((await run(['pair'], dir)).stdout);
  const b = codeFrom((await run(['pair'], dir)).stdout);
  assert.notEqual(a, b);
});

// CRITERION 4 and 5, through the commands
test('`devices` lists nothing on a fresh host, and `revoke` on nothing exits 7', async () => {
  const dir = tmp();
  const listed = await run(['devices'], dir);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /No devices are paired/);

  const revoked = await run(['revoke', 'abcdef12'], dir);
  assert.equal(revoked.code, 7, 'a device that is not there must not exit 0 and must not exit 5');
  assert.match(revoked.stderr, /Nothing has been revoked/);
});

test('a corrupt store makes `devices` and `revoke` say UNDETERMINED, not "none"', async () => {
  const dir = tmp();
  writeFileSync(pairingStoreFile({ OMA_STATE_DIR: dir }), '{ broken');

  const listed = await run(['devices'], dir);
  assert.equal(listed.code, 5, 'an unreadable store reported as an answer rather than as undetermined');
  assert.match(listed.stderr, /COULD NOT DETERMINE/);
  assert.match(listed.stderr, /NOT the same as "no devices are paired"/);
  assert.ok(!/No devices are paired with this host/.test(listed.stdout));

  const revoked = await run(['revoke', 'abcdef12'], dir);
  assert.equal(revoked.code, 5);
  assert.match(revoked.stderr, /NOTHING has been revoked/);

  const paired = await run(['pair'], dir);
  assert.equal(paired.code, 5, 'a code was issued against a store that could not be read');
});

// THE OPEN DECISION
test('a flag that would give a device credential a lifetime is REFUSED, not defaulted', async () => {
  const dir = tmp();
  for (const flag of ['--device-ttl=30d', '--session-lifetime', '--max-age=90', '--idle-timeout=1h', '--reauth-after=7d']) {
    const result = await run([flag], dir);
    assert.equal(result.code, 6, `${flag} did not refuse (exit ${result.code})`);
    assert.match(result.stderr, /REFUSING/);
    assert.match(result.stderr, /OPEN PRODUCT DECISION on Issue #5/);
    // It names the distinction it is protecting, so nobody "fixes" this by pointing at the code TTL.
    assert.match(result.stderr, /NOT about the pairing CODE/);
  }
});

test('the refusal does not accidentally catch the pairing code TTL, which IS built', async () => {
  const dir = tmp();
  // `pair` works. If the refusing list had swallowed the whole feature this would exit 6.
  const result = await run(['pair'], dir);
  assert.equal(result.code, 0);
});

test('the help text names the new commands and the new exit code', async () => {
  const dir = tmp();
  const result = await run(['help'], dir);
  assert.equal(result.code, 0);
  for (const line of ['oh-my-agents pair', 'oh-my-agents devices', 'oh-my-agents revoke']) {
    assert.ok(result.stdout.includes(line), `help does not mention '${line}'`);
  }
  assert.match(result.stdout, /^\s+7\s+we looked, and the thing you named is not there$/m);
});
