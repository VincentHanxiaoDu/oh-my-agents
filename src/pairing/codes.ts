// One-time pairing codes (criteria 2 and 3).
//
// A code is 8 characters of Crockford base32 — 40 bits — shown once as XXXX-XXXX. It is
// SINGLE-USE and TIME-LIMITED, and both of those are enforced in the same locked transaction that
// creates the device, so two browsers racing on one code cannot both be paired.
//
// The alphabet excludes I, L, O and U: the first three so a code read off a screen and typed on a
// phone cannot become a different valid code, and U so the code cannot spell anything unfortunate.
// Input is NORMALISED before hashing, so a user typing lowercase, adding spaces, or typing O for 0
// pairs successfully rather than being told their correct code is wrong.
//
// The code is never stored. Its sha256 is. A store that contains outstanding pairing codes in the
// clear is a store whose disclosure pairs the attacker's browser.

import { randomInt } from 'node:crypto';
import { constantTimeEquals } from './credential.js';
import { sha256Hex, type CodeRecord } from './store.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * How long a code is good for. Criterion 3 requires a limit; five minutes is long enough to walk a
 * phone to the desk and short enough that a code left on a screen is not a standing key.
 *
 * THIS IS THE LIFETIME OF THE *CODE*, NOT OF THE DEVICE CREDENTIAL. Whether a paired device's
 * credential ever expires on its own is an OPEN PRODUCT DECISION on Issue #5 and nothing in this
 * build answers it. Do not read this constant as precedent for one.
 */
export const CODE_TTL_MS = 5 * 60 * 1000;

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** How a code is shown to a person. The dash is presentation only; `normaliseCode` removes it. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Fold everything a human might reasonably type into the one form that gets hashed. */
export function normaliseCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[ILÌ]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function hashCode(code: string): string {
  return sha256Hex(normaliseCode(code));
}

export type CodeVerdict =
  | { kind: 'usable'; index: number }
  /** Wrong code, already-used code, expired code. ONE verdict on purpose — see below. */
  | { kind: 'refused' };

/**
 * Find a usable code.
 *
 * CRITERION 3 SAYS THE REJECTIONS DIFFER ONLY IN SO FAR AS BOTH FAIL. So this returns one refusal
 * for a mistyped code, a used code and an expired code alike; the caller has nothing finer to
 * report even if it wanted to. Telling a caller "that code was already used" confirms the code was
 * real, which is the useful half of a guess.
 *
 * Every candidate is compared in constant time and the loop does NOT break on a match, so the time
 * this takes does not depend on which code matched or on whether one did.
 */
export function findUsableCode(codes: readonly CodeRecord[], presented: string, now: number): CodeVerdict {
  const wanted = hashCode(presented);
  let found = -1;
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    const matches = constantTimeEquals(c.codeHash, wanted);
    const unused = c.usedAt === undefined;
    const live = Date.parse(c.expiresAt) > now;
    if (matches && unused && live && found === -1) found = i;
  }
  return found === -1 ? { kind: 'refused' } : { kind: 'usable', index: found };
}

/** Codes that are neither used nor expired are the only ones worth keeping. */
export function pruneCodes(codes: readonly CodeRecord[], now: number): CodeRecord[] {
  return codes.filter((c) => c.usedAt === undefined && Date.parse(c.expiresAt) > now);
}
