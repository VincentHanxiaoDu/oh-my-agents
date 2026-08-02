// A terminal screen, in the browser, with no build step and no dependency.
//
// CRITERION 7 IS "OUTPUT CONTAINING TERMINAL CONTROL SEQUENCES, COLOUR AND REDRAWS RENDERS AS THE
// AGENT INTENDED RATHER THAN AS ESCAPE-CODE TEXT". That is a statement about what a person sees,
// and the only way to satisfy it is to interpret the sequences instead of printing them. So this is
// a screen buffer — a grid of cells with attributes, a cursor, and a parser that moves both.
//
// WHERE THE LINE IS DRAWN AGAINST ISSUE #6. #6 owns "the renderer", specifically the native
// rendering of an agent's interactive prompts, and it STACKS ON THIS. What is here is the part
// criterion 7 names and no more: SGR colour and style, cursor movement, erase, scrolling, line
// editing, and the C0 controls. What is deliberately NOT here, and is #6's to decide:
//
//   * the alternate screen buffer (`?1049h`) — recognised and IGNORED, so a full-screen app draws
//     over the primary screen rather than being lost. Whether a phone should switch buffers at all
//     is a product question, not a parsing one.
//   * mouse reporting, bracketed paste, focus events — recognised and ignored.
//   * scroll regions (DECSTBM) — recognised and ignored.
//   * any special-casing of a particular agent's prompt widget. That is exactly #6.
//
// The rule this file follows without exception: A SEQUENCE THIS RENDERER DOES NOT IMPLEMENT IS
// SWALLOWED, NEVER PRINTED. Printing it is the failure criterion 7 describes, and an unimplemented
// sequence that leaks two characters of garbage is worse than one that does nothing.

