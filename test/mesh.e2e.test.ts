// THREE REAL HOSTS, ACTUALLY STARTED, ACTUALLY JOINED, AND ONE ACTUALLY KILLED.
//
// Criteria 1, 2, 4, 5, 6 and 7 are all claims about what several running hosts do, and none of them
// can be checked by inspecting configuration. So this file starts three servers on three ports with
// three state directories, joins them by address over real HTTP, reads the unified list off each of
// them, SHUTS ONE DOWN, and reads the list again.
//
// Every assertion below was watched go red — by inverting it, or by breaking the code it covers,
// observing the failure, restoring, and observing the pass. The ones that matter most, and what
// broke them, are named in comments where they sit.

import assert from 'node:assert/strict';
import test from 'node:test';
import { callHost, startTestHost, supplierFor, type TestHost } from './helpers/mesh.js';
import type { MeshHost, MeshView } from '../src/mesh/view.js';

interface MeshBody extends MeshView {
  ok: boolean;
  explicit: boolean;
}

function findHost(view: MeshBody, address: string): MeshHost {
  const found = view.hosts.find((h) => h.address === address);
  assert.ok(found, `${address} is not in the view at all — criterion 4 forbids a peer being silently dropped`);
  return found;
}

async function meshOf(host: TestHost, query = ''): Promise<MeshBody> {
  const res = await callHost(host, '/api/mesh' + query);
  assert.equal(res.status, 200, `GET /api/mesh on ${host.name} answered ${res.status}`);
  return res.json() as MeshBody;
}

async function join(host: TestHost, address: string): Promise<{ ok: boolean; duplicate: boolean }> {
  const res = await callHost(host, '/api/peers/join', { method: 'POST', body: JSON.stringify({ address }) });
  assert.equal(res.status, 200, `joining ${address} on ${host.name} answered ${res.status}: ${res.body}`);
  return res.json() as { ok: boolean; duplicate: boolean };
}

