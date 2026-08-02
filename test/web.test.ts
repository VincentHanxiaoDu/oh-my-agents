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
  // `button`, `a` and `summary` are covered by the ONE shared rule. Any other interactive element
  // type has to bring its own rule that uses the same variable — Issue #3 added a text input for a
  // peer address, and it is listed here WITH the selector that sizes it, so an input added without
  // one still fails.
  const sizedSeparately: Record<string, RegExp> = {
    input: /\.joiner input\s*\{[^}]*min-height:\s*var\(--tap\)/,
  };
  const interactive = [...html.matchAll(/<(button|a|summary|input|select|textarea)\b/g)].map((m) => m[1]);
  for (const tag of interactive) {
    if (tag === 'button' || tag === 'summary' || tag === 'a') continue;
    const rule = sizedSeparately[tag!];
    assert.ok(rule, `<${tag}> is interactive and is not covered by the 44px rule — either size it or remove it`);
    assert.match(html, rule, `<${tag}> has a rule for it, and that rule does not reach the 44px floor`);
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

test('the client needs no build step: no bundler, no external request', () => {
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'the page loads an external stylesheet');
  // NO EXTERNAL REQUEST. This is the property that matters and it is asserted directly: nothing on
  // this page may be fetched from anywhere but the host that served it.
  const external = html.match(/(?:src|href)="(?:https?:)?\/\/[^"]+"/g) ?? [];
  assert.deepEqual(external, [], `the page must fetch nothing from another origin, found ${external.join(', ')}`);

  // NO BUILD STEP. Issue #3 added a module import, and a module import is not a build step — the
  // browser resolves it, this host serves the file as written, and `scripts/copy-web.mjs` copies it
  // verbatim. What WOULD be a build step is a bundler, a transform, or an import the browser cannot
  // resolve on its own, and those are what is forbidden here.
  for (const spec of [...html.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]!)) {
    assert.ok(
      spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/'),
      `${spec} is a bare specifier; a browser cannot resolve one without a bundler or an import map`,
    );
    assert.ok(spec.endsWith('.js'), `${spec} must name a real file this host serves`);
  }
  assert.ok(!/\b(webpack|rollup|vite|esbuild|parcel|browserify)\b/i.test(html), 'the page references a bundler');
});
