// CRITERION 8 — the human-facing surface at 375px.
//
// WHAT THIS TEST CAN AND CANNOT DO, STATED RATHER THAN IMPLIED. It reads the shipped HTML and
// checks the properties that are decidable from the source: the viewport declaration, the 44px
// floor on every interactive element type the page uses, the absence of hover-only, right-click-only
// or drag-only interaction, and the wrapping rules that stop a long address widening the page.
//
// It does NOT lay the page out — that needs a browser, which is not a dependency this project is
// taking on for one assertion. The layout was measured by hand in a real browser at 375x812 and
// the result is recorded in the pull request. A structural check plus a recorded manual measurement
// is honest; a structural check described as "verified on a phone" would not be.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'index.html'),
  'utf8',
);

test('the page declares the device width, so 375px means 375px', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*width=device-width[^"]*"/);
  assert.match(html, /initial-scale=1/);
});

test('no interactive element type is styled below the 44px tap floor', () => {
  assert.match(html, /--tap:\s*44px/);
  // The one rule that styles every interactive element on this page must use the variable for both
  // dimensions. If a rule is added that styles a button without it, this assertion is what notices.
  const rule = /button,\s*a\.btn,\s*summary\s*\{([^}]*)\}/.exec(html);
  assert.ok(rule, 'the interactive-element rule was not found — it may have been renamed');
  assert.match(rule![1]!, /min-height:\s*var\(--tap\)/);
  assert.match(rule![1]!, /min-width:\s*var\(--tap\)/);
});

test('every interactive element in the markup is one the 44px rule covers', () => {
  const interactive = [...html.matchAll(/<(button|a|summary|input|select|textarea)\b/g)].map((m) => m[1]);
  for (const tag of interactive) {
    assert.ok(
      tag === 'button' || tag === 'summary' || tag === 'a',
      `<${tag}> is interactive and is not covered by the 44px rule — either size it or remove it`,
    );
  }
  assert.ok(interactive.length > 0, 'the page has no interactive elements, so this test proved nothing');
});

test('nothing on the page requires hover, right-click or drag', () => {
  assert.ok(!/:hover/.test(html), 'a :hover rule is present; a phone has no hover');
  assert.ok(!/oncontextmenu|contextmenu/.test(html), 'a right-click handler is present');
  assert.ok(!/dragstart|draggable|ondrop|dragover/.test(html), 'a drag interaction is present');
  assert.ok(!/onmouseover|onmouseenter/.test(html), 'a mouse-only handler is present');
  // Focus, which a keyboard and a tap both produce, is styled — so the page is navigable without a
  // pointer as well as with one.
  assert.match(html, /:focus-visible/);
});

test('long content wraps or scrolls in its own box, so the page never scrolls sideways', () => {
  assert.match(html, /overflow-x:\s*hidden/);
  assert.match(html, /overflow-wrap:\s*anywhere/);
  // The address is the longest single token the page shows, and it is the one that would widen it.
  const addr = /\.addr\s*\{([^}]*)\}/.exec(html);
  assert.ok(addr, '.addr rule not found');
  assert.match(addr![1]!, /overflow-wrap:\s*anywhere/);
  assert.match(html, /\.scroll-x\s*\{[^}]*overflow-x:\s*auto/);
});

test('the client needs no build step: no imports, no bundler references', () => {
  assert.ok(!/<script[^>]+src=/.test(html), 'the page loads an external script; it must be self-contained');
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'the page loads an external stylesheet');
  assert.ok(!/\btype="module"/.test(html) || !/from ['"]/.test(html), 'the page uses module imports');
});
