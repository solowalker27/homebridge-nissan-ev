# Install in the Homebridge UTM appliance

The plugin installs directly through Homebridge UI. No SSH, terminal commands,
Python installation, or path configuration is required.

1. Open Homebridge UI and go to **Plugins**.
2. Search for **homebridge-nissan-ev** and select **Install**.
3. Restart Homebridge if prompted, then open the plugin's **Settings**.
4. Wait for **Preparing Nissan connection** to finish. The first setup downloads
   a private Python runtime and the Nissan client automatically inside the VM.
   This may take a few minutes; progress is shown in the settings screen.
5. Enter your U.S. MyNISSAN email and password, then select **Sign in**.
6. After successful sign-in, save settings and restart Homebridge. The plugin
   discovers Ariyas automatically; vehicle names are configurable in settings.

Use the existing bridge pairing in Apple Home. If you place the plugin on a
separate child bridge, pair that bridge's HomeKit QR code with Apple Home.

## Existing installations

Update the plugin through Homebridge UI and restart Homebridge. Open its settings
again; missing dependencies are installed automatically. A healthy existing
runtime and saved sign-in are reused. Old system-Python paths fall back to the
managed runtime when they cannot run the Nissan client. Save settings after setup
to retain the detected paths.

Use **Check connection** to verify a saved session, or **Sign in again** to replace
it. The password field supports paste and a Show/Hide control. Passwords are not
written to configuration; renewable tokens are stored with owner-only permissions.

## Where the runtime lives

On the official appliance, plugin data lives under
`/var/lib/homebridge/nissan-connect`. This includes the private runtime, download
cache, and authentication file. System Python and shell profiles are unchanged,
and setup does not need administrator privileges. Keep Homebridge backups private.

The VM needs internet access to GitHub (the official helper and Python runtime),
PyPI/files.pythonhosted.org (Python dependencies), and Nissan (vehicle access).
If a download fails, the UI identifies the failed step; **Check connection** retries
setup. This is a Linux/macOS plugin for 64-bit Intel/AMD or ARM hosts, including
any supported 64-bit Raspberry Pi and the official UTM appliance.

Live API tests on a U.S. 2023 Ariya read battery/charging status successfully, but
Nissan returned FAILED for start and stop charging. Commands remain dependent on
the vehicle, account, and Nissan service. The plugin uses HomeKit and does not
require the Homebridge 2.4.1 Matter beta.