(function (global) {
  'use strict';

  var DEFAULT_COLS = 80;
  var DEFAULT_ROWS = 24;
  /** How many lines that have scrolled off the top are kept. Bounded, so a long session is not a leak. */
  var MAX_SCROLLBACK_LINES = 2000;

  // The xterm 16-colour palette, as CSS. Bright variants are the second eight.
  var PALETTE = [
    '#1c1f26', '#d34a4a', '#3f9a55', '#b58900', '#3a76d8', '#a45cc4', '#2f9fa8', '#c9cdd6',
    '#5c6370', '#ff6b6b', '#5cc97a', '#e0b13a', '#6fa4ff', '#c98ae0', '#4fc7d0', '#ffffff',
  ];

  function cube(n) {
    // xterm 256: 16..231 is a 6×6×6 cube, 232..255 is a greyscale ramp.
    if (n < 16) return PALETTE[n];
    if (n < 232) {
      var i = n - 16;
      var steps = [0, 95, 135, 175, 215, 255];
      return 'rgb(' + steps[Math.floor(i / 36) % 6] + ',' + steps[Math.floor(i / 6) % 6] + ',' + steps[i % 6] + ')';
    }
    var v = 8 + (n - 232) * 10;
    return 'rgb(' + v + ',' + v + ',' + v + ')';
  }

  function blankAttr() {
    return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, hidden: false };
  }

  function sameAttr(a, b) {
    return (
      a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim &&
      a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse && a.hidden === b.hidden
    );
  }

  function blankLine(cols) {
    var line = new Array(cols);
    for (var i = 0; i < cols; i++) line[i] = { ch: ' ', attr: blankAttr() };
    return line;
  }

  function Terminal(cols, rows) {
    this.cols = cols || DEFAULT_COLS;
    this.rows = rows || DEFAULT_ROWS;
    this.screen = [];
    for (var i = 0; i < this.rows; i++) this.screen.push(blankLine(this.cols));
    this.scrollback = [];
    this.x = 0;
    this.y = 0;
    this.savedX = 0;
    this.savedY = 0;
    this.attr = blankAttr();
    this.state = 'ground';
    this.params = '';
    this.intermediate = '';
    this.stringBuf = '';
    this.pendingWrap = false;
    // A UTF-8 decoder that keeps partial sequences between chunks. PTY output arrives in whatever
    // sizes the kernel chose, and a multi-byte character split across two chunks would otherwise
    // render as two replacement characters.
    this.decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
  }

  Terminal.prototype.writeBytes = function (bytes) {
    var text = this.decoder ? this.decoder.decode(bytes, { stream: true }) : String.fromCharCode.apply(null, bytes);
    this.write(text);
  };

  Terminal.prototype.write = function (text) {
    for (var i = 0; i < text.length; i++) this.consume(text[i]);
  };

  Terminal.prototype.consume = function (c) {
    var code = c.charCodeAt(0);

    switch (this.state) {
      case 'esc':
        if (c === '[') { this.state = 'csi'; this.params = ''; this.intermediate = ''; return; }
        if (c === ']') { this.state = 'osc'; this.stringBuf = ''; return; }
        // DCS, SOS, PM, APC: string sequences, consumed to their terminator and discarded.
        if (c === 'P' || c === 'X' || c === '^' || c === '_') { this.state = 'string'; this.stringBuf = ''; return; }
        if (c === '(' || c === ')' || c === '*' || c === '+') { this.state = 'charset'; return; }
        if (c === '7') { this.savedX = this.x; this.savedY = this.y; this.state = 'ground'; return; }
        if (c === '8') { this.x = this.savedX; this.y = this.savedY; this.state = 'ground'; return; }
        if (c === 'M') { this.reverseIndex(); this.state = 'ground'; return; }
        if (c === 'D') { this.lineFeed(); this.state = 'ground'; return; }
        if (c === 'E') { this.x = 0; this.lineFeed(); this.state = 'ground'; return; }
        if (c === 'c') { this.reset(); this.state = 'ground'; return; }
        // Anything else after ESC is swallowed, not printed.
        this.state = 'ground';
        return;

      case 'charset':
        this.state = 'ground';
        return;

      case 'csi':
        if (code >= 0x30 && code <= 0x3f) { this.params += c; return; }
        if (code >= 0x20 && code <= 0x2f) { this.intermediate += c; return; }
        this.csi(c);
        this.state = 'ground';
        return;

      case 'osc':
        // Terminated by BEL or by ESC \. The payload — a window title, a colour query, a
        // hyperlink — has nowhere to go on this surface, so it is dropped rather than printed.
        if (code === 0x07) { this.state = 'ground'; return; }
        if (code === 0x1b) { this.state = 'osc-esc'; return; }
        this.stringBuf += c;
        return;

      case 'osc-esc':
      case 'string-esc':
        this.state = 'ground';
        return;

      case 'string':
        if (code === 0x1b) { this.state = 'string-esc'; return; }
        return;
    }

    // GROUND
    if (code === 0x1b) { this.state = 'esc'; return; }
    if (code === 0x0a || code === 0x0b || code === 0x0c) { this.lineFeed(); return; }
    if (code === 0x0d) { this.x = 0; this.pendingWrap = false; return; }
    if (code === 0x08) { this.x = Math.max(0, this.x - 1); this.pendingWrap = false; return; }
    if (code === 0x09) { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); return; }
    // BEL and the remaining C0 controls: no bell on a phone, and nothing to print.
    if (code < 0x20 || code === 0x7f) return;

    this.putChar(c);
  };

  Terminal.prototype.putChar = function (c) {
    if (this.pendingWrap) {
      this.x = 0;
      this.lineFeed();
      this.pendingWrap = false;
    }
    var line = this.screen[this.y];
    if (!line) return;
    line[this.x] = { ch: c, attr: this.attr };
    if (this.x === this.cols - 1) this.pendingWrap = true;
    else this.x++;
  };

  Terminal.prototype.lineFeed = function () {
    this.pendingWrap = false;
    this.y++;
    if (this.y >= this.rows) {
      this.y = this.rows - 1;
      var gone = this.screen.shift();
      this.scrollback.push(gone);
      if (this.scrollback.length > MAX_SCROLLBACK_LINES) this.scrollback.shift();
      this.screen.push(blankLine(this.cols));
    }
  };

  Terminal.prototype.reverseIndex = function () {
    if (this.y === 0) {
      this.screen.pop();
      this.screen.unshift(blankLine(this.cols));
    } else {
      this.y--;
    }
  };

  Terminal.prototype.reset = function () {
    this.screen = [];
    for (var i = 0; i < this.rows; i++) this.screen.push(blankLine(this.cols));
    this.x = 0;
    this.y = 0;
    this.attr = blankAttr();
  };

  Terminal.prototype.nums = function (fallback) {
    var raw = this.params.replace(/^[?<>=]/, '');
    if (raw === '') return [fallback];
    return raw.split(';').map(function (p) {
      var n = parseInt(p, 10);
      return isNaN(n) ? fallback : n;
    });
  };

  Terminal.prototype.csi = function (final) {
    var priv = this.params.charAt(0) === '?';
    var p = this.nums(0);
    var n = p[0] || 0;
    var self = this;

    // Private modes: cursor visibility, the alternate screen, bracketed paste, mouse reporting.
    // ALL RECOGNISED AND IGNORED — see the note at the top of this file. Recognising them is what
    // stops `[?2004h` appearing as text in somebody's session.
    if (priv && (final === 'h' || final === 'l')) return;

    switch (final) {
      case 'A': this.y = Math.max(0, this.y - Math.max(1, n)); this.pendingWrap = false; return;
      case 'B': this.y = Math.min(this.rows - 1, this.y + Math.max(1, n)); this.pendingWrap = false; return;
      case 'C': this.x = Math.min(this.cols - 1, this.x + Math.max(1, n)); this.pendingWrap = false; return;
      case 'D': this.x = Math.max(0, this.x - Math.max(1, n)); this.pendingWrap = false; return;
      case 'E': this.x = 0; this.y = Math.min(this.rows - 1, this.y + Math.max(1, n)); return;
      case 'F': this.x = 0; this.y = Math.max(0, this.y - Math.max(1, n)); return;
      case 'G': case '`': this.x = Math.min(this.cols - 1, Math.max(0, Math.max(1, n) - 1)); return;
      case 'd': this.y = Math.min(this.rows - 1, Math.max(0, Math.max(1, n) - 1)); return;
      case 'H': case 'f': {
        var row = Math.max(1, p[0] || 1);
        var col = Math.max(1, p[1] || 1);
        this.y = Math.min(this.rows - 1, row - 1);
        this.x = Math.min(this.cols - 1, col - 1);
        this.pendingWrap = false;
        return;
      }
      case 'J': this.eraseInDisplay(n); return;
      case 'K': this.eraseInLine(n); return;
      case 'L': {
        for (var li = 0; li < Math.max(1, n); li++) {
          this.screen.splice(this.y, 0, blankLine(this.cols));
          this.screen.splice(this.rows, 1);
        }
        return;
      }
      case 'M': {
        for (var mi = 0; mi < Math.max(1, n); mi++) {
          this.screen.splice(this.y, 1);
          this.screen.splice(this.rows - 1, 0, blankLine(this.cols));
        }
        return;
      }
      case 'P': {
        var pl = this.screen[this.y];
        if (!pl) return;
        for (var pi = 0; pi < Math.max(1, n); pi++) {
          pl.splice(this.x, 1);
          pl.push({ ch: ' ', attr: blankAttr() });
        }
        return;
      }
      case '@': {
        var al = this.screen[this.y];
        if (!al) return;
        for (var ai = 0; ai < Math.max(1, n); ai++) {
          al.splice(this.x, 0, { ch: ' ', attr: blankAttr() });
          al.pop();
        }
        return;
      }
      case 'X': {
        var xl = this.screen[this.y];
        if (!xl) return;
        for (var xi = 0; xi < Math.max(1, n) && this.x + xi < this.cols; xi++) {
          xl[this.x + xi] = { ch: ' ', attr: blankAttr() };
        }
        return;
      }
      case 's': this.savedX = this.x; this.savedY = this.y; return;
      case 'u': this.x = this.savedX; this.y = this.savedY; return;
      case 'm': this.sgr(this.params === '' ? [0] : p); return;
      default:
        // Scroll regions, device queries, cursor-style requests and everything else: swallowed.
        void self;
        return;
    }
  };

  Terminal.prototype.eraseInLine = function (mode) {
    var line = this.screen[this.y];
    if (!line) return;
    var from = mode === 1 ? 0 : mode === 2 ? 0 : this.x;
    var to = mode === 0 ? this.cols - 1 : mode === 1 ? this.x : this.cols - 1;
    for (var i = from; i <= to && i < this.cols; i++) line[i] = { ch: ' ', attr: blankAttr() };
  };

  Terminal.prototype.eraseInDisplay = function (mode) {
    if (mode === 2 || mode === 3) {
      for (var i = 0; i < this.rows; i++) this.screen[i] = blankLine(this.cols);
      return;
    }
    if (mode === 0) {
      this.eraseInLine(0);
      for (var a = this.y + 1; a < this.rows; a++) this.screen[a] = blankLine(this.cols);
      return;
    }
    if (mode === 1) {
      this.eraseInLine(1);
      for (var b = 0; b < this.y; b++) this.screen[b] = blankLine(this.cols);
    }
  };

  Terminal.prototype.sgr = function (params) {
    var attr = {
      fg: this.attr.fg, bg: this.attr.bg, bold: this.attr.bold, dim: this.attr.dim,
      italic: this.attr.italic, underline: this.attr.underline, inverse: this.attr.inverse, hidden: this.attr.hidden,
    };
    for (var i = 0; i < params.length; i++) {
      var n = params[i];
      if (n === 0) { attr = blankAttr(); continue; }
      if (n === 1) { attr.bold = true; continue; }
      if (n === 2) { attr.dim = true; continue; }
      if (n === 3) { attr.italic = true; continue; }
      if (n === 4) { attr.underline = true; continue; }
      if (n === 7) { attr.inverse = true; continue; }
      if (n === 8) { attr.hidden = true; continue; }
      if (n === 21 || n === 22) { attr.bold = false; attr.dim = false; continue; }
      if (n === 23) { attr.italic = false; continue; }
      if (n === 24) { attr.underline = false; continue; }
      if (n === 27) { attr.inverse = false; continue; }
      if (n === 28) { attr.hidden = false; continue; }
      if (n >= 30 && n <= 37) { attr.fg = PALETTE[n - 30]; continue; }
      if (n >= 90 && n <= 97) { attr.fg = PALETTE[n - 90 + 8]; continue; }
      if (n >= 40 && n <= 47) { attr.bg = PALETTE[n - 40]; continue; }
      if (n >= 100 && n <= 107) { attr.bg = PALETTE[n - 100 + 8]; continue; }
      if (n === 39) { attr.fg = null; continue; }
      if (n === 49) { attr.bg = null; continue; }
      if (n === 38 || n === 48) {
        var target = n === 38 ? 'fg' : 'bg';
        if (params[i + 1] === 5) { attr[target] = cube(params[i + 2] || 0); i += 2; continue; }
        if (params[i + 1] === 2) {
          attr[target] = 'rgb(' + (params[i + 2] || 0) + ',' + (params[i + 3] || 0) + ',' + (params[i + 4] || 0) + ')';
          i += 4;
          continue;
        }
      }
    }
    this.attr = attr;
  };

  /**
   * The screen as DOM. Runs of identical attributes become one <span>, which is what keeps a full
   * redraw cheap enough to do on every animation frame on a phone.
   */
  Terminal.prototype.render = function (into) {
    var lines = this.scrollback.concat(this.screen);
    var frag = document.createDocumentFragment();
    for (var l = 0; l < lines.length; l++) {
      var line = lines[l];
      var div = document.createElement('div');
      div.className = 'trow';
      var last = null;
      var run = '';
      var runAttr = null;
      for (var i = 0; i < line.length; i++) {
        var cell = line[i];
        if (last !== null && sameAttr(cell.attr, runAttr)) {
          run += cell.ch;
        } else {
          if (last !== null) div.appendChild(styled(run, runAttr));
          run = cell.ch;
          runAttr = cell.attr;
          last = 1;
        }
      }
      if (last !== null) div.appendChild(styled(run, runAttr));
      frag.appendChild(div);
    }
    into.replaceChildren(frag);
  };

  function styled(text, attr) {
    if (!attr || (!attr.fg && !attr.bg && !attr.bold && !attr.dim && !attr.italic && !attr.underline && !attr.inverse)) {
      return document.createTextNode(text);
    }
    var span = document.createElement('span');
    // textContent, never innerHTML. Agent output is untrusted bytes; the one thing this renderer
    // must never do is let them become markup.
    span.textContent = attr.hidden ? text.replace(/./g, ' ') : text;
    var fg = attr.fg;
    var bg = attr.bg;
    if (attr.inverse) {
      var t = fg;
      fg = bg || 'var(--term-bg)';
      bg = t || 'var(--term-fg)';
    }
    if (fg) span.style.color = fg;
    if (bg) span.style.background = bg;
    if (attr.bold) span.style.fontWeight = '700';
    if (attr.dim) span.style.opacity = '0.65';
    if (attr.italic) span.style.fontStyle = 'italic';
    if (attr.underline) span.style.textDecoration = 'underline';
    return span;
  }

  global.OmaTerminal = Terminal;
  global.OmaTerminal.DEFAULT_COLS = DEFAULT_COLS;
  global.OmaTerminal.DEFAULT_ROWS = DEFAULT_ROWS;
})(window);
