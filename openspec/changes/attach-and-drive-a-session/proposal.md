# Attach to a running agent from any device and drive it

Refs #2

## Why

Issue #1 made a machine's host reachable from a phone over the user's own tailnet. What it serves is
a status page. The agents are running on the machine and there is no way to see one, let alone type
into it.

The interaction this has to reproduce is the one a terminal gives you: you see what the agent is
doing *as it does it*, you type a follow-up, and you hit interrupt when it goes the wrong way. The
thing that makes a remote version of it feel broken is not latency — it is the seam. A phone loses
its network in a tunnel. Reopening the tab must not dump the person into a blank screen, and it must
not replay the last thirty seconds they already read, and it must not silently skip the thirty
seconds they missed. "Recent history, then live output, in order, once" is the whole product here.

The second thing that makes it feel broken is a session that is gone being drawn the same as a
session that is running. The host restarts — a laptop sleeps, a process is upgraded — and a person
looking at a list has to be able to tell "this is still working" from "this ended, here is why" from
"I cannot tell what happened to this". This project already keeps that distinction everywhere else
(`tailnet.ts`, `state.ts`, `status.ts`, `lock.ts`); a session is the place a person will be hurt
most by collapsing it, because the action it leads to is "start another one".

## What Changes

- **A session is a detached supervisor process, not an object inside the host.** The host spawns it
  and is thereafter a CLIENT of it over a unix socket in the session's own directory. This is what
  makes a session survive the host restarting: nothing is handed between host processes in memory,
  because nothing can be.
- **The registry becomes a reader of a directory.** `list()` is a scan of `~/.local/state/oh-my-agents/sessions/`,
  reached through the Issue #1 path helper. A new host process finds the sessions the old one
  started because it re-reads what is on disk.
- **A PTY without a native dependency.** The agent runs under `script(1)`, whose flavour (BSD or
  util-linux) is PROBED rather than inferred from `process.platform`. `node-pty` is a native addon
  chosen at install time by the machine, which is what this project's `make ci` exists to deny.
- **Live output reaches the browser over a WebSocket** — an RFC 6455 implementation in `src/server/ws.ts`,
  because the client has no build step and cannot import one. No polling and no reload.
- **Input from the browser and input from this machine's own terminal go into the same PTY.** The
  pseudo-terminal's own line discipline does the echoing, so one interleaved history is structural
  rather than something kept true by convention.
- **Interrupt is the byte 0x03 written into the PTY**, not a signal sent to a pid, and there is no
  code path from an interrupt to a disconnect.
- **The attach seam is atomic with respect to the output stream.** The supervisor acknowledges a
  subscriber with the exact transcript length at the instant it was registered, in one synchronous
  block with no `await` in it, and the host buffers live output until the replay has been handed
  over. Replay `[offset-budget, offset)`, then flush: nothing twice, nothing missing.
- **Sessions answer three-valued.** `live`, `terminated` (with the reason it ended), `undetermined`
  (no exit record and no live supervisor — something ended it without recording how). None of the
  three renders as another, in the API, in the CLI or on the page.
- **A terminal renderer in plain JavaScript** (`src/web/term.js`) that interprets control sequences,
  colour, cursor addressing and redraws, and puts every character on the page with `textContent`.
- **A second page, `session.html`**, holding the list and the terminal, usable one-handed at 375px.
  `index.html` gains one link and nothing else.

## Open decision, deliberately not settled here

How much scrollback is retained is recorded on Issue #2 as blocked on a product decision, and this
change does not settle it. `SCROLLBACK_BUDGET_BYTES` in `src/sessions/scrollback.ts` is one named
constant with the openness documented beside it, and the seam tests run at a budget far below and
far above the transcript size so that what is asserted is the seam and not the default.
