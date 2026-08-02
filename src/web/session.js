// The browser client for attaching to a session. No build step, no framework, no external request.
//
// CRITERION 1 IS "WITHOUT THE PERSON RELOADING OR POLLING", so there is exactly one long-lived
// WebSocket and no `setInterval` anywhere in the attached view. Output arrives as binary frames and
// is written into the screen buffer as it lands.
//
// WHAT THIS FILE DOES NOT DO, AND WHY THAT IS THE POINT (criterion 5): it does not distinguish the
// replay from the live stream. The host sends scrollback and then live output down one socket, in
// order, with the join made atomic on the host side. If this file had to stitch two streams
// together it would have a seam of its own, and a seam in a client is a seam that is wrong on one
// device and right on another.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('id');

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // THE LIST
  // ────────────────────────────────────────────────────────────────────────────────────────────

  function stateWords(s) {
    if (s.state === 'live') return 'live';
    if (s.state === 'terminated') return 'ended';
    return 'cannot tell';
  }

  function renderList(data) {
    var ul = $('sessions');
    ul.replaceChildren();
    if (!data.sessions || data.sessions.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'No sessions on this machine yet.';
      ul.appendChild(empty);
      return;
    }
    data.sessions.forEach(function (s) {
      var li = document.createElement('li');

      var head = document.createElement('p');
      var pill = document.createElement('span');
      pill.className = 'pill ' + s.state;
      pill.textContent = stateWords(s);
      head.appendChild(pill);
      head.appendChild(document.createTextNode(' '));
      var title = document.createElement('span');
      title.className = 'wrap';
      title.textContent = s.title;
      head.appendChild(title);
      li.appendChild(head);

      var id = document.createElement('p');
      id.className = 'sid wrap';
      id.textContent = s.id + ' · started ' + s.startedAt;
      li.appendChild(id);

      // The reason is shown for BOTH non-live states, and they say different things. A person must
      // never have to guess whether "ended" means it finished or means we lost track of it.
      if (s.state !== 'live') {
        var why = document.createElement('p');
        why.className = 'muted wrap';
        why.textContent = s.reason;
        li.appendChild(why);
      }

      var row = document.createElement('div');
      row.className = 'row';
      var open = document.createElement('a');
      open.className = 'btn';
      open.href = '?id=' + encodeURIComponent(s.id);
      open.textContent = s.state === 'live' ? 'Attach' : 'Read history';
      row.appendChild(open);
      li.appendChild(row);

      ul.appendChild(li);
    });
  }

  function loadList() {
    fetch('/api/sessions', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderList(data);
        var note = $('pty-note');
        if (data.pty && data.pty.kind === 'absent') {
          note.textContent = 'This machine cannot start a session: ' + data.pty.reason;
          $('start').disabled = true;
        } else if (data.pty && data.pty.kind === 'undetermined') {
          // Not the same as "absent", and not rendered as it.
          note.textContent = 'This host COULD NOT DETERMINE whether it can allocate a terminal: ' + data.pty.reason;
        } else if (data.scrollback) {
          note.textContent =
            'Reattaching replays up to ' + data.scrollback.budgetBytes + ' bytes of recent output. ' +
            'How much is retained is still an open decision on Issue #2.';
        }
      })
      .catch(function (err) {
        $('sessions').replaceChildren();
        var li = document.createElement('li');
        li.className = 'wrap';
        li.textContent = 'This page could not reach the host it was served from: ' + err;
        $('sessions').appendChild(li);
      });
  }

  function startSession() {
    var raw = $('new-command').value.trim();
    if (raw === '') return;
    // Split on whitespace. Quoting is not invented here: a person who needs it can start a shell
    // and type inside it, which is the thing this product is for.
    var parts = raw.split(/\s+/);
    $('start').disabled = true;
    $('start-note').textContent = 'starting…';
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: parts[0], args: parts.slice(1) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (body) {
        $('start').disabled = false;
        if (body.ok && body.session) {
          window.location.search = '?id=' + encodeURIComponent(body.session.id);
        } else {
          $('start-note').textContent = body.error || 'the session was not started';
        }
      })
      .catch(function (err) {
        $('start').disabled = false;
        $('start-note').textContent = String(err);
      });
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // THE TERMINAL
  // ────────────────────────────────────────────────────────────────────────────────────────────

  function fitFont(pre, cols) {
    // 80 columns in whatever width the pane has. A phone is not 80 characters wide at a readable
    // size, and the alternative — leaving it at a comfortable size and letting the pane scroll
    // sideways — makes reading an agent's output a two-handed job. So the font shrinks, down to a
    // floor, and only below that floor does the pane scroll horizontally within itself.
    var probe = document.createElement('span');
    probe.style.font = window.getComputedStyle(pre).font;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.textContent = new Array(cols + 1).join('M');
    document.body.appendChild(probe);
    var measured = probe.getBoundingClientRect().width;
    var current = parseFloat(window.getComputedStyle(pre).fontSize);
    document.body.removeChild(probe);
    if (!measured || !current) return;
    var available = pre.clientWidth - 16;
    var next = Math.max(7, Math.min(15, (available / measured) * current));
    pre.style.fontSize = next.toFixed(2) + 'px';
  }

  function showBanner(kind, text) {
    var el = $('banner');
    el.className = 'banner ' + kind;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  function attach(id) {
    $('list-view').classList.add('hidden');
    $('term-view').classList.remove('hidden');
    $('sid').textContent = id;

    var screen = $('screen');
    var term = new window.OmaTerminal(window.OmaTerminal.DEFAULT_COLS, window.OmaTerminal.DEFAULT_ROWS);
    fitFont(screen, window.OmaTerminal.DEFAULT_COLS);
    window.addEventListener('resize', function () { fitFont(screen, window.OmaTerminal.DEFAULT_COLS); });

    var dirty = false;
    function schedule() {
      if (dirty) return;
      dirty = true;
      window.requestAnimationFrame(function () {
        dirty = false;
        var atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
        term.render(screen);
        if (atBottom) screen.scrollTop = screen.scrollHeight;
      });
    }

    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + window.location.host + '/api/sessions/' + encodeURIComponent(id) + '/attach');
    ws.binaryType = 'arraybuffer';

    var live = false;

    ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') {
        // Binary: PTY bytes. Replay and live output are the same kind of message, on purpose.
        term.writeBytes(new Uint8Array(ev.data));
        schedule();
        return;
      }
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'session') {
        $('title').textContent = msg.session.title;
        $('state-pill').className = 'pill ' + msg.session.state;
        $('state-pill').textContent = stateWords(msg.session);
      } else if (msg.type === 'attached') {
        live = true;
        setControls(true);
      } else if (msg.type === 'not-live') {
        // The transcript above is genuine history. This says so, unmistakably.
        live = false;
        setControls(false);
        $('state-pill').className = 'pill ' + msg.state;
        showBanner(
          msg.state,
          (msg.state === 'terminated' ? 'THIS SESSION HAS ENDED. ' : 'THIS SESSION’S FATE CANNOT BE DETERMINED. ') + msg.reason,
        );
      } else if (msg.type === 'exit') {
        live = false;
        setControls(false);
        $('state-pill').className = 'pill terminated';
        $('state-pill').textContent = 'ended';
        showBanner('terminated', 'THE SESSION ENDED WHILE YOU WERE WATCHING. ' + msg.reason);
      } else if (msg.type === 'error') {
        live = false;
        setControls(false);
        showBanner('error', msg.reason || 'the host reported an error');
      }
    };

    ws.onclose = function () {
      if (live) {
        // A dropped connection is NOT an ended session. Criterion 5: detaching does not stop the
        // agent, and this page must not imply that it did.
        live = false;
        setControls(false);
        showBanner('undetermined', 'The connection dropped. The agent is still running — reload to reattach.');
      }
    };
    ws.onerror = function () {
      if (!live) showBanner('error', 'This page could not open a stream to the host.');
    };

    function setControls(enabled) {
      $('send').disabled = !enabled;
      $('interrupt').disabled = !enabled;
      $('enter').disabled = !enabled;
      $('kill').disabled = !enabled;
      $('input').disabled = !enabled;
    }
    setControls(false);

    function sendBytes(text) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(new TextEncoder().encode(text));
    }

    $('send').addEventListener('click', function () {
      var value = $('input').value;
      // The newline is what submits it to the agent, and it is sent WITH the text rather than as a
      // separate message so a slow link cannot split a line in two.
      sendBytes(value + '\n');
      $('input').value = '';
      $('input').focus();
    });
    $('input').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        $('send').click();
      }
    });
    $('enter').addEventListener('click', function () { sendBytes('\n'); });
    $('interrupt').addEventListener('click', function () {
      // Criterion 4, in full: one message, and the socket stays open.
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }));
    });
    $('kill').addEventListener('click', function () {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', signal: 'SIGTERM' }));
    });
    $('back').addEventListener('click', function () {
      // Detaching. The agent keeps running; that is the whole of criterion 5's first sentence.
      try { ws.close(1000, 'detached'); } catch (e) { /* already closing */ }
      window.location.search = '';
    });
  }

  if (sessionId) {
    attach(sessionId);
  } else {
    $('reload').addEventListener('click', loadList);
    $('start').addEventListener('click', startSession);
    $('new-command').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); startSession(); }
    });
    loadList();
  }
})();
