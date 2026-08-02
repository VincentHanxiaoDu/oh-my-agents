// The HTTP server.
//
// ONE LISTENER PER ADDRESS, DELIBERATELY. `http.createServer().listen(port)` with no host binds the
// wildcard, which is exactly what criterion 3 forbids; `listen(port, host)` binds one address. So a
// host serving on loopback AND on its tailnet address runs two listeners on the same port sharing
// one request handler. That is not a workaround — it is the only way to say "these interfaces and
// no others" with Node's API, and it makes the bind set visible in the process's socket table
// rather than implied by a firewall rule somebody has to remember.
//
// Issue #2 adds the attach WebSocket, #3 adds peer proxying, #5 adds auth. Their seams are in
// seams.ts and are not wired in here.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBindSet, type BindPlan } from '../host/bind.js';
import type { SessionRegistry } from '../sessions/registry.js';
import { authoriseUpgrade, denyUpgradeOpaquely, requireAuth } from './seams.js';
import { grants } from '../pairing/auth.js';
import { handleMeshRoute, handleMeshUpgrade, type MeshContext } from './mesh-http.js';
import { ensureMachineIdentity, type MachineIdentity } from '../mesh/identity.js';
import type { CredentialSupplier } from '../mesh/trust.js';
import { bracketIfV6 } from '../mesh/address.js';
import type { PathEnv } from '../paths.js';

export interface ServerOptions {
  plan: BindPlan;
  port: number;
  registry: SessionRegistry;
  /** Directory holding the no-build browser client. Defaults to the shipped src/web. */
  webRoot?: string;
  startedAt?: string;
  /** Overrides for the state directory. Injected by tests; the daemon passes process.env. */
  env?: PathEnv;
  /**
   * ISSUE #3. How this host authenticates itself to a peer. Production leaves this unset, and the
   * default (`meshCredentialSupplier`) grants nothing for every peer, because how a host is trusted
   * when joined is this Issue's OPEN DECISION. Tests inject one so the rest of the mesh — the
   * unified list, the unreachable rendering, the deduplication — can be exercised end to end
   * without that decision being answered by implementation. See src/mesh/trust.ts.
   */
  peerCredentialSupplier?: CredentialSupplier;
  /** Per-peer deadline for the unified view. Injected by tests to keep them fast. */
  peerTimeoutMs?: number;
}

export interface RunningServer {
  /** The addresses actually bound, read back from the sockets rather than from the plan. */
  boundAddresses: string[];
  port: number;
  close(): Promise<void>;
}

