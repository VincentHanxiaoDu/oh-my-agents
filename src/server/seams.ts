// Named seams for the Issues that stack on this one.
//
// Each is a real exported symbol with the signature the later Issue needs, and each REFUSES. The
// alternative — leaving nothing, or leaving a permissive default — is what produces the failure
// this project is built against: a host that appears to have authentication because a function
// called `authenticate` exists and returns true.
//
// Nothing in this file is wired into the request path on Issue #1. `requireAuth` in particular is
// NOT installed as middleware: installing a refusing middleware would make the host unusable, and
// installing a permissive one would make it look authenticated when it is not. Issue #5 installs
// the real one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { NotImplementedOnThisIssue } from '../sessions/registry.js';

/** SEAM FOR ISSUE #5: pairing / authentication middleware in front of every route. */
export function requireAuth(_req: IncomingMessage, _res: ServerResponse): never {
  throw new NotImplementedOnThisIssue('request authentication', 'Issue #5 (pair a device with a host)');
}

/** SEAM FOR ISSUE #2: the WebSocket upgrade that carries a terminal attach. */
export function handleAttachUpgrade(_req: IncomingMessage, _socket: Duplex, _head: Buffer): never {
  throw new NotImplementedOnThisIssue('the attach WebSocket', 'Issue #2 (attach to a running agent)');
}

/** SEAM FOR ISSUE #3: proxying a request to a peer host on the same tailnet. */
export function proxyToPeer(_peerId: string, _req: IncomingMessage, _res: ServerResponse): never {
  throw new NotImplementedOnThisIssue('peer proxying', 'Issue #3 (one view over several hosts)');
}
