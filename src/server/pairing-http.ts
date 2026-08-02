// Pairing on the wire: the guard in front of every route, and the four routes pairing itself needs.
//
// This is deliberately ONE module that `server.ts` calls in ONE line, because `server.ts` is being
// edited by Issue #2 in parallel and a wide edit there is a merge conflict for both of us.
//
// ─── CRITERION 6, WHICH IS THE HARD ONE ──────────────────────────────────────────────────────────
//
// "A revoked or unpaired device attempting to attach receives no session output, no agent names,
// and no machine names — the failure leaks nothing about what is running."
//
// Leaking nothing means the denial is not distinguishable from the ordinary answer a PAIRED device
// gets when it asks for something that does not exist. So the denial is not a 401, and not a 403,
// and carries no `WWW-Authenticate`, no `X-Reason`, and no explanatory body. It is byte-for-byte
// the 404 that `server.ts` already returns for an unknown path — same status, same headers, same
// body, same length. `test/pairing.http.test.ts` asserts that equality against the REAL server's
// bytes, so if `server.ts`'s 404 ever changes and this one does not, the test goes red.
//
// A 401 would be a perfectly good answer to "is there anything here". This one is not an answer.
//
// ─── HOW AN UNPAIRED BROWSER IS STILL SHOWN A PROMPT (criterion 1) ───────────────────────────────
//
// A request that a browser made for a DOCUMENT (`Accept: text/html`) gets the pairing page, at 200.
// That page contains no agent names, no machine name, no session count and no host name — it is a
// text field and a button. So criterion 1 (shown a prompt instead of agent data) and criterion 6
// (the failure leaks nothing) are both satisfied: the prompt reveals only that an oh-my-agents host
// is here, which anyone who completed a TCP handshake already knows.
//
// Everything that is not a document request — every API call, every asset, every upgrade — gets the
// opaque 404.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { authenticate, grants, readCookie, type AuthDecision } from '../pairing/auth.js';
import { DEVICE_COOKIE } from '../pairing/credential.js';
import { labelFromUserAgent, listDevices, pairDevice, revokeDevice } from '../pairing/devices.js';
import { OPERATOR_HEADER, operatorProofIsValid } from '../pairing/operator.js';
import { readStore } from '../pairing/store.js';
import type { PathEnv } from '../paths.js';

/** The one 404 body this host emits, for an unknown path and for a denial alike. */
export const OPAQUE_BODY = JSON.stringify({ ok: false, error: 'not found' });

export interface GuardOptions {
  webRoot: string;
  env?: PathEnv;
  /** Where the host says loudly that its store is unreadable. Injected by tests. */
  warn?: (message: string) => void;
}

/**
 * The denial. Nothing about the request reaches the response.
 *
 * Note there is no `Vary`, no `WWW-Authenticate` and no `Set-Cookie` here. A `Set-Cookie` clearing
 * the device cookie would be a kindness to a revoked browser and a signal to an attacker that the
 * credential they presented was once real, which is the whole of criterion 6.
 */
export function denyOpaquely(res: ServerResponse): void {
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(OPAQUE_BODY),
    'cache-control': 'no-store',
  });
  res.end(OPAQUE_BODY);
}

/** The same denial for a socket upgrade. Issue #2's attach socket MUST route through this. */
export function denyUpgradeOpaquely(socket: Duplex): void {
  socket.end(
    'HTTP/1.1 404 Not Found\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(OPAQUE_BODY)}\r\n` +
      'cache-control: no-store\r\n' +
      'connection: close\r\n\r\n' +
      OPAQUE_BODY,
  );
}

/**
 * THE AUTHORISATION CHECK FOR THE ATTACH UPGRADE (criterion 1, criterion 6).
 *
 * Issue #2 owns the attach WebSocket and it does not exist on this branch, so this is placed AT THE
 * UPGRADE PATH rather than inside a socket that is not here yet: whatever #2 lands, it lands behind
 * this. `server.ts`'s upgrade listener calls it before anything else. #2 must keep that ordering —
 * an upgrade handler that authenticates after accepting has already told the caller a socket exists.
 */
export function authoriseUpgrade(req: IncomingMessage, env: PathEnv = process.env): AuthDecision {
  return authenticate(readCookie(req.headers.cookie, DEVICE_COOKIE), env);
}

