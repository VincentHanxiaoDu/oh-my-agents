#!/usr/bin/env node
// The single command (criterion 1) and the status command (criterion 5).
//
// `oh-my-agents` with no arguments starts the host. That is the whole of criterion 1: no tunnel
// binary, no relay, no signup, no reverse proxy, and no second command to run afterwards.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT } from './exit-codes.js';
import { DEFAULT_PORT, runDaemon, startDetached } from '../host/daemon.js';
import { queryHost } from '../host/status.js';
import { readHostRecord } from '../host/state.js';
import { isProcessAlive, releaseLock } from '../host/lock.js';
import { hostLogFile, hostStateFile } from '../paths.js';
import { createPairingCode, listDevices, revokeDevice } from '../pairing/devices.js';
import { CODE_TTL_MS, formatCode } from '../pairing/codes.js';

// FLAGS THAT WOULD ANSWER AN UNSETTLED PRODUCT DECISION. Issue #1 says explicitly that whether this
// host installs itself so it returns after a REBOOT is not decided. Accepting any of these would
// decide it — quietly, in a dev branch, by implementation. Refusing loudly is the whole point: the
// refusal is visible, and it says who owns the decision.
const UNSETTLED_PERSISTENCE_FLAGS = [
  '--install-service',
  '--install',
  '--boot',
  '--at-boot',
  '--enable-at-login',
  '--login-item',
  '--launchd',
  '--systemd',
  '--service',
  '--persist',
  '--autostart',
];

function refuseUnsettledPersistence(argv: string[]): number | null {
  const found = argv.filter((a) => UNSETTLED_PERSISTENCE_FLAGS.includes(a.split('=')[0]!));
  if (found.length === 0) return null;
  process.stderr.write(
    [
      `REFUSING: ${found.join(', ')} would make this host come back after a reboot.`,
      '',
      'Whether oh-my-agents installs itself as a login or system service is an OPEN PRODUCT',
      'DECISION on Issue #1, recorded there under "Blocked on a decision". This build survives its',
      'terminal being closed, which is what the acceptance criteria assert, and it does NOT install',
      'a launchd plist, a systemd unit, or a login item.',
      '',
      'This command refuses rather than picking an answer, because an implementation that picks one',
      'settles the decision without anyone deciding. Take it to Issue #1.',
      '',
    ].join('\n'),
  );
  return EXIT.REFUSED_UNSETTLED_DECISION;
}

// FLAGS THAT WOULD ANSWER ISSUE #5's UNSETTLED DECISION — the same pattern, for a different open
// question. Whether a PAIRED DEVICE's credential ever expires ON ITS OWN (a session lifetime, an
// idle timeout, a maximum age) is recorded on Issue #5 as unsettled; the acceptance criteria assert
// EXPLICIT REVOCATION ONLY, and that is what this build implements. Any of these flags would settle
// it by picking a number, so they refuse.
//
// NOTE WHAT IS *NOT* IN THIS LIST: the PAIRING CODE's five-minute lifetime. That one is required by
// criterion 3 and is built. The short-lived thing is the CODE; the DEVICE credential's lifetime is
// the open question, and conflating the two is exactly how the open question gets answered by
// accident.
const UNSETTLED_CREDENTIAL_EXPIRY_FLAGS = [
  '--device-ttl',
  '--credential-ttl',
  '--session-ttl',
  '--session-lifetime',
  '--device-max-age',
  '--max-age',
  '--expire-after',
  '--expire-devices',
  '--idle-timeout',
  '--reauth-after',
  '--require-reauth',
  '--pairing-lifetime',
];