test('three hosts joined by address see each other, symmetrically, and survive one going away', async (t) => {
  const hosts: TestHost[] = [];
  const supplier = supplierFor(() => hosts);

  // Two of the three run an agent with the SAME title, the SAME start time and the SAME liveness.
  // Criterion 5 is about exactly this pair.
  const sameAgent = { id: 'sess-1', title: 'refactor the parser', startedAt: '2026-01-01T00:00:00.000Z', alive: true };

  const a = await startTestHost({ name: 'a', supplier, sessions: [sameAgent] });
  const b = await startTestHost({ name: 'b', supplier, sessions: [sameAgent] });
  const c = await startTestHost({ name: 'c', supplier, sessions: [] });
  hosts.push(a, b, c);
  t.after(async () => {
    await Promise.all(hosts.map((h) => h.stop().catch(() => undefined)));
  });

  // ── CRITERION 1: joined by ADDRESS, and afterwards EITHER one lists both ───────────────────────
  // Each host joins the others itself. There is no hub and nothing is pushed: `join` is a local
  // write, and symmetry is two local writes rather than a protocol.
  const firstJoin = await join(a, b.address);
  // ASSERTED HERE so that the deduplication test below cannot pass because the first join never
  // worked. If this is `true`, the join was already there and the later assertion proves nothing.
  assert.equal(firstJoin.duplicate, false, 'the FIRST join of b into a must actually add it');
  await join(a, c.address);
  await join(b, a.address);
  await join(b, c.address);
  await join(c, a.address);
  await join(c, b.address);

  const fromA = await meshOf(a);
  const fromB = await meshOf(b);

  assert.equal(fromA.hosts.length, 3, 'opening a lists all three machines');
  assert.equal(fromB.hosts.length, 3, 'opening b lists all three machines');

  // ── CRITERION 2: no designated hub. A and B present the SAME SET ───────────────────────────────
  const setOf = (v: MeshBody): string[] => v.hosts.map((h) => h.address).sort();
  assert.deepEqual(setOf(fromA), setOf(fromB), 'opening a and opening b present the same set of machines');

  // ── CRITERION 1, second half: each agent is LABELLED with which machine it is on ───────────────
  assert.equal(fromA.agents.length, 2, 'a sees its own agent and b\'s');
  for (const agent of fromA.agents) {
    assert.ok(agent.machine.length > 0, 'every agent names the machine it is on');
    assert.ok(agent.address.length > 0, 'every agent names the address of the machine it is on');
  }

  // ── CRITERION 5: two agents sharing name, start time and liveness stay distinguishable ─────────
  // WATCHED GO RED: keying the unified list on the session id alone (dropping the host from `key`
  // in src/mesh/view.ts) collapses these two rows into one and fails this assertion.
  const keys = fromA.agents.map((x) => x.key);
  assert.equal(new Set(keys).size, 2, 'two identically-titled agents on two machines are two distinct rows');
  const machines = fromA.agents.map((x) => x.machine + '@' + x.address);
  assert.equal(new Set(machines).size, 2, 'and they are on two different machines, which the row says');

  // ── CRITERION 4: a machine with ZERO agents says so, and it is a DETERMINED answer ─────────────
  const cFromA = findHost(fromA, c.address);
  assert.equal(cFromA.agents.kind, 'listed', 'c answered, so its answer is `listed`');
  assert.deepEqual(cFromA.agents.kind === 'listed' ? cFromA.agents.agents : null, [], 'and its list is empty');

  // ── CRITERION 2, the part that must be tested by ACTUALLY SHUTTING A HOST DOWN ─────────────────
  await b.stop();
  hosts.splice(hosts.indexOf(b), 1);

  const afterA = await meshOf(a);
  const afterC = await meshOf(c);

  // a and c still see each other. This is the criterion: no host was the hub, so losing one does
  // not stop the rest.
  const cFromAAfter = findHost(afterA, c.address);
  const aFromCAfter = findHost(afterC, a.address);
  assert.equal(cFromAAfter.agents.kind, 'listed', 'a still reaches c after b is gone');
  assert.equal(aFromCAfter.agents.kind, 'listed', 'c still reaches a after b is gone');
  assert.equal(aFromCAfter.agents.kind === 'listed' ? aFromCAfter.agents.agents.length : -1, 1, 'and c still sees a\'s agent');

  // ── CRITERION 4, THE ONE MOST OFTEN FAKED ──────────────────────────────────────────────────────
  // The dead host is STILL IN THE LIST, STILL NAMED, and its answer is NOT the same answer an empty
  // machine gives. Both halves are asserted: that it is present, and that it differs from `c`.
  //
  // WATCHED GO RED, TWICE: (1) mapping a transport failure to `{kind:'listed', agents: []}` in
  // src/mesh/client.ts makes `bAfter.agents.kind` equal `listed` and fails the inequality below;
  // (2) dropping unreachable peers from `hosts` in src/mesh/aggregate.ts makes `findHost` throw.
  const bAfter = findHost(afterA, b.address);
  assert.equal(bAfter.agents.kind, 'unreachable', 'the host that was shut down is shown as unreachable');
  assert.notEqual(bAfter.agents.kind, cFromAAfter.agents.kind, 'unreachable and zero-agents are NOT the same answer');
  assert.ok(bAfter.machine.length > 0, 'the unreachable machine is still NAMED');
  assert.ok(
    !('agents' in bAfter.agents),
    'an unreachable peer carries no agent list at all — not even an empty one, which would read as idle',
  );
  assert.equal(afterA.summary.unknownMachines, 1, 'the summary counts the machine it could not list');
  assert.equal(afterA.summary.reachedMachines, 2, 'and counts the two it could');

  // Nothing from the dead host leaked into the flat agent list, and nothing from the live ones was
  // lost with it.
  assert.equal(afterA.agents.length, 1, 'only the reachable machines contribute agents');
  assert.ok(
    afterA.agents.every((x) => x.address !== b.address),
    'no agent is attributed to the machine that did not answer',
  );

  // ── CRITERION 6: joining an already-joined host adds nothing ───────────────────────────────────
  // WATCHED GO RED: removing the `byAddress` lookup in `joinPeer` makes `duplicate` false and the
  // peer count 3.
  const before = (await callHost(a, '/api/peers')).json() as { peers: unknown[] };
  const again = await join(a, c.address);
  assert.equal(again.duplicate, true, 're-joining an already-joined host reports the duplicate');
  const after = (await callHost(a, '/api/peers')).json() as { peers: unknown[] };
  assert.equal(after.peers.length, before.peers.length, 're-joining added no peer record');

  // The same address spelled differently is the SAME host. This is what the canonical form is for.
  const spelledAsUrl = await join(a, `http://${c.address}/`);
  assert.equal(spelledAsUrl.duplicate, true, 'the same host spelled as a URL is not a second peer');
  const after2 = (await callHost(a, '/api/peers')).json() as { peers: unknown[] };
  assert.equal(after2.peers.length, before.peers.length, 'and still added no peer record');

  // And the unified list did not gain a machine or a duplicated agent from any of that.
  const finalView = await meshOf(a);
  assert.equal(finalView.hosts.length, 3, 're-joining did not duplicate a machine in the list');
  assert.equal(finalView.agents.length, 1, 're-joining did not duplicate an agent list');
});

