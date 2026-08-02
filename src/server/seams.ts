// Named seams for the Issues that stack on this one.
//
// Each is a real exported symbol with the signature the later Issue needs, and each REFUSES. The
// alternative — leaving nothing, or leaving a permissive default — is what produces the failure
// this project is built against: a host that appears to have authentication because a function
// called `authenticate` exists and returns true.
//
// ISSUE #5 HAS FILLED ITS SEAM. `requireAuth` below is no longer a refusal: it is the real guard,
// it is installed in `server.ts`, and every route on this host is behind it. The other two seams
// are untouched and still refuse — they belong to Issues #2 and #3.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { NotImplementedOnThisIssue } from '../sessions/registry.js';
import { guardRequest, type GuardOptions, type GuardResult } from './pairing-http.js';

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

/** SEAM FOR ISSUE #3: proxying a request to a peer host on the same tailnet. */
export function proxyToPeer(_peerId: string, _req: IncomingMessage, _res: ServerResponse): never {
  throw new NotImplementedOnThisIssue('peer proxying', 'Issue #3 (one view over several hosts)');
}
