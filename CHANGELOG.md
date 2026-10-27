# Changelog

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