export type GuardResult = 'continue' | 'handled';

/**
 * The guard. Returns `continue` only for a request from a live paired device.
 *
 * Called from `server.ts` before any route is matched, so a route added later — by Issue #2, #3 or
 * anyone — is behind this by construction rather than by the author remembering.
 */
export async function guardRequest(req: IncomingMessage, res: ServerResponse, opts: GuardOptions): Promise<GuardResult> {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  const url = new URL(req.url ?? '/', 'http://host.invalid');
  const route = url.pathname;

  // Decided FIRST, for every request including the unauthenticated ones below, so that the cost of
  // reaching this host does not depend on which route was asked for.
  const decision = authenticate(readCookie(req.headers.cookie, DEVICE_COOKIE), env);

  if (decision.kind === 'undetermined') {
    // LOUD, AND STILL DENIED. This is the case the whole three-valued discipline exists for: a
    // store we cannot read is not a store with no devices in it. Nothing below this line can grant.
    warn(
      `PAIRING STORE UNREADABLE — DENYING EVERY REQUEST.\n` +
        `  ${decision.reason}\n` +
        `  This host cannot tell which devices are paired, so it is granting nothing. This is NOT\n` +
        `  the same as "no devices are paired": that state serves a pairing prompt, and this one\n` +
        `  serves nothing at all, on purpose. Fix or remove the file and restart.`,
    );
    denyOpaquely(res);
    return 'handled';
  }

  // Liveness. Says only that a socket reached a process, which the socket already said.
  if (route === '/healthz') return 'continue';

  // THE OPERATOR. A caller that proves it can read this host's pairing store is this host's
  // operator — `oh-my-agents status` is the one that does — and proving that requires exactly the
  // filesystem access that would let it add a device anyway. Checked ONLY when the header is
  // present, so a request without one does not pay for it and the denial stays indistinguishable
  // in cost from an ordinary 404. See src/pairing/operator.ts for why this is not a new authority.
  const presentedProof = header(req, OPERATOR_HEADER);
  // (An unreadable store already returned above, so there is no path from here that grants on one.)
  if (presentedProof !== undefined) {
    const read = readStore(env);
    if (read.kind === 'present' && operatorProofIsValid(read.store.meshSecret, presentedProof)) return 'continue';
  }

  // The pairing endpoints are reachable unauthenticated because they are how a device stops being
  // unauthenticated. They are the ONLY such routes and they are matched exactly, not by prefix.
  if (route === '/api/pair' && req.method === 'POST') {
    await handlePairPost(req, res, env);
    return 'handled';
  }
  if ((route === '/pair' || route === '/pair.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    await sendPage(res, path.join(opts.webRoot, 'pair.html'));
    return 'handled';
  }

  if (grants(decision)) {
    // Paired. The device-management routes need the identity, so they are served here rather than
    // in server.ts — that keeps server.ts's edit to one line for Issue #2's sake.
    if (route === '/api/devices' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleDeviceList(res, decision.device.id, env);
      return 'handled';
    }
    if (route === '/api/devices/revoke' && req.method === 'POST') {
      await handleRevokePost(req, res, env);
      return 'handled';
    }
    if ((route === '/devices' || route === '/devices.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      await sendPage(res, path.join(opts.webRoot, 'devices.html'));
      return 'handled';
    }
    return 'continue';
  }

  // Unpaired or revoked. A browser asking for a page gets the prompt (criteria 1 and 5); anything
  // else gets the opaque 404 (criterion 6). `revoked` and `unpaired` take the same path here — the
  // host knows the difference, the caller is not told it.
  if (wantsDocument(req)) {
    await sendPage(res, path.join(opts.webRoot, 'pair.html'));
    return 'handled';
  }
  denyOpaquely(res);
  return 'handled';
}

/** A top-level browser navigation, as opposed to a fetch, an asset load or a script. */
function wantsDocument(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const dest = header(req, 'sec-fetch-dest');
  // Modern browsers say so outright. When they do, believe them rather than guessing from Accept:
  // `fetch()` from the already-served page sends `Accept: */*` but `sec-fetch-dest: empty`, and it
  // must get the 404 so the page can notice and redirect itself to the prompt.
  if (dest !== undefined) return dest === 'document';
  return (header(req, 'accept') ?? '').includes('text/html');
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
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

async function sendPage(res: ServerResponse, file: string): Promise<void> {
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    denyOpaquely(res);
  }
}

/** 4 KiB is far more than a pairing code needs, and is a bound on an unauthenticated caller. */
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

/**
 * Cross-origin write protection.
 *
 * The device cookie is `SameSite=Strict`, which is the actual defence — a cross-site POST does not
 * carry it, so it cannot act as the user. This is the second layer, for the browsers and the
 * embedding contexts where `Sec-Fetch-Site` exists and `SameSite` handling has historically varied.
 * Absent headers are permitted: `curl` sends none, and refusing the CLI's own smoke test to defend
 * against a browser attack would be defending the wrong thing.
 */
function sameSiteWrite(req: IncomingMessage): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

async function handlePairPost(req: IncomingMessage, res: ServerResponse, env: PathEnv): Promise<void> {
  if (!sameSiteWrite(req)) {
    denyOpaquely(res);
    return;
  }
  const body = await readJsonBody(req);
  const presented = typeof body?.code === 'string' ? body.code : '';

  const outcome = pairDevice(presented, labelFromUserAgent(header(req, 'user-agent')), env);
  if (outcome.kind === 'undetermined') {
    // Said plainly, because this endpoint is the one place a person is actively trying to make the
    // host work and silence would send them looking in the wrong place. It reveals only that the
    // store is broken, which is not a fact about what is running.
    json(res, 503, { ok: false, error: 'the pairing store could not be read or written on this host' });
    return;
  }
  if (outcome.kind === 'refused') {
    // ONE response for mistyped, already-used and expired (criterion 3). The caller cannot learn
    // which, so a guess that happens to hit a spent code is worth nothing more than a wrong guess.
    json(res, 403, { ok: false, error: 'that code did not pair this device' });
    return;
  }

  const cookie = [
    `${DEVICE_COOKIE}=${outcome.credential.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    // TEN YEARS, AND NOT A POLICY. Criterion 2 says "without entering anything again on later
    // visits", which a session cookie does not survive. Whether a paired device's credential ever
    // expires ON ITS OWN is the OPEN DECISION on Issue #5, so nothing here expires it: the host
    // never checks an age, and this Max-Age exists only to stop the browser discarding the cookie
    // when it closes. If the decision lands on "credentials expire", it is enforced server-side in
    // `authenticate()`, not by shortening this number.
    `Max-Age=${10 * 365 * 24 * 60 * 60}`,
  ].join('; ');
  const payload = JSON.stringify({ ok: true, device: { id: outcome.device.id, label: outcome.device.label } });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'set-cookie': cookie,
  });
  res.end(payload);
}

function handleDeviceList(res: ServerResponse, thisDeviceId: string, env: PathEnv): void {
  const listed = listDevices(env);
  if (listed.kind === 'undetermined') {
    json(res, 503, { ok: false, error: 'the pairing store could not be read on this host' });
    return;
  }
  const devices = listed.kind === 'present' ? listed.devices : [];
  json(res, 200, {
    ok: true,
    devices: devices.map((d) => ({
      id: d.id,
      short: d.id.slice(0, 8),
      label: d.label,
      pairedAt: d.pairedAt,
      revokedAt: d.revokedAt ?? null,
      // So a person revoking from a phone can see which row is the phone they are holding.
      isThisDevice: d.id === thisDeviceId,
    })),
  });
}

async function handleRevokePost(req: IncomingMessage, res: ServerResponse, env: PathEnv): Promise<void> {
  if (!sameSiteWrite(req)) {
    denyOpaquely(res);
    return;
  }
  const body = await readJsonBody(req);
  const id = typeof body?.id === 'string' ? body.id : '';
  const outcome = revokeDevice(id, env);
  switch (outcome.kind) {
    case 'revoked':
      json(res, 200, { ok: true, revoked: outcome.device.id });
      return;
    case 'already-revoked':
      json(res, 200, { ok: true, revoked: outcome.device.id });
      return;
    case 'no-such-device':
      json(res, 404, { ok: false, error: 'no such device' });
      return;
    case 'ambiguous':
      json(res, 409, { ok: false, error: 'that identifier matches more than one device' });
      return;
    case 'undetermined':
      json(res, 503, { ok: false, error: 'the pairing store could not be read or written on this host' });
      return;
  }
}
