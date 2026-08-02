// Criteria 1, 2, 3, 4 and 6, against real processes.
//
// 1  live output arrives without the client asking for it again
// 2  browser input and THIS MACHINE'S OWN TERMINAL produce one interleaved history
// 3  two devices see the same output, and each other's input
// 4  interrupt sends Ctrl+C and the session STAYS ATTACHED
// 6  a session survives the host restarting; ended and undetermined are different answers, and
//    neither is presented as live
//
// The programs driven here are `process.execPath` and whatever shell `command -v` finds, never a
// named path and never an agent runtime — CI has none.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  attachClient,
  counterProgram,
  newSession,
  skipIfNoPty,
  sleep,
  spawnCliAttach,
  startHost,
} from './helpers/session-harness.js';
import { sessionMetaFile } from '../src/sessions/paths.js';

/** The machine's shell, PROBED. There is no assumption that it is at any particular path. */
function findShell(): string | null {
  const r = spawnSync('/bin/sh', ['-c', 'command -v sh'], { encoding: 'utf8' });
  const found = (r.stdout ?? '').trim();
  return r.status === 0 && found !== '' ? found : null;
}

test('criterion 1: live output arrives on an open attachment without asking again', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);

  const host = await startHost();
  try {
    const prog = counterProgram(5);
    const id = await newSession(host, prog.command, prog.args);
    const client = await attachClient(host.port, id);
    await client.waitForEvent('attached');

    const atFirst = client.chunks.length;
    await sleep(400);
    // No second request was made by anything in this test. More frames arrived anyway.
    assert.ok(client.chunks.length > atFirst, 'no further output arrived on an open attachment');
    client.close();
  } finally {
    await host.stop();
  }
});

test('criterion 3: two attached clients see the same output and each other’s input', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);
  const shell = findShell();
  if (!shell) return t.skip('no POSIX shell could be found on this machine');

  const host = await startHost();
  try {
    const id = await newSession(host, shell, ['-i']);
    const a = await attachClient(host.port, id);
    await a.waitForEvent('attached');
    await sleep(200);

    a.connection.sendBinary(Buffer.from('echo FROM_FIRST_DEVICE\n'));
    await a.waitForText(/FROM_FIRST_DEVICE/);

    const b = await attachClient(host.port, id);
    await b.waitForEvent('attached');

    // B replayed what A had already done: the two devices are looking at ONE session.
    await b.waitForText(/FROM_FIRST_DEVICE/);

    b.connection.sendBinary(Buffer.from('echo FROM_SECOND_DEVICE\n'));
    // Input from one appears in the other's view. Both directions, not just the one that is easy.
    await a.waitForText(/FROM_SECOND_DEVICE/);
    await b.waitForText(/FROM_SECOND_DEVICE/);

    // And the ORDER is the same in both. Two divergent views would differ here.
    const orderIn = (text: string): string[] =>
      [...text.matchAll(/FROM_(FIRST|SECOND)_DEVICE/g)].map((m) => m[0]);
    const aOrder = orderIn(a.text());
    const bOrder = orderIn(b.text());
    assert.deepEqual(bOrder, aOrder.slice(aOrder.length - bOrder.length), 'the two devices saw a different order');

    a.close();
    b.close();
  } finally {
    await host.stop();
  }
});

