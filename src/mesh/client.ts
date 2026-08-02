// Asking a peer what it has. One request, to a route that already exists.
//
// NO NEW UNAUTHENTICATED ROUTE IS ADDED FOR PEER TRAFFIC. This asks `GET /api/status`, which is
// behind Issue #5's `requireAuth` like everything else, and it presents a HOST credential. That
// matters for two of #5's criteria at once: nothing new is exposed, and the byte-identical 404 that
// an unrecognised caller receives is unchanged — this client is one of the callers that receives it,
// and it reads that 404 as `not-trusted` rather than as "no agents", which is criterion 4 here.
//
// A DENIAL AND AN OUTAGE ARE DIFFERENT ANSWERS, and the whole point of this file is that they stay
// different all the way to the screen:
//
//   connection refused / timeout / DNS failure  -> unreachable
//   404 (the opaque denial, or a host too old to have this route)  -> not-trusted
//   200 with a body we understand  -> listed  (possibly zero agents, which is a fact)
//   anything else  -> undetermined
//
// TIMEOUTS ARE SHORT AND BOUNDED because criterion 2 says shutting a host down must not stop the
// others seeing each other. A sleeping laptop that holds the request open for 30 seconds makes the
// whole unified list take 30 seconds, which is "cannot see each other" in every way a person cares
// about. Peers are asked CONCURRENTLY and each has its own deadline.

import http from 'node:http';
import { OPERATOR_HEADER } from '../pairing/operator.js';
import { parsePeerAddress, peerOrigin } from './address.js';
import type { CredentialSupplier } from './trust.js';
import type { PeerAgents } from './view.js';
import type { SessionSummary } from '../sessions/registry.js';

export const DEFAULT_PEER_TIMEOUT_MS = 2500;

export interface PeerAnswer {
  agents: PeerAgents;
  /** What the peer said it is, when it answered and we understood it. */
  identity: { hostId: string; machine: string } | null;
}

export interface AskOptions {
  timeoutMs?: number;
  /** Injected by tests so a peer can be answered without a socket. */
  request?: typeof http.request;
}

/** Ask one peer. Never throws and never returns an empty list to mean anything but "no agents". */
export async function askPeer(
  address: string,
  supplier: CredentialSupplier,
  opts: AskOptions = {},
): Promise<PeerAnswer> {
  const parsed = parsePeerAddress(address);
  if (parsed.kind === 'invalid') {
    return { agents: { kind: 'undetermined', reason: parsed.reason }, identity: null };
  }

  let credential;
  try {
    // THE CANONICAL FORM, not what the caller typed. A credential is held for a MACHINE, and
    // `100.64.0.3:8787` and `http://100.64.0.3:8787/` are one machine — a supplier keyed on the
    // spelling would hold a credential for one and not the other, which shows up as the same
    // machine being both trusted and not trusted in one list.
    credential = await supplier({ address: parsed.address.canonical, hostId: null });
  } catch (err) {
    // A supplier that throws is a wiring mistake, and it is reported as such — not as an outage,
    // because saying "unreachable" about a machine that is up would send a person to the wrong box.
    return { agents: { kind: 'undetermined', reason: `this host could not produce a credential for ${address}: ${String(err)}` }, identity: null };
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (credential.kind === 'operator') headers[OPERATOR_HEADER] = credential.proof;

  const got = await get(parsed.address.host, parsed.address.port, '/api/status', headers, opts);

  if (got.kind === 'transport') {
    return { agents: { kind: 'unreachable', reason: got.reason }, identity: null };
  }
  if (got.status === 404) {
    return {
      agents: {
        kind: 'not-trusted',
        reason:
          credential.kind === 'none'
            ? credential.reason
            : `${peerOrigin(parsed.address)} did not recognise this host's credential`,
      },
      identity: null,
    };
  }
  if (got.status !== 200) {
    return { agents: { kind: 'undetermined', reason: `${peerOrigin(parsed.address)} answered ${got.status}` }, identity: null };
  }

  let body: unknown;
  try {
    body = JSON.parse(got.body);
  } catch {
    return { agents: { kind: 'undetermined', reason: `${peerOrigin(parsed.address)} answered 200 with something that is not JSON` }, identity: null };
  }
  const v = body as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || !Array.isArray(v.sessions)) {
    return { agents: { kind: 'undetermined', reason: `${peerOrigin(parsed.address)} answered 200 in a shape this version does not understand` }, identity: null };
  }

  const agents: SessionSummary[] = [];
  for (const raw of v.sessions) {
    const s = coerceSession(raw);
    if (s === null) {
      return { agents: { kind: 'undetermined', reason: `${peerOrigin(parsed.address)} listed a session in a shape this version does not understand` }, identity: null };
    }
    agents.push(s);
  }

  const identity =
    typeof v.hostId === 'string' && typeof v.machine === 'string' ? { hostId: v.hostId, machine: v.machine } : null;

  return { agents: { kind: 'listed', agents }, identity };
}

function coerceSession(value: unknown): SessionSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.title !== 'string' || typeof v.startedAt !== 'string' || typeof v.alive !== 'boolean') return null;
  return { id: v.id, title: v.title, startedAt: v.startedAt, alive: v.alive };
}

type GetResult = { kind: 'http'; status: number; body: string } | { kind: 'transport'; reason: string };

/** 256 KiB. A peer is trusted about as far as any network peer is: not far enough to be unbounded. */
const MAX_PEER_BODY = 256 * 1024;

function get(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  opts: AskOptions,
): Promise<GetResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
  const request = opts.request ?? http.request;
  return new Promise<GetResult>((resolve) => {
    let settled = false;
    const finish = (r: GetResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let req: http.ClientRequest;
    try {
      req = request({ host, port, path, method: 'GET', headers, timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_PEER_BODY) {
            req.destroy();
            finish({ kind: 'transport', reason: `${host}:${port} sent more than ${MAX_PEER_BODY} bytes` });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish({ kind: 'http', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => finish({ kind: 'transport', reason: `${host}:${port} — ${String(err)}` }));
      });
    } catch (err) {
      finish({ kind: 'transport', reason: `${host}:${port} — ${String(err)}` });
      return;
    }
    req.on('timeout', () => {
      req.destroy();
      finish({ kind: 'transport', reason: `${host}:${port} did not answer within ${timeoutMs}ms` });
    });
    req.on('error', (err) => finish({ kind: 'transport', reason: `${host}:${port} — ${(err as NodeJS.ErrnoException).code ?? String(err)}` }));
    req.end();
  });
}
