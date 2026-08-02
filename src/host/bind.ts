// WHICH INTERFACES THIS HOST LISTENS ON. This file is Issue #1 criterion 3 and it is the security
// boundary of the whole product: everything the host will ever serve — transcripts, agent output,
// the ability to type into somebody's shell (#2) — is reachable by anything that can open a socket
// to an address this function returns.
//
// THE INVARIANT, which the tests assert against adversarial input rather than against the happy
// path: for ANY input whatsoever, every address returned is either loopback, or an address that
// passed all three of the checks below. `0.0.0.0` and `::` are never returned, and there is no
// input — no flag, no environment variable, no reachable code path — that produces one. A wildcard
// bind would put the host on the LAN and on any public interface the machine has, which is the one
// thing this Issue says must not happen.
//
// A candidate tailnet address is accepted only if ALL THREE hold:
//
//   1. Tailscale itself told us about it (it arrives as a TailnetStatus of kind 'up', which only
//      comes from a successfully parsed `tailscale status --json`).
//   2. It is inside Tailscale's own address space. This is a documented property of the protocol —
//      Tailscale assigns from 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48 — not a guess about
//      this machine. Without it, a compromised or confused CLI could hand us the machine's LAN
//      address and we would bind the LAN.
//   3. It is actually assigned to a local interface. Without it, a stale or wrong answer makes the
//      server fail to bind at all, or worse, binds something that is not what we told the user.
//
// Any candidate failing any check is REJECTED WITH ITS REASON and the host falls back to loopback.
// Falling back is safe; guessing is not.

import os from 'node:os';
import net from 'node:net';
import type { TailnetStatus } from './tailnet.js';

/** Tailscale's IPv4 range. A protocol fact, documented by Tailscale, not an observation of a host. */
export const TAILSCALE_IPV4_CIDR = '100.64.0.0/10';
/** Tailscale's ULA prefix. Same: a property of the product, not of this machine. */
export const TAILSCALE_IPV6_PREFIX = 'fd7a:115c:a1e0::';

export type Reachability = 'tailnet' | 'local-only';

export interface RejectedAddress {
  address: string;
  reason: string;
}

export interface BindPlan {
  /** Every address the server will listen on. Loopback first; never a wildcard. */
  addresses: string[];
  /** The loopback subset — always non-empty, because a host that serves nothing is not useful. */
  loopback: string[];
  /** The tailnet subset — empty exactly when reachability is 'local-only'. */
  tailnet: string[];
  /** What a person can actually do with this host right now. */
  reachability: Reachability;
  /**
   * Whether we KNOW the reachability, or merely could not find a tailnet.
   * 'undetermined' means: we do not know if Tailscale is here. It is never reported as absence.
   */
  determination: 'determined' | 'undetermined';
  /** Why the reachability is what it is, in words fit to print to a person. */
  reason: string;
  /** Candidates we refused, and why. Empty on the happy path and on the no-Tailscale path. */
  rejected: RejectedAddress[];
}

/** Every address currently assigned to a local interface, including loopback. */
export function localInterfaceAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) out.push(normalise(e.address));
  }
  return out;
}

// IPv6 addresses arrive in several spellings (zone ids, case, compression). Comparing raw strings
// would reject a perfectly good address because the CLI wrote `FD7A:...` and the kernel wrote
// `fd7a:...`, which is a security control failing open into "no tailnet, loopback only" — safe, but
// wrong, and wrong in a way that looks exactly like Tailscale being down.
function normalise(addr: string): string {
  return addr.trim().toLowerCase().split('%')[0]!;
}

export function isLoopbackAddress(addr: string): boolean {
  const a = normalise(addr);
  if (a === '::1') return true;
  if (net.isIPv4(a)) return a.startsWith('127.');
  return false;
}

/** Unspecified addresses are wildcards: binding one binds every interface the machine has. */
export function isWildcardAddress(addr: string): boolean {
  const a = normalise(addr);
  return a === '0.0.0.0' || a === '::' || a === '' || a === '*' || a === '::0' || a === '0:0:0:0:0:0:0:0';
}

