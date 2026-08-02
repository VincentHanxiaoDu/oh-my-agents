// The mesh on the wire: the unified view, the join/forget routes, and the proxied attach.
//
// ONE MODULE THAT `server.ts` CALLS IN A FEW LINES, for the same reason `pairing-http.ts` is one:
// `server.ts` is being edited by Issue #2 in parallel and a wide edit there is a merge conflict for
// both of us.
//
// ─── EVERY ROUTE HERE IS BEHIND `requireAuth` BY CONSTRUCTION ────────────────────────────────────
//
// `server.ts` calls `requireAuth` before any route is matched, so nothing below is reachable by an
// unpaired or revoked device — it received Issue #5's byte-identical 404 before this file was
// consulted. THIS ISSUE ADDS NO UNAUTHENTICATED ROUTE AND NO EXEMPTION FOR PEER TRAFFIC. A peer's
// request is an ordinary request to `/api/status` carrying a HOST credential, and it goes through
// exactly the same guard; nothing about #5's criterion 6 is eroded, and this file contains no
// second denial shape — it reuses `denyOpaquely`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { denyOpaquely } from './pairing-http.js';
import { aggregate } from '../mesh/aggregate.js';
import { forgetPeer, joinPeer, readPeers } from '../mesh/peers.js';
import { proxyUpgrade, resolveTarget } from '../mesh/proxy.js';
import { meshCredentialSupplier, type CredentialSupplier } from '../mesh/trust.js';
import type { MachineIdentity } from '../mesh/identity.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { PathEnv } from '../paths.js';

export interface MeshContext {
  identity: MachineIdentity;
  /** How this host names itself in its own view. */
  address: string;
  registry: SessionRegistry;
  env: PathEnv;
  /** Overridden only by tests. Production is `meshCredentialSupplier`, which grants nothing. */
  supplier?: CredentialSupplier;
  timeoutMs?: number;
}

export type MeshRouteResult = 'handled' | 'not-mine';

export async function handleMeshRoute(req: IncomingMessage, res: ServerResponse, ctx: MeshContext): Promise<MeshRouteResult> {
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const route = url.pathname;
  const supplier = ctx.supplier ?? meshCredentialSupplier(ctx.env);

  if (route === '/api/mesh' && (req.method === 'GET' || req.method === 'HEAD')) {
    // CRITERION 7. `?host=` may be repeated. When present, the join records are not consulted at
    // all: a person can point this at hosts that have never been joined to each other and get the
    // same unified list from the same code path.
    const explicit = url.searchParams.getAll('host').filter((h) => h.trim() !== '');
    const view = await aggregate({
      self: { identity: ctx.identity, address: ctx.address, registry: ctx.registry },
      supplier,
      env: ctx.env,
      ...(explicit.length > 0 ? { addresses: explicit } : {}),
      ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    });
    json(res, 200, { ok: true, ...view, explicit: explicit.length > 0 });
    return 'handled';
  }

  if (route === '/api/peers' && (req.method === 'GET' || req.method === 'HEAD')) {
    const read = readPeers(ctx.env);
    if (read.kind === 'undetermined') {
      // 503 and a reason, NOT 200 with an empty list. "I could not read which hosts you joined" and
      // "you have joined none" lead a person to different actions, and one of those actions is
      // re-joining a host that is already joined.
      json(res, 503, { ok: false, undetermined: true, error: read.reason });
      return 'handled';
    }
    json(res, 200, { ok: true, peers: read.kind === 'present' ? read.peers : [] });
    return 'handled';
  }

  if (route === '/api/peers/join' && req.method === 'POST') {
    if (!sameSiteWrite(req)) {
      denyOpaquely(res);
      return 'handled';
    }
    const body = await readJsonBody(req);
    const address = typeof body?.address === 'string' ? body.address : '';
    const outcome = joinPeer(address, ctx.env, { self: { hostId: ctx.identity.hostId, addresses: selfAddresses(ctx), port: selfPort(ctx) } });
    switch (outcome.kind) {
      case 'joined':
        json(res, 200, { ok: true, joined: outcome.peer, duplicate: false });
        return 'handled';
      case 'already-joined':
        // CRITERION 6. 200, not an error: asking for a state that already holds is not a failure.
        // `duplicate: true` is what the client renders, and nothing was added.
        json(res, 200, { ok: true, joined: outcome.peer, duplicate: true, matchedBy: outcome.matchedBy });
        return 'handled';
      case 'refused-self':
        json(res, 409, { ok: false, error: outcome.reason });
        return 'handled';
      case 'invalid':
        json(res, 400, { ok: false, error: outcome.reason });
        return 'handled';
      case 'undetermined':
        json(res, 503, { ok: false, undetermined: true, error: outcome.reason });
        return 'handled';
    }
  }

  if (route === '/api/peers/forget' && req.method === 'POST') {
    if (!sameSiteWrite(req)) {
      denyOpaquely(res);
      return 'handled';
    }
    const body = await readJsonBody(req);
    const address = typeof body?.address === 'string' ? body.address : '';
    const outcome = forgetPeer(address, ctx.env);
    switch (outcome.kind) {
      case 'forgotten':
        json(res, 200, { ok: true, forgotten: outcome.peer });
        return 'handled';
      case 'no-such-peer':
        json(res, 404, { ok: false, error: outcome.reason });
        return 'handled';
      case 'invalid':
        json(res, 400, { ok: false, error: outcome.reason });
        return 'handled';
      case 'undetermined':
        json(res, 503, { ok: false, undetermined: true, error: outcome.reason });
        return 'handled';
    }
  }

  return 'not-mine';
}

