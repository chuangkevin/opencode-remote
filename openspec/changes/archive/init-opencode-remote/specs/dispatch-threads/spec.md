## ADDED Requirements

### Requirement: Threads SHALL persist independently of the mobile client lifecycle
`opencode-remote` SHALL store thread state on the server so execution continues even when the iPhone PWA is backgrounded, closed, or reloaded.

#### Scenario: iPhone app is backgrounded after dispatch
- **WHEN** the user submits a prompt to a thread from the PWA and then switches apps or locks the phone
- **THEN** the associated job continues on the local runner
- **AND** the thread state remains available on the server without requiring the originating browser tab to stay connected

#### Scenario: User reopens the PWA later
- **WHEN** the user reopens the PWA after a disconnect or reload
- **THEN** the app can fetch the latest thread timeline and job state from the server
- **AND** the user returns to the same logical thread instead of creating a new ad-hoc session

### Requirement: Each thread SHALL map to a reusable OpenCode session
The system SHALL bind a remote thread to a concrete OpenCode session so follow-up prompts continue the same coding context.

#### Scenario: First prompt in a new thread
- **WHEN** the user dispatches the first prompt in a thread that does not yet have an OpenCode session mapping
- **THEN** the runner creates an OpenCode session
- **AND** stores the resulting session identifier against that thread

#### Scenario: Follow-up prompt in an existing thread
- **WHEN** the user sends another prompt to a thread that already has an OpenCode session mapping
- **THEN** the runner reuses the mapped OpenCode session
- **AND** the follow-up work continues with the existing coding context

### Requirement: Dispatch execution SHALL be asynchronous and event-backed
The mobile client SHALL submit work to the server, and the runner SHALL execute it asynchronously while emitting state transitions into the thread timeline.

#### Scenario: Prompt submission returns before execution finishes
- **WHEN** the user submits a prompt
- **THEN** the server accepts the request without waiting for the full OpenCode completion
- **AND** creates or updates a job record linked to the thread
- **AND** later timeline updates reflect running, completed, failed, or aborted states

#### Scenario: Runner receives OpenCode progress events
- **WHEN** OpenCode emits status or message events for the mapped session
- **THEN** the runner translates them into server-side thread events
- **AND** the thread timeline becomes the source of truth for the PWA

### Requirement: Permission requests SHALL round-trip through the remote thread
If OpenCode asks for permission, the request SHALL be surfaced through the thread so the user can answer from the PWA.

#### Scenario: OpenCode requires permission approval
- **WHEN** the mapped OpenCode session emits a permission request
- **THEN** the server stores the pending permission request against the thread
- **AND** the thread detail UI shows an approval / denial affordance

#### Scenario: User approves or denies from the PWA
- **WHEN** the user responds to the permission request in the PWA
- **THEN** the server forwards that response back to the mapped OpenCode permission endpoint
- **AND** the in-flight job resumes or terminates accordingly

### Requirement: Desktop continuation SHALL remain compatible with native OpenCode tooling
The remote dispatch layer SHALL preserve compatibility with the underlying OpenCode session so the same work can be resumed from a desktop terminal.

#### Scenario: User wants to continue from desktop
- **WHEN** a thread already maps to an OpenCode session and the user opens the desktop environment
- **THEN** the session identifier remains valid for desktop-side continuation workflows such as `opencode attach`
- **AND** the user is not forced into a separate disconnected thread history
