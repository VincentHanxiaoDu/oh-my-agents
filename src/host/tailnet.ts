// Detecting Tailscale, and resolving this machine's tailnet address.
//
// THE POINT OF THIS MODULE IS THAT IT HAS FOUR ANSWERS, NOT TWO.
//
//   up            the tailnet is up and this is the address
//   absent        Tailscale is not installed on this machine        — determined
//   down          Tailscale is installed and the tailnet is not up  — determined
//   undetermined  I could not tell                                  — NOT determined
//
// "Tailscale is not installed" and "I could not tell whether Tailscale is installed" are different
// facts about the world. Collapsing them means the startup banner says "local access only, install
// Tailscale" to a user whose Tailscale is running fine and whose CLI merely timed out — and the
// user acts on it. `absent` and `down` are both "determined to be nothing" and are both safe to
// state plainly; `undetermined` must always be rendered as a question, never as an answer.

import { execFile } from 'node:child_process';

export type TailnetStatus =
  | { kind: 'up'; address: string; addresses: string[]; hostname: string | null; via: string }
  | { kind: 'absent'; reason: string }
  | { kind: 'down'; reason: string }
  | { kind: 'undetermined'; reason: string };

/** True when we know the answer, whatever the answer is. False only for `undetermined`. */
export function isDetermined(status: TailnetStatus): boolean {
  return status.kind !== 'undetermined';
}

export interface ProbeResult {
  /** 'ok' with stdout, 'missing' when the binary is not there, 'failed' with whatever we learned. */
  outcome: 'ok' | 'missing' | 'failed';
  stdout: string;
  stderr: string;
  code: number | null;
  command: string;
}

export type Prober = () => Promise<ProbeResult>;

// Candidate ways to reach the CLI. `tailscale` on PATH covers Linux and Homebrew; the app bundle
// path covers a macOS install from the App Store, where nothing is on PATH by default. A machine
// where NONE of these exist is `absent`; a machine where one exists and misbehaves is not.
const CANDIDATES: readonly string[] = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

function probeOne(bin: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ outcome: 'missing', stdout: '', stderr: String(stderr ?? ''), code: null, command: bin });
          return;
        }
        resolve({
          outcome: 'failed',
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || String(code ?? err.message),
          code: typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null,
          command: bin,
        });
        return;
      }
      resolve({ outcome: 'ok', stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0, command: bin });
    });
  });
}

/** The default prober: try each candidate path, and report the first that is actually there. */
export function defaultProber(timeoutMs = 4000): Prober {
  return async () => {
    let last: ProbeResult = { outcome: 'missing', stdout: '', stderr: '', code: null, command: CANDIDATES[0]! };
    for (const bin of CANDIDATES) {
      const r = await probeOne(bin, timeoutMs);
      if (r.outcome !== 'missing') return r;
      last = r;
    }
    return last;
  };
}

// Wording the CLI uses when it is telling us, definitively, that the tailnet is not up. Anything
// it says that is NOT on this list is something we do not understand, and not understanding is
// `undetermined` — never `down`.
const DEFINITELY_DOWN = [
  'logged out',
  'needslogin',
  'needs login',
  'tailscale is stopped',
  'stopped',
  'not running',
  'failed to connect to local tailscaled',
  'is tailscaled running',
];

function saysDown(text: string): boolean {
  const t = text.toLowerCase();
  return DEFINITELY_DOWN.some((phrase) => t.includes(phrase));
}

interface TailscaleStatusJson {
  BackendState?: unknown;
  Self?: { TailscaleIPs?: unknown; DNSName?: unknown; HostName?: unknown } | undefined;
}

export async function detectTailnet(prober: Prober = defaultProber()): Promise<TailnetStatus> {
  let probe: ProbeResult;
  try {
    probe = await prober();
  } catch (err) {
    return { kind: 'undetermined', reason: `probing for Tailscale threw: ${describe(err)}` };
  }

  if (probe.outcome === 'missing') {
    return { kind: 'absent', reason: 'no tailscale binary was found on this machine' };
  }

  if (probe.outcome === 'failed') {
    const said = `${probe.stderr}\n${probe.stdout}`;
    if (saysDown(said)) {
      return { kind: 'down', reason: firstLine(said) || 'the tailscale CLI reports the tailnet is not up' };
    }
    return {
      kind: 'undetermined',
      reason: `${probe.command} exited ${probe.code ?? 'abnormally'} and said something this host does not recognise: ${firstLine(said) || '(nothing)'}`,
    };
  }

  let parsed: TailscaleStatusJson;
  try {
    parsed = JSON.parse(probe.stdout) as TailscaleStatusJson;
  } catch {
    return { kind: 'undetermined', reason: `${probe.command} status --json did not return JSON this host can parse` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'undetermined', reason: `${probe.command} status --json returned something that is not an object` };
  }

  const backend = typeof parsed.BackendState === 'string' ? parsed.BackendState : '';
  const ips = Array.isArray(parsed.Self?.TailscaleIPs)
    ? (parsed.Self!.TailscaleIPs as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

  if (backend === 'Running') {
    if (ips.length === 0) {
      // Running with no address is a real state (it happens mid-handshake) and it is not a state we
      // can serve from. It is also not "Tailscale is absent". We know the tailnet is not usable.
      return { kind: 'down', reason: 'Tailscale is running but has not been assigned a tailnet address yet' };
    }
    const hostname = pickHostname(parsed);
    return { kind: 'up', address: ips[0]!, addresses: ips, hostname, via: probe.command };
  }

  if (backend === 'NeedsLogin' || backend === 'Stopped' || backend === 'NoState') {
    return { kind: 'down', reason: `Tailscale is installed and its backend state is ${backend}` };
  }

  if (backend === '') {
    return { kind: 'undetermined', reason: `${probe.command} status --json had no BackendState field` };
  }

  // A state string we have never seen. We are not going to guess which side of the line it is on.
  return { kind: 'undetermined', reason: `${probe.command} reports an unrecognised backend state '${backend}'` };
}

function pickHostname(parsed: TailscaleStatusJson): string | null {
  const dns = parsed.Self?.DNSName;
  if (typeof dns === 'string' && dns.length > 0) return dns.replace(/\.$/, '');
  const host = parsed.Self?.HostName;
  if (typeof host === 'string' && host.length > 0) return host;
  return null;
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
