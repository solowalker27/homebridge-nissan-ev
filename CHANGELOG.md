# Changelog

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
