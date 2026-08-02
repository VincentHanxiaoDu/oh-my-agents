# host-mesh

## ADDED Requirements

### Requirement: A host shall be joinable to another by address

The system SHALL allow a host to be joined to another host by the address that host prints when it
starts. After joining, opening either host SHALL list the agents of both, and every agent in that
list SHALL be labelled with the machine it is running on.

#### Scenario: Opening either joined host lists both machines' agents

- **WHEN** a person joins host A to host B by address and opens host A
- **THEN** the list presented names both machines and the agents of both
- **AND** each agent in the list names the machine it is running on

#### Scenario: A join survives the host being restarted

- **WHEN** a host that has been joined to another is stopped and started again
- **THEN** it still lists the joined host without the join being made again

### Requirement: The relationship between hosts shall be symmetric with no designated hub

The system SHALL NOT designate any host as a hub. Opening host A and opening host B SHALL each
present the full set of machines. Shutting down any one host SHALL NOT prevent the remaining hosts
from seeing each other.

#### Scenario: Two hosts present the same set

- **WHEN** three hosts are joined to each other and a person opens the first and then the second
- **THEN** both present the same set of machines

#### Scenario: The remaining hosts still see each other when one is shut down

- **WHEN** three joined hosts are running and one of them is shut down
- **THEN** the other two still list each other and each other's agents
- **AND** neither of them becomes unable to answer

### Requirement: Attaching to an agent on another host shall behave as a local attach

The system SHALL route an attach for an agent owned by another host to that host, so that output
streams to the person, input reaches the agent, and an interrupt takes effect. The relay SHALL NOT
transform, reframe or buffer the stream in a way that changes what either end observes.

#### Scenario: A remote attach streams, accepts input and can be interrupted

- **WHEN** a person opens one host and attaches to an agent that lives on another
- **THEN** the agent's output reaches them as it is produced
- **AND** what they type reaches the agent
- **AND** an interrupt they send takes effect on the agent

#### Scenario: An attach naming a host that is not joined discloses nothing

- **WHEN** a paired device requests an attach naming a host that this one has not joined
- **THEN** the request is refused with the same response an unknown path receives
- **AND** the response does not reveal whether that host exists

### Requirement: An unreachable peer shall be shown as unreachable and never as empty

The system SHALL show a peer that cannot be reached as unreachable, with its machine still named.
Its agents SHALL NOT be presented as running and well, and SHALL NOT be dropped from the list. An
unreachable peer and a peer with zero agents SHALL be distinguishable in the list, in the data and
in what a person reads.

#### Scenario: An unreachable machine and an idle machine read differently

- **WHEN** one joined host is running with no agents and another joined host is shut down
- **THEN** the list names both machines
- **AND** the idle one is shown as having no agents
- **AND** the shut-down one is shown as unreachable, with what it is running stated as unknown

#### Scenario: A peer that answers but does not accept this host is a third state

- **WHEN** a joined host is running and does not accept the host that is asking
- **THEN** it is shown as neither unreachable nor as having no agents
- **AND** what it is running is stated as unknown

#### Scenario: A peer list that cannot be read is not an empty peer list

- **WHEN** the record of which hosts have been joined cannot be read or understood
- **THEN** the person is told that the list may be incomplete and why
- **AND** the record is not overwritten

### Requirement: Agents on different machines shall remain distinguishable

The system SHALL keep two agents distinguishable in the unified list when they share a name, a
working directory or a runtime but run on different machines. Each entry SHALL carry the machine it
belongs to, and SHALL be identified in a way that is unique across every joined machine.

#### Scenario: Two identically named agents on two machines are two entries

- **WHEN** two joined machines each run an agent with the same name, working directory and runtime
- **THEN** the unified list contains two separate entries
- **AND** each entry names the machine its agent is on

### Requirement: Joining an already-joined host shall add nothing

The system SHALL treat joining a host that is already joined as a no-op that reports itself as one.
It SHALL NOT create a second entry for that host and SHALL NOT list that host's agents twice. Two
spellings of one address, and two different addresses that turn out to be one machine, SHALL each
resolve to a single entry.

#### Scenario: Re-joining the same host adds no entry

- **WHEN** a person joins a host that is already joined
- **THEN** they are told it was already joined
- **AND** the number of joined hosts is unchanged
- **AND** the unified list contains that machine once and its agents once

#### Scenario: One machine reached at two addresses becomes one entry

- **WHEN** one machine is joined at two different addresses and answers at both
- **THEN** it appears in the list once

### Requirement: A client shall accept an explicit list of host addresses

The system SHALL allow a person to name a list of host addresses directly and receive the same
unified list, with the same labelling and the same distinctions, without those hosts having been
joined to each other or to the host being used.

#### Scenario: An explicit list produces the same unified view

- **WHEN** a person names two host addresses that have never been joined to anything
- **THEN** they receive one unified list covering both machines
- **AND** an address in that list that does not answer is shown as unreachable rather than as empty

#### Scenario: Naming hosts does not join them

- **WHEN** a person names host addresses explicitly and then asks which hosts are joined
- **THEN** no host has been joined as a result

### Requirement: The capability shall require no relay, tunnel or external process

The system SHALL implement this capability with the hosts themselves and nothing else. It SHALL NOT
require a relay, a tunnel, a broker, a discovery service, an account, or any process running
anywhere other than on the hosts being joined.

#### Scenario: Two hosts list each other with nothing else running

- **WHEN** two hosts are joined and one lists the other's agents
- **THEN** the only processes involved are the two hosts themselves

### Requirement: How a peer is trusted when joined shall not be answered by this change

The system SHALL NOT settle how a host comes to be trusted by a peer, and SHALL NOT settle how a
revocation on one host reaches another. Those mechanisms SHALL refuse rather than adopt a default.
No host SHALL accept a device credential issued by another host while the revocation question is
unanswered, so that a device revoked on the host that issued it is served by no host in the mesh.

#### Scenario: A credential issued by one host is refused by another

- **WHEN** a device paired with one host presents its credential to a different host
- **THEN** that host refuses it
- **AND** the refusal is the same response an unknown path receives

#### Scenario: A request to settle the trust mechanism is refused

- **WHEN** a person asks the command line to share a mesh key, trust a peer on joining, or
  propagate revocations
- **THEN** the command refuses, reports the exit code reserved for an open product decision, and
  names the Issue that owns it

#### Scenario: A peer that cannot be authenticated to is reported rather than guessed at

- **WHEN** a host has no credential for a peer it has joined
- **THEN** that peer is shown with its machine named and its agents stated as unknown
- **AND** it is not shown as unreachable and not shown as having no agents

### Requirement: Every mesh surface shall be usable one-handed on a phone

The system SHALL present every human-facing surface of this capability so that it is usable
one-handed on a 375px-wide viewport: no horizontal page scroll, no interactive target smaller than
44px in either dimension, and no content or action reachable only with a pointer.

#### Scenario: The unified list and the join control at 375px

- **WHEN** a person opens the unified list on a 375px-wide phone
- **THEN** the page does not scroll sideways
- **AND** every control, including the field for a host address, is at least 44px in both dimensions
- **AND** nothing requires hover, right-click or drag