test('criterion 2: the browser and this machine’s own terminal produce ONE interleaved history', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);
  const shell = findShell();
  if (!shell) return t.skip('no POSIX shell could be found on this machine');

  const host = await startHost();
  let terminal: ReturnType<typeof spawnCliAttach> | null = null;
  try {
    const id = await newSession(host, shell, ['-i']);

    // The browser end.
    const browser = await attachClient(host.port, id);
    await browser.waitForEvent('attached');
    await sleep(200);

    // The machine's own terminal end: `oh-my-agents attach`, a separate process with its own stdin.
    terminal = spawnCliAttach(host.dir, id);
    let terminalSaw = '';
    terminal.stdout?.on('data', (c: Buffer) => (terminalSaw += c.toString('utf8')));
    await sleep(600);

    browser.connection.sendBinary(Buffer.from('echo ONE_FROM_BROWSER\n'));
    await browser.waitForText(/ONE_FROM_BROWSER/);

    terminal.stdin?.write('echo TWO_FROM_TERMINAL\n');
    await browser.waitForText(/TWO_FROM_TERMINAL/);

    browser.connection.sendBinary(Buffer.from('echo THREE_FROM_BROWSER\n'));
    await browser.waitForText(/THREE_FROM_BROWSER/);

    // ONE history, in one order, containing both sources. Not two views.
    const order = [...browser.text().matchAll(/(ONE_FROM_BROWSER|TWO_FROM_TERMINAL|THREE_FROM_BROWSER)/g)].map((m) => m[0]);
    // Each token appears twice — the pty echoes the typed line, then the shell prints its output.
    // What matters is the SEQUENCE of first appearances.
    const firstAppearances: string[] = [];
    for (const token of order) if (!firstAppearances.includes(token)) firstAppearances.push(token);
    assert.deepEqual(firstAppearances, ['ONE_FROM_BROWSER', 'TWO_FROM_TERMINAL', 'THREE_FROM_BROWSER']);

    // And the terminal saw the browser's input too, in the same session.
    const deadline = Date.now() + 4000;
    while (!/THREE_FROM_BROWSER/.test(terminalSaw) && Date.now() < deadline) await sleep(50);
    assert.match(terminalSaw, /ONE_FROM_BROWSER/, 'the terminal client never saw what the browser typed');
    assert.match(terminalSaw, /THREE_FROM_BROWSER/);

    browser.close();
  } finally {
    terminal?.kill('SIGKILL');
    await host.stop();
  }
});

test('criterion 4: an interrupt reaches the agent and the session REMAINS ATTACHED', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);
  const shell = findShell();
  if (!shell) return t.skip('no POSIX shell could be found on this machine');

  const host = await startHost();
  try {
    const id = await newSession(host, shell, ['-i']);
    const client = await attachClient(host.port, id);
    await client.waitForEvent('attached');
    await sleep(300);

    // Something that would run for far longer than this test.
    client.connection.sendBinary(Buffer.from('sleep 45\n'));
    await client.waitForText(/sleep 45/);
    await sleep(300);

    client.connection.sendJson({ type: 'interrupt' });

    // The interrupt reached the agent: the shell is taking commands again well before `sleep 45`
    // could have finished.
    await sleep(400);
    client.connection.sendBinary(Buffer.from('echo STILL_HERE\n'));
    await client.waitForText(/STILL_HERE/, 5000);

    // AND NOTHING DETACHED, KILLED OR ORPHANED. Same connection, no exit event, session still live.
    assert.equal(client.events.filter((e) => e.type === 'exit').length, 0, 'interrupting produced an exit');
    assert.equal(client.events.filter((e) => e.type === 'not-live').length, 0, 'interrupting made the session not-live');
    const after = await host.api('GET', `/api/sessions/${id}`);
    assert.equal(after.json.session.state, 'live', 'interrupting changed the session state');

    // More live output still arrives on the SAME attachment.
    const before = client.chunks.length;
    client.connection.sendBinary(Buffer.from('echo AND_AGAIN\n'));
    await client.waitForText(/AND_AGAIN/);
    assert.ok(client.chunks.length > before);
    client.close();
  } finally {
    await host.stop();
  }
});

test('criterion 6: a session survives the host restarting, and replays on reattach', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);

  const host = await startHost();
  try {
    const prog = counterProgram(4);
    const id = await newSession(host, prog.command, prog.args);
    const before = await attachClient(host.port, id);
    await before.waitForEvent('attached');
    await before.waitForText(/#10#/);
    before.drop();

    // The HOST process goes away. Not the machine, not the agent — the host.
    await host.stopKeepingState();
    await sleep(300);
    await host.restart();

    // It is listed again, by a process that has never seen it before.
    const listed = await host.api('GET', '/api/sessions');
    const found = (listed.json.sessions as any[]).find((s) => s.id === id);
    assert.ok(found, 'the session was not listed after the host restarted');
    assert.equal(found.state, 'live', `the session was ${found.state} after the host restarted: ${found.reason}`);

    // And reattaching replays recent history and then continues live.
    const after = await attachClient(host.port, id);
    await after.waitForEvent('attached');
    const replayed = await after.waitForEvent('attached');
    assert.ok(replayed.replayBytes > 0, 'nothing was replayed after the host restart');
    const at = after.chunks.length;
    await sleep(300);
    assert.ok(after.chunks.length > at, 'no live output arrived after the host restart');
    after.close();
  } finally {
    await host.stop();
  }
});

