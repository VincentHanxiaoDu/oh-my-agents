// Attaching to an agent that lives on another machine (criterion 3).
//
// ─── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────────────────────────
//
// Criterion 3: "attaching to an agent that lives on a different host than the one I opened gives
// the same live attach as attaching locally: output streams, input reaches the agent, interrupt
// works." The attach socket itself is ISSUE #2 and is not on this branch — `handleAttachUpgrade`
// still refuses and `registry.ts` is still the interface plus an empty registry.
//
// So this file builds the OTHER half: the route from the host a person opened to the host that owns
// the agent. It is a byte-for-byte bidirectional relay over the already-established socket, which is
// what makes "the same live attach as locally" true rather than approximately true — there is no
// framing, no buffering by message, and no transformation, so whatever #2's protocol turns out to
// be, streaming output, inbound input and an interrupt all traverse this unchanged.
//
// IT IS NOT A RELAY IN THE SENSE CRITERION 8 FORBIDS. Criterion 8 rules out "a relay, a tunnel, or
// any process outside the hosts themselves". This runs INSIDE the host the person opened, which is
// one of the hosts, and it exists only because that host is the one the browser has a socket to.
// Nothing new has to be running anywhere, and a person who opens the owning host directly does not
// go through it at all.
//
// ─── FAIL CLOSED ─────────────────────────────────────────────────────────────────────────────────
//
// A proxied attach is the most privileged thing in this product: it is a live terminal on another
// machine. It happens only when this host holds a credential for that peer, and on this branch it
// holds none (see trust.ts — the open decision). So the shipped path denies, opaquely, with Issue
// #5's denial rather than a new one. That is the correct failure: an attach that worked without an
// answer to "how is a peer trusted" would be a terminal granted by a mechanism nobody reviewed.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { OPERATOR_HEADER } from '../pairing/operator.js';
import { parsePeerAddress } from './address.js';
import type { PeerCredential } from './trust.js';

export interface ProxyTarget {
  host: string;
  port: number;
}

export type ProxyOutcome = { kind: 'proxied' } | { kind: 'refused'; reason: string } | { kind: 'unreachable'; reason: string };

export function resolveTarget(address: string): ProxyTarget | null {
  const parsed = parsePeerAddress(address);
  return parsed.kind === 'ok' ? { host: parsed.address.host, port: parsed.address.port } : null;
}

/**
 * Forward an ordinary request to a peer and stream the answer back.
 *
 * The response is streamed, not buffered: a peer's answer that is large or slow reaches the browser
 * as it arrives, which is the same behaviour the local route has.
 */
