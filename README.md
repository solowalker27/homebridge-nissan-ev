# homebridge-nissan-ev

A Homebridge dynamic platform for a **US MyNISSAN account and Nissan Ariya**.
Each vehicle is **one HomeKit accessory containing linked services**, identified by
VIN. Renaming it does not replace the accessory or break its service identities.

This is an unofficial integration using [pynissan](https://github.com/bvdcode/nissan-connect-sdk)
0.2.1. It runs a private Python subprocess over stdin/stdout; it does not expose
an HTTP server. Tested with Homebridge 2.4's real HAP service classes. Requires
Node 22, 24, or 26 on a 64-bit Linux or macOS Homebridge host. **No preinstalled
Python or terminal setup is required.**

Tested with a U.S. 2023 Ariya. Support for other Nissan EV models or markets has
not been verified; vehicle discovery currently selects Ariyas. This project is
not affiliated with Nissan or Homebridge.

## What appears in HomeKit

| Vehicle function | HomeKit representation |
| --- | --- |
| Lock/unlock all doors | Lock Mechanism (primary service) |
| Charging start/stop | Outlet; On and In Use reflect reported charging |
| Battery percentage, charging state, low battery | Battery service |
| Charge cable connected | Contact Sensor; closed means connected |
| Cabin climate temperature and target | Thermostat, with Off/Auto control |
| Climate on/off | Fan service; no invented fan-speed controls |
| Individual doors, windows, hood, hatch, sunroof | Read-only Contact Sensors when reported |
| Flash lights | Momentary Lightbulb |
| Horn and lights | Momentary Switch (Nissan combines these) |
| Refresh vehicle/battery/climate; wake vehicle | Momentary Switches |
| Locate vehicle | Momentary Switch, plus custom location data |
| Existing charge/climate schedules | Switch per schedule, identified by Nissan schedule ID |
| Seat heat/cool, heated steering wheel, defrost | Setting switches when Nissan returns those settings |
| Charge limit and notification percentage | Writable custom characteristics, when returned |
| V2L reserve percentage | Writable custom characteristic, only if returned |
| Create/edit/delete schedules; delayed climate | Custom JSON command characteristics |
| Range, odometer, tire pressures, maintenance indicators, timestamps, location, capabilities, and schedule details | Custom read-only characteristics |
| Next service date, odometer target, remaining distance/months, due status | Linked Maintenance service with custom characteristics |
| Vehicle name, command progress and failures | Custom characteristics |

All scalar fields returned by the selected current-status, capabilities, climate,
charge-configuration, schedule, maintenance, V2L and optional location queries are exposed. Data
is split into linked services to respect HomeKit's limit of 100 characteristics
per service. Unknown values are unavailable rather than converted to false/zero.

**Apple Home and Siri do not display arbitrary custom characteristics.** An app
such as Eve or Controller for HomeKit can expose those details; visibility depends
on the controller. Standard services are the route to Apple Home/Siri control.
Apple Home chooses its own tile layout; the plugin guarantees one underlying
accessory with linked services, not one particular Home app tile arrangement.

This is vehicle telemetry and remote control, not a clone of every Nissan app
screen. Billing, subscriptions, public charging purchases, trip/history browsers,
navigation route editing, camera streams, and account administration are not
HomeKit services in this plugin. It does not add features absent from the car or
subscription. In particular, a library method for charge limits or V2L does not
prove a 2023 Ariya supports it.

## Install in Homebridge UI

1. In **Plugins**, search for **homebridge-nissan-ev** and install it.
2. Restart Homebridge if prompted, then open the plugin's **Settings**.
3. Wait for automatic connection setup. The plugin downloads a private Python
   runtime and installs the pinned Nissan client plus its dependencies. Progress
   appears in the settings screen. First setup may take a few minutes.
4. Enter your U.S. MyNISSAN email and password and select **Sign in**.
5. Save settings and restart Homebridge after initial setup. Your Ariya is
   discovered automatically. Vehicle names and options are below the sign-in form.

**No SSH, terminal commands, Python installation, or executable-path configuration
is needed.** This also applies to the official Homebridge UTM appliance; see
[the UTM guide](docs/INSTALL-UTM.md).

The plugin supports 64-bit Linux and macOS on Intel/AMD (`x64`) or ARM (`arm64`).
Homebridge needs internet access to download its private runtime from Astral's
GitHub releases and Python packages from PyPI/files.pythonhosted.org. Downloads
of the connection helper are version-pinned and SHA-256 verified before use.
The helper installs Python 3.13 and `pynissan==0.2.1`, including `aiohttp` and its
transitive dependencies, under `nissan-connect` in Homebridge storage. Setup
coordinates across the UI and running plugin, reuses a healthy runtime, and does
not require administrator privileges or change system Python/shell profiles.
It works even when npm lifecycle scripts are disabled.

If setup fails because a download is unavailable, the UI explains which step
failed. Use **Check connection** to retry once connectivity is restored. An
existing outdated `python3` setting automatically falls back to the private
runtime; a compatible custom Python environment remains usable.

The UI creates the platform configuration for you. A minimal manual entry is:

```json
{
  "platform": "NissanConnect",
  "name": "Nissan EV",
  "readOnly": true
}
```

`readOnly: true` blocks vehicle commands while retaining status. Set it to false
when ready to use remote actions; vehicle support and Nissan entitlement still
apply. Names and per-vehicle overrides can be set with:

```json
{
  "vehicles": [
    { "vin": "YOUR_17_DIGIT_VIN", "name": "My Ariya", "enabled": true }
  ]
}
```

`vehicles` is optional; all Ariyas in the account are discovered otherwise.
`disabledFeatures` on a vehicle can block `lock`, `charge`, `climate`, `lights`,
`horn`, `refresh`, `wake`, `location`, `schedules`, or `chargeSettings`. Blocking
retains status services but rejects the corresponding writes. Disabling a vehicle
removes it on discovery after restart.

Use the existing bridge pairing in Apple Home. If you choose a separate child
bridge, pair that child bridge's HomeKit QR code. This plugin publishes HomeKit
accessories and does not require a Homebridge Matter beta.

## Sign-in and reauthentication in Homebridge UI

Open the plugin's settings and use **Sign in** or **Sign in again**. The password
is sent through Homebridge UI to a private Python pipe, then to Nissan. It is not
written into `config.json`, process arguments, diagnostic output, or the token
file. The password field is cleared when submitted, including on failure. The
plugin stores renewable tokens in an owner-only (`0600`) auth file on the
Homebridge host. Treat normal Homebridge storage backups as private.

The password field supports clipboard paste, including Safari's text clipboard
format. Use **Show** to check the entered value, or **Hide** to conceal it again.
Background status and connection checks preserve anything you have typed or
pasted. Submitting sign-in clears and conceals the field immediately.

**Saved sign-in found** only means a local token file exists; select **Check
connection** for a read-only account check. Opening settings may prepare local
dependencies but does not contact Nissan. No sign-in or connection check sends
vehicle commands. If Nissan rejects
a new sign-in or account verification fails, the existing token file is retained.
The settings screen shows fixed error guidance without raw upstream responses.

Sign-in and token refresh use a shared file lock on Linux/macOS. The running
adapter reloads the file before each request, so a saved replacement session is
used on its next request. If a status poll is holding the lock, the UI may ask
you to wait and try again. There are no automatic login retries. Initial setup,
path changes, or changing platform options still require Save and restart.

The terminal fallback remains available:

```sh
"$NISSAN_DATA/venv/bin/python" "$PLUGIN_DIR/python/nissan_bridge.py" \
  --setup --auth-file "$NISSAN_DATA/auth.json"
```

Run as the Homebridge service account. On macOS, `--dialogs` uses local credential
dialogs. UI login requires Homebridge Config UI X with custom plugin UI support;
the packaged `homebridge-ui` uses the official `@homebridge/plugin-ui-utils` API.

## Rename at any time

- In Apple Home, edit the accessory name in its settings; this affects Home/Siri.
- In Homebridge UI, change the name for the same VIN and restart Homebridge. The
  plugin updates linked service names without changing accessory/service UUIDs.
- A controller supporting custom characteristics can write **Vehicle Name** to
  rename the plugin accessory immediately, without restarting.

Apple Home may retain names it has already cached or names you edited in Home;
change those in Home as well. This is a HomeKit name, not a request to rename the
vehicle in Nissan's account. The plugin never uses the name as an identifier.

## Climate behavior

HomeKit uses Celsius internally. Target range is initially 16–30 °C. Nissan's
reported climate temperature is exposed separately from saved target settings.
Changing a target while climate is off saves the next-start target locally;
while on, it sends a climate adjustment. The Fan service controls climate power,
not fan speed. The car decides heating versus cooling; only Off/Auto is writable.
If Nissan only reports ON, without heat/cool state, the thermostat's *current*
heating/cooling state remains unavailable. Some Home apps may therefore mark
that thermostat unavailable; the separate Climate Power control still works.
No ambient temperature or operating mode is fabricated to fill missing data.

Seat/wheel/defrost switches represent settings returned by Nissan, not measured
physical heater activity. While climate is off, they update saved defaults.
While climate is on, they submit an adjustment. Optional fields appear only
when the API supplies them; all commands remain subject to Nissan enforcement.

## Commands, latency, and freshness

HomeKit writes acknowledge **queueing**, not physical completion. Nissan commands
are asynchronous; **Command In Progress**, **Last Command**, and **Command Failed
or Unconfirmed** expose the outcome. A successful submission is polled until
Nissan reports success/failure or a timeout. The log records the result. Actual
lock/charge/climate readings are not set to optimistic target values. A second
command to the same vehicle is rejected while one is pending. Commands are never
replayed automatically after an error, restart, or timeout. A timed-out command
may still finish at Nissan; inspect the car/app before trying it again.

Routine polling reads Nissan's cached data; it does not wake the car. The manual
refresh/wake switches are separate commands. API Read Time only describes when
the server was queried, not when the car last reported. Individual source
timestamps are exposed when supplied. `staleAfter` marks data unavailable if API
reads stop succeeding; it cannot detect stale upstream data with no timestamp.

## Advanced schedule commands

Use a HomeKit controller that supports writing custom strings. These are not
native Apple Home calendar editors. Times must have an explicit UTC offset;
weekday codes are MO, TU, WE, TH, FR, SA, SU. Strings are limited to 256 bytes by
the characteristic. Durations are ISO 8601 hours/minutes, such as `PT2H30M`.

Write to **Edit Charge Schedule**:

```json
{"operation":"create","start":"2026-10-21T23:00:00-05:00","duration":"PT2H","days":["MO","TU","WE","TH","FR"]}
```

Write to **Edit Climate Schedule**:

```json
{"operation":"create","start":"2026-10-21T07:00:00-05:00","temperature":22,"days":["MO","TU","WE","TH","FR"]}
```

Use `"operation":"update"` and `"id":"NISSAN_SCHEDULE_ID"` with the same full
fields to replace a schedule; use `{"operation":"delete","id":"..."}` to
remove one. **Schedule Delayed Climate** accepts
`{"start":"2026-10-21T07:00:00-05:00","temperature":22}`. All temperatures are
Celsius. Read back Nissan's schedule data to verify timezone/DST interpretation.

## Validation and troubleshooting

The initial read-only probe successfully authenticated, found a U.S. 2023
Ariya, read battery status, refreshed tokens, and read again. Plugin tests use
real Homebridge/HAP service objects and simulated Nissan responses, including
failed commands, null telemetry, renaming/restarts, and token persistence.
The plugin has not yet been verified against a deployed Homebridge instance. Separate
live API tests successfully read battery percentage and plugged-in/charging
status. Both start and stop charging were accepted for processing, then returned
FAILED; status confirmed the stop request did not end the active charging session.
Other remote commands have not been verified against that vehicle.

- Adapter stopped: reopen plugin settings to check/repair its private runtime.
  Check Homebridge storage ownership, available disk space, and internet access.
- HTTP 401: reauthenticate locally after verifying official-app login.
- HTTP 403: Nissan may require device verification or additional entitlement.
  The helper supports an optional `request_proof` object in the private auth file
  (`api_attestation`, `device_status`) but does not obtain/renew attestation itself.
- Optional query failure: the core snapshot remains usable; **Unavailable Data
  Sections** lists failed queries. Missing values are not interpreted as zero.

Credentials and tokens are never logged. Homebridge's accessory cache does contain
vehicle status and, when enabled, location; protect normal Homebridge backups.
Raw server error bodies are suppressed because they may contain personal data.

To develop from source:

```sh
npm ci --ignore-scripts
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm test
npm run check
.venv/bin/python -m unittest discover -s test -p 'test_*.py'
npm pack
```

The original read-only probe remains at `check_connection.py` in the source
workspace. It is not bundled into the Homebridge package.

## Next recommended service (0.1.1)

The linked **Maintenance** service reads Nissan's maintenance timeline. It exposes
**Next Service Date**, **Next Service Odometer**, **Distance Until Service**,
**Service Distance Unit**, and **Months Until Service (Nissan)**. The API is queried
in miles. These use Nissan's predictions, not a locally invented service interval.
The full timeline, including last service and current mileage, is also in Vehicle Data.

**Next Service Status** is derived from the returned next date and remaining
mileage: Upcoming, Due by date, Due by mileage, or Due by date and mileage. Date
comparison uses the Homebridge host's timezone. Zero remaining months alone does
not mean overdue, because Nissan can round that value. Missing/failed data is
unavailable rather than interpreted as no service due. This endpoint does not
supply a description of the specific work (such as tire rotation).

**Maintenance Availability** distinguishes a returned timeline, an empty response,
and a failed query. A maintenance-alert subscription does not guarantee that this
endpoint supplies the recommendation shown in MyNISSAN. If it returns no timeline,
the plugin cannot yet reproduce that app recommendation. The library also contains
generated maintenance-visit queries, but they require schedule inputs (including a
severity identifier) that this integration does not currently obtain; they are not
used as an unverified substitute.

Maintenance is a custom service: Apple Home has no native odometer/service-reminder
tile. View the fields in a HomeKit controller that displays custom characteristics,
or use the read-only inspection report below. The fields are not disguised as an
air-filter replacement or an unrelated Home sensor.

## Which features does my vehicle actually have?

The feature list describes this plugin's implemented mappings, not a verified list
of everything on your VIN. The base lock/climate/charge/refresh controls are exposed
as candidates; only a successful command and subsequent observation establish that
a particular action works. Some options depend on subscription, vehicle software,
region, and Nissan's request-verification requirements.

**Charge Limit Availability** and **Charge Notification Availability** in Vehicle
Data distinguish three cases:

- **Reported: N%; changing it is not yet verified**: Nissan returned a numeric
  setting. Its control is exposed, but no test mutation was performed.
- **Not reported for this vehicle/account**: the query succeeded without that
  setting. Its control is omitted (and removed if previously present).
- **Unknown: charge configuration query failed**: a network, entitlement, parser,
  or authentication problem prevents a conclusion. Previously created controls
  remain unavailable until another successful read, including for writes.

Charge limit is a requested charging stop percentage; notification percentage is
an alert threshold and is not evidence of an enforced charging limit. The library
queries these under the `BaseElectric2Vehicle` GraphQL interface. Its support for
that interface does not prove a 2023 Ariya implements it.

The raw **capabilities / services** entries include Nissan's service `type`,
`enabled`, and `subscribed` flags. These provide eligibility evidence, not proof of
successful remote execution. A null subscription flag is unknown, not false.
Vehicle Data also shows named **Eligibility** fields for door lock/unlock, remote
charging, climate, battery status, maintenance alerts, horn/lights and parked-car
finder. These show both flags explicitly; an enabled service does not validate
every related command (for example, charging eligibility alone cannot establish
charge-stop or percentage-limit support).

To inspect your actual vehicle without changing anything, use the same Python and
plugin paths configured above. Shared token-file access is coordinated through
the adapter's lock; if it is busy, wait for the current request to finish:

```sh
"$NISSAN_DATA/venv/bin/python" "$PLUGIN_DIR/python/nissan_bridge.py" \
  --inspect --auth-file "$NISSAN_DATA/auth.json" \
  --report "$NISSAN_DATA/vehicle-capabilities.json"
```

Alternatively omit `--auth-file` to sign in interactively using an independent,
in-memory session. Add `--dialogs` on macOS for local credential dialogs. This
independent inspection saves neither password nor tokens. The report includes a
masked VIN, maintenance timeline, charge settings, service eligibility flags,
and per-query error types. It excludes location, credentials, and raw error bodies.
No vehicle commands or wake requests are sent. Inspection results describe the
time/account queried and can change.