function selfAddresses(ctx: MeshContext): string[] {
  const i = ctx.address.lastIndexOf(':');
  return i === -1 ? [ctx.address] : [ctx.address.slice(0, i).replace(/^\[|\]$/g, '')];
}

function selfPort(ctx: MeshContext): number {
  const i = ctx.address.lastIndexOf(':');
  return i === -1 ? 0 : Number(ctx.address.slice(i + 1));
}

/**
 * CRITERION 3, the proxied attach.
 *
 * Called from `server.ts`'s upgrade listener AFTER Issue #5's `authoriseUpgrade` has granted, so the
 * device is paired with THIS host before a byte goes anywhere. Returns `not-mine` when the upgrade
 * names no peer, which is the local attach and belongs to Issue #2.
 */
export async function handleMeshUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: MeshContext): Promise<MeshRouteResult> {
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const wanted = url.searchParams.get('host');
  if (wanted === null || wanted.trim() === '') return 'not-mine';
  if (wanted === ctx.identity.hostId || wanted === ctx.address) return 'not-mine';

  const read = readPeers(ctx.env);
  const peers = read.kind === 'present' ? read.peers : [];
  const peer = peers.find((p) => p.hostId === wanted || p.address === wanted);
  // An upgrade naming a host this one has not joined is not told whether that host exists. It is
  // the same opaque denial an unpaired caller gets, deliberately.
  const address = peer?.address ?? null;
  if (address === null) {
    denyUpgrade(socket);
    return 'handled';
  }
  const target = resolveTarget(address);
  if (target === null) {
    denyUpgrade(socket);
    return 'handled';
  }

  const supplier = ctx.supplier ?? meshCredentialSupplier(ctx.env);
  const credential = await supplier({ address, hostId: peer?.hostId ?? null });
  const outcome = await proxyUpgrade(target, credential, req, socket, head);
  if (outcome.kind === 'proxied') return 'handled';
  // FAIL CLOSED, IN WORDS. The device is paired with this host, so it is allowed to know that the
  // attach did not happen and why — this is not the unauthenticated path, and silence here would
  // look to a person exactly like a hung terminal.
  socket.end(
    `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n` +
      `the attach was not proxied to ${address}: ${outcome.reason}\n`,
  );
  return 'handled';
}

function denyUpgrade(socket: Duplex): void {
  const body = JSON.stringify({ ok: false, error: 'not found' });
  socket.end(
    'HTTP/1.1 404 Not Found\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n` +
      'cache-control: no-store\r\n' +
      'connection: close\r\n\r\n' +
      body,
  );
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Same rule as `pairing-http.ts`'s: `SameSite=Strict` is the defence, this is the second layer. */
function sameSiteWrite(req: IncomingMessage): boolean {
  const raw = req.headers['sec-fetch-site'];
  const site = Array.isArray(raw) ? raw[0] : raw;
  return site === undefined || site === 'same-origin' || site === 'none';
}

const MAX_BODY = 4096;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY) return null;
    chunks.push(buf);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
