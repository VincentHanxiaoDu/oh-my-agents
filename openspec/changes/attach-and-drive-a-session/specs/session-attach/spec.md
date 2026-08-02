# session-attach

## ADDED Requirements

### Requirement: Attaching shall stream a session's live output without polling or reloading

The system SHALL, on attaching to a live session, deliver that session's output to the attached
client as the agent produces it. The client SHALL not be required to issue a further request, poll,
or reload in order to receive output produced after the attach.

#### Scenario: Output keeps arriving on an open attachment

- **WHEN** a client attaches to a live session and then makes no further request of any kind
- **THEN** output the agent produces after the attach is delivered to that client
- **AND** no polling request and no reload is required for it to arrive

### Requirement: Input from any attached client and from the machine's own terminal shall reach one session and produce one history

The system SHALL write input received from an attached client into the same pseudo-terminal that a
client attached at the machine's own terminal writes into. The effect of that input SHALL appear in
the output stream every attached client is receiving. The system SHALL not maintain a separate view
per client.

#### Scenario: Text typed in a browser reaches the agent

- **WHEN** a person types an instruction in an attached browser and submits it
- **THEN** the agent receives it as input
- **AND** its effect appears in the output stream that browser is receiving

#### Scenario: A browser and the machine's own terminal produce one interleaved history

- **WHEN** input is submitted from a browser, then from a client attached at the machine's own
  terminal, then from the browser again
- **THEN** both clients see all three, in the order they were submitted
- **AND** neither client sees a history the other does not

### Requirement: Two attached devices shall see the same output, including each other's input

The system SHALL permit more than one client to be attached to a session at once. No attachment
shall be exclusive, and attaching SHALL not evict an existing attachment.

#### Scenario: A second device joins a session already in use

- **WHEN** a device attaches to a session another device is already attached to
- **THEN** it is shown the session's recent history, including work the first device did
- **AND** input submitted from either device appears in the other's view
- **AND** the order of events is the same in both views

### Requirement: An interrupt shall interrupt the agent and shall not end the attachment

The system SHALL provide a control that delivers an interrupt (the Ctrl+C equivalent) to the agent.
Using it SHALL not detach the client, SHALL not terminate the session, and SHALL not orphan it.

#### Scenario: Interrupting leaves the person where they were

- **WHEN** an attached person uses the interrupt control while the agent is working
- **THEN** the agent receives an interrupt
- **AND** the client is still attached afterwards
- **AND** output produced after the interrupt continues to arrive on the same attachment

### Requirement: Detaching shall not stop the agent, and reattaching shall replay recent history followed by live output with no gap and no repeat

The system SHALL keep a session running when every client detaches, including when a client
disappears without a close handshake. On reattaching, the system SHALL deliver recent history
followed by live output. No region of the stream SHALL be delivered twice, and no region produced
between the history and the live stream SHALL be omitted.

#### Scenario: The agent keeps working while nobody is attached

- **WHEN** the only attached client's connection is cut without a close handshake, and no client
  attaches for a period
- **THEN** the agent continues to run and continues to produce output
- **AND** that output is retained for a later attachment

#### Scenario: Reattaching under continuous output has no gap and no repeat at the seam

- **WHEN** a client reattaches to a session that is producing output continuously, and keeps
  receiving output well past the moment it reattached
- **THEN** it is shown recent history and then live output, in order
- **AND** no part of the stream appears twice
- **AND** no part of the stream produced between the history and the live output is missing

#### Scenario: The seam is correct whatever the retention budget is

- **WHEN** the reattach above is performed with a retention budget far smaller than the transcript,
  and again with one far larger than the whole transcript
- **THEN** in both cases the stream has no duplicated and no dropped region
- **AND** in both cases the reattaching client is shown history it was not present for

### Requirement: A session shall survive the host process restarting, and a session that did not survive shall be reported as terminated with its reason

The system SHALL keep a session running across a restart of the host process, SHALL list it again
afterwards, and SHALL replay its recent history on reattaching. The system SHALL report a session
that ended as terminated together with the reason it ended, and SHALL report a session whose fate
cannot be established as undetermined. A live session, an ended session and an undetermined session
shall never be presented identically.

#### Scenario: The host restarts and the session is still there

- **WHEN** the host process is stopped and a new host process is started on the same machine
- **THEN** the session is listed again by the new host
- **AND** it is reported as live
- **AND** reattaching to it replays recent history and then continues with live output

#### Scenario: Ended, undetermined and live are three answers with three reasons

- **WHEN** one session is running, one has exited with a non-zero status, and one has had its
  supervising process killed without recording an outcome
- **THEN** the first is reported as live, the second as terminated, and the third as undetermined
- **AND** the terminated one states the status it exited with
- **AND** the undetermined one states that what happened to it cannot be determined, is given no
  invented reason, and is given no end time
- **AND** no two of the three are presented the same way

#### Scenario: Attaching to an ended session does not look like attaching to a live one

- **WHEN** a client attaches to a session that has ended
- **THEN** it is told the session is not live, which of the two non-live answers applies, and why
- **AND** it is never told that it is attached

### Requirement: Terminal control sequences shall render as the agent intended rather than as escape-code text

The system SHALL interpret the terminal control sequences in a session's output — colour, text
attributes, cursor addressing, erasure and redraws — and render their effect. No escape sequence,
whether interpreted or deliberately ignored, SHALL appear on screen as text. Agent output shall
never be interpreted as markup.

#### Scenario: Colour and a redraw render as colour and a redraw

- **WHEN** an agent emits coloured and bold text and redraws its current line with a carriage return
- **THEN** the colour appears as colour and the bold as bold
- **AND** the redrawn line replaces the line it was redrawing
- **AND** no escape character or escape-code text appears on screen

#### Scenario: Hostile output cannot become markup or leak escape text

- **WHEN** an agent emits output containing HTML, private mode sequences, an alternate screen
  switch, an operating system command, a device query and a character set selection
- **THEN** the HTML appears as the characters the agent emitted and is not interpreted as markup
- **AND** none of the sequences appears on screen as text

### Requirement: Every surface this capability exposes shall be usable one-handed at a 375px viewport

The system's session surfaces SHALL, at a 375px-wide viewport, produce no horizontal page scroll,
present no interactive target smaller than 44px in either dimension, and require no hover,
right-click or drag to reach any content or control.

#### Scenario: The session surfaces at 375px

- **WHEN** the session list and the attached terminal are viewed at a 375px-wide viewport
- **THEN** the page does not scroll horizontally
- **AND** every visible interactive target is at least 44px in both dimensions
- **AND** content too wide for the viewport scrolls inside its own box rather than moving the page
- **AND** no control requires hover, right-click or drag to operate