function refuseUnsettledCredentialExpiry(argv: string[]): number | null {
  const found = argv.filter((a) => UNSETTLED_CREDENTIAL_EXPIRY_FLAGS.includes(a.split('=')[0]!));
  if (found.length === 0) return null;
  process.stderr.write(
    [
      `REFUSING: ${found.join(', ')} would give a paired device's credential a lifetime.`,
      '',
      'Whether a pairing credential EVER EXPIRES ON ITS OWN is an OPEN PRODUCT DECISION on Issue #5,',
      'recorded there under "Blocked on a decision". The acceptance criteria assert EXPLICIT',
      'REVOCATION ONLY, and that is what this build does: `oh-my-agents revoke` ends a device, and',
      'nothing else ever does.',
      '',
      'A default here would be invisible. A phone that silently stopped working after N days would',
      'look like a bug in the host, and the number that caused it would have been chosen in a branch',
      'by whoever typed it. So this refuses instead. Take it to Issue #5.',
      '',
      'This is NOT about the pairing CODE, which is single-use and expires in five minutes as',
      'criterion 3 requires. It is about the credential the paired browser then holds.',
      '',
    ].join('\n'),
  );
  return EXIT.REFUSED_UNSETTLED_DECISION;
}

function parsePort(argv: string[]): number | { error: string } {
  const i = argv.indexOf('--port');
  let raw: string | undefined;
  if (i !== -1) raw = argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--port='));
  if (eq) raw = eq.slice('--port='.length);
  if (raw === undefined) {
    const fromEnv = process.env.OMA_PORT;
    if (fromEnv === undefined || fromEnv.trim() === '') return DEFAULT_PORT;
    raw = fromEnv;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: `'${raw}' is not a port number between 1 and 65535` };
  return n;
}

const USAGE = `oh-my-agents — serve this machine's coding agents over your own tailnet.

  oh-my-agents                start the host (this is the one command)
  oh-my-agents start          the same thing, spelled out
  oh-my-agents status         is a host running here, where, and how many sessions
  oh-my-agents stop           stop the host running on this machine

  oh-my-agents pair           print a one-time pairing code for a new browser
  oh-my-agents devices        list the browsers that are paired with this host
  oh-my-agents revoke <id>    revoke one device, by id or by an unambiguous prefix

  --port <n>                  which port to serve on (default ${DEFAULT_PORT}, or $OMA_PORT)

Exit codes
  0  the thing asked about is true
  1  something went wrong
  3  a host is already running here
  4  no host is running here
  5  could not determine — NOT the same as 4, and never printed as if it were
  6  refused: you asked for something that is an open product decision
  7  we looked, and the thing you named is not there
`;

async function cmdStart(argv: string[]): Promise<number> {
  const port = parsePort(argv);
  if (typeof port !== 'number') {
    process.stderr.write(`${port.error}\n`);
    return EXIT.ERROR;
  }

  const result = await startDetached({ port });
  switch (result.kind) {
    case 'started':
      process.stdout.write(result.banner + '\n');
      return EXIT.OK;
    case 'already-running':
      process.stderr.write(result.message + '\n');
      return EXIT.ALREADY_RUNNING;
    case 'undetermined':
      process.stderr.write('COULD NOT DETERMINE whether a host started.\n' + result.message + '\n');
      return EXIT.UNDETERMINED;
    case 'failed':
      process.stderr.write('The host did not start.\n' + result.message + '\n');
      return EXIT.ERROR;
  }
}

async function cmdStatus(): Promise<number> {
  const report = await queryHost();
  switch (report.kind) {
    case 'running': {
      const r = report.record;
      const primary = r.tailnetAddresses[0] ?? r.addresses[0] ?? '127.0.0.1';
      const shown = primary.includes(':') ? `[${primary}]` : primary;
      process.stdout.write(
        [
          'RUNNING',
          `  address:  http://${shown}:${r.port}/`,
          `  sessions: ${report.live.sessionCount}`,
          `  reachability: ${r.reachability}`,
          `  pid:      ${r.pid}`,
          `  started:  ${r.startedAt}`,
          `  listening on: ${r.addresses.map((a) => `${a}:${r.port}`).join('  ')}`,
          '',
        ].join('\n'),
      );
      return EXIT.OK;
    }
    case 'not-running':
      // Deliberately says nothing that could be mistaken for a running host: no address, no port,
      // no session count. The exit code alone tells the two apart, and so does this text.
      process.stderr.write(`NOT RUNNING — no host is serving on this machine.\n  ${report.reason}\n`);
      return EXIT.NOT_RUNNING;
    case 'undetermined':
      process.stderr.write(
        [
          'COULD NOT DETERMINE whether a host is running on this machine.',
          `  ${report.reason}`,
          '  This is NOT the same answer as "not running". Do not start a second host on the strength',
          `  of this. Look at ${hostLogFile()} and at ${hostStateFile()}.`,
          '',
        ].join('\n'),
      );
      return EXIT.UNDETERMINED;
  }
}

