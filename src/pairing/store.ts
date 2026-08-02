// The pairing store: which devices are allowed, and which one-time codes are outstanding.
//
// THIS FILE IS THE ONE THAT MUST NOT FAIL OPEN. Every other part of pairing is arithmetic on what
// this returns, so a read that quietly answers "no devices" when it means "I could not read the
// file" hands the whole product away. The read is therefore THREE-VALUED, exactly as `tailnet.ts`,
// `state.ts` and `status.ts` are (see ARCHITECTURE.md):
//
//   present      — we read the store and here it is
//   absent       — we looked, and there is no store yet (nobody has ever paired)
//   undetermined — we looked and COULD NOT TELL: unreadable, corrupt, wrong schema, a directory
//
// `absent` grants nothing, and neither does `undetermined` — but they are different answers and
// they are rendered differently in the host's log, because "nobody has paired yet" is a normal
// first run and "your pairing store is corrupt" is an incident.
//
// It lives in the directory `src/paths.ts` resolves, alongside host.json — not in a second location.

import { randomBytes, createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir, type PathEnv } from '../paths.js';

/** The current on-disk schema. A store written by a future version is `undetermined`, not empty. */
export const PAIRING_SCHEMA = 1;

export interface DeviceRecord {
  /** Opaque, random, 128 bits of hex. Also the public half of the device credential. */
  id: string;
  /** What a person reads in the list to tell one device from another (criterion 4). */
  label: string;
  /** ISO-8601. */
  pairedAt: string;
  /**
   * sha256 of the credential's MAC. The MAC itself is never written down: a store that contains
   * the credential is a store whose disclosure is the same event as the device's disclosure.
   */
  macHash: string;
  /** ISO-8601, present only once revoked. Records are kept so a revocation is auditable. */
  revokedAt?: string;
}

export interface CodeRecord {
  /** sha256 of the normalised code. The code itself is shown once, to a human, and never stored. */
  codeHash: string;
  createdAt: string;
  /** ISO-8601. Criterion 3: a code is TIME-LIMITED. This is that limit. */
  expiresAt: string;
  /** ISO-8601, present once the code has paired a device. Criterion 3: SINGLE-USE. */
  usedAt?: string;
  /** Which device this code produced. Kept so "who used my code" is answerable. */
  usedByDeviceId?: string;
}

export interface PairingStore {
  schema: number;
  /**
   * The mesh key. Device credentials are HMACed with it so a PEER host can verify a credential it
   * did not issue (criterion 8). HOW A PEER COMES TO HOLD IT IS ISSUE #3's OPEN DECISION and is
   * not decided here — see `src/pairing/mesh.ts`, which refuses.
   */
  meshSecret: string;
  devices: DeviceRecord[];
  codes: CodeRecord[];
}

export type StoreRead =
  | { kind: 'present'; store: PairingStore }
  | { kind: 'absent' }
  | { kind: 'undetermined'; reason: string };

export function pairingStoreFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'pairing.json');
}

function pairingLockFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'pairing.lock');
}

/**
 * Read the store. NEVER throws, and never turns a failure into an empty store — the empty store is
 * `absent`, which is a different answer from `undetermined` and reached by a different path.
 */
