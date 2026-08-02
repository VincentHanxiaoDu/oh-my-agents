// The status command's engine (criterion 5).
//
// The criterion is a statement about EXIT CODES: running exits 0, not running exits non-zero and
// reports nothing mistakable for a running host, and the two are distinguishable by exit code
// alone. There is a third answer — we could not tell — and it gets a third code. A status command
// that reports "not running" when its own state directory is unreadable will, sooner or later,
// convince someone to start a second host beside a first one that is serving perfectly well.
//
// Three questions are asked in order, and each can only narrow:
//   1. Is there a record?            no  -> not running.        unreadable -> undetermined.
//   2. Is the recorded pid alive?    no  -> not running (stale). yes       -> keep going.
//   3. Does it answer on loopback?   no  -> undetermined (a live pid that will not answer is not
//                                          a host we can vouch for, and it is not an absence).

import http from 'node:http';
import { isProcessAlive } from './lock.js';
import { readHostRecord, type HostRecord } from './state.js';
import type { PathEnv } from '../paths.js';

export interface LiveStatus {
  sessionCount: number;
  reachability: string;
  addresses: string[];
}

export type StatusReport =
  | { kind: 'running'; record: HostRecord; live: LiveStatus }
  | { kind: 'not-running'; reason: string }
  | { kind: 'undetermined'; reason: string };

export interface QueryOptions {
  env?: PathEnv;
  timeoutMs?: number;
}

export async function queryHost(opts: QueryOptions = {}): Promise<StatusReport> {
  const env = opts.env ?? process.env;
  const read = await readHostRecord(env);

  if (read.kind === 'absent') return { kind: 'not-running', reason: read.reason };
  if (read.kind === 'undetermined') return { kind: 'undetermined', reason: read.reason };

  const record = read.record;
  if (!isProcessAlive(record.pid)) {
    return {
      kind: 'not-running',
      reason: `a host record names pid ${record.pid}, and that process is gone — the record is stale`,
    };
  }

  const probed = await probe(record, opts.timeoutMs ?? 3000);
  if (probed.kind === 'error') {
    return {
      kind: 'undetermined',
      reason: `pid ${record.pid} is alive but did not answer on ${record.port}: ${probed.reason}. This host will not claim it is running and will not claim it is not.`,
    };
  }

  return { kind: 'running', record, live: probed.live };
}

type ProbeOutcome = { kind: 'ok'; live: LiveStatus } | { kind: 'error'; reason: string };

function probe(record: HostRecord, timeoutMs: number): Promise<ProbeOutcome> {
  // Always over loopback: a status command asking about THIS machine's host must not depend on the
  // tailnet being up, or `status` would go undetermined every time Tailscale hiccuped.
  const host = record.addresses.find((a) => a === '127.0.0.1') ?? '127.0.0.1';
  return new Promise((resolve) => {
    const req = http.request(
      { host, port: record.port, path: '/api/status', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ kind: 'error', reason: `it answered HTTP ${res.statusCode}` });
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            const count = typeof body.sessionCount === 'number' ? body.sessionCount : NaN;
            if (!Number.isInteger(count)) {
              resolve({ kind: 'error', reason: 'it answered without a session count' });
              return;
            }
            resolve({
              kind: 'ok',
              live: {
                sessionCount: count,
                reachability: typeof body.reachability === 'string' ? body.reachability : record.reachability,
                addresses: Array.isArray(body.addresses) ? (body.addresses as string[]) : record.addresses,
              },
            });
          } catch {
            resolve({ kind: 'error', reason: 'it answered with something that is not JSON' });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ kind: 'error', reason: `no answer within ${timeoutMs}ms` });
    });
    req.on('error', (err) => {
      resolve({ kind: 'error', reason: (err as NodeJS.ErrnoException).code ?? err.message });
    });
    req.end();
  });
}
