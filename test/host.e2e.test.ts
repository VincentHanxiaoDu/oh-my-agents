// The end-to-end tests: real processes, real sockets, real exit codes.
//
// Reading the diff is not verification, so these start the actual host, fetch the actual address,
// read the actual `$?`, and start it twice. Every one of them was watched go red before it was
// kept — the criterion 5 exit-code test was inverted (asserting 0 for a stopped host) and observed
// failing; the criterion 7 test was made to expect 0 from the second start and observed failing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.js');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], stateDir: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      // The ambient environment is deliberately not inherited for OMA_STATE_DIR: a developer with a
      // real host running must not have these tests talk to it, or stop it.
      { env: { ...process.env, OMA_STATE_DIR: stateDir }, timeout: 60000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

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

function get(host: string, port: number, p: string, timeoutMs = 4000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: p, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function tmpState(tag: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `oma-${tag}-`));
}

function ppidOf(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, stdout) => {
      if (err) reject(err);
      else resolve(Number(String(stdout).trim()));
    });
  });
}

test('the whole lifecycle: one command starts it, it serves, status agrees, stop stops it', async (t) => {
  const dir = tmpState('life');
  const port = await freePort();

  t.after(async () => {
    await run(['stop', '--port', String(port)], dir);
  });

  // CRITERION 1 — one command, no further configuration.
  const started = await run(['start', '--port', String(port)], dir);
  assert.equal(started.code, 0, `start failed: ${started.stderr}`);
  assert.match(started.stdout, /oh-my-agents host is serving/);
  // CRITERION 4 — the marker that makes the two cases distinguishable from the output alone.
  assert.match(started.stdout, /^REACHABILITY: (tailnet|local-only)$/m);
  assert.match(started.stdout, /^DETERMINATION: (determined|undetermined)$/m);

  // CRITERION 2/1 — the printed address is the one that works. Extract it from the banner and use
  // exactly that, rather than reconstructing one we believe it should have printed.
  const printed = /http:\/\/([^\s/]+):(\d+)\//.exec(started.stdout);
  assert.ok(printed, 'the banner printed no address');
  const shownHost = printed![1]!.replace(/^\[|\]$/g, '');
  const shownPort = Number(printed![2]);
  assert.equal(shownPort, port);

  const page = await get(shownHost, shownPort, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>oh-my-agents<\/title>/);

  const api = await get('127.0.0.1', port, '/api/status');
  assert.equal(api.status, 200);
  const body = JSON.parse(api.body) as Record<string, unknown>;
  assert.equal(body.sessionCount, 0);
  assert.ok(Array.isArray(body.addresses));
  assert.ok((body.addresses as string[]).includes('127.0.0.1'));
  // CRITERION 3 — no wildcard ever appears in what the host says it bound.
  for (const a of body.addresses as string[]) {
    assert.ok(a !== '0.0.0.0' && a !== '::', `the host reports binding the wildcard ${a}`);
  }

  // CRITERION 5 — running exits 0 and reports address and session count.
  const status = await run(['status'], dir);
  assert.equal(status.code, 0, `status said: ${status.stderr}`);
  assert.match(status.stdout, /^RUNNING$/m);
  assert.match(status.stdout, /sessions: 0/);
  assert.match(status.stdout, /address:\s+http:\/\//);

  // CRITERION 7 — the second start refuses and exits non-zero.
  const second = await run(['start', '--port', String(port)], dir);
  assert.notEqual(second.code, 0);
  assert.equal(second.code, 3);
  assert.match(second.stderr, /already running/i);
  // And there is still exactly one host: the record still names the first pid.
  const stillOne = await run(['status'], dir);
  assert.equal(stillOne.code, 0);
  assert.equal(
    /pid:\s+(\d+)/.exec(status.stdout)![1],
    /pid:\s+(\d+)/.exec(stillOne.stdout)![1],
    'the second start produced a different host',
  );

  // CRITERION 6 — the host has left the terminal. Its parent is init (or the platform's reaper),
  // never the shell that ran the command, and a SIGHUP does not stop it.
  const pid = Number(/pid:\s+(\d+)/.exec(status.stdout)![1]);
  const ppid = await ppidOf(pid);
  assert.notEqual(ppid, process.pid, 'the host is still a child of the test process');
  assert.ok(ppid <= 1 || ppid === 1, `the host was reparented to ${ppid}, expected the init process`);
  process.kill(pid, 'SIGHUP');
  await new Promise((r) => setTimeout(r, 500));
  const afterHup = await get('127.0.0.1', port, '/healthz');
  assert.equal(afterHup.status, 200, 'the host stopped on SIGHUP, which is what a closing terminal sends');

  // Stop, and then criterion 5's other half.
  const stopped = await run(['stop'], dir);
  assert.equal(stopped.code, 0, stopped.stderr);

  const gone = await run(['status'], dir);
  assert.equal(gone.code, 4, 'a stopped host must exit 4, not 0 and not 5');
  assert.match(gone.stderr, /NOT RUNNING/);
  // "reports nothing that could be mistaken for a running host": no address, no port, no count.
  assert.equal(gone.stdout.trim(), '');
  assert.ok(!/RUNNING$/m.test(gone.stderr.replace(/NOT RUNNING/g, '')), 'the not-running output contains the word RUNNING on its own');
  assert.ok(!/sessions:/.test(gone.stderr), 'the not-running output reports a session count');
  assert.ok(!/http:\/\//.test(gone.stderr), 'the not-running output names an address');
});

test('CRITERION 5: running and not-running differ BY EXIT CODE ALONE', async (t) => {
  const dir = tmpState('codes');
  const port = await freePort();
  t.after(async () => {
    await run(['stop'], dir);
  });

  const before = await run(['status'], dir);
  assert.equal(before.code, 4);

  assert.equal((await run(['start', '--port', String(port)], dir)).code, 0);
  const during = await run(['status'], dir);
  assert.equal(during.code, 0);

  assert.equal((await run(['stop'], dir)).code, 0);
  const after = await run(['status'], dir);
  assert.equal(after.code, 4);

  assert.notEqual(before.code, during.code);
  assert.notEqual(after.code, during.code);
});

test('CRITERION 5: could-not-determine gets its own exit code, distinct from not-running', async () => {
  const dir = tmpState('undet');
  mkdirSync(dir, { recursive: true });
  // A record that exists and cannot be understood. This is "I do not know", and it must not be
  // reported as "nothing is running" — a user who acts on that starts a second host.
  writeFileSync(path.join(dir, 'host.json'), '{ this is not json');

  const r = await run(['status'], dir);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /COULD NOT DETERMINE/);
  assert.ok(!/NOT RUNNING/.test(r.stderr), 'undetermined was rendered as not-running');

  const absent = await run(['status'], tmpState('absent'));
  assert.equal(absent.code, 4);
  assert.notEqual(r.code, absent.code);
});

test('an unsettled product decision is refused loudly rather than answered', async () => {
  const dir = tmpState('refuse');
  for (const flag of ['--install-service', '--launchd', '--systemd', '--enable-at-login', '--boot=1']) {
    const r = await run([flag], dir);
    assert.equal(r.code, 6, `${flag} did not refuse`);
    assert.match(r.stderr, /REFUSING/);
    assert.match(r.stderr, /OPEN PRODUCT\s+DECISION/);
    assert.ok(!/^REACHABILITY/m.test(r.stdout), `${flag} started a host`);
  }
});

test('the help text names the exit codes, because criterion 5 is about them', async () => {
  const r = await run(['help'], tmpState('help'));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /could not determine/i);
  assert.match(r.stdout, /no host is running here/i);
});
