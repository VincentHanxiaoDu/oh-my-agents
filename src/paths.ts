// Where this project keeps its on-disk state.
//
// Issues #2 (transcripts), #3 (peer records) and #5 (pairing state) all persist here, so the path
// helper is established once, on this Issue, rather than three times with three different answers.
// THIS ISSUE CREATES ONLY host.json AND host.lock. It does not create their files.
//
// XDG_STATE_HOME is respected because that is what it is for: state that should survive a reboot
// but is not configuration and is not a cache. OMA_STATE_DIR overrides everything, which is how
// the tests get an isolated directory without touching the developer's real host.

import os from 'node:os';
import path from 'node:path';

export interface PathEnv {
  // The index signature is what makes `process.env` assignable here without a cast. Without it
  // every call site needs one, and a cast is a place a wrong type gets in unnoticed.
  [key: string]: string | undefined;
  OMA_STATE_DIR?: string | undefined;
  XDG_STATE_HOME?: string | undefined;
  HOME?: string | undefined;
}

/** The directory this project owns. Callers must create it; this only names it. */
export function stateDir(env: PathEnv = process.env): string {
  const override = env.OMA_STATE_DIR?.trim();
  if (override) return path.resolve(override);

  const xdg = env.XDG_STATE_HOME?.trim();
  // An XDG variable that is set to a relative path is, per the spec, to be ignored — a relative
  // state directory would otherwise resolve against whatever directory the daemon happened to be
  // started from, which is not a stable location for a file that outlives the terminal.
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'oh-my-agents');

  return path.join(env.HOME?.trim() || os.homedir(), '.local', 'state', 'oh-my-agents');
}

/** The record a running host publishes about itself. Read by the status command. */
export function hostStateFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'host.json');
}

/** The single-instance lock. Its existence plus a live pid means a host owns this machine. */
export function hostLockFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'host.lock');
}

/** Where a detached host's output goes, since it no longer has a terminal to write to. */
export function hostLogFile(env: PathEnv = process.env): string {
  return path.join(stateDir(env), 'host.log');
}
