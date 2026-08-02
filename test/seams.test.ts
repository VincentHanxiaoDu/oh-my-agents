// The seams left for Issues #2, #3 and #5 must REFUSE, not return something plausible.
//
// A stub that returns `true` from something called `requireAuth`, or a session id from something
// called `spawnSession`, is how a host ends up appearing to have a property it does not have. Each
// of these is asserted to throw, and to say which Issue owns it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyRegistry, NotImplementedOnThisIssue, spawnSession } from '../src/sessions/registry.js';
import { handleAttachUpgrade, proxyToPeer, requireAuth } from '../src/server/seams.js';

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
    ['requireAuth', () => requireAuth({} as never, {} as never), /Issue #5/],
    ['proxyToPeer', () => proxyToPeer('peer', {} as never, {} as never), /Issue #3/],
  ];
  for (const [name, call, issue] of cases) {
    assert.throws(call, (err: unknown) => {
      assert.ok(err instanceof NotImplementedOnThisIssue, `${name} threw something else`);
      assert.match((err as Error).message, issue);
      return true;
    }, `${name} did not refuse`);
  }
});