export function readStore(env: PathEnv = process.env): StoreRead {
  const file = pairingStoreFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the ONLY error that means "nobody has paired yet". EACCES, EISDIR, EIO and
    // everything else mean we could not tell, and are not allowed to look like an empty store.
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'undetermined', reason: `${file} could not be read (${code ?? String(err)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'undetermined', reason: `${file} is not valid JSON (${String(err)})` };
  }

  const store = validate(parsed);
  if (typeof store === 'string') return { kind: 'undetermined', reason: `${file} is not a pairing store: ${store}` };
  return { kind: 'present', store };
}

function validate(value: unknown): PairingStore | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'the top level is not an object';
  const v = value as Record<string, unknown>;
  if (v.schema !== PAIRING_SCHEMA) return `schema is ${JSON.stringify(v.schema)}, this build understands ${PAIRING_SCHEMA}`;
  if (typeof v.meshSecret !== 'string' || !/^[0-9a-f]{64}$/.test(v.meshSecret)) return 'meshSecret is missing or malformed';
  if (!Array.isArray(v.devices)) return 'devices is not an array';
  if (!Array.isArray(v.codes)) return 'codes is not an array';

  const devices: DeviceRecord[] = [];
  for (const d of v.devices) {
    if (typeof d !== 'object' || d === null) return 'a device record is not an object';
    const r = d as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.label !== 'string' || typeof r.pairedAt !== 'string' || typeof r.macHash !== 'string') {
      return 'a device record is missing a required field';
    }
    const rec: DeviceRecord = { id: r.id, label: r.label, pairedAt: r.pairedAt, macHash: r.macHash };
    if (typeof r.revokedAt === 'string') rec.revokedAt = r.revokedAt;
    devices.push(rec);
  }

  const codes: CodeRecord[] = [];
  for (const c of v.codes) {
    if (typeof c !== 'object' || c === null) return 'a code record is not an object';
    const r = c as Record<string, unknown>;
    if (typeof r.codeHash !== 'string' || typeof r.createdAt !== 'string' || typeof r.expiresAt !== 'string') {
      return 'a code record is missing a required field';
    }
    const rec: CodeRecord = { codeHash: r.codeHash, createdAt: r.createdAt, expiresAt: r.expiresAt };
    if (typeof r.usedAt === 'string') rec.usedAt = r.usedAt;
    if (typeof r.usedByDeviceId === 'string') rec.usedByDeviceId = r.usedByDeviceId;
    codes.push(rec);
  }

  return { schema: PAIRING_SCHEMA, meshSecret: v.meshSecret, devices, codes };
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function emptyStore(): PairingStore {
  return { schema: PAIRING_SCHEMA, meshSecret: randomBytes(32).toString('hex'), devices: [], codes: [] };
}

/**
 * Read-modify-write under an exclusive lock file.
 *
 * THE LOCK IS WHY A PAIRING CODE IS SINGLE-USE AND NOT MERELY USUALLY-SINGLE-USE. Marking a code
 * used and writing the device it produced is one transaction; the CLI (`pair`, `revoke`) and the
 * host process both perform it, so two of them racing without this could each observe the code as
 * unused. `openSync(..., 'wx')` is atomic on every filesystem this runs on, which a
 * `existsSync`-then-create is not.
 *
 * On a mutation the result is written to a temporary file and renamed over the real one, so a
 * store is never observed half-written — a half-written store reads as `undetermined`, which
 * denies, which would lock the owner out of their own host until they deleted a file.
 */
/**
 * Create the store if it is not there, so this host owns a mesh key from the moment it starts.
 *
 * Called by the daemon at startup. Without it, a host that nobody has paired with yet has no mesh
 * key, and `oh-my-agents status` — which authenticates as the operator using that key — could not
 * probe it. Creating an EMPTY store grants nothing: it has no devices in it.
 */
export function ensureStore(env: PathEnv = process.env): MutateResult<null> {
  return mutateStore<null>((store) => ({ store, value: null }), env);
}

export type MutateResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'undetermined'; reason: string };

export function mutateStore<T>(
  fn: (store: PairingStore) => { store: PairingStore; value: T } | { refuse: string },
  env: PathEnv = process.env,
): MutateResult<T> {
  const dir = stateDir(env);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { kind: 'undetermined', reason: `${dir} could not be created (${String(err)})` };
  }

  const lock = pairingLockFile(env);
  const held = acquireStoreLock(lock);
  if (held !== 'acquired') return { kind: 'undetermined', reason: held.reason };

  try {
    const read = readStore(env);
    // A store we cannot READ is a store we must not OVERWRITE: overwriting it with a fresh empty
    // one would silently revoke every device the user has, which is the loudest possible failure
    // to have happen quietly. Refuse, and let a human look at the file.
    if (read.kind === 'undetermined') return { kind: 'undetermined', reason: read.reason };
    const current = read.kind === 'present' ? read.store : emptyStore();

    const outcome = fn(current);
    if ('refuse' in outcome) return { kind: 'undetermined', reason: outcome.refuse };

    const tmp = pairingStoreFile(env) + `.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(outcome.store, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, pairingStoreFile(env));
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing else to do */
      }
      return { kind: 'undetermined', reason: `the pairing store could not be written (${String(err)})` };
    }
    return { kind: 'ok', value: outcome.value };
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* the lock is advisory; a leftover is cleared by the staleness check below */
    }
  }
}

function acquireStoreLock(lock: string): 'acquired' | { reason: string } {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      return 'acquired';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return { reason: `the pairing lock ${lock} could not be taken (${code ?? String(err)})` };
      if (Date.now() > deadline) {
        // A lock older than the whole wait is one whose holder died mid-write. Breaking it is safe
        // because the write itself is a rename, so there is no half-written store to step on.
        try {
          unlinkSync(lock);
          continue;
        } catch {
          return { reason: `the pairing lock ${lock} is held and could not be broken` };
        }
      }
      // Busy-wait deliberately: this is contended for microseconds by two processes at most, and a
      // synchronous helper is what the CLI and the request path both need.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
