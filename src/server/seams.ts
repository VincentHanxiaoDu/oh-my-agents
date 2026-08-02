// Named seams for the Issues that stack on this one.
//
// Each is a real exported symbol with the signature the later Issue needs, and each REFUSES. The
// alternative — leaving nothing, or leaving a permissive default — is what produces the failure
// this project is built against: a host that appears to have authentication because a function
// called `authenticate` exists and returns true.
//
// ISSUE #5 HAS FILLED ITS SEAM. `requireAuth` below is no longer a refusal: it is the real guard,
// it is installed in `server.ts`, and every route on this host is behind it.
//
// ISSUE #3 HAS FILLED `proxyToPeer`. It routes a request to the host that owns the agent, and it
// FAILS CLOSED: it forwards only with a credential this host holds for that peer, and on this
// branch it holds none, because how a host is trusted when joined is Issue #3's OPEN DECISION and
// this branch refuses to answer it. `establishPeerTrustSeam` below still throws.
//
// `handleAttachUpgrade` is untouched and still refuses — it belongs to Issue #2.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { NotImplementedOnThisIssue } from '../sessions/registry.js';
import { denyOpaquely, guardRequest, type GuardOptions, type GuardResult } from './pairing-http.js';
import { readPeers } from '../mesh/peers.js';
import { proxyRequest, resolveTarget, type ProxyOutcome } from '../mesh/proxy.js';
import { meshCredentialSupplier, refuseToEstablishTrust, type CredentialSupplier } from '../mesh/trust.js';
import type { PathEnv } from '../paths.js';

export { authoriseUpgrade, denyUpgradeOpaquely, denyOpaquely } from './pairing-http.js';
export type { GuardOptions, GuardResult } from './pairing-http.js';

/**
 * ISSUE #5: pairing / authentication in front of every route.
 *
 * Returns `continue` ONLY for a request carrying a credential this host issued and has not revoked.
 * Every other outcome — no credential, a forged one, a revoked one, and a pairing store this host
 * cannot read — is `handled`, and the response has already been written by the time it returns.
 *
 * NOTHING ABOUT THIS FUNCTION FAILS OPEN. There is no boolean to get backwards and no exception to
 * swallow: the caller cannot serve a route without having received the string `continue`.
 */
export function requireAuth(req: IncomingMessage, res: ServerResponse, opts: GuardOptions): Promise<GuardResult> {
  return guardRequest(req, res, opts);
}

/** SEAM FOR ISSUE #2: the WebSocket upgrade that carries a terminal attach. */
export function handleAttachUpgrade(_req: IncomingMessage, _socket: Duplex, _head: Buffer): never {
  throw new NotImplementedOnThisIssue('the attach WebSocket', 'Issue #2 (attach to a running agent)');
}

/**
 * ISSUE #3 HAS FILLED THIS SEAM. Proxy a request to a peer host on the same tailnet.
 *
 * `peerId` is either a peer's `hostId` or the canonical `host:port` it was joined at. The peer is
 * looked up in this host's own join records; a `peerId` naming nothing joined here is denied with
 * Issue #5's opaque 404, so a paired device cannot use this to probe which machines exist.
 *
 * IT FAILS CLOSED AND, ON THIS BRANCH, IT ALWAYS FAILS. Forwarding requires a credential this host
 * can present to the peer, and how a host comes to hold one is Issue #3's OPEN DECISION, which this
 * branch refuses to answer. `meshCredentialSupplier` therefore returns `none` for every peer and
 * this returns `refused`. The caller gets a value it must handle; nothing here invents a credential
 * and nothing here forwards the DEVICE's cookie, which would make the peer verify a foreign device
 * credential it cannot check for revocation. See `src/mesh/trust.ts`.
 */
export async function proxyToPeer(
  peerId: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { env?: PathEnv; supplier?: CredentialSupplier } = {},
): Promise<ProxyOutcome> {
  const env = opts.env ?? process.env;
  const read = readPeers(env);
  const peers = read.kind === 'present' ? read.peers : [];
  const peer = peers.find((p) => p.hostId === peerId || p.address === peerId);
  if (peer === undefined) {
    denyOpaquely(res);
    return { kind: 'refused', reason: `no peer named '${peerId}' is joined to this host` };
  }
  const target = resolveTarget(peer.address);
  if (target === null) {
    denyOpaquely(res);
    return { kind: 'refused', reason: `'${peer.address}' is not an address this host can reach` };
  }
  const supplier = opts.supplier ?? meshCredentialSupplier(env);
  const credential = await supplier({ address: peer.address, hostId: peer.hostId });
  const outcome = await proxyRequest(target, credential, req, res);
  if (outcome.kind !== 'proxied' && !res.headersSent) {
    // The device is paired with THIS host, so it is told that the peer did not serve it. That
    // discloses nothing an unpaired caller could learn: it never got past `requireAuth`.
    const payload = JSON.stringify({ ok: false, error: outcome.reason, peer: peer.address, outcome: outcome.kind });
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
  return outcome;
}

/** SEAM STILL REFUSING: how a peer comes to hold what it needs to trust another host. */
export function establishPeerTrustSeam(peerId: string, peerAddress: string): never {
  return refuseToEstablishTrust(peerId, peerAddress);
}
