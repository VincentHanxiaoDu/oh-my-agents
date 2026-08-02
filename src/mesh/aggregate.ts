// One unified list, from three different starting points, through one code path.
//
// Criterion 1 (open either joined host and see both), criterion 2 (symmetric, no hub) and
// criterion 7 (point a client at an explicit list of addresses, no join required) are three
// entry points into the SAME assembly. They are one function with different inputs on purpose: if
// the explicit-list path had its own aggregation, criterion 4's unreachable rendering and criterion
// 5's disambiguation would be built twice and would drift, and one of the two copies would be the
// one nobody looked at.
//
// CRITERION 8 — NO RELAY, NO TUNNEL, NO EXTRA PROCESS — IS A PROPERTY OF THIS FUNCTION. It makes
// direct HTTP requests, from the host the person opened, to each peer's own address, over the
// network Issue #1 already put them on. There is no broker, no discovery service, no message bus,
// nothing that has to be running anywhere else, and no third party. Killing every host but two
// leaves those two talking to each other.

import { askPeer, type AskOptions } from './client.js';
import { readPeers, recordPeerIdentity } from './peers.js';
import { assembleView, displayName, type MeshHost, type MeshView } from './view.js';
import type { CredentialSupplier } from './trust.js';
import type { SessionRegistry } from '../sessions/registry.js';
import type { MachineIdentity } from './identity.js';
import type { PathEnv } from '../paths.js';

export interface AggregateOptions extends AskOptions {
  /** This host: read locally, never over a socket. */
  self: { identity: MachineIdentity; address: string; registry: SessionRegistry };
  supplier: CredentialSupplier;
  env?: PathEnv;
  /**
   * CRITERION 7. When given, THESE addresses are asked and the join records are not consulted at
   * all — a person can point a client at a list of hosts that have never been joined to each other
   * and get the same unified list, assembled by the same code.
   */
  addresses?: string[];
  /** Whether to include the local host in the view. A pure client (criterion 7) may not want it. */
  includeSelf?: boolean;
  /** Injected by tests. Skips persisting learned identities. */
  persistIdentities?: boolean;
}

/** Build the unified view. Never throws; every failure arrives as a value on some host's entry. */
export async function aggregate(opts: AggregateOptions): Promise<MeshView> {
  const env = opts.env ?? process.env;
  const includeSelf = opts.includeSelf ?? true;

  let addresses: string[];
  let peersUndetermined: string | null = null;
  const knownMachine = new Map<string, string | null>();

  if (opts.addresses !== undefined) {
    addresses = opts.addresses;
  } else {
    const read = readPeers(env);
    if (read.kind === 'undetermined') {
      // NOT an empty peer list. A person whose peers file went bad must not be shown "no other
      // machines" — that reads as "I never joined anything" and sends them to re-join, which is
      // exactly the state in which a re-join would duplicate. Said out loud instead.
      peersUndetermined = read.reason;
      addresses = [];
    } else {
      const peers = read.kind === 'present' ? read.peers : [];
      addresses = peers.map((p) => p.address);
      for (const p of peers) knownMachine.set(p.address, p.machine);
    }
  }

  // CONCURRENTLY, each with its own deadline. One asleep laptop must not delay the rest — criterion
  // 2 is about the remaining hosts still working when one goes away, and a serial loop makes "still
  // working" mean "still working, eventually, after every dead peer has timed out in turn".
  const answers = await Promise.all(addresses.map(async (address) => ({ address, answer: await askPeer(address, opts.supplier, opts) })));

  const hosts: MeshHost[] = [];
  if (includeSelf) {
    hosts.push({
      hostId: opts.self.identity.hostId,
      machine: opts.self.identity.machine,
      address: opts.self.address,
      self: true,
      agents: { kind: 'listed', agents: opts.self.registry.list() },
    });
  }

  for (const { address, answer } of answers) {
    if (answer.identity !== null && opts.persistIdentities !== false && opts.addresses === undefined) {
      recordPeerIdentity(address, answer.identity.hostId, answer.identity.machine, env);
    }
    hosts.push({
      hostId: answer.identity?.hostId ?? null,
      // A peer that did not answer is STILL NAMED (criterion 4). The name comes from the last time
      // it did answer, and failing that from the address it was joined at — never from nothing.
      machine: answer.identity?.machine ?? displayName({ machine: knownMachine.get(address) ?? null, address }),
      address,
      self: false,
      agents: answer.agents,
    });
  }

  return assembleView(hosts, peersUndetermined);
}
