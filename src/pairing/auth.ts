// The decision: may this request see anything?
//
// THE STORE IS RE-READ ON EVERY REQUEST AND NOT CACHED. Criterion 5 says a revoked device's NEXT
// request is rejected, and revocation happens in a different process (the CLI). A cache with any
// TTL at all turns "next request" into "next request after the cache expires", which is a window
// in which a phone that has been given away still works.
//
// THE ANSWER IS FOUR-VALUED and the fourth value is the point:
//
//   authorised   — a live device credential
//   unpaired     — no credential, or one this host has never issued
//   revoked      — a credential this host issued and has since revoked
//   undetermined — THE STORE COULD NOT BE READ
//
// `undetermined` DENIES. It is not `unpaired` and it is not an exception that a `catch` upstream
// turns into a permissive default: it is a distinct value that the caller must handle, and the
// only handling that exists denies and logs loudly. A pairing store that cannot be read is the one
// circumstance in which failing open would hand every session on the machine to whoever asked.

import { macIsValid, parseCredential, constantTimeEquals, DEVICE_COOKIE } from './credential.js';
import { readStore, sha256Hex } from './store.js';
import type { DeviceRecord } from './store.js';
import type { PathEnv } from '../paths.js';

export type AuthDecision =
  | { kind: 'authorised'; device: DeviceRecord }
  | { kind: 'unpaired' }
  | { kind: 'revoked'; deviceId: string }
  | { kind: 'undetermined'; reason: string };

/** Whether this decision permits anything. The ONLY function callers should branch on to grant. */
export function grants(decision: AuthDecision): decision is { kind: 'authorised'; device: DeviceRecord } {
  return decision.kind === 'authorised';
}

/**
 * Parse a Cookie header. Deliberately tolerant of whitespace and of a value containing `=`, and
 * deliberately NOT tolerant of anything else — this runs before authentication, on input from an
 * unauthenticated caller, so it does no work proportional to anything but the header's length.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Decide, from a presented credential.
 *
 * WORK IS CONSTANT ACROSS OUTCOMES ON PURPOSE. The store is read, the MAC is recomputed and every
 * device record is compared in constant time WITHOUT breaking out of the loop, whether the
 * credential is good, revoked, forged or absent. Criterion 6 requires the failure to be
 * indistinguishable from a paired device asking for something that does not exist, and TIMING is
 * named there alongside body and headers.
 */
export function authenticate(token: string | undefined, env: PathEnv = process.env): AuthDecision {
  const read = readStore(env);
  if (read.kind === 'undetermined') return { kind: 'undetermined', reason: read.reason };

  // `absent` means nobody has ever paired. It is a real answer and it grants nothing, but the
  // work below still runs so that a first-visit denial and a forged-credential denial cost the
  // same. The synthetic mesh secret is never written anywhere and can validate nothing.
  const store = read.kind === 'present' ? read.store : { meshSecret: '0'.repeat(64), devices: [] as DeviceRecord[] };

  const parsed = parseCredential(token);
  // A structurally invalid credential still pays for a MAC computation and a full scan, against a
  // deviceId that cannot match anything. Returning here instead would make "no cookie at all"
  // measurably cheaper than "a cookie with a wrong MAC", which is the first bit of an oracle.
  const deviceId = parsed?.deviceId ?? '0'.repeat(32);
  const presentedMac = parsed?.mac ?? '';
  const authentic = macIsValid(store.meshSecret, deviceId, presentedMac);
  const macHash = sha256Hex(presentedMac);

  let match: DeviceRecord | undefined;
  let revokedMatch: DeviceRecord | undefined;
  for (const d of store.devices) {
    // Both comparisons run for every device; neither the loop nor either branch is skipped.
    const idMatches = constantTimeEquals(d.id, deviceId);
    const macMatches = constantTimeEquals(d.macHash, macHash);
    const hit = idMatches && macMatches && authentic;
    if (hit && d.revokedAt === undefined && match === undefined) match = d;
    if (hit && d.revokedAt !== undefined && revokedMatch === undefined) revokedMatch = d;
  }

  if (match !== undefined) return { kind: 'authorised', device: match };
  if (revokedMatch !== undefined) return { kind: 'revoked', deviceId: revokedMatch.id };
  return { kind: 'unpaired' };
}

/** Convenience for the request path: pull the credential out of the Cookie header and decide. */
export function authenticateRequest(headers: { cookie?: string | undefined }, env: PathEnv = process.env): AuthDecision {
  return authenticate(readCookie(headers.cookie, DEVICE_COOKIE), env);
}