export function defaultWebRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  // Asserted here as well as in the resolver, because this is the moment the socket is opened and
  // a plan that came from anywhere other than resolveBind must not get past this line.
  assertSafeBindSet(opts.plan.addresses);

  const webRoot = opts.webRoot ?? defaultWebRoot();
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const env = opts.env ?? process.env;

  // ISSUE #3. This machine's durable identity, so its agents can be LABELLED with which machine
  // they are on and so a peer joined twice is recognised as one machine. `undetermined` is loud and
  // NOT fatal: the host serves under a per-process identity, and says so, rather than refusing to
  // start over a file a user can delete. The distinction is preserved on the wire below.
  const identityRead = ensureMachineIdentity(env);
  const identity: MachineIdentity = identityRead.kind === 'ok' ? identityRead.identity : identityRead.fallback;
  if (identityRead.kind === 'undetermined') {
    process.stderr.write(
      `WARNING: this host could not establish a durable machine identity: ${identityRead.reason}\n` +
        `It is serving under a per-process identity, so peers will see it as a NEW machine after each\n` +
        `restart. This is NOT the same as having no peers, and joins made against it will not stick.\n`,
    );
  }

  const selfAddress = `${bracketIfV6(opts.plan.tailnet[0] ?? opts.plan.addresses[0] ?? '127.0.0.1')}:${opts.port}`;
  const meshContext: MeshContext = {
    identity,
    address: selfAddress,
    registry: opts.registry,
    env,
    ...(opts.peerCredentialSupplier ? { supplier: opts.peerCredentialSupplier } : {}),
    ...(opts.peerTimeoutMs !== undefined ? { timeoutMs: opts.peerTimeoutMs } : {}),
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // ISSUE #5. Before any route is matched, so a route added later is behind it by construction.
    if ((await requireAuth(req, res, { webRoot, ...(opts.env ? { env: opts.env } : {}) })) !== 'continue') return;
    const url = new URL(req.url ?? '/', 'http://host.invalid');
    const route = url.pathname;

    if (route === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/status') {
      json(res, 200, {
        ok: true,
        // ISSUE #3. A peer reads these two to label this machine's agents in a unified list, and to
        // recognise this machine when it was joined at a second address. They are a NAME, not a
        // secret: `hostId` is random, means nothing on its own, and is only shown to a caller that
        // already got past the pairing guard.
        hostId: identity.hostId,
        machine: identity.machine,
        identityDetermination: identityRead.kind === 'ok' ? 'determined' : 'undetermined',
        startedAt,
        pid: process.pid,
        port: opts.port,
        reachability: opts.plan.reachability,
        determination: opts.plan.determination,
        addresses: opts.plan.addresses,
        tailnetAddresses: opts.plan.tailnet,
        sessionCount: opts.registry.count(),
        sessions: opts.registry.list(),
      });
      return;
    }

    // ISSUE #3: the unified view, the join records, and joining/forgetting a peer. Every one of
    // these is behind `requireAuth` above by construction — this line is reached only for a device
    // this host has paired and has not revoked.
    if (await handleMeshRoute(req, res, meshContext) === 'handled') return;

    if (route === '/' || route === '/index.html') {
      await sendFile(res, path.join(webRoot, 'index.html'));
      return;
    }

    // Static assets, confined to webRoot. `path.resolve` on user input and then a prefix check is
    // the whole of the traversal defence — without it, `/../../etc/passwd` is served by a host that
    // is, by design, reachable from every device on somebody's tailnet.
    const candidate = path.resolve(webRoot, '.' + route);
    if (candidate.startsWith(path.resolve(webRoot) + path.sep)) {
      await sendFile(res, candidate);
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  };

  const servers: http.Server[] = [];
  const bound: string[] = [];
  // Every socket this host has upgraded, so shutdown can end them. See `close` below for why the
  // server's own bookkeeping is not enough.
  const upgraded = new Set<import('node:stream').Duplex>();

  try {
    for (const address of opts.plan.addresses) {
      const server = http.createServer((req, res) => {
        void handler(req, res).catch(() => {
          if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
          else res.end();
        });
      });
      // ISSUE #5 AUTHORISES THE UPGRADE PATH ITSELF, not the socket behind it. Issue #2's attach
      // socket does not exist on this branch, so putting the check inside it was not available —
      // and putting it here is better anyway: whatever #2 lands, it lands behind this, and an
      // unpaired caller never learns whether an attach socket exists at all. #2 MUST keep this
      // check first; a handler that authenticates after accepting has already answered the question.
      server.on('upgrade', (req, socket, head) => {
        upgraded.add(socket);
        socket.on('close', () => upgraded.delete(socket));
        if (!grants(authoriseUpgrade(req, env))) {
          denyUpgradeOpaquely(socket);
          return;
        }
        // ISSUE #3, CRITERION 3. An upgrade naming another machine is relayed to the host that owns
        // the agent, byte for byte, so a remote attach is the same live attach as a local one. It
        // is attempted only AFTER the check above, so an unpaired caller never learns that a peer
        // exists, let alone reaches one.
        void handleMeshUpgrade(req, socket, head, meshContext)
          .then((outcome) => {
            if (outcome === 'handled') return;
            // Local, and there is still nothing to attach to on this branch. Refused in words, as
            // Issue #1 left it — a paired device may know that this host has no attach yet.
            socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\nthe attach WebSocket is Issue #2\n');
          })
          .catch(() => socket.destroy());
      });
      await listen(server, opts.port, address);
      servers.push(server);
      const addr = server.address();
      bound.push(typeof addr === 'object' && addr !== null ? addr.address : address);
    }
  } catch (err) {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    throw err;
  }

  return {
    boundAddresses: bound,
    port: opts.port,
    close: async () => {
      // ─── WHY THIS IS NOT JUST `s.close()` ──────────────────────────────────────────────────────
      //
      // `close()` stops accepting and then waits for every open connection to END, and an attach is
      // a connection that by design never ends. Before Issue #3 this host had no long-lived socket,
      // so `close()` always returned promptly; the first proxied attach made `oh-my-agents stop`
      // hang until the person closed the browser tab.
      //
      // AND `closeAllConnections()` ALONE IS NOT ENOUGH. Node detaches an UPGRADED socket from the
      // server's connection set — so `closeAllConnections()` cannot see it — while still counting
      // it in the server's connection total. Once a socket has been upgraded and has gone away,
      // that total never reaches zero and the `close()` callback therefore never fires. Measured,
      // not assumed: a bare server with one upgraded-then-destroyed socket reports one connection
      // forever. So the upgraded sockets are tracked here and destroyed by name, and the wait ends
      // when the LISTENING SOCKET is closed — which is what "this host has stopped serving" means.
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((r) => {
              let done = false;
              const finish = (): void => {
                if (done) return;
                done = true;
                r();
              };
              s.close(() => finish());
              s.closeAllConnections();
              // `close()` has already released the listening socket synchronously, so the port is
              // free from here. Nothing is left holding a connection: everything the server still
              // tracked was just destroyed, and everything it no longer tracks was destroyed above.
              setImmediate(finish);
            }),
        ),
      );
    },
  };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // `exclusive` so a second host on this machine gets EADDRINUSE rather than silently sharing the
    // port with the first — criterion 7 depends on the collision being observable.
    server.listen({ port, host, exclusive: true });
  });
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function sendFile(res: http.ServerResponse, file: string): Promise<void> {
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    json(res, 404, { ok: false, error: 'not found' });
  }
}
