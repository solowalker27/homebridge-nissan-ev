# Changelog

## 0.6.0

- Log reported vehicle state changes by default, with before/after values and
  poll versus matching plugin-command follow-up labels. Establish a baseline on
  startup and avoid repeating unchanged polls or timestamp-only updates.
- Give commands local references and log requests, acceptance, outcomes, known
  failure reasons and whether lock/charging results are observed. Preserve the
  distinction between Nissan's success response and cached telemetry.
- Add optional debug logging in plugin settings, default off and independent of
  Homebridge's global debug flag: HTTP timing/status, session renewal, poll and
  command diagnostics, HomeKit update counts and threshold pulses.
- Read available remote-service history and notification/reminder settings at
  most every five minutes in debug mode. Correlate history privately with plugin
  requests and leave unknown callers unidentified. Do not register push listeners.
- Redact credentials, raw payloads, identifiers, free text and precise location;
  keep safe reason categories. Diagnostic failures cannot invalidate core status.

## 0.5.2

- Keep the requested lock/unlock target while Nissan processes a command instead
  of immediately snapping it back to the previous state. Current lock state still
  reflects reported vehicle telemetry. Repeated writes of the same pending lock
  target do not send another command.
- Stop reporting door/window and charge-cable sensor faults when an unrelated
  vehicle command fails. Sensor faults now depend on their own available, fresh
  telemetry; command failures remain visible in command diagnostics and logs.
- Log an actionable reason when settings or an in-progress command block a write.
- Test lock/unlock through real HAP handlers and the actual SDK/native HTTP path
  with simulated Nissan responses, including failed submissions and completion.

## 0.5.1

- Fix the sign-in UI enabling status-only mode for new configurations despite the
  schema default being off. Default vehicle controls to enabled in setup and runtime,
  while preserving explicitly saved choices.
- Rename the setting to "Disable secure vehicle controls" and explain the commands
  it blocks, its purpose and that it does not limit access outside the home network.

## 0.5.0

- Make Battery Threshold Reached configurable as a read-only outlet (the new
  default), contact sensor or read-only switch in Homebridge plugin settings.
- Repeat threshold events on newly observed battery increases by default: reset
  the indicator for one second, then reassert it while the threshold remains met.
  Queue rapid increases separately with one second between pulses.
- Add a setting to disable repeated events. Unchanged or decreasing readings do
  not repeat; disabling the threshold, changing it, losing valid data or shutting
  down cancels pending pulses.
- Replace only the indicator when changing types, preserving threshold settings
  and custom names. Reconfigure existing contact-based automations for the new
  default outlet, or select Contact sensor to retain the original service type.

## 0.4.0

- Retain the genuine battery service and add a read-only dimmable-light proxy:
  brightness displays the reported battery percentage, with writes rejected.
- Add a Battery Threshold light whose brightness sets a local 0–100% threshold
  and whose power enables or disables monitoring. Default to 80% and disabled.
- Add a linked Battery Threshold Reached contact sensor. It opens when an enabled
  threshold is met or exceeded and closes below the threshold or when disabled.
- Persist threshold settings across restarts, update sensor events immediately
  when settings change, and reject stale or invalid battery readings while enabled.
- Keep all three services linked to the existing vehicle accessory. Threshold
  settings remain local and do not send charging commands or set Nissan charge limits.

## 0.3.1

- Use the vehicle name directly for the primary lock service, preventing repeated
  "Doors" suffixes from feeding back into every linked service name.
- Save individual service names and preserve them through status polling,
  Homebridge restarts and vehicle renames, including optional and custom services.
- Repair recognizable generated "Doors Doors" names on upgrade and retain surviving
  cached custom names without changing accessory or service identities.
- Keep service Name, ConfiguredName and accessory information names consistent.

## 0.3.0

- Replace pynissan and the Python subprocess with the native TypeScript SDK in
  [nissan-connect-sdk-ts](https://github.com/solowalker27/nissan-connect-sdk-ts),
  an auto-generated MIT-licensed translation of bvdcode/nissan-connect-sdk.
- Install and sign in entirely through Homebridge UI using existing Node.js.
  Remove Python downloads, dependency provisioning and executable-path settings.
- Preserve existing saved tokens, accessory UUIDs, linked services and Safari
  password paste support. Serialize UI/plugin token updates with a shared lock.
- Abort timed-out native sessions and cancel queued writes; subsequent reads can
  reconnect without replaying an abandoned command.
- Handle password paste inside the setup iframe, including Safari's text clipboard format.
- Add an accessible Show/Hide password button.
- Preserve entered passwords during background status and connection checks.
- Capture sign-in credentials before asynchronous settings reads; clear and conceal the submitted password immediately.

## 0.2.0

- Initial npm release with MyNISSAN account sign-in and connection checks in Homebridge UI.
