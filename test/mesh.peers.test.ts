// The join records: canonicalisation, deduplication (criterion 6), and the three-valued read.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePeerAddress } from '../src/mesh/address.js';
import { forgetPeer, joinPeer, peersFile, readPeers, recordPeerIdentity } from '../src/mesh/peers.js';
import { assembleView, type MeshHost } from '../src/mesh/view.js';

function tempEnv(): { OMA_STATE_DIR: string } {
  return { OMA_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'oma-peers-')) };
}

test('an address is canonicalised so one machine is one entry however it was typed', () => {
  const canonical = (s: string): string => {
    const r = parsePeerAddress(s);
    assert.equal(r.kind, 'ok', `${s} should parse: ${r.kind === 'invalid' ? r.reason : ''}`);
    return r.kind === 'ok' ? r.address.canonical : '';
  };
  // All five spellings of one machine.
  const forms = ['100.64.0.3', '100.64.0.3:8787', 'http://100.64.0.3:8787', 'http://100.64.0.3:8787/', ' 100.64.0.3 '];
  const all = new Set(forms.map(canonical));
  assert.equal(all.size, 1, `these are one machine, not ${all.size}: ${[...all].join(', ')}`);
  assert.equal([...all][0], '100.64.0.3:8787');

  // Case is not part of a host name.
  assert.equal(canonical('Laptop.Tail1234.ts.net'), canonical('laptop.tail1234.ts.net'));
  // IPv6, bracketed and bare, with and without a port.
  assert.equal(canonical('[fd7a:115c:a1e0::1]:9000'), '[fd7a:115c:a1e0::1]:9000');
  assert.equal(canonical('fd7a:115c:a1e0::1'), '[fd7a:115c:a1e0::1]:8787');
  assert.equal(canonical('http://[fd7a:115c:a1e0::1]:9000/'), '[fd7a:115c:a1e0::1]:9000');
  // A different PORT is a different endpoint, and two hosts on one machine are two hosts.
  assert.notEqual(canonical('100.64.0.3:8787'), canonical('100.64.0.3:9999'));

  for (const bad of ['', '   ', 'http://1.2.3.4/some/path', '1.2.3.4:0', '1.2.3.4:99999', '1.2.3.4:abc', '[::1', 'a b']) {
    assert.equal(parsePeerAddress(bad).kind, 'invalid', `${JSON.stringify(bad)} should be refused, not guessed at`);
  }
});

test('joining is idempotent by address and by learned identity — criterion 6', () => {
  const env = tempEnv();
  const first = joinPeer('100.64.0.3', env);
  // Asserted so nothing below can pass because the first join silently failed.
  assert.equal(first.kind, 'joined', 'the first join actually adds the peer');

  assert.equal(joinPeer('100.64.0.3:8787', env).kind, 'already-joined');
  assert.equal(joinPeer('http://100.64.0.3:8787/', env).kind, 'already-joined');
  const read = readPeers(env);
  assert.equal(read.kind === 'present' ? read.peers.length : -1, 1, 're-joining added no record');

  // The SAME MACHINE at a genuinely different address. Only its identity can catch this, and it is
  // only known once it has answered.
  assert.equal(joinPeer('laptop.example', env).kind, 'joined', 'a second address is a new record until it answers');
  recordPeerIdentity('100.64.0.3:8787', 'a'.repeat(32), 'laptop', env);
  recordPeerIdentity('laptop.example:8787', 'a'.repeat(32), 'laptop', env);
  const collapsed = readPeers(env);
  assert.equal(
    collapsed.kind === 'present' ? collapsed.peers.length : -1,
    1,
    'once both addresses answer with one identity they collapse into one machine',
  );
});

test('a peers file that cannot be understood is undetermined, and is never overwritten', () => {
  const env = tempEnv();
  mkdirSync(env.OMA_STATE_DIR, { recursive: true });
  const file = peersFile(env);
  const corrupt = '{ this is not json';
  writeFileSync(file, corrupt, 'utf8');

  const read = readPeers(env);
  assert.equal(read.kind, 'undetermined', 'a corrupt file is undetermined');
  // WATCHED GO RED: returning `{kind:'absent'}` here (the "just treat it as empty" fix) makes the
  // join below succeed and silently discard every machine the person had joined.
  const outcome = joinPeer('100.64.0.3', env);
  assert.equal(outcome.kind, 'undetermined', 'joining refuses rather than writing over an unreadable file');
  assert.equal(forgetPeer('100.64.0.3', env).kind, 'undetermined', 'and so does forgetting');

  const stillThere = readFileSync(file, 'utf8');
  assert.equal(stillThere, corrupt, 'the unreadable file is left exactly as it was');
});

test('absent and undetermined are different answers about the peer list', () => {
  const env = tempEnv();
  assert.equal(readPeers(env).kind, 'absent', 'no file means nobody has joined anything — a normal first run');
  mkdirSync(env.OMA_STATE_DIR, { recursive: true });
  writeFileSync(peersFile(env), JSON.stringify({ schema: 99, peers: [] }), 'utf8');
  assert.equal(readPeers(env).kind, 'undetermined', 'a schema from the future is not an empty list');
});

test('forgetting a peer removes exactly one, by address or by identity', () => {
  const env = tempEnv();
  joinPeer('100.64.0.3', env);
  joinPeer('100.64.0.4', env);
  recordPeerIdentity('100.64.0.4:8787', 'b'.repeat(32), 'desktop', env);

  assert.equal(forgetPeer('100.64.0.9', env).kind, 'no-such-peer', 'forgetting something not joined changes nothing');
  assert.equal(forgetPeer('b'.repeat(32), env).kind, 'forgotten', 'a peer can be forgotten by identity');
  const left = readPeers(env);
  assert.equal(left.kind === 'present' ? left.peers.length : -1, 1);
  assert.equal(left.kind === 'present' ? left.peers[0]?.address : '', '100.64.0.3:8787', 'the other one is untouched');
});

test('assembling a view keeps unknown machines apart from empty ones and apart from each other', () => {
  const host = (address: string, agents: MeshHost['agents']): MeshHost => ({
    hostId: null,
    machine: address,
    address,
    self: false,
    agents,
  });
  const view = assembleView([
    host('empty:8787', { kind: 'listed', agents: [] }),
    host('down:8787', { kind: 'unreachable', reason: 'refused' }),
    host('blocked:8787', { kind: 'not-trusted', reason: 'no credential' }),
    host('odd:8787', { kind: 'undetermined', reason: 'answered 500' }),
  ]);

  const kinds = view.hosts.map((h) => h.agents.kind);
  // FOUR DISTINCT ANSWERS. Criterion 4 in its strongest form: not merely "unreachable is not
  // empty", but that every non-answer keeps its own identity.
  assert.equal(new Set(kinds).size, 4, `four machines, four different answers, got ${kinds.join(', ')}`);
  assert.equal(view.hosts.length, 4, 'and none of them was dropped from the list');
  assert.equal(view.summary.unknownMachines, 3, 'three could not be listed');
  assert.equal(view.summary.reachedMachines, 1, 'one could');
  assert.equal(view.agents.length, 0, 'and nothing was invented for the three that did not answer');
});
