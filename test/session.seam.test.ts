// CRITERION 5 — "Reattaching later shows recent scrollback followed by live output, in order, with
// no duplicated and no dropped region at the seam."
//
// THIS IS THE HARDEST THING ON ISSUE #2 AND THE EASIEST TO FAKE, so this file is written to be hard
// to pass by accident.
//
// A SEAM TEST AGAINST AN IDLE SESSION PROVES NOTHING. If the agent is producing nothing while the
// client detaches and reattaches, there is nothing to duplicate and nothing to drop — the naive
// implementation (read the file, then subscribe) passes every time. So every test here drives
// CONTINUOUS OUTPUT across the detach and the reattach, and the reattach happens while bytes are in
// flight.
//
// THE ASSERTION IS SELF-EVIDENT AND BUDGET-INDEPENDENT. The agent emits `#1#`, `#2#`, `#3#`… so the
// stream a reattaching client receives must be a run of CONSECUTIVE integers. A duplicated region
// shows up as a repeat; a dropped region shows up as a jump. Neither can hide, and neither
// assertion mentions how much scrollback was retained — which matters, because the budget is an
// OPEN PRODUCT DECISION on Issue #2 and a test that only passes at the default would be a test of
// the default. Each case is therefore run at a tiny budget and at a huge one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { attachClient, counterProgram, counters, newSession, skipIfNoPty, sleep, startHost } from './helpers/session-harness.js';

/** A tiny budget truncates hard; a huge one never truncates. The seam must be right at both. */
const BUDGETS = [
  { name: 'a tiny budget that truncates every time', bytes: 512 },
  { name: 'a budget larger than the whole transcript', bytes: 8 * 1024 * 1024 },
];

function assertConsecutive(seen: number[], what: string): void {
  assert.ok(seen.length > 5, `${what}: only ${seen.length} values arrived, which is not enough to prove anything`);
  for (let i = 1; i < seen.length; i++) {
    const prev = seen[i - 1]!;
    const cur = seen[i]!;
    if (cur === prev) assert.fail(`${what}: ${cur} appeared twice in a row — A REGION WAS DUPLICATED AT THE SEAM`);
    if (cur !== prev + 1) {
      assert.fail(
        `${what}: the stream went ${prev} -> ${cur}, so ${cur - prev - 1} line(s) were ` +
          `${cur > prev ? 'DROPPED AT THE SEAM' : 'delivered OUT OF ORDER'}`,
      );
    }
  }
}

for (const budget of BUDGETS) {
  test(`reattaching under continuous output has no gap and no repeat — ${budget.name}`, async (t) => {
    const skip = skipIfNoPty();
    if (skip) return t.skip(skip);

    // Set before the host is started, because the host inherits it: the budget is read by the
    // process that serves the attach, not by this one.
    process.env.OMA_SCROLLBACK_BYTES = String(budget.bytes);
    const host = await startHost();
    try {
      const prog = counterProgram(2);
      const id = await newSession(host, prog.command, prog.args);

      const first = await attachClient(host.port, id);
      await first.waitForEvent('attached');
      await first.waitForText(/#20#/);

      // Detach while output is still being produced. `drop()` cuts the socket with no close
      // handshake — a closed tab or a lost network, not a polite goodbye.
      first.drop();

      // The agent keeps going, unattended, and the transcript keeps growing. This gap is the
      // "recent history I missed" of the journey, and it is what the replay has to cover.
      await sleep(400);

      // REATTACHED SEVERAL TIMES, NOT ONCE. A seam bug is a race between the replay read and the
      // bytes arriving during it, and a race loses some of the time: a single reattach passes
      // against an implementation with the buffering removed often enough to be useless as a test.
      // Every cycle here is a fresh attach under continuous output, and each one is asserted.
      for (let cycle = 0; cycle < 4; cycle++) {
        const second = await attachClient(host.port, id);
        const secondAck = await second.waitForEvent('attached');
        // Keep receiving live output well past the reattach, so the seam is in the middle of what
        // is asserted rather than at the end of it.
        await sleep(250);
        second.drop();

        const seen = counters(second.text());
        assertConsecutive(seen, `at ${budget.bytes} bytes of budget, reattach ${cycle + 1}`);

      // And the reattached client really did see history it was not present for.
      //
      // ASSERTED AS `replayBytes`, NOT AS "the first value is not 1". That phrasing is only correct
      // at a small budget: when the budget exceeds the whole transcript the replay CORRECTLY starts
      // at `#1#`, and an assertion that rejects it is an assertion about the default budget rather
      // than about the seam — precisely what this file is written not to be.
        assert.ok(
          secondAck.replayBytes > 0,
          `at ${budget.bytes} bytes of budget the reattached client was replayed nothing`,
        );
      }
    } finally {
      delete process.env.OMA_SCROLLBACK_BYTES;
      await host.stop();
    }
  });
}

test('the agent keeps running while nobody is attached at all', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);

  const host = await startHost();
  try {
    const prog = counterProgram(4);
    const id = await newSession(host, prog.command, prog.args);

    const first = await attachClient(host.port, id);
    await first.waitForEvent('attached');
    await first.waitForText(/#10#/);
    const lastSeenBefore = counters(first.text()).pop()!;
    first.drop();

    // Nobody is attached for a while. Criterion 5's first sentence: detaching does not stop it.
    await sleep(600);

    const second = await attachClient(host.port, id);
    await second.waitForEvent('attached');
    await sleep(200);
    const seen = counters(second.text());
    second.close();

    assert.ok(
      seen[seen.length - 1]! > lastSeenBefore + 20,
      `the agent produced almost nothing while detached (${lastSeenBefore} -> ${seen[seen.length - 1]}), so it had stopped`,
    );
    assertConsecutive(seen, 'after a period with no subscriber');
  } finally {
    await host.stop();
  }
});

test('several reattaches in a row each join cleanly', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);

  const host = await startHost();
  try {
    const prog = counterProgram(2);
    const id = await newSession(host, prog.command, prog.args);
    await sleep(200);

    // Repeated, because a seam bug that depends on a race shows up as a flake at one attempt and as
    // a failure at five.
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await attachClient(host.port, id);
      await client.waitForEvent('attached');
      await sleep(150);
      client.drop();
      const seen = counters(client.text());
      assertConsecutive(seen, `reattach attempt ${attempt + 1}`);
      await sleep(60);
    }
  } finally {
    await host.stop();
  }
});
