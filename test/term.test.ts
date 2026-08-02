// CRITERION 7 — "Output containing terminal control sequences, colour and redraws renders as the
// agent intended rather than as escape-code text."
//
// The renderer is browser code with no build step, so it is loaded here as source and evaluated
// against a DOM small enough to be obviously correct. That is the honest way to test it without
// taking on a headless-browser dependency for one file: the parser and the screen buffer — the part
// that decides what a person sees — are exercised in full, and the CSS layout is asserted
// structurally in test/session-web.test.ts and was measured by hand in a real browser at 375×812.
//
// THE ASSERTION THAT MATTERS MOST IS THE LAST ONE: no escape sequence, implemented or not, ever
// reaches the screen as text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'term.js'),
  'utf8',
);

// ── A DOM with exactly the four operations term.js uses. ────────────────────────────────────────
interface FakeNode {
  nodeText: string;
  style: Record<string, string>;
  children: FakeNode[];
  className: string;
  textContent: string;
  appendChild(n: FakeNode): void;
  replaceChildren(n?: FakeNode): void;
}

function makeNode(text = ''): FakeNode {
  const node: FakeNode = {
    nodeText: text,
    style: {},
    children: [],
    className: '',
    textContent: text,
    appendChild(child) {
      node.children.push(child);
    },
    replaceChildren(child) {
      node.children = child ? [child] : [];
    },
  };
  return node;
}

function flatten(node: FakeNode): string {
  if (node.children.length === 0) return node.textContent || node.nodeText;
  return node.children.map(flatten).join(node.className === 'trow' ? '' : '');
}

function lines(node: FakeNode): string[] {
  const rows: FakeNode[] = [];
  const walk = (n: FakeNode): void => {
    if (n.className === 'trow') rows.push(n);
    else n.children.forEach(walk);
  };
  walk(node);
  return rows.map((r) => flatten(r).replace(/\s+$/, ''));
}

function loadTerminal(): { Terminal: any; document: any } {
  const document = {
    createElement: (_tag: string) => makeNode(),
    createTextNode: (text: string) => makeNode(text),
    createDocumentFragment: () => makeNode(),
    body: makeNode(),
  };
  const window: Record<string, unknown> = { document, TextDecoder };
  const context = vm.createContext({ window, document, TextDecoder, console });
  vm.runInContext(SOURCE, context);
  return { Terminal: (window as any).OmaTerminal, document };
}

function screenOf(text: string, cols = 20, rows = 6): string[] {
  const { Terminal } = loadTerminal();
  const term = new Terminal(cols, rows);
  term.write(text);
  const into = makeNode();
  term.render(into);
  return lines(into);
}

// A pseudo-terminal emits CRLF, not LF: a bare line feed moves DOWN and keeps the column, which is
// what a real terminal does and what these tests therefore assert against.
test('plain text lands on the screen', () => {
  assert.deepEqual(screenOf('hello\r\nworld').slice(0, 2), ['hello', 'world']);
});

test('a carriage return rewrites the line it is on — the commonest redraw there is', () => {
  // A progress indicator: three writes, one visible line, and the last one wins.
  assert.equal(screenOf('10%\r50%\r100%')[0], '100%');
});

test('backspace and overwrite behave as a terminal, not as text', () => {
  assert.equal(screenOf('abcd\b\bXY')[0], 'abXY');
});

test('a cursor-addressed redraw puts characters where the agent aimed them', () => {
  const out = screenOf('\x1b[2J\x1b[1;1HTOP\x1b[3;5HDEEP');
  assert.equal(out[0], 'TOP');
  assert.equal(out[2], '    DEEP');
});

test('erase-in-line and erase-in-display clear what they say they clear', () => {
  assert.equal(screenOf('abcdef\x1b[4G\x1b[K')[0], 'abc');
  assert.equal(screenOf('keep\r\ngone\x1b[1;1H\x1b[J')[0], '');
  assert.equal(screenOf('one\r\ntwo\x1b[2J')[0], '');
});

