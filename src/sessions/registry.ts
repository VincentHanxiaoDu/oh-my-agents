// The session registry — the INTERFACE, on this Issue.
//
// Issue #1 needs exactly one thing from sessions: a count, for the status command (criterion 5).
// Issue #2 implements real PTY-backed sessions behind this interface. So the interface is defined
// here, in full, and the only implementation shipped on this Issue is an honest empty one.
//
// The seam below (`spawnSession`) is deliberately a function that REFUSES rather than a stub that
// returns something plausible. A stub that returns a fake session id is a lie that reaches the
// browser; a refusal is a build error for whoever wires it up next, which is where the cost belongs.

export interface SessionSummary {
  /** Stable identifier. Opaque to the client; #2 decides its shape. */
  id: string;
  /** What a person calls this session in a list. */
  title: string;
  /** ISO-8601. */
  startedAt: string;
  /** Whether the underlying process is still alive. */
  alive: boolean;
}

export interface SessionRegistry {
  list(): SessionSummary[];
  get(id: string): SessionSummary | undefined;
  count(): number;
}

/**
 * The registry this Issue ships: it owns no sessions, and says so truthfully.
 * A status command reporting `0 sessions` on a host that owns none is correct, not a placeholder.
 */
export function createEmptyRegistry(): SessionRegistry {
  return {
    list: () => [],
    get: () => undefined,
    count: () => 0,
  };
}

/** Thrown by every seam this Issue leaves for a later one. Never caught into a plausible default. */
export class NotImplementedOnThisIssue extends Error {
  constructor(what: string, issue: string) {
    super(`${what} is not implemented on Issue #1; it belongs to ${issue}. This host refuses rather than pretending.`);
    this.name = 'NotImplementedOnThisIssue';
  }
}

/** SEAM FOR ISSUE #2: spawn a PTY-backed agent session and register it. */
export function spawnSession(_registry: SessionRegistry, _command: string, _args: string[]): never {
  throw new NotImplementedOnThisIssue('spawning a PTY session', 'Issue #2 (attach to a running agent)');
}
