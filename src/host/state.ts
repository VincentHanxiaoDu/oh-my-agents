// The record a running host publishes about itself, and how it is read back.
//
// This is the only channel between the detached daemon and the status command, so its failure modes
// are the status command's failure modes. Three outcomes, and they are kept apart on purpose:
// there is no record (nothing is running), there is a record (something is), and the record could
// not be read or understood (we do not know, and must not say either of the other two).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hostStateFile, stateDir, type PathEnv } from '../paths.js';
import type { Reachability } from './bind.js';

export interface HostRecord {
  schema: 1;
  pid: number;
  port: number;
  /** Every address the host is listening on. */
  addresses: string[];
  /** The subset a person can reach from another device. Empty means local-only. */
  tailnetAddresses: string[];
  reachability: Reachability;
  determination: 'determined' | 'undetermined';
  reason: string;
  startedAt: string;
}

export type ReadRecordResult =
  | { kind: 'present'; record: HostRecord }
  | { kind: 'absent'; reason: string }
  | { kind: 'undetermined'; reason: string };

export async function writeHostRecord(record: HostRecord, env: PathEnv = process.env): Promise<void> {
  const dir = stateDir(env);
  await mkdir(dir, { recursive: true });
  // Written to a temp name and renamed, so a status command that reads at the wrong moment sees
  // either the whole record or no record — never half of one, which would read as `undetermined`
  // and tell a user we could not tell when in fact a host was starting normally.
  const target = hostStateFile(env);
  const tmp = path.join(dir, `host.json.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  await rename(tmp, target);
}

export async function readHostRecord(env: PathEnv = process.env): Promise<ReadRecordResult> {
  let text: string;
  try {
    text = await readFile(hostStateFile(env), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent', reason: 'no host record exists on this machine' };
    // Permission denied, an I/O error, a directory where a file should be: all of these mean we do
    // not know whether a host is running. Reporting "not running" here would be a guess.
    return { kind: 'undetermined', reason: `the host record could not be read (${code ?? String(err)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'undetermined', reason: 'the host record exists but is not valid JSON' };
  }

  const record = coerce(parsed);
  if (!record) return { kind: 'undetermined', reason: 'the host record exists but is not in a shape this version understands' };
  return { kind: 'present', record };
}

function coerce(value: unknown): HostRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) return null;
  if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return null;
  if (typeof v.port !== 'number' || !Number.isInteger(v.port)) return null;
  if (!Array.isArray(v.addresses) || !v.addresses.every((a) => typeof a === 'string')) return null;
  if (!Array.isArray(v.tailnetAddresses) || !v.tailnetAddresses.every((a) => typeof a === 'string')) return null;
  if (v.reachability !== 'tailnet' && v.reachability !== 'local-only') return null;
  if (v.determination !== 'determined' && v.determination !== 'undetermined') return null;
  if (typeof v.reason !== 'string') return null;
  if (typeof v.startedAt !== 'string') return null;
  return {
    schema: 1,
    pid: v.pid,
    port: v.port,
    addresses: v.addresses as string[],
    tailnetAddresses: v.tailnetAddresses as string[],
    reachability: v.reachability,
    determination: v.determination,
    reason: v.reason,
    startedAt: v.startedAt,
  };
}
