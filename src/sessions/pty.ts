// Running an agent under a real PTY, with no native dependency.
//
// WHY NOT node-pty. This project's determinism argument (ARCHITECTURE.md, "Toolchain") is two
// devDependencies at exact versions installed by `npm ci` from a committed lockfile. node-pty is a
// native addon: it either compiles on the machine — needing a toolchain this project does not
// otherwise require — or it downloads a prebuilt binary per platform and per Node ABI. Either way
// the thing that runs is chosen at install time by the machine, which is precisely the property
// `make ci` exists to deny. So the PTY comes from `script(1)`, which is POSIX-adjacent, present on
// macOS and on every util-linux system, and which allocates a real pseudo-terminal.
//
// WHY A FIFO AND A SHELL PIPELINE. `script(1)` calls `tcgetattr` on its own stdin. Node's
// `stdio: 'pipe'` is a socketpair on macOS, and `tcgetattr` on a socket fails with EOPNOTSUPP,
// which BSD `script` treats as fatal: it prints `script: tcgetattr/ioctl: Operation not supported
// on socket` and exits 1 before running the agent at all. On a real pipe(2) the same call fails
// with ENOTTY, which it tolerates. There is no way to ask Node for a pipe(2); there is a way to ask
// a shell for one. Hence `cat FIFO | script …`: `cat` reads the FIFO we can write to, and the
// shell's `|` gives `script` the real pipe it insists on.
//
// WHY THE FLAVOUR IS PROBED AND NOT NAMED. BSD `script` takes the command as argv after the
// typescript file; util-linux `script` takes it as a single string after `-c`. Which one is present
// is a property of the machine, not of `process.platform` — a Mac can have util-linux from
// Homebrew, and a Linux container can have busybox. So the flavour is established by RUNNING a
// harmless command through each form and seeing which produces its output, once per process.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export type ScriptFlavour = 'bsd' | 'util-linux';

export type PtySupport =
  | { kind: 'available'; flavour: ScriptFlavour }
  | { kind: 'absent'; reason: string }
  | { kind: 'undetermined'; reason: string };

/** POSIX single-quote quoting, for the util-linux `-c` form. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

const PROBE_MARKER = 'oma-pty-probe-ok';

let cached: PtySupport | null = null;

/**
 * Establish whether this machine can give us a PTY, and how. Three answers, kept apart: `script` is
 * not there, `script` is there in a form we recognise, and we could not tell (it is there but
 * neither invocation produced our marker — a busybox applet, a wrapper, a sandbox with no ptys).
 * Reporting the third as `absent` would tell an operator to install something already installed.
 */
export function detectPtySupport(force = false): PtySupport {
  if (cached && !force) return cached;
  cached = probe();
  return cached;
}