test('a client pointed at an explicit list of hosts gets the same unified list, unjoined', async (t) => {
  // CRITERION 7. `d` joins nothing, and `a` and `c` have never been joined to each other on this
  // run either — the addresses are simply named in the request.
  const hosts: TestHost[] = [];
  const supplier = supplierFor(() => hosts);
  const a = await startTestHost({ name: 'x-a', supplier, sessions: [{ id: 's', title: 'build', startedAt: '2026-01-01T00:00:00.000Z', alive: true }] });
  const c = await startTestHost({ name: 'x-c', supplier, sessions: [] });
  const d = await startTestHost({ name: 'x-d', supplier, sessions: [] });
  hosts.push(a, c, d);
  t.after(async () => {
    await Promise.all(hosts.map((h) => h.stop().catch(() => undefined)));
  });

  // Nothing is joined anywhere. Asserted, so this test cannot pass on joins left by another test.
  for (const h of [a, c, d]) {
    const peers = (await callHost(h, '/api/peers')).json() as { peers: unknown[] };
    assert.equal(peers.peers.length, 0, `${h.name} has joined nothing`);
  }

  const view = await meshOf(d, `?host=${encodeURIComponent(a.address)}&host=${encodeURIComponent(c.address)}`);
  assert.equal(view.explicit, true, 'the view says it came from an explicit host list');
  assert.equal(view.hosts.length, 3, 'the opened host plus the two named ones');
  assert.equal(findHost(view, a.address).agents.kind, 'listed');
  assert.equal(findHost(view, c.address).agents.kind, 'listed');
  assert.equal(view.agents.length, 1, 'and the agents of the named hosts are in the unified list');
  assert.equal(view.agents[0]?.machine, findHost(view, a.address).machine, 'labelled with the machine it is on');

  // Still nothing joined: an explicit list does not write anything.
  const peersAfter = (await callHost(d, '/api/peers')).json() as { peers: unknown[] };
  assert.equal(peersAfter.peers.length, 0, 'pointing a client at hosts does not join them');

  // CRITERION 6 applies to the explicit list too: one machine named twice is one entry.
  const twice = await meshOf(d, `?host=${encodeURIComponent(a.address)}&host=${encodeURIComponent('http://' + a.address + '/')}`);
  assert.equal(twice.hosts.length, 2, 'one machine named twice in an explicit list is one entry');
  assert.equal(twice.agents.length, 1, 'and its agents appear once');

  // A named host that is not running is unreachable, not empty — criterion 4, on this path too.
  await c.stop();
  hosts.splice(hosts.indexOf(c), 1);
  const withDead = await meshOf(d, `?host=${encodeURIComponent(a.address)}&host=${encodeURIComponent(c.address)}`);
  assert.equal(findHost(withDead, c.address).agents.kind, 'unreachable');
  assert.equal(findHost(withDead, a.address).agents.kind, 'listed');
});

test('a peer this host holds no credential for is NOT TRUSTED, which is not unreachable and not empty', async (t) => {
  // This is the SHIPPED behaviour: `meshCredentialSupplier` grants nothing, because how a host is
  // trusted when joined is Issue #3's open decision. The peer is up, it answers, and it denies —
  // and that must be a THIRD state, or a person debugging a mesh is sent to the wrong machine.
  const hosts: TestHost[] = [];
  const a = await startTestHost({ name: 't-a' }); // no supplier: the production one, which refuses
  const b = await startTestHost({ name: 't-b' });
  hosts.push(a, b);
  t.after(async () => {
    await Promise.all(hosts.map((h) => h.stop().catch(() => undefined)));
  });

  await join(a, b.address);
  const view = await meshOf(a);
  const peer = findHost(view, b.address);

  // WATCHED GO RED: making `meshCredentialSupplier` return an operator proof turns this into
  // `listed` and fails here — which is exactly the failure mode of answering the open decision.
  assert.equal(peer.agents.kind, 'not-trusted', 'a peer this host cannot authenticate to is `not-trusted`');
  assert.notEqual(peer.agents.kind, 'unreachable', 'it is up, so it is not reported as an outage');
  assert.notEqual(peer.agents.kind, 'listed', 'and its agents are UNKNOWN, never reported as none');
  assert.match(
    peer.agents.kind === 'not-trusted' ? peer.agents.reason : '',
    /OPEN PRODUCT DECISION on Issue #3/,
    'and the reason names the decision rather than reading as a bug',
  );
  assert.ok(peer.machine.length > 0, 'the machine is still named');
  assert.equal(view.summary.unknownMachines, 1, 'and it is counted as unlisted, not as empty');
  assert.equal(view.agents.length, 0, 'a has no agents of its own and gained none from b');
});
