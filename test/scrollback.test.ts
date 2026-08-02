// The scrollback window, as arithmetic.
//
// THE VALUE OF THE BUDGET IS AN OPEN PRODUCT DECISION ON ISSUE #2, so nothing here asserts one.
// What is asserted is the property that has to hold for ANY budget: the window ENDS EXACTLY at the
// offset the supervisor acknowledged. That is the seam. Truncation may only move the start.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { alignTruncatedStart, scrollbackBudgetBytes, scrollbackRange, SCROLLBACK_BUDGET_BYTES } from '../src/sessions/scrollback.js';
import { readScrollback } from '../src/sessions/attach.js';

test('the window always ends at the acknowledged offset, whatever the budget', () => {
  for (const offset of [0, 1, 999, 1024 * 1024]) {
    for (const budget of [0, 1, 64, 512, 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      const r = scrollbackRange(offset, budget);
      assert.equal(r.end, offset, `end moved for offset=${offset} budget=${budget}`);
      assert.ok(r.start >= 0);
      assert.ok(r.start <= r.end);
    }
  }
});

test('a budget larger than the transcript replays all of it and reports no truncation', () => {
  const r = scrollbackRange(100, 1000);
  assert.deepEqual(r, { start: 0, end: 100, truncated: false });
});

test('a budget smaller than the transcript keeps the RECENT end of it', () => {
  const r = scrollbackRange(1000, 100);
  assert.deepEqual(r, { start: 900, end: 1000, truncated: true });
});

test('a budget of zero replays nothing and still ends at the offset — the seam is unaffected', () => {
  const r = scrollbackRange(1000, 0);
  assert.equal(r.start, 1000);
  assert.equal(r.end, 1000);
});

test('a truncated window is advanced past the first partial line; an untruncated one is not', () => {
  const chunk = Buffer.from('SEQ\x1b[3middle-of-an-escape\nsecond line\n');
  assert.equal(alignTruncatedStart(chunk, true).toString(), 'second line\n');
  // NOT truncated means nothing was discarded by the budget, so nothing may be discarded here.
  assert.equal(alignTruncatedStart(chunk, false).toString(), chunk.toString());
});

test('a truncated window with no newline at all is left alone rather than emptied', () => {
  const chunk = Buffer.from('no newlines here');
  assert.equal(alignTruncatedStart(chunk, true).toString(), 'no newlines here');
});

test('the budget comes from the environment when it is set, and is a documented default otherwise', () => {
  assert.equal(scrollbackBudgetBytes({}), SCROLLBACK_BUDGET_BYTES);
  assert.equal(scrollbackBudgetBytes({ OMA_SCROLLBACK_BYTES: '4096' }), 4096);
  assert.equal(scrollbackBudgetBytes({ OMA_SCROLLBACK_BYTES: '0' }), 0);
  // Nonsense falls back rather than becoming NaN and replaying nothing.
  assert.equal(scrollbackBudgetBytes({ OMA_SCROLLBACK_BYTES: 'lots' }), SCROLLBACK_BUDGET_BYTES);
  assert.equal(scrollbackBudgetBytes({ OMA_SCROLLBACK_BYTES: '-5' }), SCROLLBACK_BUDGET_BYTES);
});

test('readScrollback reads to the OFFSET, not to the end of a file that has grown past it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oma-scrollback-'));
  const file = path.join(dir, 'transcript');
  // The first 10 bytes are "history"; the rest arrived after the attach was acknowledged and is
  // already on its way to the client as live frames. Replaying it would duplicate it.
  await writeFile(file, 'AAAAAAAAAA' + 'LIVELIVELIVE');

  assert.equal((await readScrollback(file, 10, 1000)).toString(), 'AAAAAAAAAA');
  assert.equal((await readScrollback(file, 10, 4)).toString(), 'AAAA');
  assert.equal((await readScrollback(file, 0, 1000)).length, 0);
});

test('a transcript that does not exist yet replays nothing rather than failing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oma-scrollback-'));
  assert.equal((await readScrollback(path.join(dir, 'nope'), 100, 100)).length, 0);
});