async function cmdStop(): Promise<number> {
  const read = await readHostRecord();
  if (read.kind === 'absent') {
    process.stderr.write('NOT RUNNING — there is nothing to stop.\n');
    return EXIT.NOT_RUNNING;
  }
  if (read.kind === 'undetermined') {
    process.stderr.write(`COULD NOT DETERMINE what is running: ${read.reason}\nNothing has been stopped.\n`);
    return EXIT.UNDETERMINED;
  }
  const pid = read.record.pid;
  if (!isProcessAlive(pid)) {
    releaseLock(pid);
    process.stderr.write(`NOT RUNNING — the record named pid ${pid}, which is gone. Cleaned up.\n`);
    return EXIT.NOT_RUNNING;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    process.stderr.write(`could not signal pid ${pid}: ${String(err)}\n`);
    return EXIT.ERROR;
  }
  for (let i = 0; i < 100; i++) {
    if (!isProcessAlive(pid)) {
      process.stdout.write(`stopped the host (pid ${pid}).\n`);
      return EXIT.OK;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stderr.write(`signalled pid ${pid} but it is still alive after 10s. Nothing further has been done.\n`);
  return EXIT.UNDETERMINED;
}

/** Criterion 2: the host produces a one-time pairing code on demand. This is "on demand". */
function cmdPair(): number {
  const issued = createPairingCode();
  if (issued.kind === 'undetermined') {
    process.stderr.write(
      [
        'COULD NOT DETERMINE the state of the pairing store, so no code was issued.',
        `  ${issued.reason}`,
        '  Nothing has been changed. This is NOT "no devices are paired" — this host cannot tell.',
        '',
      ].join('\n'),
    );
    return EXIT.UNDETERMINED;
  }
  const { code, expiresAt } = issued.value;
  const minutes = Math.round(CODE_TTL_MS / 60000);
  process.stdout.write(
    [
      '',
      `    ${formatCode(code)}`,
      '',
      `Type this into the browser you want to pair. It works ONCE and expires in ${minutes} minutes`,
      `(at ${expiresAt}).`,
      '',
      'The browser will show a pairing prompt the first time it reaches this host. Once paired it',
      'stays paired until you run `oh-my-agents revoke` — nothing expires it on its own.',
      '',
    ].join('\n'),
  );
  return EXIT.OK;
}

/** Criterion 4: paired devices are listable, with something a human can tell them apart by. */
function cmdDevices(): number {
  const listed = listDevices();
  if (listed.kind === 'undetermined') {
    process.stderr.write(
      [
        'COULD NOT DETERMINE which devices are paired.',
        `  ${listed.reason}`,
        '  This is NOT the same as "no devices are paired". While this is true the host is denying',
        '  every request, including from devices that were paired.',
        '',
      ].join('\n'),
    );
    return EXIT.UNDETERMINED;
  }
  const devices = listed.kind === 'present' ? listed.devices : [];
  if (devices.length === 0) {
    // A true answer, not an error: a host nobody has paired with is the normal first run.
    process.stdout.write('No devices are paired with this host. Run `oh-my-agents pair` to add one.\n');
    return EXIT.OK;
  }
  const live = devices.filter((d) => d.revokedAt === undefined);
  process.stdout.write(
    [
      `${live.length} device${live.length === 1 ? '' : 's'} paired with this host.`,
      '',
      ...devices.map((d) =>
        [
          `  ${d.id.slice(0, 8)}  ${d.label}${d.revokedAt === undefined ? '' : '  [REVOKED]'}`,
          `            paired ${d.pairedAt}${d.revokedAt === undefined ? '' : `, revoked ${d.revokedAt}`}`,
          // The label comes from the browser's User-Agent, which the browser chooses. Said out
          // loud, once, rather than letting a list of confident-looking names imply otherwise.
          '',
        ].join('\n'),
      ),
      'Names are taken from each browser\'s own User-Agent and are a hint, not proof.',
      'Revoke one with: oh-my-agents revoke <the 8 characters above>',
      '',
    ].join('\n'),
  );
  return EXIT.OK;
}

/** Criteria 4 and 5: revoke ONE device, and change nothing about any other. */
function cmdRevoke(argv: string[]): number {
  const id = argv[1];
  if (id === undefined || id.startsWith('-')) {
    process.stderr.write('usage: oh-my-agents revoke <device-id>\nRun `oh-my-agents devices` to see the ids.\n');
    return EXIT.ERROR;
  }
  const outcome = revokeDevice(id);
  switch (outcome.kind) {
    case 'revoked':
      process.stdout.write(
        [
          `Revoked ${outcome.device.id.slice(0, 8)} (${outcome.device.label}).`,
          'Its next request is rejected and it is shown the pairing prompt again.',
          'Every other paired device is untouched and does not have to pair again.',
          '',
        ].join('\n'),
      );
      return EXIT.OK;
    case 'already-revoked':
      process.stdout.write(`${outcome.device.id.slice(0, 8)} (${outcome.device.label}) was already revoked. Nothing changed.\n`);
      return EXIT.OK;
    case 'no-such-device':
      process.stderr.write(`No paired device matches '${id}'. Nothing has been revoked.\n`);
      return EXIT.NO_SUCH_THING;
    case 'ambiguous':
      process.stderr.write(
        [
          `'${id}' matches ${outcome.matches.length} devices, so NOTHING has been revoked:`,
          ...outcome.matches.map((m) => `  ${m}`),
          'Give more characters. Revoking the first match would be a guess about which phone you lost.',
          '',
        ].join('\n'),
      );
      return EXIT.ERROR;
    case 'undetermined':
      process.stderr.write(
        [
          'COULD NOT DETERMINE the state of the pairing store. NOTHING has been revoked.',
          `  ${outcome.reason}`,
          '  Do not assume the device is revoked on the strength of this.',
          '',
        ].join('\n'),
      );
      return EXIT.UNDETERMINED;
  }
}

export async function main(argv: string[]): Promise<number> {
  const refusal = refuseUnsettledPersistence(argv);
  if (refusal !== null) return refusal;
  const expiryRefusal = refuseUnsettledCredentialExpiry(argv);
  if (expiryRefusal !== null) return expiryRefusal;

  // The command is the FIRST argument, or `start` when there is none — `oh-my-agents` on its own is
  // the single command of criterion 1. Scanning for the first non-flag instead would take the `9000`
  // of `--port 9000` as a command, which it did until this was measured.
  const first = argv[0];
  const command = first === undefined || first.startsWith('-') ? 'start' : first;

  switch (command) {
    case 'start':
      return cmdStart(argv);
    case 'status':
      return cmdStatus();
    case 'stop':
      return cmdStop();
    case 'pair':
      return cmdPair();
    case 'devices':
      return cmdDevices();
    case 'revoke':
      return cmdRevoke(argv);
    case '__daemon': {
      const port = parsePort(argv);
      if (typeof port !== 'number') {
        process.stderr.write(`${port.error}\n`);
        return EXIT.ERROR;
      }
      await runDaemon({ port });
      return EXIT.OK;
    }
    case 'help':
      process.stdout.write(USAGE);
      return EXIT.OK;
    default:
      process.stderr.write(`unknown command '${command}'.\n\n${USAGE}`);
      return EXIT.ERROR;
  }
}

// Compared by resolved real path, not by string suffix: a suffix match calls this file the entry
// point when something else named main.js is, and a symlinked bin (which is how npm installs one)
// makes argv[1] a path that is not this file at all.
const invokedDirectly = ((): boolean => {
  try {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    process.exit(EXIT.OK);
  }
  main(argv).then(
    (code) => {
      // __daemon never returns; everything else does, and its code is the answer.
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(EXIT.ERROR);
    },
  );
}
