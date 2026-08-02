// The session routes, kept OUT of src/server/server.ts on purpose.
//
// server.ts is edited by more than one Issue at a time — Issue #5 (device pairing) is being built
// from the same commit as this one and installs its middleware there. Putting four routes into that
// file would guarantee a conflict in the one file neither branch can afford one in. So the routes
// live here behind a single boolean-returning function, and server.ts gains one `if`.
//
// Everything here is JSON over plain HTTP. The live stream is NOT here: it is a WebSocket upgrade,
// handled in src/server/seams.ts, because criterion 1 is "without the person reloading or polling"
// and a JSON route is a thing you poll.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidSessionId } from './paths.js';
import { spawnSession, type PtyRegistry } from './registry.js';
import { attachSession } from './attach.js';
import { detectPtySupport } from './pty.js';
import { scrollbackBudgetBytes, SCROLLBACK_BUDGET_BYTES } from './scrollback.js';

const ID = '[a-z0-9][a-z0-9-]{0,63}';
const ONE = new RegExp(`^/api/sessions/(${ID})$`);
const SIGNAL = new RegExp(`^/api/sessions/(${ID})/signal$`);

/** The largest request body a session route will read. Bodies here are small JSON documents. */
const MAX_BODY_BYTES = 64 * 1024;

export interface SessionHttpContext {
  registry: PtyRegistry;
}

/**
 * Handle a session route. Returns false if the request was not one, so the caller can carry on.
 * Never throws into the request path: a route that throws leaves a socket open on a host that is,
 * by design, reachable from every device on somebody's tailnet.
 */
export async function handleSessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHttpContext,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const route = url.pathname;
  const method = req.method ?? 'GET';

  if (route === '/api/sessions' && method === 'GET') {
    const support = detectPtySupport();
    json(res, 200, {
      ok: true,
      sessions: ctx.registry.list(),
      // The scrollback budget is reported rather than assumed by the client, because it is an OPEN
      // PRODUCT DECISION on Issue #2 and the client must not hard-code a second copy of it.
      scrollback: {
        budgetBytes: scrollbackBudgetBytes(ctx.registry.env),
        defaultBudgetBytes: SCROLLBACK_BUDGET_BYTES,
        settled: false,
        note: 'How much scrollback is retained is an open product decision on Issue #2. This value is provisional.',
      },
      pty: support,
    });
    return true;
  }

  if (route === '/api/sessions' && method === 'POST') {
    const body = await readJson(req);
    if (!body.ok) {
      json(res, 400, { ok: false, error: body.error });
      return true;
    }
    const payload = body.value as { command?: unknown; args?: unknown; title?: unknown; cwd?: unknown };
    if (typeof payload.command !== 'string' || payload.command.trim() === '') {
      json(res, 400, { ok: false, error: 'a session needs a "command" to run' });
      return true;
    }
    if (payload.args !== undefined && (!Array.isArray(payload.args) || !payload.args.every((a) => typeof a === 'string'))) {
      json(res, 400, { ok: false, error: '"args" must be an array of strings' });
      return true;
    }
    const support = detectPtySupport();
    if (support.kind !== 'available') {
      // Two different failures, kept apart: this machine HAS no way to allocate a pty, versus this
      // host COULD NOT ESTABLISH whether it has one.
      json(res, support.kind === 'absent' ? 501 : 500, {
        ok: false,
        pty: support,
        error: support.reason,
      });
      return true;
    }
    const result = await spawnSession(ctx.registry, {
      command: payload.command,
      args: (payload.args as string[] | undefined) ?? [],
      ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
      ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
    });
    if (result.kind === 'spawned') json(res, 201, { ok: true, session: result.summary });
    else json(res, result.kind === 'refused' ? 400 : 500, { ok: false, error: result.reason });
    return true;
  }

  const one = ONE.exec(route);
  if (one && method === 'GET') {
    const summary = ctx.registry.get(one[1]!);
    if (!summary) {
      json(res, 404, { ok: false, error: 'no session with that id on this machine' });
      return true;
    }
    json(res, 200, { ok: true, session: summary });
    return true;
  }

  const sig = SIGNAL.exec(route);
  if (sig && method === 'POST') {
    const id = sig[1]!;
    if (!isValidSessionId(id)) {
      json(res, 400, { ok: false, error: 'that is not a session id' });
      return true;
    }
    const body = await readJson(req);
    const payload = body.ok ? (body.value as { signal?: unknown }) : {};
    const signal = typeof payload.signal === 'string' ? payload.signal : 'SIGTERM';
    if (!/^SIG[A-Z0-9]+$/.test(signal)) {
      json(res, 400, { ok: false, error: `'${signal}' is not a signal name` });
      return true;
    }
    const summary = ctx.registry.get(id);
    if (!summary) {
      json(res, 404, { ok: false, error: 'no session with that id on this machine' });
      return true;
    }
    if (summary.state !== 'live') {
      json(res, 409, { ok: false, state: summary.state, error: summary.reason });
      return true;
    }
    // A signal goes through the supervisor, not from here: this host does not know the agent's
    // process group and should not learn it. Note that SIGNAL is for KILLING a session. Ctrl+C is
    // not a signal on this path — it is the byte 0x03 on the attach socket. See seams.ts.
    const attached = await attachSession({ id, env: ctx.registry.env, budgetBytes: 0 });
    if (attached.kind === 'unreachable') {
      json(res, 502, { ok: false, state: 'undetermined', error: attached.reason });
      return true;
    }
    attached.attachment.signal(signal);
    setTimeout(() => attached.attachment.detach(), 250);
    json(res, 202, { ok: true, signal, id });
    return true;
  }

  return false;
}

interface JsonBody {
  ok: boolean;
  value?: unknown;
  error?: string;
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return { ok: false, error: 'the request body is larger than this host accepts' };
    chunks.push(buf);
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    return { ok: false, error: 'the request body is not valid JSON' };
  }
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
