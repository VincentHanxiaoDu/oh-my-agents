// The pseudo-terminal layer.
//
// The parts that can be decided without spawning anything are asserted as pure functions; the part
// that cannot — whether this machine can actually give an agent a tty — is PROBED, and reported as
// a skip with a stated reason when it cannot. Naming an operating system here instead would make
// this file a test of `process.platform`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { detectPtySupport, ptyArgv, ptyEnv, shellQuote } from '../src/sessions/pty.js';
import { isValidSessionId } from '../src/sessions/paths.js';

test('shell quoting survives the characters that would otherwise end the quote', () => {
  for (const word of [`plain`, `with space`, `it's`, `a"b`, `$(whoami)`, `back\\slash`, `;rm -rf /`]) {
    // The proof is a round trip through a real shell: whatever comes back must be the input.
    const r = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(word)}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `the shell rejected ${JSON.stringify(word)}`);
    assert.equal(r.stdout, word, `quoting mangled ${JSON.stringify(word)}`);
  }
});

test('the BSD pipeline passes the agent’s argv through without a string round trip', () => {
  const argv = ptyArgv('bsd', '/tmp/f.fifo', '/tmp/s.status', '/usr/bin/env', ['A=1', 'a b', "it's"]);
  assert.equal(argv[0], '-c');
  // The fifo and the whole inner argv are passed as arguments, so nothing needs quoting and nothing
  // can be re-split. An argument containing a space arrives as one argument.
  assert.match(argv[1]!, /cat "\$fifo" \| exec script -q \/dev\/null "\$@"/);
  assert.deepEqual(argv.slice(2), [
    'oma',
    '/tmp/f.fifo',
    '/bin/sh',
    '-c',
    'st=$1; shift; "$@"; s=$?; printf %s "$s" > "$st"; exit "$s"',
    'sh',
    '/tmp/s.status',
    '/usr/bin/env',
    'A=1',
    'a b',
    "it's",
  ]);
});

// The status file is the ONLY route by which the agent's exit code reaches the supervisor: `cat` is
// blocked on a FIFO that never reaches EOF, so the pipeline's own status never arrives. A pipeline
// built without the recorder would leave every ended session reporting `live` forever.
test('both pipelines record the agent’s exit status where the supervisor can read it', () => {
  for (const flavour of ['bsd', 'util-linux'] as const) {
    const joined = ptyArgv(flavour, '/tmp/f.fifo', '/tmp/s.status', '/bin/true', []).join(' ');
    assert.match(joined, /\/tmp\/s.status/, `the ${flavour} pipeline never names the status file`);
    assert.match(joined, /\$\?/, `the ${flavour} pipeline never captures an exit status`);
  }
});

test('the util-linux pipeline quotes the command string it is forced to build', () => {
  const argv = ptyArgv('util-linux', '/tmp/f.fifo', '/tmp/s.status', '/usr/bin/env', ['a b', "it's"]);
  assert.equal(argv.length, 3, 'the util-linux form takes the command as one string, not as argv');
  assert.match(argv[1]!, /script -q -e -c /);
  // The single quote inside the argument must not be able to terminate the quoting around it.
  assert.match(argv[1]!, /'\\''/);
  assert.equal(argv[2], '/tmp/f.fifo');
});

test('the agent is given a TERM that can express colour, and an existing one is respected', () => {
  assert.equal(ptyEnv({}).TERM, 'xterm-256color');
  assert.equal(ptyEnv({ TERM: 'dumb' }).TERM, 'xterm-256color', 'a dumb terminal was passed through');
  assert.equal(ptyEnv({ TERM: 'screen-256color' }).TERM, 'screen-256color');
  assert.equal(ptyEnv({}).OMA_SESSION, '1');
});

test('pty support is a THREE-valued answer, and each value carries a reason', () => {
  const support = detectPtySupport(true);
  assert.ok(['available', 'absent', 'undetermined'].includes(support.kind));
  if (support.kind === 'available') {
    assert.ok(support.flavour === 'bsd' || support.flavour === 'util-linux');
  } else {
    // "not there" and "could not tell" are different answers, and neither is silent.
    assert.ok(support.reason.length > 0, 'a non-available answer came with no reason');
  }
});

test('a session id cannot be a path, a traversal, or a URL trick', () => {
  assert.equal(isValidSessionId('s1abc'), true);
  assert.equal(isValidSessionId('a-b-c'), true);
  for (const bad of ['..', '.', '', '../etc', 'a/b', 'a\\b', 'A1', 'a b', 'a--b', '-a', 'a'.repeat(65), 'a%2f']) {
    assert.equal(isValidSessionId(bad), false, `${JSON.stringify(bad)} was accepted as a session id`);
  }
});
