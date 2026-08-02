// The seams left for Issues #2 and #3 must REFUSE, not return something plausible.
//
// A stub that returns `true` from something called `requireAuth`, or a session id from something
// called `spawnSession`, is how a host ends up appearing to have a property it does not have. Each
// of these is asserted to throw, and to say which Issue owns it.
//
// ISSUE #5 HAS FILLED ITS OWN SEAM, so `requireAuth` is no longer in the refusing list — it is the
// real guard now, covered by test/pairing.http.test.ts. It is asserted below to be DENY-BY-DEFAULT
// instead: the property that mattered about the refusing stub (it never grants by accident) is the
// property the real one has to keep, so the assertion moves rather than disappearing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmptyRegistry, NotImplementedOnThisIssue, spawnSession } from '../src/sessions/registry.js';
import { handleAttachUpgrade, proxyToPeer, requireAuth } from '../src/server/seams.js';
import { establishPeerTrust, propagateRevocation } from '../src/pairing/mesh.js';
import { fakeRequest, fakeResponse } from './helpers/http.js';

test('the registry this Issue ships owns nothing and says so truthfully', () => {
  const r = createEmptyRegistry();
  assert.equal(r.count(), 0);
  assert.deepEqual(r.list(), []);
  assert.equal(r.get('anything'), undefined);
});

test('every seam refuses and names the Issue that owns it', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['spawnSession', () => spawnSession(createEmptyRegistry(), 'sh', []), /Issue #2/],
    ['handleAttachUpgrade', () => handleAttachUpgrade({} as never, {} as never, Buffer.alloc(0)), /Issue #2/],
    ['proxyToPeer', () => proxyToPeer('peer', {} as never, {} as never), /Issue #3/],
    // ISSUE #5 LEFT THESE TWO for Issue #3. Criterion 8 required a credential a peer can VERIFY,
    // and that is built; how a peer comes to hold the mesh key, and how a revocation reaches it,
    // are #3's open decision and are refused rather than guessed at here.
    ['establishPeerTrust', () => establishPeerTrust('peer', '100.64.0.1'), /Issue #3/],
    ['propagateRevocation', () => propagateRevocation('deadbeef'), /Issue #3/],
  ];
  for (const [name, call, issue] of cases) {
    assert.throws(call, (err: unknown) => {
      assert.ok(err instanceof NotImplementedOnThisIssue, `${name} threw something else`);
      assert.match((err as Error).message, issue);
      return true;
    }, `${name} did not refuse`);
  }
});

// ISSUE #5's seam is filled, so what is asserted about it changes from "it refuses" to "it never
// grants by accident". Given an empty state directory — no pairing store at all, the state every
// host is in on its first run — `requireAuth` must NOT return 'continue'.
//
// This is the assertion that would catch the specific failure the seam comment warns about: a
// middleware that looks installed and is permissive.
test('requireAuth does not grant on a host where nothing has ever been paired', async () => {
  const env = { OMA_STATE_DIR: mkdtempSync(path.join(tmpdir(), 'oma-seam-')) };
  const res = fakeResponse();
  const verdict = await requireAuth(fakeRequest({ url: '/api/status' }), res, {
    webRoot: path.join(process.cwd(), 'src', 'web'),
    env,
  });
  assert.notEqual(verdict, 'continue', 'requireAuth granted on a host with no pairing store at all');
  assert.equal(verdict, 'handled');
  assert.equal(res.captured.status, 404);
});
