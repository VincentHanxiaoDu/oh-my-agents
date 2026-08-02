# host-serving

## ADDED Requirements

### Requirement: A single command shall start a host that serves with no further configuration

The system SHALL provide one command that starts a host process and begins serving. Starting SHALL
require no tunnel binary, no relay process, no account signup and no reverse proxy, and SHALL
require no second command before the host is reachable.

#### Scenario: One command, and it is serving

- **WHEN** a person runs `oh-my-agents` on a machine with nothing else installed or configured
- **THEN** a host process starts, begins listening, and the command returns 0
- **AND** the host answers an HTTP request on the address it printed
- **AND** no other process, binary, account or proxy is required for it to answer

### Requirement: The host shall bind only the tailnet interface and loopback

The system SHALL listen only on loopback and on addresses that Tailscale has reported, that lie
inside Tailscale's own address space, and that are assigned to a local interface. The system SHALL
never listen on an unspecified (wildcard) address. Any candidate address failing any of those
conditions SHALL be refused, and the refusal SHALL be stated.

#### Scenario: A request on a LAN-only interface does not reach the host

- **WHEN** the host is serving and a connection is attempted to the machine's LAN address on the
  host's port
- **THEN** the connection fails to establish
- **AND** no agent data is returned on that path

#### Scenario: A wildcard is never bound, whatever the resolver is handed

- **WHEN** the bind resolver is given any tailnet detection result, including one naming
  `0.0.0.0`, `::`, a LAN address, a public address or a malformed string
- **THEN** every address it returns is loopback or a locally-assigned Tailscale address
- **AND** it never returns an unspecified address

#### Scenario: An address Tailscale reports but that is not Tailscale's is refused

- **WHEN** the tailnet probe reports an address outside Tailscale's address space, and that address
  is genuinely assigned to a local interface
- **THEN** the host does not bind it
- **AND** the startup output names the address and states why it was refused

### Requirement: The host shall print, on startup, the address that works

The system SHALL print on startup the address at which it is reachable. When a tailnet is up, the
printed address SHALL be the tailnet address, and a request to exactly that address SHALL reach the
host.

#### Scenario: The printed address is the one that works

- **WHEN** a host starts on a machine whose tailnet is up
- **THEN** the startup output contains the machine's tailnet address and port
- **AND** a request to that exact address and port reaches the host

### Requirement: Loopback-only serving shall be stated plainly and distinguishably

When no tailnet address can be bound, the system SHALL still start and serve on loopback, and SHALL
state in its startup output that only local access is available. The loopback-only case and the
tailnet case SHALL be distinguishable from the startup output alone.

#### Scenario: Tailscale is absent, and the host says so

- **WHEN** no Tailscale binary is present and a host is started
- **THEN** the host starts and serves on loopback
- **AND** the startup output states that only local access is available
- **AND** the output differs from the tailnet case in a line that identifies which case it is

#### Scenario: Whether Tailscale is present could not be determined

- **WHEN** the tailnet probe neither succeeds nor establishes that Tailscale is absent or down
- **THEN** the host starts and serves on loopback
- **AND** the startup output states that the question could not be determined
- **AND** the output does not state that Tailscale is absent

### Requirement: A status command shall report whether a host is running, where, and how many sessions

The system SHALL provide a status command that, when a host is running, reports its serving address
and the number of sessions it owns and exits 0. When it has established that no host is running, it
SHALL exit non-zero and report nothing that could be mistaken for a running host. When it cannot
determine which is the case, it SHALL exit with a code distinct from both.

#### Scenario: Running and not running differ by exit code alone

- **WHEN** the status command is run while a host is serving
- **THEN** it exits 0 and reports the serving address and the session count
- **WHEN** the status command is run after the host has stopped
- **THEN** it exits non-zero
- **AND** it reports no address, no port and no session count

#### Scenario: Cannot tell is not reported as not running

- **WHEN** a host record exists on disk and cannot be read or understood
- **THEN** the status command exits with a code that is neither the running code nor the
  not-running code
- **AND** its output states that the question could not be determined

### Requirement: The host shall survive the terminal that started it being closed

The system SHALL continue serving, and its sessions SHALL continue running, after the terminal that
started it is closed.

#### Scenario: The terminal goes away and the address keeps serving

- **WHEN** a host is started and the process that started it exits
- **THEN** the host process is no longer a child of that process
- **AND** the host continues to answer requests on its address
- **AND** a hangup signal does not stop it

### Requirement: Starting the host twice shall not produce two hosts

The system SHALL permit at most one host per machine. A second invocation SHALL report that a host
is already running and exit non-zero, and SHALL not start a second serving process.

#### Scenario: The second start refuses

- **WHEN** a host is running and the start command is run again on the same machine
- **THEN** the second invocation exits non-zero
- **AND** its output says a host is already running
- **AND** the host reported by the status command is the same process as before

#### Scenario: A lock whose owner cannot be identified is not treated as a running host

- **WHEN** a lock file exists that cannot be read or parsed
- **THEN** the start command neither takes the lock nor reports that a host is running
- **AND** it states that it could not determine whose lock it is

### Requirement: Every human-facing surface shall be usable one-handed on a 375px viewport

The system's browser client SHALL, at a viewport 375 CSS pixels wide, produce no horizontal page
scroll, present no interactive target smaller than 44 by 44 CSS pixels, and require no hover,
right-click or drag to reach any content or action.

#### Scenario: The client at 375px

- **WHEN** the browser client is opened at a viewport 375 pixels wide
- **THEN** the document's scroll width does not exceed the viewport width
- **AND** every button, link and disclosure control measures at least 44 pixels in both directions
- **AND** every action on the page can be performed by a single tap

### Requirement: An unsettled product decision shall be refused rather than answered

The system SHALL not install itself as a login or system service. Any option that would imply
returning after a reboot SHALL be refused with a distinct exit code and a statement of where the
decision belongs.

#### Scenario: A persistence flag refuses

- **WHEN** the command is invoked with a flag implying installation as a service or login item
- **THEN** it exits with a code distinct from success and from every other failure
- **AND** its output states that this is an open product decision
- **AND** no host is started and nothing is installed
