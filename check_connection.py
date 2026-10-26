"""One-shot, read-only MyNISSAN US connectivity test. No credential persistence."""

import argparse
import asyncio
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys

from aiohttp import ClientSession
from pynissan import Country, NissanClient

RESULT_PATH = Path(__file__).parent / ".local" / "connection-result.json"


def prompt(label, *, hidden=False, dialogs=False):
    if dialogs:
        script = (
            'on run argv\n'
            'set reply to display dialog (item 1 of argv) default answer "" '
            'with title "Ariya read-only API test" '
            'buttons {"Cancel", "Continue"} default button "Continue" '
            'cancel button "Cancel"'
            + (' with hidden answer' if hidden else '')
            + '\nreturn text returned of reply\nend run'
        )
        result = subprocess.run(
            ["/usr/bin/osascript", "-e", script, label],
            capture_output=True, text=True, check=False,
        )
        if result.returncode:
            raise KeyboardInterrupt
        return result.stdout.removesuffix("\n")
    if not sys.stdin.isatty():
        raise RuntimeError("Run in an interactive terminal, or use --dialogs on macOS.")
    return getpass.getpass(label + ": ") if hidden else input(label + ": ")


def summarize_battery(status):
    battery = status.battery
    if battery is None:
        return {"available": False}
    distance = battery.remaining_mileage
    return {
        "available": True,
        "percent": battery.level,
        "plugged_in": battery.is_plugged_in,
        "charging": battery.is_charging,
        "range": None if distance is None else distance.value,
        "range_unit": None if distance is None else distance.unit,
        "range_reported_at": (
            distance.last_updated_at.isoformat()
            if distance and distance.last_updated_at else None
        ),
        "freshness_note": "Cached Nissan data; range timestamp is not a battery timestamp.",
    }


def write_result(report):
    RESULT_PATH.parent.mkdir(mode=0o700, exist_ok=True)
    temporary = RESULT_PATH.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    temporary.replace(RESULT_PATH)


async def check(email, password, report, choose, client_factory=NissanClient):
    async with ClientSession() as session:
        client = client_factory(session, country=Country.US, read_only=True)
        report["stage"] = "authentication"
        await client.async_authenticate(email, password)
        password = None
        report["authentication"] = "passed"
        print("MyNISSAN authentication succeeded.", flush=True)

        report["stage"] = "vehicle_discovery"
        vehicles = await client.async_get_vehicles()
        report["vehicle_count"] = len(vehicles)
        candidates = [v for v in vehicles if "ariya" in (v.model or "").lower()]
        if not candidates:
            report["outcome"] = "no_ariya_found"
            print("Login worked, but no vehicle identified as an Ariya was returned.")
            return
        matches = [v for v in candidates if str(v.year) == "2023"]
        candidates = matches or candidates
        if len(candidates) == 1:
            vehicle = candidates[0]
        else:
            choices = "\n".join(
                f"{i}: {v.year} {v.model}, VIN ending {v.vin[-4:]}"
                for i, v in enumerate(candidates, 1)
            )
            selection = int(choose("Select your Ariya by number:\n" + choices))
            if not 1 <= selection <= len(candidates):
                raise ValueError("Invalid vehicle selection")
            vehicle = candidates[selection - 1]
        report["vehicle"] = {
            "year": vehicle.year, "model": vehicle.model,
            "vin_suffix": vehicle.vin[-4:],
        }

        report["stage"] = "cached_status"
        status = await client.async_get_vehicle_status(vehicle.vin)
        report["battery_before_refresh"] = summarize_battery(status)
        print("Cached battery:", json.dumps(report["battery_before_refresh"]), flush=True)

        report["stage"] = "token_refresh"
        await client.async_refresh_tokens()
        report["token_refresh"] = "passed"

        # A new client verifies the replacement tokens can be reused independently.
        reused = client_factory(
            session, country=Country.US, read_only=True,
            tokens=client.tokens, oauth_device_id=client.oauth_device_id,
        )
        report["stage"] = "read_with_refreshed_tokens"
        refreshed = await reused.async_get_vehicle_status(vehicle.vin)
        report["battery_after_refresh"] = summarize_battery(refreshed)
        report["read_with_refreshed_tokens"] = "passed"
        has_level = status.battery is not None and status.battery.level is not None
        has_refreshed_level = refreshed.battery is not None and refreshed.battery.level is not None
        report["outcome"] = "passed" if has_level and has_refreshed_level else "connected_battery_missing"
        report["stage"] = "complete"


def record_failure(report, error):
    # Upstream error bodies can contain personal information. Never persist/print them.
    report["outcome"] = "failed"
    report["error_type"] = type(error).__name__
    status = getattr(error, "status", None)
    if isinstance(status, int):
        report["http_status"] = status
    if status == 401:
        hint = "Authentication rejected. Verify sign-in in MyNISSAN; do not repeatedly retry."
    elif status == 403:
        hint = "Request forbidden. Possible device verification, entitlement, or client restriction."
    else:
        hint = "Check the failed stage. No raw server response was recorded."
    report["hint"] = hint


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dialogs", action="store_true", help="Use private macOS credential prompts")
    args = parser.parse_args()
    report = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "country": "US", "read_only": True, "stage": "credentials",
    }
    print("Read-only test: no vehicle commands or wake requests; tokens stay in memory.", flush=True)
    try:
        email = prompt("MyNISSAN email", dialogs=args.dialogs).strip()
        password = prompt("MyNISSAN password (sent only to Nissan)", hidden=True, dialogs=args.dialogs)
        if not email or not password:
            raise ValueError("Email and password must not be empty")
        asyncio.run(check(email, password, report, lambda label: prompt(label, dialogs=args.dialogs)))
    except (KeyboardInterrupt, EOFError):
        report["outcome"] = "cancelled"
    except Exception as error:
        record_failure(report, error)
    finally:
        email = password = None
        write_result(report)
    print("Result:", report["outcome"], flush=True)
    print("Diagnostic report:", RESULT_PATH, flush=True)
    return 0 if report["outcome"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
