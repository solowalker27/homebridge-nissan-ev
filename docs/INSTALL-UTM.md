# Install inside the official Homebridge UTM appliance

Use the Linux guest's Homebridge environment for both the plugin and Python.
This guide assumes the official Debian appliance and its default storage path,
`/var/lib/homebridge`.

## 1. Connect to the VM

Replace `VM_USER` with the Linux login created during the appliance's first boot,
and `VM_IP` with the VM's address (the address used to open Homebridge UI).

Run in the Mac's Terminal:

```sh
ssh VM_USER@VM_IP
```

## 2. Enter the appliance's Homebridge shell

Run in the SSH session:

```sh
sudo hb-shell
```

This switches to the Homebridge service account, selects Homebridge's Node/npm,
and opens `/var/lib/homebridge`. Run all remaining commands in this shell.
The appliance stores plugins here; a global npm install under `/opt/homebridge`
is not the appropriate location for this installation.

```sh
cd /var/lib/homebridge
npm install --save homebridge-nissan-ev
node --version
```

The plugin supports Node 22, 24 or 26. You can also install by searching for
**homebridge-nissan-ev** in Homebridge UI's plugin installer.

## 3. Add a private Python runtime

The plugin requires Python 3.12+. Debian 12's default Python is 3.11. These
commands use Astral's uv installer and a private Python 3.13 environment. They
leave the Linux system Python intact. The interpreter and credentials are owned
by the same account that runs Homebridge.

```sh
NISSAN_DATA=/var/lib/homebridge/nissan-connect
PLUGIN_DIR=/var/lib/homebridge/node_modules/homebridge-nissan-ev
mkdir -p "$NISSAN_DATA"
chmod 700 "$NISSAN_DATA"
curl -LsSf https://astral.sh/uv/install.sh -o "$NISSAN_DATA/install-uv.sh"
env UV_INSTALL_DIR="$NISSAN_DATA/tools" UV_NO_MODIFY_PATH=1 sh "$NISSAN_DATA/install-uv.sh"
env UV_PYTHON_INSTALL_DIR="$NISSAN_DATA/python" "$NISSAN_DATA/tools/uv" venv --python 3.13 "$NISSAN_DATA/venv"
"$NISSAN_DATA/tools/uv" pip install --python "$NISSAN_DATA/venv/bin/python" -r "$PLUGIN_DIR/requirements.txt"
"$NISSAN_DATA/venv/bin/python" --version
```

Downloads must be reachable from the VM. Do not copy the Mac's `.venv` into Linux;
the VM needs its own interpreter and dependencies for its architecture.

## 4. Sign in from the guest

Restart Homebridge after installing the plugin. In Homebridge UI, open
**Plugins → homebridge-nissan-ev → Settings**. Enter your MyNISSAN email and password
and select **Sign in**. The private Python runtime from step 3 is detected
automatically. A successful connection lists your Ariya with a masked VIN.

The password is cleared after submission and is not saved in settings. Renewable
authentication tokens are stored in the VM with owner-only permissions. For
reauthentication, return here and select **Sign in again**. If Python is unavailable, check its path
in the settings form below the sign-in panel and complete step 3.

## 5. Configure Homebridge

The settings screen keeps the normal configuration form below the sign-in panel.
Save settings and restart Homebridge after initial setup. To configure manually,
merge this object into the existing `platforms` array (preserve your other entries):

```json
{
  "platform": "NissanConnect",
  "name": "Nissan EV",
  "pythonPath": "/var/lib/homebridge/nissan-connect/venv/bin/python",
  "authFile": "/var/lib/homebridge/nissan-connect/auth.json",
  "pollInterval": 300,
  "staleAfter": 900,
  "includeLocation": true,
  "readOnly": true
}
```

Start with `readOnly: true` to verify status. All Ariyas in the account are
discovered automatically. To specify a name, add a `vehicles` entry with your
VIN and `name`, as described in the README. You can later set `readOnly: false`
to enable the implemented commands; their operation remains vehicle-dependent.
Live tests on a U.S. 2023 Ariya successfully read battery/charging status, but
Nissan returned FAILED for both start and stop charging.

Restart Homebridge through its UI. If using its already-paired main bridge,
the accessory appears through that existing pairing. If you choose a separate
child bridge for the plugin, pair that child bridge's HomeKit QR code with Home.
This package currently publishes HomeKit accessories; it does not publish Matter
EVSE endpoints or require the Homebridge 2.4.1 beta.

## Updating and troubleshooting

For an update, use Homebridge UI's plugin update action or run `npm install
--save homebridge-nissan-ev@latest` from `/var/lib/homebridge` in `sudo hb-shell`, then restart
Homebridge. The Python environment and auth file remain outside the plugin's
directory. Rerun the uv pip command if the new package changes requirements.

If the plugin cannot launch, check its log and the two absolute paths above.
Use `sudo hb-shell` to run the Python helper as the service account; do not fix
permission problems by making the auth file world-readable. Reauthenticate in
plugin settings; sign-in and worker token refreshes share a session lock. A CLI
fallback is available in the README.

Sources: [Homebridge appliance environment](https://github.com/homebridge/homebridge-apt-pkg#about),
[VM appliance guide](https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Virtual-Machine),
[uv installation](https://docs.astral.sh/uv/getting-started/installation/),
[uv-managed Python](https://docs.astral.sh/uv/guides/install-python/).
