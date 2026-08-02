// The unified list, and the four answers a peer can give.
//
// ─── CRITERION 4 IS THE SHAPE OF THIS FILE ───────────────────────────────────────────────────────
//
// "A peer that becomes unreachable is shown as unreachable, with its machine still named. Its
// agents are never shown as if they were running-and-fine, and they are never silently dropped from
// the list — an unreachable peer and a peer with zero agents are distinguishable in the list."
//
// So `PeerAgents` has FOUR values and none of them is `SessionSummary[]`:
//
//   listed        we reached it, it served us, and this is its list. `agents: []` means ZERO AGENTS,
//                 which is a determined fact and is a different thing from every value below.
//   unreachable   we could not reach it. Its machine is still named from the join record.
//   not-trusted   we reached it and it did not recognise us. This is the OPEN DECISION arriving as
//                 a value (see trust.ts) and it is not `unreachable` and not zero agents.
//   undetermined  it answered something this version cannot understand.
//
// There is no code path that turns any of the last three into an empty array. That is deliberate
// and it is the criterion: a `?? []` anywhere below would make an unreachable machine render
// identically to an idle one, which is exactly the failure the criterion names.
//
// ─── CRITERION 5 IS THE `key` FIELD ──────────────────────────────────────────────────────────────
//
// "Two agents on different machines that share a name, working directory, or runtime remain
// distinguishable in the unified list." Session ids are assigned per host and Issue #2 has not said
// they are globally unique — assuming they are is how two machines' agents merge into one row. So
// the unified list is keyed on `hostId` + the host's own session id, and every agent carries the
// machine it is on. Two identical agents on two machines are two rows with two keys.

import type { SessionSummary } from '../sessions/registry.js';

export type PeerAgents =
  /** Determined. `agents` may be empty, and an empty list means the machine has no agents. */
  | { kind: 'listed'; agents: SessionSummary[] }
  /** Determined to be out of contact. NOT an empty list. */
  | { kind: 'unreachable'; reason: string }
  /** Reached, and it does not serve us. The open decision, as a value. NOT an empty list. */
  | { kind: 'not-trusted'; reason: string }
  /** It answered something we could not understand. NOT an empty list, and NOT `unreachable`. */
  | { kind: 'undetermined'; reason: string };

export interface MeshAgent extends SessionSummary {
  /** Unique across the mesh: this host's identity plus the id that host gave the session. */
  key: string;
  hostId: string | null;
  /** The machine label. Allowed to collide with another machine's; `key` is what disambiguates. */
  machine: string;
  address: string;
}

export interface MeshHost {
  /** `null` for a peer that has never answered — we know its address and not its identity. */
  hostId: string | null;
  /** Always a string. A peer that never answered is named by its address, never left blank. */
  machine: string;
  address: string;
  /** Whether this is the host the person opened. */
  self: boolean;
  agents: PeerAgents;
}

export interface MeshView {
  /** Every machine, including the one opened, in a stable order: self first, then join order. */
  hosts: MeshHost[];
  /** Every agent on every REACHED machine, labelled. Nothing from an unreached one appears here. */
  agents: MeshAgent[];
  /** Counts a person can act on. `unknown` is the machines whose agents we could not determine. */
  summary: { machines: number; reachedMachines: number; agents: number; unknownMachines: number };
  /** Set when the peer list itself could not be read — NOT the same as having no peers. */
  peersUndetermined: string | null;
}

/** Never blank: a peer that has never answered is named by the address it was joined at. */
export function displayName(host: { machine: string | null; address: string }): string {
  const m = host.machine?.trim();
  return m !== undefined && m !== '' ? m : host.address;
}

/**
 * Assemble the view. Pure: every host's answer has already been obtained by the caller.
 *
 * DEDUPLICATION (criterion 6) happens here as well as in the peer store, because criterion 7's
 * explicit host list is not stored anywhere and can still name one machine twice — `--host a.tail
 * --host 100.64.0.3` is one machine and must be one entry with one agent list. Identity wins over
 * address, and the first mention wins over the later one.
 */
export function assembleView(hosts: MeshHost[], peersUndetermined: string | null = null): MeshView {
  const kept: MeshHost[] = [];
  for (const host of hosts) {
    const dupe = kept.find(
      (k) => (host.hostId !== null && k.hostId === host.hostId) || (host.hostId === null && k.address === host.address),
    );
    if (dupe) {
      // Same machine, reached twice. Keep the entry that actually has an answer, so joining a
      // machine at a second address never turns a working entry into an unreachable one.
      if (dupe.agents.kind !== 'listed' && host.agents.kind === 'listed') dupe.agents = host.agents;
      continue;
    }
    kept.push(host);
  }

  const agents: MeshAgent[] = [];
  for (const host of kept) {
    if (host.agents.kind !== 'listed') continue;
    for (const s of host.agents.agents) {
      agents.push({
        ...s,
        key: `${host.hostId ?? host.address}:${s.id}`,
        hostId: host.hostId,
        machine: host.machine,
        address: host.address,
      });
    }
  }

  return {
    hosts: kept,
    agents,
    summary: {
      machines: kept.length,
      reachedMachines: kept.filter((h) => h.agents.kind === 'listed').length,
      agents: agents.length,
      unknownMachines: kept.filter((h) => h.agents.kind !== 'listed').length,
    },
    peersUndetermined,
  };
}
