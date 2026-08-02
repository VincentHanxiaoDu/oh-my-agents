// Types for `mesh-view.js`, so `test/mesh.web.test.ts` can import the REAL browser module under
// `strict` rather than a TypeScript copy of it. The browser gets the .js; this file is never served
// and never emitted — it exists so the thing under test is the thing that ships.

export interface HostDescription {
  name: string;
  address: string;
  self: boolean;
  hostId: string | null;
  status: string;
  tone: 'ok' | 'idle' | 'down' | 'blocked' | 'unknown';
  detail: string;
  /** `null` whenever this machine's agents are UNKNOWN. Never `[]` for an unknown machine. */
  agents: unknown[] | null;
}

export interface AgentDescription {
  key: string;
  title: string;
  machine: string;
  address: string;
  label: string;
  startedAt: string;
  alive: boolean;
}

export function describeHost(host: unknown): HostDescription;
export function describeAgent(agent: unknown): AgentDescription;
export function describeSummary(view: unknown): string;
