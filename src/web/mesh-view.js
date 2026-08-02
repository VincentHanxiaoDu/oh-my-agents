// How a machine and its agents are RENDERED. Plain ES module, served as written, no build step.
//
// ─── WHY THIS IS A MODULE AND NOT INLINE SCRIPT ──────────────────────────────────────────────────
//
// Criterion 4 is not satisfied by the API payload alone: "an unreachable peer and a peer with zero
// agents are distinguishable IN THE LIST". A test that asserts the two differ in JSON has not
// tested the criterion, because the bug the criterion is guarding against is a client that renders
// both as an empty section. So the decision "what does this machine look like" lives in a function
// a test can call, and `test/mesh.web.test.ts` calls it with all four answers and asserts the four
// renderings differ from each other.
//
// It is imported by `index.html` with `<script type="module">` and served verbatim by the host,
// exactly like the HTML. No bundler, no CDN, no external request.

/**
 * The four answers, as a person sees them. Every field is user-visible text.
 *
 * NOTE WHAT IS NOT HERE: there is no branch that turns `unreachable`, `not-trusted` or
 * `undetermined` into "0 agents". Each has its own status word, its own tone, and its own
 * explanation, and `agents` is `null` — not `[]` — for all three, so a caller cannot iterate an
 * empty list and conclude the machine is idle.
 */
export function describeHost(host) {
  const name = host.machine && String(host.machine).trim() !== '' ? String(host.machine) : String(host.address);
  const base = { name, address: String(host.address), self: host.self === true, hostId: host.hostId || null };
  const kind = host && host.agents ? host.agents.kind : undefined;

  if (kind === 'listed') {
    const agents = Array.isArray(host.agents.agents) ? host.agents.agents : [];
    return {
      ...base,
      status: agents.length === 0 ? 'no agents' : agents.length === 1 ? '1 agent' : agents.length + ' agents',
      tone: agents.length === 0 ? 'idle' : 'ok',
      // Said in words as well as in a count, because "no agents" and "not answering" are one word
      // apart on a phone screen and a person acts differently on each.
      detail: agents.length === 0 ? 'Answered. This machine has no agents running.' : 'Answered.',
      agents,
    };
  }
  if (kind === 'unreachable') {
    return {
      ...base,
      status: 'unreachable',
      tone: 'down',
      detail: 'This machine did not answer, so what it is running is unknown. ' + String(host.agents.reason),
      // NULL, NOT []. An empty array here is the exact bug criterion 4 names.
      agents: null,
    };
  }
  if (kind === 'not-trusted') {
    return {
      ...base,
      status: 'not trusted yet',
      tone: 'blocked',
      detail:
        'This machine answered but did not accept this host. Its agents are unknown — this is not ' +
        'the same as it having none. ' + String(host.agents.reason),
      agents: null,
    };
  }
  return {
    ...base,
    status: 'undetermined',
    tone: 'unknown',
    detail:
      'This machine answered something this version does not understand, so what it is running is ' +
      'unknown. ' + String(host && host.agents ? host.agents.reason : 'no answer was recorded'),
    agents: null,
  };
}

/**
 * CRITERION 5. Two agents on different machines that share a name, a working directory and a
 * runtime are still two rows: the machine is part of every row, and `key` — the mesh-wide identity
 * the host computed — is what the row is tracked by.
 */
export function describeAgent(agent) {
  return {
    key: String(agent.key),
    title: String(agent.title),
    machine: String(agent.machine),
    address: String(agent.address),
    // The disambiguator a person reads. Never just the title.
    label: String(agent.title) + ' — on ' + String(agent.machine),
    startedAt: String(agent.startedAt),
    alive: agent.alive === true,
  };
}

/** A one-line summary a person can act on. `unknown` machines are counted, never hidden. */
export function describeSummary(view) {
  const s = view && view.summary ? view.summary : { machines: 0, reachedMachines: 0, agents: 0, unknownMachines: 0 };
  const machines = s.machines === 1 ? '1 machine' : s.machines + ' machines';
  const agents = s.agents === 1 ? '1 agent' : s.agents + ' agents';
  if (s.unknownMachines === 0) return agents + ' on ' + machines + '.';
  return (
    agents +
    ' on ' +
    (s.reachedMachines === 1 ? '1 machine' : s.reachedMachines + ' machines') +
    '. ' +
    (s.unknownMachines === 1 ? '1 machine could not be listed' : s.unknownMachines + ' machines could not be listed') +
    ' — what those are running is unknown, not none.'
  );
}
