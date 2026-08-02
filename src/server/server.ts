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
      server.on('upgrade', (req, socket) => {
        if (!grants(authoriseUpgrade(req, opts.env ?? process.env))) {
          denyUpgradeOpaquely(socket);
          return;
        }
        // Paired, and there is still nothing to attach to on this branch. Refused in words, as
        // Issue #1 left it — a paired device is allowed to know that this host has no attach yet.
        socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\nthe attach WebSocket is Issue #2\n');
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
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
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