/** Is this address inside the space Tailscale assigns from? */
export function isTailscaleAddress(addr: string): boolean {
  const a = normalise(addr);
  if (net.isIPv4(a)) {
    const parts = a.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    // 100.64.0.0/10 — first octet 100, second octet 64..127.
    return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
  }
  if (net.isIPv6(a)) return a.startsWith(TAILSCALE_IPV6_PREFIX.slice(0, TAILSCALE_IPV6_PREFIX.length - 2));
  return false;
}

export interface ResolveOptions {
  /** Injected so tests can drive the resolver without depending on the runner's interfaces. */
  localAddresses?: string[];
}

/**
 * Turn a tailnet detection result into the exact set of addresses to listen on.
 * Pure: no I/O, no globals beyond the optionally-injected interface list.
 */
export function resolveBind(status: TailnetStatus, opts: ResolveOptions = {}): BindPlan {
  const local = new Set((opts.localAddresses ?? localInterfaceAddresses()).map(normalise));

  // Loopback is unconditional: this host must serve locally whatever else is true, and 127.0.0.1
  // exists on every machine that has a network stack at all. ::1 is added only when present,
  // because binding it on a v4-only host fails and would take the whole start down with it.
  const loopback: string[] = ['127.0.0.1'];
  if (local.has('::1')) loopback.push('::1');

  const rejected: RejectedAddress[] = [];

  if (status.kind !== 'up') {
    const determination = status.kind === 'undetermined' ? 'undetermined' : 'determined';
    return {
      addresses: [...loopback],
      loopback,
      tailnet: [],
      reachability: 'local-only',
      determination,
      reason: status.reason,
      rejected,
    };
  }

  const tailnet: string[] = [];
  for (const raw of status.addresses) {
    const addr = normalise(raw);
    if (isWildcardAddress(addr)) {
      rejected.push({ address: raw, reason: 'it is a wildcard address; binding it would expose every interface on this machine' });
      continue;
    }
    if (net.isIP(addr) === 0) {
      rejected.push({ address: raw, reason: 'it is not an IP address' });
      continue;
    }
    if (isLoopbackAddress(addr)) {
      rejected.push({ address: raw, reason: 'it is loopback, which this host already binds; it is not a tailnet address' });
      continue;
    }
    if (!isTailscaleAddress(addr)) {
      rejected.push({
        address: raw,
        reason: `it is outside Tailscale's own address space (${TAILSCALE_IPV4_CIDR} / ${TAILSCALE_IPV6_PREFIX}/48), so binding it could put this host on a LAN or public interface`,
      });
      continue;
    }
    if (!local.has(addr)) {
      rejected.push({ address: raw, reason: 'it is not assigned to any interface on this machine' });
      continue;
    }
    if (!tailnet.includes(addr)) tailnet.push(addr);
  }

  if (tailnet.length === 0) {
    return {
      addresses: [...loopback],
      loopback,
      tailnet: [],
      reachability: 'local-only',
      determination: 'determined',
      reason:
        rejected.length > 0
          ? `Tailscale reported ${rejected.length} address(es) and this host refused all of them: ${rejected.map((r) => `${r.address} — ${r.reason}`).join('; ')}`
          : 'Tailscale is up but reported no address to serve on',
      rejected,
    };
  }

  return {
    addresses: [...loopback, ...tailnet],
    loopback,
    tailnet,
    reachability: 'tailnet',
    determination: 'determined',
    reason: `Tailscale is up; this machine's tailnet address is ${tailnet[0]}`,
    rejected,
  };
}

/**
 * The last line of defence, asserted at the moment of binding rather than only at planning time.
 * If this ever throws, something has produced a bind set the resolver cannot have produced — and
 * refusing to start is strictly better than listening on an address nobody chose.
 */
export function assertSafeBindSet(addresses: readonly string[]): void {
  if (addresses.length === 0) throw new Error('refusing to start: the bind set is empty');
  for (const addr of addresses) {
    if (isWildcardAddress(addr)) {
      throw new Error(`refusing to start: '${addr}' is a wildcard address and would expose every interface on this machine`);
    }
    if (!isLoopbackAddress(addr) && !isTailscaleAddress(addr)) {
      throw new Error(`refusing to start: '${addr}' is neither loopback nor a Tailscale address`);
    }
  }
}
