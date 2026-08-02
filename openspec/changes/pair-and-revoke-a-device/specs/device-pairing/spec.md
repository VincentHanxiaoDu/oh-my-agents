# device-pairing

## ADDED Requirements

### Requirement: A browser that has never been paired shall receive no agent data

The system shall require a device credential for every route, including when the request arrives
over the tailnet address. A browser holding no credential shall be shown a pairing prompt rather
than any agent data, and shall be unable to list agents, attach to a session, or send input.

#### Scenario: An unpaired browser on the tailnet is shown a prompt, not agents

- **WHEN** a browser that has never paired requests the host's page over its tailnet address
- **THEN** it receives a pairing prompt
- **AND** the response contains no agent name, no session identifier, no session count and no
  machine or host name

#### Scenario: An unpaired browser cannot list, attach or send input

- **WHEN** an unpaired browser requests any API route, by any method
- **THEN** the request is refused
- **AND** no agent data is returned on any of them

### Requirement: The host shall produce a one-time pairing code on demand

The system shall produce, on demand, a pairing code that a person can read off one screen and type
into another. Entering that code in an unpaired browser shall pair that browser, after which it
shall have access on later visits without anything being entered again.

#### Scenario: A code pairs a browser, and later visits need nothing typed

- **WHEN** an operator asks the host for a pairing code and enters it in an unpaired browser
- **THEN** that browser is paired and is served agent data
- **AND** a later request from that browser is served without any code being entered again

#### Scenario: A code is produced only on demand

- **WHEN** no operator has asked for a pairing code
- **THEN** no code exists that would pair a browser

### Requirement: A pairing code shall be single-use and time-limited

The system shall accept a pairing code at most once, and only within a bounded window from its
creation. A code that has already paired a device, and a code past its window, shall not pair. The
refusal for a spent or expired code shall be indistinguishable from the refusal for a mistyped one.

#### Scenario: A code that has already paired a device does not pair a second one

- **WHEN** a code is used to pair one browser and is then presented by a second browser
- **THEN** the second browser is not paired
- **AND** it is served no agent data

#### Scenario: A code past its window does not pair

- **WHEN** a code is presented after its expiry
- **THEN** it does not pair the browser presenting it

#### Scenario: A spent code and a mistyped code fail the same way

- **WHEN** a spent code and a never-valid code are each presented
- **THEN** both are refused
- **AND** the two responses are identical, so neither confirms that a code was ever real

### Requirement: Paired devices shall be listable and individually revocable

The system shall list the devices paired with a host, each carrying something a person can use to
tell one from another, and shall allow any single device to be revoked. An identifier matching more
than one device shall revoke nothing.

#### Scenario: Two paired devices are distinguishable in the list

- **WHEN** two different browsers are paired and the devices are listed
- **THEN** both appear
- **AND** each carries a label and an identifier a person can use to tell them apart

#### Scenario: An ambiguous identifier revokes nothing

- **WHEN** a revocation names an identifier matching more than one device
- **THEN** no device is revoked
- **AND** the ambiguity is reported

### Requirement: Revoking one device shall not affect the others

The system shall reject a revoked device's next request and return it to the pairing prompt. Every
other paired device shall continue to be served and shall not be required to pair again.

#### Scenario: The revoked device is rejected on its next request

- **WHEN** a device is revoked and that device makes its next request
- **THEN** the request is rejected
- **AND** a document request from it is answered with the pairing prompt

#### Scenario: The other paired device is untouched

- **WHEN** one of two paired devices is revoked
- **THEN** the other device's request is still served agent data
- **AND** it is not asked to pair again

### Requirement: A refused request shall disclose nothing about what is running

The system shall answer an unpaired or revoked caller with a response indistinguishable from the one
a paired caller receives for something that does not exist — in status code, headers, body and
length alike. The response shall carry no session output, no agent name, no machine name, no host
name and no count, and shall not disclose that authentication is what failed.

#### Scenario: The denial is byte-identical to an ordinary not-found

- **WHEN** an unpaired caller requests a real route and a paired caller requests a route that does
  not exist
- **THEN** the two responses have the same status code, the same headers and the same body bytes

#### Scenario: A revoked device attempting to attach learns nothing

- **WHEN** a revoked device attempts to attach
- **THEN** it receives no session output, no agent name and no machine name
- **AND** it is not told whether an attach endpoint exists at all

### Requirement: A pairing store that cannot be read shall deny

The system shall distinguish a store that is absent, meaning no device has ever paired, from a store
whose contents could not be determined, meaning unreadable, corrupt, or of an unrecognised schema.
Neither shall grant access, the two shall not share a value or a rendering, and a store that could
not be read shall never be treated as an empty one nor overwritten with one.

#### Scenario: An unreadable store denies a credential that worked a moment ago

- **WHEN** a device is paired and served, and the pairing store then becomes unreadable
- **THEN** that same device's next request is denied
- **AND** the host reports that it could not determine which devices are paired, rather than
  reporting that none are

#### Scenario: An absent store is not an error

- **WHEN** no device has ever paired with a host
- **THEN** the store reads as absent rather than as undetermined
- **AND** a browser is served the pairing prompt

#### Scenario: A store that could not be read is not overwritten

- **WHEN** an operation that would write the store runs against a store that cannot be read
- **THEN** the store on disk is left unchanged
- **AND** no device is silently revoked

### Requirement: Pairing state shall survive a host restart

The system shall persist pairing state on disk, in the directory the project's state-directory
helper resolves, so that a paired device is not required to pair again after the host is restarted.

#### Scenario: A paired device does not pair again after a restart

- **WHEN** a device is paired and the host is stopped and started again
- **THEN** that device's next request is served
- **AND** it is not shown a pairing prompt

### Requirement: A device credential shall be verifiable by a host that did not issue it

The system shall make a device credential verifiable by any host holding the mesh key, rather than
only by the host that issued it, so that a device paired to one host in the mesh is not required to
pair separately with each peer. Such verification shall establish authenticity only, not current
authorisation, because only the issuing host's store records a revocation.

#### Scenario: A peer verifies a credential it never issued

- **WHEN** a host holding only the mesh key is presented a credential issued by another host
- **THEN** it can determine that the credential is authentic
- **AND** it needs no copy of the issuing host's device records to do so

#### Scenario: A credential from a different mesh is not authentic

- **WHEN** a credential minted under a different mesh key is presented
- **THEN** it is not authentic
- **AND** it grants nothing

### Requirement: Every pairing surface shall be usable one-handed on a 375px viewport

The system shall present every human-facing surface this capability adds so that it is usable
one-handed at a 375px-wide viewport: no horizontal page scroll, no interactive target smaller than
44px, and nothing reachable only by hover, right-click or drag.

#### Scenario: The pairing prompt and the device list fit a phone

- **WHEN** the pairing prompt and the device list are viewed at a 375px-wide viewport
- **THEN** neither scrolls horizontally
- **AND** every interactive target is at least 44px
- **AND** no action requires hover, right-click or drag
