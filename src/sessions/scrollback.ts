// How much of a session's transcript is replayed on reattach, and how it is read.
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE VALUE BELOW IS AN OPEN PRODUCT DECISION ON ISSUE #2 AND HAS NOT BEEN SETTLED.
//
// Issue #2 records under "Blocked on a decision": *how much scrollback is retained (a byte budget,
// a line count, a time window) is not fixed. The criteria assert that recent history replays and
// that the seam is correct; they do not assert a size.*
//
// So this build picks a provisional number, in ONE named place, and the code around it is correct
// for ANY value of it — including 0 and including a value larger than the whole transcript. The
// seam tests in test/session.seam.test.ts are run at more than one budget for exactly that reason:
// a test that only passes at the default is a test of the default, not of the seam.
//
// When the decision is made, change this constant (or replace it with the shape that was chosen —
// a line count or a time window — behind `readScrollback`). Nothing else needs to move.
// ────────────────────────────────────────────────────────────────────────────────────────────────
export const SCROLLBACK_BUDGET_BYTES = 256 * 1024;

/** Where the budget comes from at runtime, so tests and operators can vary it without a rebuild. */
export function scrollbackBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMA_SCROLLBACK_BYTES?.trim();
  if (!raw) return SCROLLBACK_BUDGET_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return SCROLLBACK_BUDGET_BYTES;
  return n;
}

/**
 * The byte range of a transcript to replay, given how long it is at the instant the attach was
 * acknowledged (`offset`) and a budget.
 *
 * `end` is ALWAYS `offset` and never anything else. That is the whole of criterion 5's seam on this
 * side: the supervisor promises that every byte at or after `offset` arrives as a live frame, so
 * replaying `[start, offset)` duplicates nothing and drops nothing. Truncation only ever moves
 * `start` forward, which is what "recent" means; it can never move `end`.
 */
export function scrollbackRange(offset: number, budget: number): { start: number; end: number; truncated: boolean } {
  const end = Math.max(0, offset);
  const start = Math.max(0, end - Math.max(0, budget));
  return { start, end, truncated: start > 0 };
}

/**
 * When the replay window has already cut into the transcript, the cut can land in the middle of an
 * escape sequence, and half an escape sequence renders as garbage or swallows the line after it.
 * So a TRUNCATED window is advanced to just after the next newline — the first place a terminal is
 * certainly not mid-sequence.
 *
 * This only ever applies when `truncated` is true, i.e. to bytes the budget had already discarded.
 * It cannot drop anything the budget would have kept, and it never touches the end of the window,
 * so the seam is unaffected by it. That distinction is the reason it is a separate function with
 * its own test rather than three lines inside the reader.
 */
export function alignTruncatedStart(chunk: Buffer, truncated: boolean): Buffer {
  if (!truncated) return chunk;
  const nl = chunk.indexOf(0x0a);
  if (nl === -1) return chunk;
  return chunk.subarray(nl + 1);
}
