// Who this machine is, in a way that survives a restart.
//
// A join is durable (Issue #3 criterion 1: "joined by address" and it stays joined), and a unified
// list has to LABEL each agent with the machine it is on (criterion 1) and keep two agents on
// different machines apart even when they share a name, a working directory and a runtime
// (criterion 5). Neither is possible from an address alone: an address can be reassigned, a peer
// can be reachable at two addresses, and `os.hostname()` is not unique across a tailnet with two
// laptops both called `mbp`.
//
// So a host mints ONE random identifier the first time it starts and keeps it in the state
// directory `src/paths.ts` resolves — the same directory, not a second one. `hostId` is the
// identity; `machine` is the human label and is allowed to collide.
//
// THREE-VALUED, like everything else here. A machine file that cannot be read is NOT a machine that
// has no identity: the difference decides whether a peer is the one you already joined or a new one,
// and answering "new one" on an unreadable file is how criterion 6 (re-joining does not duplicate)
// quietly breaks.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stateDir, type PathEnv } from '../paths.js';

export const MACHINE_SCHEMA = 1;

export interface MachineIdentity {
  /** 128 bits of randomness, hex. Stable across restarts. Not a secret — it is a name. */
  hostId: string;
  /** What a person calls this machine in a list. Allowed to collide with another machine's. */
  machine: string;
}

export type IdentityResult =
  | { kind: 'ok'; identity: MachineIdentity }
  | { kind: 'undetermined'; reason: string; fallback: MachineIdentity };

export function machineFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'machine.json');
}

/** Read this machine's identity, minting one the first time. Never throws. */
export function ensureMachineIdentity(env: PathEnv = process.env): IdentityResult {
  const file = machineFile(env);
  // A per-process identity, used ONLY when the file could not be read. It is returned alongside an
  // `undetermined`, never instead of one, so a caller cannot mistake it for a durable identity.
  const fallback: MachineIdentity = { hostId: randomBytes(16).toString('hex'), machine: os.hostname() };

  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return { kind: 'undetermined', reason: `${file} could not be read (${code ?? String(err)})`, fallback };
    }
  }

  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'undetermined', reason: `${file} exists but is not valid JSON`, fallback };
    }
    const v = parsed as Record<string, unknown> | null;
    if (typeof v !== 'object' || v === null || v.schema !== MACHINE_SCHEMA || typeof v.hostId !== 'string' || !/^[0-9a-f]{32}$/.test(v.hostId)) {
      return { kind: 'undetermined', reason: `${file} exists but is not in a shape this version understands`, fallback };
    }
    // The machine NAME is refreshed from the OS on every read: a laptop that gets renamed should
    // show its new name. The hostId is not, because that is the thing joins are recorded against.
    const identity: MachineIdentity = { hostId: v.hostId, machine: os.hostname() };
    if (typeof v.machine === 'string' && v.machine !== identity.machine) writeIdentity(file, identity);
    return { kind: 'ok', identity };
  }

  const minted: MachineIdentity = { hostId: randomBytes(16).toString('hex'), machine: os.hostname() };
  try {
    writeIdentity(file, minted);
  } catch (err) {
    return { kind: 'undetermined', reason: `${file} could not be written (${String(err)})`, fallback };
  }
  return { kind: 'ok', identity: minted };
}

function writeIdentity(file: string, identity: MachineIdentity): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: MACHINE_SCHEMA, ...identity }, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}
