// CRITERION 7 (the lock half) and the "could not determine" rule applied to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, isProcessAlive, readLock, releaseLock } from '../src/host/lock.js';
import { hostLockFile, stateDir } from '../src/paths.js';
import { readHostRecord, writeHostRecord } from '../src/host/state.js';

function isolated(): { OMA_STATE_DIR: string } {
  return { OMA_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), 'oma-lock-')) };
}

// A pid that is not a live process, found IMMEDIATELY BEFORE it is used.
//
// The first version computed this once at module load, and the test failed intermittently: the
// other test files spawn host processes, one of them took the pid, and a lock naming it was
// correctly reported as HELD. The window cannot be closed entirely — pids are reused — so it is
// made as small as possible and the liveness is re-asserted at the point of use.
function findDeadPid(): number {
  for (let candidate = process.pid + 1; candidate < process.pid + 5000; candidate++) {
    if (!isProcessAlive(candidate)) return candidate;
  }
  throw new Error('could not find a dead pid to test with');
}

test('the state directory honours OMA_STATE_DIR and XDG_STATE_HOME, in that order', () => {
  assert.equal(stateDir({ OMA_STATE_DIR: '/tmp/x', XDG_STATE_HOME: '/tmp/y' }), '/tmp/x');
  assert.equal(stateDir({ XDG_STATE_HOME: '/tmp/y' }), '/tmp/y/oh-my-agents');
  assert.equal(stateDir({ HOME: '/home/z' }), '/home/z/.local/state/oh-my-agents');
  // A relative XDG value is ignored, per the spec, rather than resolved against the cwd of whatever
  // shell happened to start the daemon.
  assert.equal(stateDir({ XDG_STATE_HOME: 'relative', HOME: '/home/z' }), '/home/z/.local/state/oh-my-agents');
});

test('the first acquire wins and the second is told a host is already running', () => {
  const env = isolated();
  assert.equal(acquireLock(process.pid, env).kind, 'acquired');
  const second = acquireLock(process.pid + 100000, env);
  assert.equal(second.kind, 'held');
  if (second.kind === 'held') assert.equal(second.pid, process.pid);
  releaseLock(process.pid, env);
  assert.equal(existsSync(hostLockFile(env)), false);
});

test('a lock naming a dead process is stale and is taken', () => {
  const env = isolated();
  mkdirSync(stateDir(env), { recursive: true });
  const deadPid = findDeadPid();
  assert.equal(isProcessAlive(deadPid), false, 'the pid chosen for this test came alive before it was used');
  writeFileSync(hostLockFile(env), JSON.stringify({ pid: deadPid, startedAt: 'then' }));
  const result = acquireLock(process.pid, env);
  assert.equal(result.kind, 'acquired');
  const back = readLock(env);
  assert.notEqual(back, 'absent');
  assert.notEqual(back, 'unreadable');
  if (back !== 'absent' && back !== 'unreadable') assert.equal(back.pid, process.pid);
});

test('a lock we cannot understand is UNDETERMINED — not taken, and not reported as a running host', () => {
  const env = isolated();
  mkdirSync(stateDir(env), { recursive: true });
  writeFileSync(hostLockFile(env), 'this is not json');
  const result = acquireLock(process.pid, env);
  assert.equal(result.kind, 'undetermined');
  if (result.kind === 'undetermined') {
    assert.match(result.reason, /cannot tell whose it is/);
    assert.match(result.reason, /no host has been shown to be running/);
  }
  // Crucially it is NOT 'held': that would report a running host we have no evidence for.
  assert.notEqual(result.kind, 'held');
});

test('releaseLock never removes a lock a different host has taken', () => {
  const env = isolated();
  acquireLock(process.pid, env);
  releaseLock(process.pid + 100000, env);
  assert.equal(existsSync(hostLockFile(env)), true);
  releaseLock(process.pid, env);
  assert.equal(existsSync(hostLockFile(env)), false);
});

test('a missing host record is ABSENT and a corrupt one is UNDETERMINED', async () => {
  const env = isolated();
  assert.equal((await readHostRecord(env)).kind, 'absent');

  await writeHostRecord(
    {
      schema: 1,
      pid: process.pid,
      port: 8787,
      addresses: ['127.0.0.1'],
      tailnetAddresses: [],
      reachability: 'local-only',
      determination: 'determined',
      reason: 'no tailnet',
      startedAt: new Date().toISOString(),
    },
    env,
  );
  const present = await readHostRecord(env);
  assert.equal(present.kind, 'present');

  writeFileSync(path.join(stateDir(env), 'host.json'), '{ not json');
  assert.equal((await readHostRecord(env)).kind, 'undetermined');

  writeFileSync(path.join(stateDir(env), 'host.json'), JSON.stringify({ schema: 99 }));
  assert.equal((await readHostRecord(env)).kind, 'undetermined');
});
