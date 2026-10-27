# Install in the Homebridge UTM appliance

The plugin installs directly through Homebridge UI. No SSH, Python installation,
compiler or extra runtime setup is required.

1. Open Homebridge UI and go to **Plugins**.
2. Search for **homebridge-nissan-ev** and select **Install**.
3. Restart Homebridge if prompted, then open the plugin's **Settings**.
4. Enter your U.S. MyNISSAN email and password, then select **Sign in**.
5. Save settings and restart Homebridge. The plugin discovers Ariyas automatically;
   vehicle names are configurable in settings.

Use the existing bridge pairing in Apple Home. If you place the plugin on a
separate child bridge, pair that bridge's HomeKit QR code with Apple Home.

## Existing installations

Update the plugin and restart Homebridge. Saved token files remain compatible.
The TypeScript SDK replaces Python completely. Old `pythonPath` options are
ignored and removed when settings are saved; no migration command is needed.
Old managed runtime files are no longer used and are left in place.

Use **Check connection** to verify a saved session, or **Sign in again** to replace
it. The password field supports paste and a Show/Hide control. Passwords are not
written to configuration; renewable tokens are stored with owner-only permissions.

On the official appliance, the token file defaults to
`/var/lib/homebridge/nissan-connect/auth.json`. Keep Homebridge backups private.
The VM needs access to npm and GitHub during installation and Nissan during use.
The SDK is pinned to a repository commit with compiled JavaScript, so installation
works with npm lifecycle scripts disabled and without Git or build tools.

Previous live API tests on a U.S. 2023 Ariya read battery/charging status successfully,
but Nissan returned FAILED for start and stop charging. The TypeScript port has
synthetic test coverage; a new live sign-in and deployment still need verification.
The plugin uses HomeKit and does not require the Homebridge 2.4.1 Matter beta.