test('colour becomes colour, not the digits that asked for it', () => {
  const { Terminal } = loadTerminal();
  const term = new Terminal(20, 3);
  term.write('\x1b[31mRED\x1b[0m plain \x1b[1;38;5;46mBRIGHT\x1b[0m');
  const into = makeNode();
  term.render(into);

  const flat = lines(into)[0]!;
  assert.equal(flat, 'RED plain BRIGHT');
  assert.ok(!/\[31m|38;5;46/.test(flat), 'an SGR sequence reached the screen as text');

  // And the styling actually got applied to the right run.
  const spans: FakeNode[] = [];
  const walk = (n: FakeNode): void => {
    if (Object.keys(n.style).length > 0) spans.push(n);
    n.children.forEach(walk);
  };
  walk(into);
  const red = spans.find((s) => s.textContent === 'RED');
  assert.ok(red, 'the red run was not styled at all');
  assert.equal(red!.style.color, '#d34a4a');
  const bright = spans.find((s) => s.textContent === 'BRIGHT');
  assert.ok(bright, 'the 256-colour run was not styled');
  assert.equal(bright!.style.fontWeight, '700');
  assert.match(bright!.style.color!, /^rgb\(/);
});

test('lines that scroll off the top are kept as scrollback, in order', () => {
  const out = screenOf('a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh', 20, 3);
  assert.deepEqual(out.slice(0, 4), ['a', 'b', 'c', 'd']);
  assert.equal(out[out.length - 1], 'h');
});

test('output wraps at the right margin instead of running off it', () => {
  const out = screenOf('abcdefghij', 4, 4);
  assert.deepEqual(out.slice(0, 3), ['abcd', 'efgh', 'ij']);
});

test('a UTF-8 character split across two chunks is one character, not two replacements', () => {
  const { Terminal } = loadTerminal();
  const term = new Terminal(10, 2);
  const bytes = Buffer.from('é☃', 'utf8');
  term.writeBytes(new Uint8Array(bytes.subarray(0, 3)));
  term.writeBytes(new Uint8Array(bytes.subarray(3)));
  const into = makeNode();
  term.render(into);
  assert.equal(lines(into)[0], 'é☃');
});

test('NO SEQUENCE, IMPLEMENTED OR NOT, EVER REACHES THE SCREEN AS TEXT', () => {
  // A deliberately hostile mix: private modes, the alternate screen, bracketed paste, mouse
  // reporting, an OSC window title, a DCS string, a scroll region, a device query, and a charset
  // selection. Every one of these is either implemented or explicitly swallowed; none may print.
  const noisy =
    '\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b]0;a window title\x07' +
    '\x1bP+q544e\x1b\\\x1b[1;24r\x1b[6n\x1b(B\x1b[>4;2m\x1b[?25l' +
    'VISIBLE' +
    '\x1b[?25h\x1b[?1049l\x1b[?2004l';
  const out = screenOf(noisy).join('\n');
  assert.equal(out.replace(/\n+$/, ''), 'VISIBLE');
  assert.ok(!/\x1b/.test(out), 'an escape character reached the screen');
  assert.ok(!/\[\?|\d+;\d+[rmH]|window title|544e/.test(out), `escape-code text reached the screen: ${JSON.stringify(out)}`);
});

test('agent output can never become markup', () => {
  const out = screenOf('<img src=x onerror=alert(1)>', 40, 3).join('');
  // It is rendered as the characters the agent emitted. The renderer uses textContent throughout,
  // which is asserted structurally here and in the source: there is no innerHTML in term.js.
  assert.match(out, /<img src=x onerror=alert\(1\)>/);
  // The structural check is for USE of the property — an assignment or a member access — and not
  // for the word, which also occurs in the comment above `styled()` explaining that it is not used.
  // A bare `/innerHTML/` here fails on its own documentation and would be "fixed" by deleting the
  // sentence that tells the next person why textContent matters.
  const uses = SOURCE.match(/\.innerHTML|\binnerHTML\s*=|\[['"]innerHTML['"]\]/g);
  assert.equal(uses, null, `term.js uses innerHTML: ${JSON.stringify(uses)}`);
  // And the way it does put text on the screen is the safe one.
  assert.match(SOURCE, /textContent/, 'term.js does not set textContent anywhere');
});