test('criterion 6: ended, undetermined and live are three different answers with three reasons', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);
  const shell = findShell();
  if (!shell) return t.skip('no POSIX shell could be found on this machine');

  const host = await startHost();
  try {
    const prog = counterProgram(10);
    const live = await newSession(host, prog.command, prog.args);
    const ended = await newSession(host, shell, ['-c', 'exit 3']);
    const lost = await newSession(host, prog.command, prog.args);
    await sleep(1200);

    // The one whose supervisor was killed without warning: nothing recorded how it ended.
    const meta = JSON.parse(readFileSync(sessionMetaFile(lost, { OMA_STATE_DIR: host.dir }), 'utf8')) as {
      supervisorPid: number;
    };
    process.kill(meta.supervisorPid, 'SIGKILL');
    await sleep(400);

    const list = (await host.api('GET', '/api/sessions')).json.sessions as any[];
    const byId = (id: string): any => list.find((s) => s.id === id);

    assert.equal(byId(live).state, 'live');
    assert.equal(byId(ended).state, 'terminated');
    assert.equal(byId(lost).state, 'undetermined');

    // THE REASON IS THERE, AND IT IS THE REASON. An ended session says how it ended.
    assert.match(byId(ended).reason, /status 3/, 'the ended session did not say why it ended');
    assert.equal(byId(ended).exitCode, 3);

    // The undetermined one says, in words, that it cannot be told — not that it ended.
    assert.match(byId(lost).reason, /CANNOT BE DETERMINED/);
    assert.ok(!/exited normally/.test(byId(lost).reason), 'an undetermined session was given an invented reason');
    assert.equal(byId(lost).endedAt, undefined, 'an undetermined session was given an end time it does not have');

    // NONE OF THE THREE RENDERS AS ANOTHER.
    const states = new Set([byId(live).state, byId(ended).state, byId(lost).state]);
    assert.equal(states.size, 3);
    assert.equal(byId(live).alive, true);
    assert.equal(byId(ended).alive, false);
    assert.equal(byId(lost).alive, false);

    // And the CLI prints them as three different things.
    const printed = await host.cli(['sessions']);
    assert.match(printed.stdout, /^LIVE/m);
    assert.match(printed.stdout, /^ENDED/m);
    assert.match(printed.stdout, /^UNDETERMINED/m);

    // Attaching to a session that ended does not look like attaching to a live one.
    const deadClient = await attachClient(host.port, ended);
    const notLive = await deadClient.waitForEvent('not-live');
    assert.equal(notLive.state, 'terminated');
    assert.match(notLive.reason, /status 3/);
    assert.equal(deadClient.events.filter((e) => e.type === 'attached').length, 0, 'an ended session reported itself attached');
  } finally {
    await host.stop();
  }
});

test('a session whose meta record is unreadable is not counted as anything', async (t) => {
  const skip = skipIfNoPty();
  if (skip) return t.skip(skip);

  const host = await startHost();
  try {
    const prog = counterProgram(20);
    const id = await newSession(host, prog.command, prog.args);
    await sleep(400);
    writeFileSync(sessionMetaFile(id, { OMA_STATE_DIR: host.dir }), 'this is not json\n');

    const list = (await host.api('GET', '/api/sessions')).json.sessions as any[];
    assert.equal(list.find((s) => s.id === id), undefined, 'a session with an unreadable record was listed anyway');

    const one = await host.api('GET', `/api/sessions/${id}`);
    assert.equal(one.status, 404);
  } finally {
    await host.stop();
  }
});
