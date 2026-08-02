// Starting several REAL hosts, on this one machine, for the multi-host tests.
//
// ─── WHY LOOPBACK AND DISTINCT PORTS, AND WHY NOTHING IS HARDCODED ───────────────────────────────
//
// Issue #3 is about several machines, and CI has one machine and no Tailscale. A test that named a
// tailnet address, or assumed Tailscale was installed, or assumed a second box existed, would be a
// test that passes on a developer's laptop and is meaningless on the runner. So a "host" here is a
// real `startServer` on `127.0.0.1` with its own port and its own state directory — a real HTTP
// server, real sockets, real join records on real files — and every address is discovered from the
// socket rather than written down. Nothing here probes for Tailscale because nothing here needs it:
// the mesh speaks plain HTTP over whatever network Issue #1's bind policy put the host on.
//
// ─── THE CREDENTIAL SUPPLIER IS INJECTED, AND THAT IS THE POINT ──────────────────────────────────
//
// How a host comes to hold a credential for a peer is Issue #3's OPEN DECISION and the shipped
// supplier grants nothing. So these tests inject one, built from each host's own store — the test
// process is the operator of all three state directories, which is an authority Issue #5 already
// defined and which the filesystem already granted it.
//
// THIS IS A STAND-IN AT ONE NAMED SEAM, NOT A DECISION. It is the same technique the attach tests
// use for Issue #2's absent PTY. What it demonstrates is everything downstream of trust: the
// unified list, the labelling, the unreachable rendering, the deduplication, the explicit host
// list. What it does NOT demonstrate is a mesh that works in production, because in production
// `meshCredentialSupplier` returns `none` for every peer, on purpose.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer, type RunningServer } from '../../src/server/server.js';
import type { BindPlan } from '../../src/host/bind.js';
import { ensureStore } from '../../src/pairing/store.js';
import { operatorProof, OPERATOR_HEADER } from '../../src/pairing/operator.js';
import type { SessionRegistry, SessionSummary } from '../../src/sessions/registry.js';
import type { CredentialSupplier } from '../../src/mesh/trust.js';

export interface TestHost {
  name: string;
  dir: string;
  port: number;
  address: string;
  server: RunningServer;
  stop(): Promise<void>;
}

/** Loopback only, which is what `assertSafeBindSet` permits and what a runner without a tailnet has. */
function loopbackPlan(): BindPlan {
  return {
    addresses: ['127.0.0.1'],
    loopback: ['127.0.0.1'],
    tailnet: [],
    reachability: 'local-only',
    determination: 'determined',
    reason: 'a test host, bound to loopback',
    rejected: [],
  };
}

export function fixedRegistry(sessions: SessionSummary[]): SessionRegistry {
  return {
    list: () => sessions.slice(),
    get: (id) => sessions.find((s) => s.id === id),
    count: () => sessions.length,
  };
}

export interface StartOptions {
  name: string;
  sessions?: SessionSummary[];
  supplier?: CredentialSupplier;
  peerTimeoutMs?: number;
}

/** Port 0: the OS picks a free one and we read it back off the socket. Nothing is hardcoded. */
export async function startTestHost(opts: StartOptions): Promise<TestHost> {
  const dir = mkdtempSync(path.join(tmpdir(), `oma-mesh-${opts.name}-`));
  const env = { OMA_STATE_DIR: dir };
  ensureStore(env);
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const server = await startServer({
    plan: loopbackPlan(),
    port,
    registry: fixedRegistry(opts.sessions ?? []),
    env,
    ...(opts.supplier ? { peerCredentialSupplier: opts.supplier } : {}),
    peerTimeoutMs: opts.peerTimeoutMs ?? 750,
  });

  return {
    name: opts.name,
    dir,
    port,
    address: `127.0.0.1:${port}`,
    server,
    stop: () => server.close(),
  };
}

/**
 * A supplier that can authenticate to any of the given hosts, by computing each one's operator
 * proof from its own state directory. See the note at the top of this file: a stand-in, not an
 * answer to how a host would come to hold this in production.
 */
export function supplierFor(hosts: () => TestHost[]): CredentialSupplier {
  return ({ address }) => {
    const host = hosts().find((h) => h.address === address);
    if (host === undefined) return { kind: 'none', reason: `this test holds no credential for ${address}` };
    const proof = operatorProof({ OMA_STATE_DIR: host.dir });
    if (proof.kind !== 'ok') return { kind: 'none', reason: proof.reason };
    return { kind: 'operator', proof: proof.proof };
  };
}

export interface Fetched {
  status: number;
  body: string;
  json(): unknown;
}

/** A request to a host, authenticated as that host's operator — the test IS its operator. */
export function callHost(host: TestHost, route: string, init: { method?: string; body?: string } = {}): Promise<Fetched> {
  const proof = operatorProof({ OMA_STATE_DIR: host.dir });
  const headers: Record<string, string> = { accept: 'application/json' };
  if (proof.kind === 'ok') headers[OPERATOR_HEADER] = proof.proof;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(init.body));
  }
  return new Promise<Fetched>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: host.port, path: route, method: init.method ?? 'GET', headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body,
            json: () => JSON.parse(body) as unknown,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${host.name} did not answer ${route} in time`));
    });
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
