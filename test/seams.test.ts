// The seams that are still somebody else's must REFUSE, and the two that were Issue #2's must not.
//
// A stub that returns `true` from something called `requireAuth` is how a host ends up appearing to
// have a property it does not have. `requireAuth` (Issue #5) and `proxyToPeer` (Issue #3) are
// asserted to throw and to name the Issue that owns them — and this file is also the check that
// Issue #2 did not quietly "helpfully" implement either of them on its way past.
//
// `spawnSession` and `handleAttachUpgrade` WERE refusing stubs and are now real. They are asserted
// here to be real, so a regression to a stub is a red test rather than a quiet loss.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyRegistry, NotImplementedOnThisIssue, spawnSession } from '../src/sessions/registry.js';
import { handleAttachUpgrade, proxyToPeer, requireAuth } from '../src/server/seams.js';

test('the empty registry still owns nothing and says so truthfully', () => {
  const r = createEmptyRegistry();
  assert.equal(r.count(), 0);
  assert.deepEqual(r.list(), []);
  assert.equal(r.get('anything'), undefined);
});

test('the seams that are not Issue #2 still refuse, and still name their Issue', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['requireAuth', () => requireAuth({} as never, {} as never), /Issue #5/],
    ['proxyToPeer', () => proxyToPeer('peer', {} as never, {} as never), /Issue #3/],
  ];
  for (const [name, call, issue] of cases) {
    assert.throws(
      call,
      (err: unknown) => {
        assert.ok(err instanceof NotImplementedOnThisIssue, `${name} threw something else`);
        assert.match((err as Error).message, issue);
        return true;
      },
      `${name} did not refuse`,
    );
  }
});

test('the two seams Issue #2 owned are implemented, not stubs', () => {
  assert.equal(typeof spawnSession, 'function');
  assert.equal(typeof handleAttachUpgrade, 'function');

  // Deliberately malformed: an upgrade to a path that is not an attach path. A real implementation
  // ANSWERS ON THE SOCKET; a refusing stub throws NotImplementedOnThisIssue no matter what it is
  // given. Which of those happens is the whole assertion.
  const ended: string[] = [];
  let threwNotImplemented = false;
  try {
    handleAttachUpgrade(
      { url: '/not-an-attach-path', headers: {} } as never,
      { end: (s: string) => ended.push(s) } as never,
      Buffer.alloc(0),
      { registry: createEmptyRegistry() as never },
    );
  } catch (err) {
    threwNotImplemented = err instanceof NotImplementedOnThisIssue;
  }
  assert.equal(threwNotImplemented, false, 'handleAttachUpgrade is still a refusing stub');
  assert.match(ended.join(''), /404/, 'handleAttachUpgrade did not answer the socket');
});