function probe(): PtySupport {
  const which = spawnSync('/bin/sh', ['-c', 'command -v script'], { encoding: 'utf8' });
  if (which.error) {
    return { kind: 'undetermined', reason: `could not run a shell to look for script(1): ${String(which.error)}` };
  }
  if (which.status !== 0 || which.stdout.trim() === '') {
    return {
      kind: 'absent',
      reason: 'script(1) is not on PATH, so this host cannot allocate a pseudo-terminal for an agent',
    };
  }

  // `< /dev/null` is not decoration. `script(1)` calls `tcgetattr` on its stdin, and the host that
  // runs this probe is DETACHED and has no terminal — its stdin, and the stdin `spawnSync` would
  // otherwise hand the probe, is a socketpair, on which that call fails fatally. A probe that only
  // succeeds when run from somebody's terminal would report "this machine cannot allocate a pty"
  // on exactly the machines this product runs on. Redirecting from /dev/null is what a shell can
  // give us that Node cannot.

  // BSD form: `script -q <typescript> <cmd> <args...>`
  const bsd = spawnSync('/bin/sh', ['-c', `exec script -q /dev/null /bin/echo ${PROBE_MARKER} </dev/null`], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (bsd.status === 0 && (bsd.stdout ?? '').includes(PROBE_MARKER)) return { kind: 'available', flavour: 'bsd' };

  // util-linux form: `script -q -e -c "<cmd string>" <typescript>`
  const util = spawnSync(
    '/bin/sh',
    ['-c', `exec script -q -e -c ${shellQuote(`/bin/echo ${PROBE_MARKER}`)} /dev/null </dev/null`],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (util.status === 0 && (util.stdout ?? '').includes(PROBE_MARKER)) return { kind: 'available', flavour: 'util-linux' };

  return {
    kind: 'undetermined',
    reason:
      'script(1) is on PATH but neither the BSD nor the util-linux invocation produced its output, ' +
      'so this host cannot tell how to allocate a pseudo-terminal with it',
  };
}

/**
 * The shell that runs the agent and RECORDS ITS EXIT STATUS before letting go.
 *
 * `$1` is the status file, the rest is the agent's argv. `$?` is captured immediately after the
 * agent returns, and a signal death is recorded the way a shell reports one, as `128 + signal`.
 *
 * This exists because `cat` in the pipeline below is blocked on a FIFO that is held open for the
 * life of the session, so the pipeline's own exit status can never arrive. See
 * `sessionAgentStatusFile` in paths.ts for why that FIFO is held open.
 */
const RECORD_STATUS = 'st=$1; shift; "$@"; s=$?; printf %s "$s" > "$st"; exit "$s"';

/**
 * The argv that runs `command args…` under a PTY, reading keystrokes from `fifo` and writing the
 * agent's exit status to `statusFile`.
 *
 * Pure, and exported, so the shape of the pipeline is asserted in a unit test without spawning
 * anything — the quoting in the util-linux branch is the part that would be wrong silently.
 */
export function ptyArgv(
  flavour: ScriptFlavour,
  fifo: string,
  statusFile: string,
  command: string,
  args: string[],
): string[] {
  if (flavour === 'bsd') {
    // `$0` is the fifo; after the shift, `"$@"` is the inner shell's whole argv — passed through
    // without a round trip through a string, so an argument containing a space or a quote survives
    // intact. `sh` is the inner shell's `$0`; the agent's argv follows the status file.
    return [
      '-c',
      'fifo=$1; shift; cat "$fifo" | exec script -q /dev/null "$@"',
      'oma',
      fifo,
      '/bin/sh',
      '-c',
      RECORD_STATUS,
      'sh',
      statusFile,
      command,
      ...args,
    ];
  }
  // util-linux takes ONE string, so the whole inner invocation has to be quoted into it. Every word
  // goes through `shellQuote`, including the recorder script itself.
  const inner = ['/bin/sh', '-c', RECORD_STATUS, 'sh', statusFile, command, ...args].map(shellQuote).join(' ');
  return ['-c', `cat "$0" | exec script -q -e -c ${shellQuote(inner)} /dev/null`, fifo];
}

export interface PtyProcess {
  child: ChildProcess;
}

/**
 * Spawn `command args…` under a PTY. `stdoutFd`/`stderrFd` are handed straight to the child so the
 * caller decides where the byte stream goes; nothing is buffered here.
 */
export function spawnUnderPty(opts: {
  flavour: ScriptFlavour;
  fifo: string;
  statusFile: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): PtyProcess {
  const child = spawn('/bin/sh', ptyArgv(opts.flavour, opts.fifo, opts.statusFile, opts.command, opts.args), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so `kill(-pid)` reaches the whole pipeline — the shell, `cat`,
    // `script` and the agent — instead of one process of four, leaving the rest orphaned. The
    // supervisor is itself detached, so without this the pipeline shares the supervisor's group and
    // a negative kill would either miss or take the supervisor down with it.
    detached: true,
  });
  return { child };
}

/**
 * The environment an agent under this PTY sees.
 *
 * TERM is set only if the caller has not already set one. Criterion 7 is about output rendering as
 * intended, and an agent that sees `TERM=dumb` (or no TERM at all) emits no colour and no redraws
 * to render. `xterm-256color` is the capability set the browser renderer implements. It is NOT read
 * from the operator's own terminal, because the host is detached and has none.
 */
export function ptyEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    TERM: base.TERM && base.TERM !== 'dumb' ? base.TERM : 'xterm-256color',
    // Announced so an agent can behave differently when it knows a person may be on a phone.
    OMA_SESSION: '1',
  };
}
