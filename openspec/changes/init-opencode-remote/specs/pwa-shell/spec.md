## ADDED Requirements

### Requirement: The web client SHALL be installable as an iPhone-friendly PWA
`opencode-remote` SHALL expose the metadata and assets required for installation to the iPhone home screen.

#### Scenario: Installing from Safari
- **WHEN** the user opens the app in Safari and chooses Add to Home Screen
- **THEN** the installed app has a dedicated manifest identity, icon set, name, and theme color
- **AND** launches as a standalone PWA instead of a normal browser tab

### Requirement: The PWA layout SHALL honor iPhone safe areas
The installed PWA SHALL avoid placing critical controls under the Dynamic Island, status area, or home indicator regions.

#### Scenario: Opening thread detail on iPhone portrait
- **WHEN** the user opens a thread detail view on an iPhone in portrait orientation
- **THEN** the top bar, primary actions, and composer remain fully visible below the top safe area
- **AND** bottom actions remain reachable above the bottom safe area

### Requirement: The PWA SHALL resume from server-side state after reload or restore
The client SHALL treat server-stored thread state as authoritative so iPhone restore behavior does not orphan the user.

#### Scenario: PWA is killed and reopened
- **WHEN** iOS terminates the PWA and the user opens it again from the home screen
- **THEN** the app reloads the last known projects and threads from the server
- **AND** the selected thread can be reopened with current job and permission state

### Requirement: Foreground thread updates SHALL stream without polling-only UX
While the PWA is in the foreground, thread state updates SHALL arrive through a live stream suitable for responsive mobile UX.

#### Scenario: Job is actively running while thread screen is open
- **WHEN** the user is viewing the thread detail screen in the foreground
- **THEN** new timeline events and job status changes appear incrementally without requiring manual refresh
- **AND** the client does not need to wait for the full job to finish before showing progress

### Requirement: The PWA SHALL provide a minimal offline-capable app shell
The installed app SHALL cache its shell so it can reopen quickly and show recoverable UI even before live data reconnects.

#### Scenario: Launching after a transient network interruption
- **WHEN** the user opens the installed PWA during a transient network delay
- **THEN** the app shell still loads from local cache
- **AND** the UI can indicate that remote data is reconnecting rather than failing as a blank page
