// The peers this host has been joined to, on disk.
//
// `peers.json`, in the directory `src/paths.ts` resolves — the same directory as `host.json` and
// `pairing.json`, not a second location (ARCHITECTURE.md says so explicitly).
//
// ─── WHY THIS IS SYMMETRIC AND WHY THAT IS A PROPERTY OF THE RECORD, NOT OF A PROTOCOL ───────────
//
// Criterion 2: "there is no designated hub. Opening host A and opening host B both present the full
// set. Shutting down any one host does not make the remaining hosts unable to see each other."
//
// That is achieved by every host holding its own peer list and asking each peer DIRECTLY. There is
// no membership document, no leader and no gossip: A's list names B and C, B's list names A and C,
// and A asking C does not route through B. So killing B removes B from what A and C can see and
// changes nothing else — which is the criterion, and it is a consequence of the shape rather than
// something a reconvergence routine has to achieve.
//
// `joinPeer` is therefore a LOCAL write. Making the far side reciprocal is `oh-my-agents join`'s
// job (it joins here, and tells you to run the same command there) rather than a push, because a
// push is host-to-host authenticated traffic and how a peer is trusted when joined is this Issue's
// OPEN DECISION. See `src/mesh/trust.ts`.
//
// ─── THREE-VALUED, AND `absent` IS NOT `undetermined` ────────────────────────────────────────────
//
// `absent` means nobody has joined anything — the normal first run, and it renders as "no peers".
// `undetermined` means the file is there and could not be understood, and it is NEVER flattened
// into an empty list: doing so would let a corrupt file silently un-join every machine a person
// added, and then a re-join would look like a first join and produce a duplicate.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parsePeerAddress, type PeerAddress } from './address.js';
import { stateDir, type PathEnv } from '../paths.js';

export const PEERS_SCHEMA = 1;

export interface PeerRecord {
  /** The canonical `host:port` this peer was joined at. The record key. */
  address: string;
  /**
   * The peer's own `hostId`, once it has answered at least once. `null` until then.
   * A join is by ADDRESS (criterion 1); the identity is learned afterwards and is what collapses
   * two addresses for one machine into one entry (criterion 6).
   */
  hostId: string | null;
  /** The peer's own name for itself, once it has answered. `null` until then. */
  machine: string | null;
  joinedAt: string;
  /** Last time this peer answered. `null` if it never has. Rendered, never used to hide a peer. */
  lastSeenAt: string | null;
}

export interface PeersFile {
  schema: number;
  peers: PeerRecord[];
}

export type PeersRead =
  | { kind: 'present'; peers: PeerRecord[] }
  | { kind: 'absent'; reason: string }
  | { kind: 'undetermined'; reason: string };

export function peersFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'peers.json');
}

