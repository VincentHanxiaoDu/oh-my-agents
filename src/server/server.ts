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
// seams.ts.
//
// ISSUE #2 TOUCHED THIS FILE IN TWO PLACES AND NO MORE, deliberately: one `if` in the request
// handler that delegates to `handleSessionRoute`, and the body of the `upgrade` listener. Both
// delegate immediately to a module of their own. Issue #5 is being built from the same commit and
// installs its middleware here too; keeping this branch's footprint to two hunks is what makes
// whichever lands second a trivial rebase rather than a merge of two rewrites.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeBindSet, type BindPlan } from '../host/bind.js';
import type { PtyRegistry, SessionRegistry } from '../sessions/registry.js';
import { handleSessionRoute } from '../sessions/http.js';
import { handleAttachUpgrade } from './seams.js';

export interface ServerOptions {
  plan: BindPlan;
  port: number;
  registry: SessionRegistry;
  /**
   * The PTY-backed registry, when this host owns sessions (Issue #2). Optional so a host can still
   * be started with `createEmptyRegistry()` — a test fixture, or a machine with no pty support —
   * without the session routes pretending to work.
   */
  sessions?: PtyRegistry;
  /** Directory holding the no-build browser client. Defaults to the shipped src/web. */
  webRoot?: string;
  startedAt?: string;
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
    const url = new URL(req.url ?? '/', 'http://host.invalid');
    const route = url.pathname;

    if (route === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    // ISSUE #2: session list, spawn, signal. Returns false when the request was not one of those.
    if (opts.sessions && (await handleSessionRoute(req, res, { registry: opts.sessions }))) return;

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
      // ISSUE #2: the attach socket. A host with no PTY-backed registry still refuses IN WORDS
      // rather than leaving the upgrade to hang — a hanging upgrade is indistinguishable from a bug
      // in the client, and costs whoever is debugging it an afternoon.
      server.on('upgrade', (req, socket, head) => {
        const sessions = opts.sessions;
        if (!sessions) {
          socket.end(
            'HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n' +
              'this host was started without a session registry, so there is nothing to attach to\n',
          );
          return;
        }
        handleAttachUpgrade(req, socket, head, { registry: sessions });
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
