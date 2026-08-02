// CRITERION 9 — the surfaces this capability adds, at 375px.
//
// Same honesty as Issue #1's test/web.test.ts, and for the same reason: this checks what is
// DECIDABLE FROM THE SOURCE — the viewport declaration, the 44px floor on every interactive element
// type each page actually uses, the absence of hover-only / right-click-only / drag-only
// interaction, and the wrapping that stops long content widening the page. It does NOT lay the page
// out. The layout was measured by hand in a real browser at 375x812 and the result is recorded in
// the pull request. A structural check plus a recorded manual measurement is honest; calling a
// structural check "verified on a phone" would not be.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
const PAGES = ['pair.html', 'devices.html'] as const;
const source = Object.fromEntries(PAGES.map((p) => [p, readFileSync(path.join(WEB, p), 'utf8')])) as Record<string, string>;

for (const page of PAGES) {
  const html = source[page]!;

  test(`${page} declares the device width, so 375px means 375px`, () => {
    assert.match(html, /<meta name="viewport" content="[^"]*width=device-width[^"]*"/);
    assert.match(html, /initial-scale=1/);
  });

  test(`${page} styles no interactive element type below the 44px tap floor`, () => {
    assert.match(html, /--tap:\s*44px/);
    const rule = /button,\s*a\.btn,\s*summary\s*\{([^}]*)\}/.exec(html);
    assert.ok(rule, 'the interactive-element rule was not found — it may have been renamed');
    assert.match(rule![1]!, /min-height:\s*var\(--tap\)/);
    assert.match(rule![1]!, /min-width:\s*var\(--tap\)/);
  });

  test(`every interactive element in ${page} is covered by a rule at or above 44px`, () => {
    const tags = [...html.matchAll(/<(button|a|summary|input|select|textarea)\b/g)].map((m) => m[1]!);
    assert.ok(tags.length > 0, 'the page has no interactive elements, so this test proved nothing');
    for (const tag of tags) {
      if (tag === 'button' || tag === 'summary') continue;
      if (tag === 'a') {
        // Every anchor that is a TARGET carries .btn, which the 44px rule covers. An anchor
        // without it would be an inline link under the floor, which is what this catches.
        continue;
      }
      // The only other interactive element these pages use is the code field, and it is sized
      // explicitly above the floor rather than relying on the shared rule.
      assert.equal(tag, 'input', `<${tag}> is interactive and nothing here sizes it`);
      const rule = /input\[type="text"\]\s*\{([^}]*)\}/.exec(html);
      assert.ok(rule, 'a text input is present with no rule sizing it');
      const min = /min-height:\s*(\d+)px/.exec(rule![1]!);
      assert.ok(min, 'the text input has no min-height');
      assert.ok(Number(min![1]) >= 44, `the text input is ${min![1]}px tall, below the 44px floor`);
    }
  });

  test(`every anchor in ${page} that acts as a target carries .btn`, () => {
    for (const m of html.matchAll(/<a\s([^>]*)>/g)) {
      assert.match(m[1]!, /class="btn"/, `an anchor in ${page} is not sized: <a ${m[1]}>`);
    }
  });

  test(`nothing in ${page} requires hover, right-click or drag`, () => {
    assert.ok(!/:hover/.test(html), 'a :hover rule is present; a phone has no hover');
    assert.ok(!/oncontextmenu|contextmenu/.test(html), 'a right-click handler is present');
    assert.ok(!/dragstart|draggable|ondrop|dragover/.test(html), 'a drag interaction is present');
    assert.ok(!/onmouseover|onmouseenter/.test(html), 'a mouse-only handler is present');
    // A long-press is a pointer gesture too, and it is the tempting way to confirm a revoke.
    assert.ok(!/touchstart|pointerdown|longpress/.test(html), 'a press-and-hold interaction is present');
    assert.match(html, /:focus-visible/);
  });

  test(`long content in ${page} wraps or scrolls in its own box`, () => {
    assert.match(html, /overflow-x:\s*hidden/);
    assert.match(html, /overflow-wrap:\s*anywhere/);
    assert.match(html, /\.scroll-x\s*\{[^}]*overflow-x:\s*auto/);
  });

  test(`${page} needs no build step and makes no external request`, () => {
    assert.ok(!/<script[^>]+src=/.test(html), 'the page loads an external script');
    assert.ok(!/<link[^>]+stylesheet/.test(html), 'the page loads an external stylesheet');
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'the page references an external origin');
  });
}

// CRITERION 6, at the level of the file that is served to an unpaired device.
test('the pairing prompt itself names nothing about what is running', () => {
  const html = source['pair.html']!;
  for (const forbidden of ['sessionCount', '/api/status', '/api/devices', 'tailnetAddresses']) {
    assert.ok(!html.includes(forbidden), `the pairing prompt references ${forbidden}`);
  }
  // The only host endpoint it talks to is the one that turns an unpaired device into a paired one.
  const fetched = [...html.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(fetched, ['/api/pair']);
});

test('the revoke control asks twice, and the second tap is the same size as the first', () => {
  const html = source['devices.html']!;
  assert.match(html, /Tap again to revoke/);
  const rule = /\.revoke\s*\{([^}]*)\}/.exec(html);
  assert.ok(rule, '.revoke rule not found');
  const min = /min-height:\s*(\d+)px/.exec(rule![1]!);
  assert.ok(min && Number(min[1]) >= 44, 'the revoke target is below the 44px floor');
  assert.match(rule![1]!, /width:\s*100%/);
});

// The main page must send a revoked device back to the prompt (criterion 5).
test('the main page returns a device to the pairing prompt when it is no longer recognised', () => {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.match(html, /res\.status === 404/);
  assert.match(html, /location\.assign\('\/pair'\)/);
});
