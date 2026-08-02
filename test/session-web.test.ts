// CRITERION 8 for the surfaces Issue #2 adds — the session list and the terminal.
//
// The same honesty as test/web.test.ts: this reads the shipped source and checks what is DECIDABLE
// from it. It does not lay the page out. The layout was measured by hand in a real browser at
// 375×812 and the result is recorded in the pull request. A structural check plus a recorded manual
// measurement is honest; a structural check described as "verified on a phone" would not be.
//
// A terminal is the hardest surface in this product to hold to a 375px viewport, because a terminal
// is 80 columns wide and a phone is not. The rules asserted below are what keep it inside: the pane
// scrolls in its own box, never the page, and the font is fitted to the pane at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
const html = readFileSync(path.join(webDir, 'session.html'), 'utf8');
const js = readFileSync(path.join(webDir, 'session.js'), 'utf8');
const index = readFileSync(path.join(webDir, 'index.html'), 'utf8');

test('the page declares the device width, so 375px means 375px', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*width=device-width[^"]*"/);
  assert.match(html, /initial-scale=1/);
});

test('no interactive element type is styled below the 44px tap floor', () => {
  assert.match(html, /--tap:\s*44px/);
  const rule = /button,\s*a\.btn,\s*summary,\s*input,\s*select,\s*textarea\s*\{([^}]*)\}/.exec(html);
  assert.ok(rule, 'the interactive-element rule was not found — it may have been renamed');
  assert.match(rule![1]!, /min-height:\s*var\(--tap\)/);
  assert.match(rule![1]!, /min-width:\s*var\(--tap\)/);
});

test('every interactive element in the markup is one that rule covers', () => {
  const interactive = [...html.matchAll(/<(button|a|summary|input|select|textarea)\b/g)].map((m) => m[1]);
  const covered = ['button', 'a', 'summary', 'input', 'select', 'textarea'];
  for (const tag of interactive) {
    assert.ok(covered.includes(tag!), `<${tag}> is interactive and is not covered by the 44px rule`);
  }
  // The controls criteria 2 and 4 require are actually on the page.
  assert.match(html, /id="send"/);
  assert.match(html, /id="interrupt"/);
  assert.match(html, /id="input"/);
});

test('nothing on either new surface requires hover, right-click or drag', () => {
  for (const [name, source] of [['session.html', html], ['session.js', js]] as const) {
    assert.ok(!/:hover/.test(source), `${name} has a :hover rule; a phone has no hover`);
    assert.ok(!/contextmenu/.test(source), `${name} has a right-click handler`);
    assert.ok(!/dragstart|draggable|ondrop|dragover/.test(source), `${name} has a drag interaction`);
    assert.ok(!/mouseover|mouseenter|dblclick/.test(source), `${name} has a pointer-only handler`);
  }
  assert.match(html, /:focus-visible/);
});

test('the page never scrolls sideways: the terminal scrolls inside its own box', () => {
  assert.match(html, /overflow-x:\s*hidden/);
  const screen = /#screen\s*\{([^}]*)\}/.exec(html);
  assert.ok(screen, 'the terminal pane rule was not found');
  assert.match(screen![1]!, /overflow:\s*auto/);
  assert.match(screen![1]!, /max-width:\s*100%/);
  // And the font is fitted to the pane at runtime rather than left at a size that forces the
  // sideways scroll this criterion is about.
  assert.match(js, /fitFont/);
  assert.match(js, /DEFAULT_COLS/);
});

test('the three session states are three different things to look at, not one word', () => {
  // Criterion 6 reaching the surface: a live, an ended and an undetermined session must not be
  // presented identically. Three CSS classes, and a reason shown for both non-live states.
  assert.match(html, /\.pill\.live/);
  assert.match(html, /\.pill\.terminated/);
  assert.match(html, /\.pill\.undetermined/);
  assert.match(js, /s\.state !== 'live'[\s\S]{0,200}s\.reason/);
  assert.match(js, /CANNOT BE DETERMINED/);
  assert.match(js, /THIS SESSION HAS ENDED/);
});

test('a dropped connection is not reported as an ended session', () => {
  // The failure this guards against is a page that says "the session ended" when the train went
  // into a tunnel. Criterion 5: detaching does not stop the agent.
  assert.match(js, /ws\.onclose[\s\S]{0,400}still running/);
});

test('the client polls nothing while attached', () => {
  // Criterion 1 is "without the person reloading or polling". A timer in the attached view would
  // be exactly that, whether or not the output happened to look live.
  assert.ok(!/setInterval\s*\(/.test(js), 'the client polls on a timer');
  assert.match(js, /new WebSocket/);
});

test('the client is served as written: no bundler, no import, no external host', () => {
  for (const [name, source] of [['session.html', html], ['session.js', js]] as const) {
    // No src=, href= or url() pointing off this host. The one absolute URL in the page is the SVG
    // XML namespace, which is an identifier and not a request.
    const external = [...source.matchAll(/(?:src|href)="(https?:)?\/\/[^"]*/g)].map((m) => m[0]);
    assert.deepEqual(external, [], `${name} references an external URL: ${external.join(', ')}`);
    assert.ok(!/\bimport\s+[\w{*]/.test(source), `${name} uses module imports`);
  }
  // The two scripts it does load are its own, served off this host with no build step.
  assert.match(html, /<script src="term\.js"><\/script>/);
  assert.match(html, /<script src="session\.js"><\/script>/);
});

test('the first page links to this one, and that is the whole of Issue #2’s edit to it', () => {
  assert.match(index, /href="\/session\.html"/);
  // The stale "not built yet" note is gone: a page that says a built capability is not built is a
  // lie of the same kind as a stub that returns a plausible value.
  assert.ok(!/Issue&nbsp;#2 and is not built yet/.test(index));
});