export async function proxyRequest(
  target: ProxyTarget,
  credential: PeerCredential,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { request?: typeof http.request; timeoutMs?: number } = {},
): Promise<ProxyOutcome> {
  if (credential.kind === 'none') return { kind: 'refused', reason: credential.reason };
  const request = opts.request ?? http.request;

  return new Promise<ProxyOutcome>((resolve) => {
    let settled = false;
    const finish = (o: ProxyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    // The DEVICE's cookie is deliberately not forwarded. This host has already authenticated the
    // device against its own store; the peer authenticates THIS HOST. Forwarding the cookie would
    // make the peer verify a foreign device credential, which is precisely the revocation question
    // Issue #3 leaves open — see trust.ts.
    const headers: Record<string, string> = { accept: 'application/json', [OPERATOR_HEADER]: credential.proof };
    const upstream = request(
      { host: target.host, port: target.port, path: req.url ?? '/', method: req.method ?? 'GET', headers, timeout: opts.timeoutMs ?? 10000 },
      (peerRes) => {
        res.writeHead(peerRes.statusCode ?? 502, peerRes.headers as http.OutgoingHttpHeaders);
        peerRes.pipe(res);
        peerRes.on('end', () => finish({ kind: 'proxied' }));
        peerRes.on('error', (err) => {
          res.destroy();
          finish({ kind: 'unreachable', reason: String(err) });
        });
      },
    );
    upstream.on('timeout', () => {
      upstream.destroy();
      finish({ kind: 'unreachable', reason: `${target.host}:${target.port} did not answer in time` });
    });
    upstream.on('error', (err) => finish({ kind: 'unreachable', reason: `${target.host}:${target.port} — ${String(err)}` }));
    req.pipe(upstream);
  });
}

/**
 * Forward a socket UPGRADE to the peer and then relay bytes in both directions until either side
 * closes. This is the criterion 3 path.
 *
 * `head` — the bytes the client already sent past the end of the upgrade request — is forwarded
 * before anything else. Dropping it is the classic way a proxied WebSocket loses its first frame,
 * which would look exactly like "input does not reach the agent".
 */
export function proxyUpgrade(
  target: ProxyTarget,
  credential: PeerCredential,
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  opts: { request?: typeof http.request; timeoutMs?: number } = {},
): Promise<ProxyOutcome> {
  if (credential.kind === 'none') return Promise.resolve<ProxyOutcome>({ kind: 'refused', reason: credential.reason });
  const request = opts.request ?? http.request;

  return new Promise<ProxyOutcome>((resolve) => {
    let settled = false;
    const finish = (o: ProxyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };

    // Every hop-by-hop header the client sent is passed through — `upgrade`, `connection`,
    // `sec-websocket-key`, `sec-websocket-version`, the protocol list — because the peer, not this
    // host, is the one completing the handshake. The device cookie is dropped, as above.
    const headers: Record<string, string> = { [OPERATOR_HEADER]: credential.proof };
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === 'cookie' || name === 'host') continue;
      if (typeof value === 'string') headers[name] = value;
      else if (Array.isArray(value)) headers[name] = value.join(', ');
    }

    const upstream = request({
      host: target.host,
      port: target.port,
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      headers,
      timeout: opts.timeoutMs ?? 10000,
    });

    upstream.on('upgrade', (peerRes, peerSocket, peerHead) => {
      // The peer's own 101 line and headers go back verbatim. The browser is completing a handshake
      // with the OWNING host; this host is wire, not a participant.
      const statusLine = `HTTP/1.1 ${peerRes.statusCode ?? 101} ${peerRes.statusMessage ?? 'Switching Protocols'}\r\n`;
      const headerLines = Object.entries(peerRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`)
        .join('');
      clientSocket.write(statusLine + headerLines + '\r\n');
      if (peerHead && peerHead.length > 0) clientSocket.write(peerHead);
      if (head && head.length > 0) peerSocket.write(head);

      // No transformation in either direction. Output streams out, input reaches the agent, and an
      // interrupt — whatever byte or frame #2 chooses for it — is just more bytes going the other
      // way. Nothing here can be the thing that swallows it.
      clientSocket.pipe(peerSocket);
      peerSocket.pipe(clientSocket);

      const bothDown = (): void => {
        clientSocket.destroy();
        peerSocket.destroy();
      };
      clientSocket.on('error', bothDown);
      peerSocket.on('error', bothDown);
      clientSocket.on('close', () => peerSocket.destroy());
      peerSocket.on('close', () => clientSocket.destroy());
      finish({ kind: 'proxied' });
    });

    // The peer answered without upgrading — most likely Issue #5's opaque 404 for a host that does
    // not recognise us, or #1's 501 for a host with no attach socket yet. Either way there is no
    // socket, and the caller decides what the client is told.
    upstream.on('response', (peerRes) => {
      peerRes.resume();
      finish({ kind: 'refused', reason: `${target.host}:${target.port} answered ${peerRes.statusCode ?? 0} instead of upgrading` });
    });
    upstream.on('timeout', () => {
      upstream.destroy();
      finish({ kind: 'unreachable', reason: `${target.host}:${target.port} did not answer in time` });
    });
    upstream.on('error', (err) => finish({ kind: 'unreachable', reason: `${target.host}:${target.port} — ${String(err)}` }));
    upstream.end();
  });
}
