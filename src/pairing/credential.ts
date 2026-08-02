// The device credential: what a paired browser holds, and what proves it is that browser.
//
// SHAPE:  oma1.<deviceId>.<mac>
//   deviceId  128 bits of randomness, hex. Not secret; it is what the device list shows.
//   mac       HMAC-SHA256(meshSecret, "oma1|" + deviceId), base64url. This is the secret half.
//
// WHY AN HMAC AND NOT A BARE RANDOM TOKEN. Criterion 8: a device paired to ANY host in the mesh is
// not required to pair again with each peer. A bare random token is only checkable by the host that
// generated it — a peer would have to be handed a copy of every token, which means a peer holds
// every device's credential. An HMAC over a mesh key means a peer can verify a credential it has
// never seen, holding only the key.
//
// WHAT THAT DOES NOT DECIDE, AND MUST NOT BE READ AS DECIDING: how a peer comes to hold the mesh
// key — whether hosts share this key, or authenticate to each other separately and vouch. That is
// ISSUE #3's open decision. `src/pairing/mesh.ts` is the named seam and it REFUSES.
//
// LOCAL verification does not rely on the HMAC alone: the issuing host checks the credential
// against its store, because the store is the only thing that knows about REVOCATION (criterion 5).
// The HMAC establishes authenticity; the store establishes current authorisation. A peer can do
// the first without the second, which is exactly the gap Issue #3 has to close and is written down
// in ARCHITECTURE.md so #3 builds to this answer rather than a second one.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CREDENTIAL_VERSION = 'oma1';

/** The cookie a paired browser carries. */
export const DEVICE_COOKIE = 'oma_device';

export interface Credential {
  deviceId: string;
  mac: string;
  /** The full string as it travels in the cookie. */
  token: string;
}

export function computeMac(meshSecret: string, deviceId: string): string {
  return createHmac('sha256', Buffer.from(meshSecret, 'hex'))
    .update(`${CREDENTIAL_VERSION}|${deviceId}`, 'utf8')
    .digest('base64url');
}

export function issueCredential(meshSecret: string): Credential {
  const deviceId = randomBytes(16).toString('hex');
  const mac = computeMac(meshSecret, deviceId);
  return { deviceId, mac, token: `${CREDENTIAL_VERSION}.${deviceId}.${mac}` };
}

/** Split a presented credential without deciding anything about it. Never throws. */
export function parseCredential(token: string | undefined): { deviceId: string; mac: string } | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, deviceId, mac] = parts as [string, string, string];
  if (version !== CREDENTIAL_VERSION) return null;
  if (!/^[0-9a-f]{32}$/.test(deviceId)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  return { deviceId, mac };
}

/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret leaks its prefix through how long the comparison takes. `timingSafeEqual`
 * requires equal lengths and throws otherwise, and the length check itself is a leak — so both
 * sides are hashed to a fixed 32 bytes first and the digests are compared. That is the standard
 * construction and it removes the length dependency as well as the content dependency.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest();
  const hb = createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// Per-process, so the digests being compared are not values an attacker can precompute offline.
const COMPARE_KEY = randomBytes(32);

/** Does this credential carry a valid MAC for this mesh? Authenticity only — NOT authorisation. */
export function macIsValid(meshSecret: string, deviceId: string, presentedMac: string): boolean {
  return constantTimeEquals(computeMac(meshSecret, deviceId), presentedMac);
}
