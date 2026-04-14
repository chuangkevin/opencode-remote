## ADDED Requirements

### Requirement: The system SHALL support Web Push subscriptions for the installed PWA
`opencode-remote` SHALL let the installed PWA register a push subscription so the server can notify the user while the app is not in the foreground.

#### Scenario: User enables notifications on iPhone PWA
- **WHEN** the user grants notification permission from the installed PWA
- **THEN** the client registers a push subscription with the server
- **AND** the subscription is stored for future thread-related notifications

### Requirement: The server SHALL notify on job completion and job failure
The server SHALL send Web Push notifications for important terminal job outcomes.

#### Scenario: Job completes successfully in the background
- **WHEN** a background job transitions to completed
- **THEN** the server sends a push notification that identifies the related project and thread

#### Scenario: Job fails in the background
- **WHEN** a background job transitions to failed
- **THEN** the server sends a push notification indicating that attention is needed

### Requirement: The server SHALL notify when user approval is required
Permission-gated execution SHALL trigger a push notification so the user does not need to keep the app open to notice it.

#### Scenario: OpenCode emits a permission request while PWA is backgrounded
- **WHEN** the runner records a pending permission request for a thread
- **THEN** the server sends a push notification that clearly indicates approval is required

### Requirement: Notification clicks SHALL route back to the related thread
Notifications SHALL deep-link the user back to the thread that triggered them.

#### Scenario: User taps a completion or approval notification
- **WHEN** the user taps the delivered notification
- **THEN** the PWA opens or focuses
- **AND** navigates to the thread detail view for the associated project and thread
