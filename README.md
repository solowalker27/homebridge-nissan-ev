# homebridge-nissan-ev

A Homebridge dynamic platform for a **US MyNISSAN account and Nissan Ariya**.
Each vehicle is **one HomeKit accessory containing linked services**, identified by
VIN. Renaming it does not replace the accessory or break its service identities.

This is an unofficial integration using [our TypeScript SDK](https://github.com/solowalker27/nissan-connect-sdk-ts),
an auto-generated translation of [pynissan](https://github.com/bvdcode/nissan-connect-sdk)
by Vadim Belov. It runs directly in Node.js with no Python environment, compiler,
subprocess, runtime download or installation scripts. Tested with Homebridge 2.4's
real HAP service classes. Requires Node 22, 24 or 26. **Install and sign in directly
through Homebridge UI; no terminal setup is required.**

Tested with a U.S. 2023 Ariya. Support for other Nissan EV models or markets has
not been verified; vehicle discovery currently selects Ariyas. This project is
not affiliated with Nissan or Homebridge.

## What appears in HomeKit

| Vehicle function | HomeKit representation |
| --- | --- |
| Lock/unlock all doors | Lock Mechanism (primary service) |
| Charging start/stop | Outlet; On and In Use reflect reported charging |
| Battery percentage, charging state, low battery | Battery service |
| Battery percentage for Home display and Shortcut reads | Read-only dimmable Lightbulb; brightness equals battery percentage |
| Battery automation threshold and enable/disable | Dimmable Lightbulb; brightness sets percentage and On enables monitoring |
| Battery threshold reached | Read-only Outlet by default; configurable as Contact Sensor or read-only Switch |
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
3. Enter your U.S. MyNISSAN email and password and select **Sign in**.
4. Save settings and restart Homebridge after initial setup. Your Ariya is
   discovered automatically. Vehicle names and options are below the sign-in form.

**No SSH, terminal commands, Python installation, or executable-path configuration
is needed.** This also applies to the official Homebridge UTM appliance; see
[the UTM guide](docs/INSTALL-UTM.md). The SDK's compiled JavaScript is included in its
pinned GitHub dependency. npm downloads it as part of normal plugin installation;
no build tools or npm lifecycle scripts are needed. Installation needs access to
npm and GitHub; runtime vehicle access needs Nissan's services.

Existing owner-only token files remain compatible. Legacy `pythonPath` settings
are ignored and removed from configuration when you open and save the settings UI.
Any old managed Python environment is no longer used; upgrades leave its files in
place so existing Homebridge storage is not deleted automatically.

The UI creates the platform configuration for you. A minimal manual entry is:

```json
{
  "platform": "NissanConnect",
  "name": "Nissan EV",
  "readOnly": false
}
```

**Disable secure vehicle controls** (`readOnly`) defaults to **off**. Enable it
for status-only use to prevent accidental actions from Home, Siri or automations.
It blocks all vehicle commands, including locking/unlocking, climate, charging,
horn/lights, schedules and vehicle wake/refresh/location requests. Status polling
and local battery threshold controls remain available. It does not restrict access
outside your home network. Existing saved choices are preserved; if an older
version enabled this during setup, turn it off in plugin settings to allow controls.
Vehicle support and Nissan entitlement still apply. Names and per-vehicle overrides
can be set with:

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
is sent through Homebridge UI to the native Node client, then to Nissan. It is not
written into `config.json`, process arguments, diagnostic output, or the token
file. The password field is cleared when submitted, including on failure. The
plugin stores renewable tokens in an owner-only (`0600`) auth file on the
Homebridge host. Treat normal Homebridge storage backups as private.

The password field supports clipboard paste, including Safari's text clipboard
format. Use **Show** to check the entered value, or **Hide** to conceal it again.
Background status and connection checks preserve anything you have typed or
pasted. Submitting sign-in clears and conceals the field immediately.

**Saved sign-in found** only means a local token file exists; select **Check
connection** for a read-only account check. Opening settings checks the saved
file without contacting Nissan. No sign-in or connection check sends
vehicle commands. If Nissan rejects
a new sign-in or account verification fails, the existing token file is retained.
The settings screen shows fixed error guidance without raw upstream responses.

Sign-in and token refresh use a shared file lock on Linux/macOS. The running
adapter reloads the file before each request, so a saved replacement session is
used on its next request. If a status poll is holding the lock, the UI may ask
you to wait and try again. There are no automatic login retries. Initial setup,
path changes, or changing platform options still require Save and restart.

UI login requires Homebridge Config UI X with custom plugin UI support; the
packaged `homebridge-ui` uses the official `@homebridge/plugin-ui-utils` API.

## Battery percentage and Home automations

The genuine **Battery** service is retained. Three additional services are linked
to the same vehicle accessory:

| Service | Behavior |
| --- | --- |
| **Battery Level** light | Brightness is the latest reported battery percentage. Both brightness and power are read-only. Power is on above 0% and off at 0%; it does not indicate charging. |
| **Battery Threshold** light | Brightness sets the threshold from 0–100% in 1% steps. Turn this light on to enable monitoring or off to disable it. The default is 80% and disabled. |
| **Battery Threshold Reached** indicator | A read-only outlet by default. On when monitoring is enabled and battery percentage is greater than or equal to the threshold; off below the threshold or when monitoring is disabled, apart from brief repeat pulses. Outlet In Use follows the same state. |

For an 80% automation, set **Battery Threshold** brightness to 80%, turn that light
on, then create a Home automation using **An Accessory Is Controlled → Battery
Threshold Reached → Turns On** and select your desired action.

Changing the threshold or its enabled state updates the indicator immediately using
the latest available reading. For example, a jump from 79% to 81% trips an 80%
threshold. Turning the control off clears the indicator immediately. Re-enabling
it while already at or above the threshold activates it again. Threshold
percentage, enabled state and custom service names are saved across restarts.

Plugin settings provide two options:

- **Battery threshold indicator type** (`batteryThresholdIndicatorType`):
  `outlet` (default), `contact`, or `switch`. All types are read-only. A contact
  sensor opens when triggered and closes when cleared; use **A Sensor Detects
  Something → Opens** for its automation. A switch uses **Turns On** like the outlet.
- **Repeat threshold trigger on each battery increase**
  (`batteryThresholdRepeatOnIncrease`): enabled by default. Once an enabled
  threshold is met, each newly observed higher battery percentage turns the
  outlet/switch off for one second and then on again. A contact sensor closes and
  reopens instead. Rapid increases queue separate pulses with one second in the
  active state between them. Turn this option off for steady threshold status.

For example, with a threshold of 80%, the first reading of 80% activates the
indicator. A subsequent reading of 81% briefly clears it and activates it again,
allowing the Home automation to run again. Repeated readings of 81%, or a decrease
to 80%, leave it active without a repeat. One newly observed jump produces one
repeat, even if several percentage points were skipped between polls. Other
updates, renames and unchanged polls do not generate repeats.

Disabling the threshold or changing its percentage cancels pending pulses.
Invalid/failed readings and shutdown also cancel pulses; the delayed reactivation
checks the reading is still valid and the threshold still met. Restart establishes
a new observation baseline. Repeats occur at the cadence of newly reported battery
increases; remote actions still depend on the Home hub and target accessory.

Save plugin settings and restart Homebridge after changing either option.
**Upgrading from 0.4.0 changes the default indicator from a contact sensor to an
outlet.** Update automations to use the outlet's **Turns On** trigger, or select
**Contact sensor** before restarting to retain the old service type. Changing type
replaces only the indicator service; threshold settings, custom names and the
vehicle's other services are retained.

These are local automation controls. They remain usable when the plugin's remote
commands are blocked by `readOnly`. They do not set Nissan's charge limit or start
or stop charging; any charging action must be added explicitly to your automation.
The battery display light rejects attempts to change its brightness or power.

When monitoring is enabled, missing, invalid, failed or stale battery reads make
the indicator unavailable and set its fault flag. Disabled monitoring always reports
an inactive, non-faulted indicator. Cached readings from before a restart are not used
until a new snapshot succeeds. Normal polling defaults to five minutes, and Nissan
may return older vehicle data even after a successful API read.

## Rename at any time

- In Apple Home, edit the accessory name in its settings; this affects Home/Siri.
- In Homebridge UI, change the name for the same VIN and restart Homebridge. The
  plugin updates linked service names without changing accessory/service UUIDs.
- A controller supporting custom characteristics can write **Vehicle Name** to
  rename the plugin accessory immediately, without restarting.

The primary lock uses the vehicle name directly, such as **Ariya**. Other services
use names such as **Ariya Charging** and **Ariya Charge Cable**. The plugin saves
individual service renames through `ConfiguredName` and preserves them across
status refreshes, restarts and vehicle renames. Renaming the vehicle updates only
services that still use automatically generated names. Set a service back to its
current default name to resume automatic naming for that service.

Version 0.3.1 repairs recognizable duplicated "Doors" prefixes on upgrade and
retains custom names still present in the accessory cache. Custom names already
overwritten by an earlier version need to be entered again once.

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

## Logging

Normal logging is always enabled. It reports an initial state baseline, then
every changed scalar field in the returned vehicle status, capabilities, charging
settings, climate defaults, schedules, maintenance and V2L data. Location changes
are recorded without coordinates or addresses. Observation timestamps alone do
not count as vehicle changes, and identical polls do not repeat state messages.
Failed optional reads are reported separately rather than treated as changes or
deletions. Loss of status, stale data and recovery are also logged.

Each vehicle command gets a local reference such as **C1**. The logs record its
request, Nissan's acceptance, reported success or failure, known safe failure
reasons, and whether lock/charging telemetry reflects the requested state. Blocked
commands explain the setting or pending command that prevented them. Unconfirmed
commands are not automatically retried. A successful Nissan response does not
prove that its cached telemetry has caught up.

State changes found while polling are marked **poll detected; cause unknown**.
Matching fields read immediately after a successful command are marked **plugin
action C1 ... follow-up**, with an explicit causality qualification. Unrelated
changes in that same read remain poll-detected changes. This distinguishes plugin
actions from newly observed data without claiming the plugin caused everything
that happened at the same time. Changes between polls cannot be reconstructed,
and the first read after a restart establishes a new baseline.

For example:

```text
Ariya: State change [poll detected; cause unknown]: status.battery.level: 79 -> 80.
Ariya: Command C1 lock requested by plugin; awaiting Nissan confirmation.
Ariya: Command C1 lock accepted by Nissan; awaiting completion.
Ariya: Command C1 lock: Nissan reported success; reading vehicle status to observe the result.
Ariya: State change [plugin action C1 lock follow-up; observed change, causality not guaranteed]: status.doors.overall_lock: UNLOCKED -> LOCKED.
```

Turn on **Enable debug logging** in plugin settings, save and restart the Nissan
child bridge for additional details. It defaults to **off** and works without
enabling Homebridge's global `-D` mode. Debug entries use the **[Debug]** prefix:

- HTTP operation, endpoint, response status and timing; network failures; session
  loading, token renewal and authentication-file lock wait times.
- Poll read time, available vehicle observation timestamps, failed optional
  sections, command completion checks and Nissan's available activation/status times.
- HomeKit update counts, individual characteristic availability transitions and battery threshold
  repeat pulses. Local threshold enable/percentage and indication changes are
  included in normal logging.
- Up to ten recent Nissan remote-service history entries, notification category/
  channel opt-ins and leaving-vehicle reminder flags, read at most once every
  five minutes. These are optional, read-only queries; unsupported/failed queries
  do not invalidate normal vehicle status.

History is correlated privately against request IDs from the last twenty plugin
commands in this session. An unmatched entry is explicitly labeled as having an
unknown caller; Nissan does not reliably identify the app, person or physical
action responsible for a change. Notification diagnostics describe available
settings and history, **not a live push-notification subscription or proof of
delivery to an iPhone**. Cached/history data may lag the vehicle.

Both log levels exclude passwords, tokens, authentication headers, request proof,
raw request/response bodies, vehicle/request identifiers, and precise location.
Free-text state values and unrecognized server reason text are withheld; known
reason categories such as `TIMED_OUT`, `VEHICLE_UNREACHABLE` and
`DEVICE_VERIFICATION` are retained. Turn debug logging off after investigating
to reduce log volume and the additional diagnostic reads.

## Validation and troubleshooting

The original Python-based read-only probe successfully authenticated, found a U.S. 2023
Ariya, read battery status, refreshed tokens, and read again. Plugin tests use
real Homebridge/HAP service objects and simulated Nissan responses, including
failed commands, null telemetry, renaming/restarts, and token persistence.
The plugin has not yet been verified against a deployed Homebridge instance. Separate
live API tests successfully read battery percentage and plugged-in/charging
status. Both start and stop charging were accepted for processing, then returned
FAILED; status confirmed the stop request did not end the active charging session.
Other remote commands have not been verified against that vehicle. The TypeScript
port is verified against translated upstream tests and synthetic responses; it has
not yet been tested with a new live sign-in or vehicle command.

- Connection error: use **Check connection** in plugin settings. Check Homebridge
  storage ownership and internet access; sign in again if Nissan rejects the session.
- Lock controls: the target stays at the requested state while the command is in
  progress; current lock state changes only when Nissan reports it. A failed
  command restores the target to the last reported state and is recorded in
  **Last Command**, **Command Failed or Unconfirmed** and Homebridge logs. Valid
  door/window, charge-cable and battery readings remain usable after command failures.
  If Home immediately reports No Response, check for a `lock not sent` log line:
  **Disable secure vehicle controls**, vehicle feature blocks or another pending
  command may be preventing the write. The log identifies the reason. API read
  failures or stale/missing telemetry can still make the affected status unavailable.
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
npm test
npm run check
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
alongside the other Vehicle Data fields. The fields are not disguised as an
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

Inspect **Vehicle Data** and **Maintenance** in a controller that supports custom
HomeKit characteristics. These reads do not send commands or wake requests.
Results describe the time/account queried and can change.