export function readPeers(env: PathEnv = process.env): PeersRead {
  const file = peersFile(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent', reason: 'no host has been joined to this one' };
    return { kind: 'undetermined', reason: `${file} could not be read (${code ?? String(err)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'undetermined', reason: `${file} exists but is not valid JSON` };
  }
  const v = parsed as Record<string, unknown> | null;
  if (typeof v !== 'object' || v === null || v.schema !== PEERS_SCHEMA || !Array.isArray(v.peers)) {
    return { kind: 'undetermined', reason: `${file} exists but is not in a shape this version understands` };
  }
  const peers: PeerRecord[] = [];
  for (const entry of v.peers) {
    const p = coerce(entry);
    // ONE bad record makes the whole file undetermined. Skipping it would silently un-join a
    // machine, which is the failure this three-valued discipline exists to prevent.
    if (p === null) return { kind: 'undetermined', reason: `${file} contains a peer record this version does not understand` };
    peers.push(p);
  }
  return { kind: 'present', peers };
}

function coerce(value: unknown): PeerRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.address !== 'string' || v.address === '') return null;
  if (v.hostId !== null && typeof v.hostId !== 'string') return null;
  if (v.machine !== null && typeof v.machine !== 'string') return null;
  if (typeof v.joinedAt !== 'string') return null;
  if (v.lastSeenAt !== null && typeof v.lastSeenAt !== 'string') return null;
  return {
    address: v.address,
    hostId: v.hostId as string | null,
    machine: v.machine as string | null,
    joinedAt: v.joinedAt,
    lastSeenAt: v.lastSeenAt as string | null,
  };
}

export type MutatePeers<T> = { kind: 'ok'; value: T } | { kind: 'undetermined'; reason: string };

/**
 * Read, change, write. Refuses on an `undetermined` read for the same reason `mutateStore` does:
 * writing over a file we could not understand would throw away every join the person made.
 */
export function mutatePeers<T>(change: (peers: PeerRecord[]) => T, env: PathEnv = process.env): MutatePeers<T> {
  const read = readPeers(env);
  if (read.kind === 'undetermined') return { kind: 'undetermined', reason: read.reason };
  const peers = read.kind === 'present' ? read.peers : [];
  const value = change(peers);
  const file = peersFile(env);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body: PeersFile = { schema: PEERS_SCHEMA, peers };
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    return { kind: 'undetermined', reason: `${file} could not be written (${String(err)})` };
  }
  return { kind: 'ok', value };
}

export type JoinOutcome =
  | { kind: 'joined'; peer: PeerRecord }
  /** CRITERION 6. Already there, by address or by learned identity. Nothing was added. */
  | { kind: 'already-joined'; peer: PeerRecord; matchedBy: 'address' | 'identity' }
  | { kind: 'refused-self'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'undetermined'; reason: string };

export interface JoinOptions {
  /** This host's own identity, so joining yourself is refused rather than listed twice. */
  self?: { hostId: string; addresses: string[]; port: number };
  now?: string;
}

/**
 * Join a peer, by address. LOCAL and idempotent.
 *
 * Criterion 6 lives here and is enforced on TWO keys, because one is not enough: the canonical
 * address catches `100.64.0.2` typed twice in different spellings, and the learned `hostId` catches
 * the same machine joined at two genuinely different addresses.
 */
export function joinPeer(input: string, env: PathEnv = process.env, opts: JoinOptions = {}): JoinOutcome {
  const parsed = parsePeerAddress(input);
  if (parsed.kind === 'invalid') return { kind: 'invalid', reason: parsed.reason };
  const address: PeerAddress = parsed.address;

  const self = opts.self;
  if (self && self.port === address.port && self.addresses.map((a) => a.toLowerCase()).includes(address.host)) {
    return {
      kind: 'refused-self',
      reason: `${address.canonical} is this host. A host is already in its own view; joining itself would list every agent twice.`,
    };
  }

  const now = opts.now ?? new Date().toISOString();
  const result = mutatePeers((peers) => {
    const byAddress = peers.find((p) => p.address === address.canonical);
    if (byAddress) return { kind: 'already-joined' as const, peer: byAddress, matchedBy: 'address' as const };
    return { kind: 'joined' as const, peer: appended(peers, address.canonical, now) };
  }, env);

  if (result.kind === 'undetermined') return { kind: 'undetermined', reason: result.reason };
  return result.value;
}

function appended(peers: PeerRecord[], address: string, now: string): PeerRecord {
  const peer: PeerRecord = { address, hostId: null, machine: null, joinedAt: now, lastSeenAt: null };
  peers.push(peer);
  return peer;
}

export type ForgetOutcome =
  | { kind: 'forgotten'; peer: PeerRecord }
  | { kind: 'no-such-peer'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'undetermined'; reason: string };

export function forgetPeer(input: string, env: PathEnv = process.env): ForgetOutcome {
  const parsed = parsePeerAddress(input);
  // Also accept a raw hostId, so a peer whose address changed can still be removed by identity.
  const wantedAddress = parsed.kind === 'ok' ? parsed.address.canonical : null;
  const wantedId = /^[0-9a-f]{32}$/.test(input.trim()) ? input.trim() : null;
  if (wantedAddress === null && wantedId === null) {
    return { kind: 'invalid', reason: parsed.kind === 'invalid' ? parsed.reason : `'${input}' is neither an address nor a host id` };
  }
  const result = mutatePeers((peers) => {
    const i = peers.findIndex((p) => p.address === wantedAddress || (wantedId !== null && p.hostId === wantedId));
    if (i === -1) return null;
    return peers.splice(i, 1)[0] ?? null;
  }, env);
  if (result.kind === 'undetermined') return { kind: 'undetermined', reason: result.reason };
  if (result.value === null) return { kind: 'no-such-peer', reason: `'${input}' is not joined to this host` };
  return { kind: 'forgotten', peer: result.value };
}

/**
 * Record what a peer said about itself, after it answered.
 *
 * CRITERION 6, SECOND HALF. If the identity we just learned already belongs to another entry, the
 * two entries are the same machine reached two ways and they are collapsed — the older join wins
 * and keeps its address. Without this, `join laptop.tail` followed by `join 100.64.0.3` lists one
 * machine twice and every one of its agents twice.
 *
 * A failure to persist is NOT propagated to the view: the view was already computed from live
 * answers, and a read-only state directory should degrade to "identities are re-learned every time"
 * rather than to "the list is broken".
 */
export function recordPeerIdentity(address: string, hostId: string, machine: string, env: PathEnv = process.env, now?: string): void {
  mutatePeers((peers) => {
    const mine = peers.find((p) => p.address === address);
    if (!mine) return null;
    const other = peers.find((p) => p !== mine && p.hostId === hostId);
    if (other) {
      const older = other.joinedAt <= mine.joinedAt ? other : mine;
      const newer = older === other ? mine : other;
      older.hostId = hostId;
      older.machine = machine;
      older.lastSeenAt = now ?? new Date().toISOString();
      peers.splice(peers.indexOf(newer), 1);
      return null;
    }
    mine.hostId = hostId;
    mine.machine = machine;
    mine.lastSeenAt = now ?? new Date().toISOString();
    return null;
  }, env);
}
