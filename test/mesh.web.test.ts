// CRITERION 4's SECOND HALF, AND CRITERION 9.
//
// "An unreachable peer and a peer with zero agents are distinguishable IN THE LIST." A test that
// only checks the API payload has not covered that: the bug it guards against is a client that
// renders both as an empty section. So this imports the REAL browser module — the same
// `src/web/mesh-view.js` the host serves, byte for byte, with no build step in between — and
// asserts that the four answers produce four different renderings.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { describeAgent, describeHost, describeSummary } from '../src/web/mesh-view.js';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
const index = readFileSync(path.join(webDir, 'index.html'), 'utf8');

const machine = { hostId: 'a'.repeat(32), machine: 'the-laptop', address: '100.64.0.3:8787', self: false };

test('an unreachable machine and an empty one render differently, and neither is blank', () => {
  const empty = describeHost({ ...machine, agents: { kind: 'listed', agents: [] } });
  const down = describeHost({ ...machine, agents: { kind: 'unreachable', reason: 'ECONNREFUSED' } });

  // THE ASSERTION THE CRITERION IS ABOUT.
  // WATCHED GO RED: making the `unreachable` branch of `describeHost` return
  // `{status: 'no agents', agents: []}` — the plausible simplification — fails all three of these.
  assert.notEqual(down.status, empty.status, 'the status word differs');
  assert.notEqual(down.detail, empty.detail, 'the sentence under it differs');
  assert.notEqual(down.tone, empty.tone, 'and so does the colour, for anyone who can see it');

  assert.match(empty.status, /no agents/, 'an empty machine says it has no agents');
  assert.match(down.status, /unreachable/, 'an unreachable one says it is unreachable');
  assert.match(down.detail, /unknown/i, 'and says what it is running is UNKNOWN');

  // The machine is still NAMED in both. A row with a blank name is a row a person cannot act on.
  assert.equal(down.name, 'the-laptop');
  assert.equal(empty.name, 'the-laptop');

  // `null`, NOT `[]`. A client that iterates `agents` must not be able to conclude "none".
  assert.equal(empty.agents?.length, 0, 'an empty machine has a real, empty list');
  assert.equal(down.agents, null, 'an unreachable machine has NO list — not an empty one');
});

test('all four answers are distinguishable from each other, not merely from `listed`', () => {
  const rendered = [
    describeHost({ ...machine, agents: { kind: 'listed', agents: [] } }),
    describeHost({ ...machine, agents: { kind: 'unreachable', reason: 'ECONNREFUSED' } }),
    describeHost({ ...machine, agents: { kind: 'not-trusted', reason: 'no credential' } }),
    describeHost({ ...machine, agents: { kind: 'undetermined', reason: 'answered 500' } }),
  ];
  assert.equal(new Set(rendered.map((r) => r.status)).size, 4, 'four status words');
  assert.equal(new Set(rendered.map((r) => r.detail)).size, 4, 'four explanations');
  for (const r of rendered.slice(1)) {
    assert.equal(r.agents, null, `${r.status} carries no agent list`);
    assert.match(r.detail, /unknown/i, `${r.status} says the agents are unknown`);
  }
});

test('a machine that never answered is named by its address rather than left blank', () => {
  const nameless = describeHost({ hostId: null, machine: null, address: '100.64.0.9:8787', self: false, agents: { kind: 'unreachable', reason: 'timed out' } });
  assert.equal(nameless.name, '100.64.0.9:8787', 'the address is the name of last resort');
  assert.notEqual(nameless.name.trim(), '', 'and it is never empty');
});

test('two agents sharing a title on two machines render as two distinguishable rows — criterion 5', () => {
  const common = { title: 'refactor the parser', startedAt: '2026-01-01T00:00:00.000Z', alive: true };
  const one = describeAgent({ ...common, key: 'host-a:s1', machine: 'the-laptop', address: '100.64.0.3:8787' });
  const two = describeAgent({ ...common, key: 'host-b:s1', machine: 'the-desktop', address: '100.64.0.4:8787' });

  assert.notEqual(one.key, two.key, 'they have different keys');
  assert.notEqual(one.label, two.label, 'and different labels a person actually reads');
  assert.match(one.label, /the-laptop/, 'each label names the machine the agent is on');
  assert.match(two.label, /the-desktop/);
});

test('the summary counts machines it could not list rather than hiding them', () => {
  const complete = describeSummary({ summary: { machines: 3, reachedMachines: 3, agents: 4, unknownMachines: 0 } });
  const partial = describeSummary({ summary: { machines: 3, reachedMachines: 2, agents: 4, unknownMachines: 1 } });
  assert.notEqual(complete, partial, 'a complete list and a partial one do not read the same');
  assert.match(partial, /could not be listed/, 'the partial one says so');
  assert.match(partial, /unknown, not none/, 'and says which of the two it means');
});

test('the mesh section of the client is served with no build step and no external request', () => {
  // The module the browser loads is a file this host serves. Not a CDN, not a bundle.
  assert.match(index, /<script type="module">/, 'the client is a plain module');
  assert.match(index, /from '\.\/mesh-view\.js'/, 'and imports the mesh renderer by relative path');
  const external = index.match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? [];
  assert.deepEqual(external, [], `the page must make no external request, found ${external.join(', ')}`);
});

test('the mesh surfaces meet criterion 9 at 375px: no fixed widths, 44px targets, no pointer-only affordance', () => {
  // Same shape of check `test/web.test.ts` makes for Issue #1's surfaces, extended to this one's.
  assert.match(index, /id="join-address"/, 'there is a field to type an address into');
  assert.match(index, /id="join"/, 'and a button to act on it');

  // Every interactive element added here inherits the one 44px rule, or states its own.
  assert.match(index, /\.joiner input\s*\{[^}]*min-height:\s*var\(--tap\)/, 'the input is at least one tap high');
  assert.match(index, /\.agent\s*\{[^}]*min-height:\s*var\(--tap\)/, 'and so is an agent row');
  assert.match(index, /--tap:\s*44px/, 'and a tap is 44px');

  // Nothing in the new markup or styles depends on a pointer.
  assert.doesNotMatch(index, /:hover\s*\{/, 'no hover state carries information');
  assert.doesNotMatch(index, /contextmenu/, 'nothing is behind a right-click');
  assert.doesNotMatch(index, /draggable|dragstart/, 'nothing has to be dragged');

  // Nothing may be wider than the viewport. The long strings this section adds are addresses and
  // failure reasons, and both are in elements that wrap.
  assert.match(index, /\.machine\s*\{[^}]*min-width:\s*0/, 'a machine block can shrink below its content');
  assert.match(index, /\.agent\s*\{[^}]*overflow-wrap:\s*anywhere/, 'an agent row wraps rather than pushing the page');
  assert.match(index, /\.joiner input\s*\{[^}]*min-width:\s*0/, 'the input can shrink inside its row');
  // A flex row that cannot wrap is the usual cause of a 375px page scrolling sideways.
  assert.match(index, /\.joiner\s*\{[^}]*flex-wrap:\s*wrap/, 'the join row wraps at narrow widths');
  assert.match(index, /\.machine h3\s*\{[^}]*flex-wrap:\s*wrap/, 'a long machine name and its status pill wrap');
  assert.doesNotMatch(index, /width:\s*\d{3,}px/, 'nothing has a fixed width wider than a phone');
});
