# Tasks

Every box below is ticked because the work is done and was run. What did not get built is not on
this list — it is named in the pull request body instead.

This branch was built across two agent sessions. The second session VERIFIED the first session's
uncommitted work rather than inheriting it: nothing here had ever been compiled or run before that
point, and four real defects were found and fixed doing it (see the pull request body).

## Session substrate — a session that outlives the host

- [x] `src/sessions/paths.ts` names every session file THROUGH `stateDir()` from `src/paths.ts`, and resolves no root of its own
- [x] Session ids are validated as a directory name and as a URL segment before either is built from them
- [x] `src/sessions/pty.ts` runs an agent under `script(1)` with no native dependency
- [x] The `script` flavour (BSD / util-linux) is PROBED by running it, not inferred from `process.platform`
- [x] PTY support is a three-valued answer — available / absent / undetermined — each with a reason
- [x] `src/sessions/supervisor.ts`: one detached supervisor process per session, owning the PTY, the transcript and a unix socket
- [x] The agent's exit status is recorded by the agent's own wrapper, because the pipeline's status can never arrive
- [x] `src/sessions/registry.ts` reads the sessions directory rather than holding a map in memory
- [x] `src/sessions/protocol.ts`: a length-prefixed, typed frame protocol between host and supervisor

## Criterion 1 — live output, no reload and no polling

- [x] `src/server/ws.ts`: RFC 6455 in this repository, because the client has no build step to import one
- [x] `handleAttachUpgrade` in `src/server/seams.ts` streams supervisor output as binary frames
- [x] Ran it: a browser at 375px advanced its screen with no interaction (`/tmp/browser-check.mjs`)
- [x] Tested: `criterion 1: live output arrives on an open attachment without asking again`

## Criterion 2 — one interleaved history, browser and this machine's terminal

- [x] Browser input is written into the PTY; the line discipline does the echoing, so there is one history by construction
- [x] `oh-my-agents attach` gives the machine's own terminal the SAME path into the PTY as the browser
- [x] Tested: `criterion 2: the browser and this machine's own terminal produce ONE interleaved history`
- [x] Seen to fail: with browser input echoed locally instead of written into the PTY, the test goes red
- [x] Ran it: typed in a browser at 375px and the shell's output came back in the same stream

## Criterion 3 — two devices, one session

- [x] The supervisor broadcasts to every subscriber; no attachment is exclusive and none can evict another
- [x] Tested: `criterion 3: two attached clients see the same output and each other's input`
- [x] Ran it: two browser tabs, each seeing the other's input, in the same order

## Criterion 4 — interrupt without detaching

- [x] Interrupt is the byte 0x03 written into the PTY, not a signal sent to a pid
- [x] There is no code path from an interrupt to a close, in the host or in the client
- [x] Tested: `criterion 4: an interrupt reaches the agent and the session REMAINS ATTACHED`
- [x] Ran it: clicked Interrupt in a browser, the agent's SIGINT handler printed, and output kept arriving

## Criterion 5 — the seam

- [x] The supervisor's ACK carries the transcript length at the instant the subscriber was registered, set in one synchronous block
- [x] Transcript appends are `writeSync`, so the counter and the file never disagree
- [x] The host buffers live output from the ACK until the replay has been handed over, then flushes it in order
- [x] The replay is read to the ACKED OFFSET, never to end-of-file
- [x] A truncated replay window is advanced past the next newline, so a half escape sequence never renders
- [x] Tested UNDER LOAD: continuous output across every detach and reattach, four reattaches per case
- [x] Tested at a budget far below AND far above the transcript size, so what is asserted is the seam, not the default
- [x] Seen to fail: removing the buffer produces DROPPED regions; replaying to end-of-file produces DUPLICATED regions. Both at both budgets
- [x] Ran it: reloaded a browser tab mid-stream; history replayed, live continued, nothing doubled

## Criterion 6 — surviving a host restart, and three different answers

- [x] The supervisor is `detached` and `unref`'d, so stopping the host does not take the sessions with it
- [x] A restarted host re-reads the directory and lists the sessions a previous host started
- [x] `live` / `terminated` / `undetermined` are three values with three reasons, in the API, the CLI and the page
- [x] An exit record is written only when the supervisor OBSERVED the end; its absence is what `undetermined` means
- [x] Attaching to an ended session reports `not-live` with the reason and never reports itself attached
- [x] Tested: `criterion 6: a session survives the host restarting, and replays on reattach`
- [x] Tested: `criterion 6: ended, undetermined and live are three different answers with three reasons`
- [x] Seen to fail: with the agent's exit unnoticed, an ended session reports `live` and the test goes red

## Criterion 7 — control sequences render as the agent intended

- [x] `src/web/term.js`: a terminal renderer in plain JavaScript, no bundler and no external request
- [x] Cursor addressing, erase-in-line and erase-in-display, carriage-return redraws, wrapping, scrollback
- [x] SGR colour, bold, dim, italic, underline, inverse and hidden
- [x] UTF-8 decoded across chunk boundaries, so a split character is one character
- [x] Every sequence is either implemented or swallowed; none reaches the screen as text
- [x] Agent output can never become markup: `textContent` throughout, asserted structurally
- [x] Ran it: colour, bold and a carriage-return redraw rendered in a real browser, with no escape text on screen

## Criterion 8 — usable one-handed at 375px

- [x] `session.html` declares the device width and holds every control at 44px
- [x] The terminal scrolls inside its own box; the page never scrolls sideways
- [x] Nothing needs hover, right-click or drag
- [x] `index.html` gains one link and nothing else
- [x] Measured in a real browser at 375×812: page scroll width 375, seven visible targets, none under 44px

## Hygiene found while verifying

- [x] The attach connect retries while a just-spawned supervisor is still coming up, instead of failing on ENOENT
- [x] A WebSocket holds messages that arrive before its caller has attached listeners, instead of dropping them
- [x] The test harness ends the sessions it starts, instead of leaking a runaway process per session per run
