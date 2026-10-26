"""Private stdin/stdout RPC adapter; never opens a network listener."""
import argparse
import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
from enum import Enum
import getpass
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import fcntl

from aiohttp import ClientSession
from pynissan import (Country, NissanClient, Tokens, TemperatureUnit, ClimateSettings,
                     ClimateParameters, SeatClimateSettings, SeatClimateOption,
                     ServiceRequest, ServiceRequestKind, RequestProof,
                     ChargeScheduleInput, ClimateScheduleInput, WeekDay)


def plain(value):
    if is_dataclass(value):
        return plain(asdict(value))
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [plain(v) for v in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return value


def private_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.nissan-', dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(data, handle)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


class AuthBusyError(Exception):
    """Another process is using the same Nissan session."""


@asynccontextmanager
async def auth_lock(path, timeout=15):
    """Serialize UI sign-in and adapter refreshes across processes on Linux/macOS."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(path) + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Invalid session lock')
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if asyncio.get_running_loop().time() >= deadline:
                    raise AuthBusyError
                await asyncio.sleep(0.05)
        yield
    finally:
        os.close(fd)


def private_read(path):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Auth file must be a regular owner-only file (chmod 600).')
    with open(path) as handle:
        return json.load(handle)


def safe_error(error):
    result = {'type': type(error).__name__}
    code = getattr(error, 'status', None)
    if isinstance(code, int):
        result['status'] = code
    # No upstream messages: they can contain VINs, account data, or tokens.
    return result


class Adapter:
    def __init__(self, path, session, client_factory=NissanClient):
        self.path = Path(path)
        self.auth = private_read(self.path)
        self.session = session
        self.client_factory = client_factory

    async def save(self, tokens):
        self.auth['tokens'] = plain(tokens)
        private_write(self.path, self.auth)

    def client(self, write=False):
        proof = self.auth.get('request_proof')
        return self.client_factory(
            self.session, country=Country.US, read_only=not write,
            tokens=Tokens(**self.auth['tokens']), token_listener=self.save,
            oauth_device_id=self.auth['device_id'],
            request_proof=RequestProof(**proof) if proof else None,
        )

    async def dispatch(self, request):
        async with auth_lock(self.path):
            # A UI sign-in or another reader may have replaced the tokens.
            self.auth = private_read(self.path)
            return await self._dispatch(request)

    async def _dispatch(self, request):
        method = request['method']
        args = request.get('args', {})
        if method == 'vehicles':
            return plain(await self.client().async_get_vehicles())
        vin = args['vin']
        if method == 'snapshot':
            client = self.client()
            result = {'status': plain(await client.async_get_vehicle_status(vin, temperature_unit=TemperatureUnit.CELSIUS)), 'errors': {}}
            reads = {
                'capabilities': lambda: client.async_get_vehicle_capabilities(vin, TemperatureUnit.CELSIUS),
                'defaults': lambda: client.async_get_climate_defaults(vin, temperature_unit=TemperatureUnit.CELSIUS),
                'charge_config': lambda: client.async_get_charge_config(vin),
                'v2l': lambda: client.async_get_v2l_status(vin),
                'charge_schedules': lambda: client.async_get_charge_schedules(vin),
                'climate_schedules': lambda: client.async_get_climate_schedules(vin),
                'maintenance': lambda: client.async_get_maintenance_timeline(vin),
            }
            if args.get('location', False):
                reads['location'] = lambda: client.async_get_vehicle_location(vin)
            for name, read in reads.items():
                try:
                    result[name] = plain(await read())
                except Exception as error:
                    result['errors'][name] = safe_error(error)
            result['fetched_at'] = datetime.now(timezone.utc).isoformat()
            return result
        if method == 'command':
            return await self.command(vin, args['action'], args.get('params', {}))
        if method == 'command_status':
            service_request = ServiceRequest(args['request']['id'], ServiceRequestKind(args['request']['kind']))
            result = await self.client().async_check_service_request(vin, service_request)
            return {'terminal': result.is_terminal, 'success': result.is_success,
                    'status': plain(result.status), 'location': plain(result.location)}
        raise ValueError('Unsupported RPC method')

    async def command(self, vin, action, params):
        client = self.client(write=True)
        simple = {
            'lock': client.async_lock_doors, 'unlock': client.async_unlock_doors,
            'flash': client.async_flash_lights, 'horn': client.async_flash_lights_and_horn,
            'locate': client.async_locate_vehicle, 'refresh': client.async_refresh_vehicle_status,
            'wake': client.async_wake_up_vehicle, 'refresh_battery': client.async_refresh_battery_status,
            'refresh_climate': client.async_refresh_climate_status,
            'start_charge': client.async_start_charge, 'stop_charge': client.async_stop_charge,
            'stop_climate': client.async_stop_climate,
            'cancel_delayed_climate': client.async_cancel_delayed_climate,
        }
        if action in simple:
            result = await simple[action](vin)
        elif action in ('start_climate', 'adjust_climate', 'climate_defaults'):
            temperature = params['temperature']
            if not isinstance(temperature, (float, int)) or not 16 <= temperature <= 30:
                raise ValueError('Invalid target temperature')
            raw = params.get('parameters') or {}
            seats = {k: SeatClimateOption(v) for k, v in (raw.get('seats') or {}).items() if v is not None}
            parameters = ClimateParameters(
                seats=SeatClimateSettings(**seats) if seats else None,
                steering_wheel_heater=raw.get('steering_wheel_heater'),
                defrost_and_deicer=raw.get('defrost_and_deicer'),
            ) if raw else None
            climate = ClimateSettings(temperature, TemperatureUnit.CELSIUS, parameters)
            fn = {'start_climate': client.async_start_climate,
                  'adjust_climate': client.async_adjust_climate,
                  'climate_defaults': client.async_set_climate_defaults}[action]
            result = await fn(vin, climate)
        elif action in ('charge_limit', 'charge_notification', 'v2l_minimum'):
            percent = params['percent']
            if type(percent) is not int or not 1 <= percent <= 100:
                raise ValueError('Invalid percentage')
            fn = {'charge_limit': client.async_set_charge_limit,
                  'charge_notification': client.async_set_charge_notification_threshold,
                  'v2l_minimum': client.async_set_v2l_minimum_battery_charge_level}[action]
            result = await fn(vin, percent)
        elif action in ('charge_schedule', 'climate_schedule'):
            if type(params['enabled']) is not bool or not isinstance(params['id'], str):
                raise ValueError('Invalid schedule toggle')
            fn = client.async_toggle_charge_schedule if action == 'charge_schedule' else client.async_toggle_climate_schedule
            result = await fn(vin, params['id'], enabled=params['enabled'])
        elif action in ('edit_charge_schedule', 'edit_climate_schedule', 'delayed_climate'):
            kind = 'charge' if action == 'edit_charge_schedule' else 'climate'
            operation = params.get('operation', 'create')
            if operation not in ('create', 'update', 'delete'):
                raise ValueError('Invalid schedule operation')
            if action != 'delayed_climate' and operation == 'delete':
                result = await getattr(client, f'async_delete_{kind}_schedule')(vin, params['id'])
            else:
                start = datetime.fromisoformat(params['start'])
                if start.utcoffset() is None:
                    raise ValueError('Schedule needs an explicit UTC offset')
                days = tuple(WeekDay(day) for day in params.get('days', []))
                if WeekDay.UNKNOWN_VALUE in days:
                    raise ValueError('Invalid weekday')
                if kind == 'charge':
                    schedule = ChargeScheduleInput(start, params['duration'], days)
                else:
                    temperature = params['temperature']
                    if not isinstance(temperature, (float, int)) or not 16 <= temperature <= 30:
                        raise ValueError('Invalid temperature')
                    climate = ClimateSettings(temperature, TemperatureUnit.CELSIUS)
                    schedule = ClimateScheduleInput(start, days, climate)
                if action == 'delayed_climate':
                    result = await client.async_set_delayed_climate(vin, start, climate)
                elif operation == 'create':
                    result = await getattr(client, f'async_create_{kind}_schedule')(vin, schedule)
                else:
                    result = await getattr(client, f'async_update_{kind}_schedule')(vin, params['id'], schedule)
        else:
            raise ValueError('Unsupported vehicle command')
        if isinstance(result, bool):
            if not result:
                raise RuntimeError('Nissan rejected command')
            return {'complete': True}
        if not isinstance(result, ServiceRequest):
            raise TypeError('Unexpected command response')
        return {'complete': False, 'request': {'id': result.id, 'kind': result.kind.value}}


def credential(label, hidden=False, dialogs=False):
    if dialogs:
        script = ('on run argv\nset r to display dialog (item 1 of argv) default answer "" '
                  'with title "Nissan Homebridge setup" buttons {"Cancel", "Continue"} '
                  'default button "Continue" cancel button "Cancel"'
                  + (' with hidden answer' if hidden else '')
                  + '\nreturn text returned of r\nend run')
        result = subprocess.run(['/usr/bin/osascript', '-e', script, label], capture_output=True, text=True)
        if result.returncode:
            raise KeyboardInterrupt
        return result.stdout.removesuffix('\n')
    return getpass.getpass(label + ': ') if hidden else input(label + ': ')


async def setup(args):
    email = credential('MyNISSAN email', dialogs=args.dialogs).strip()
    password = credential('MyNISSAN password', hidden=True, dialogs=args.dialogs)
    await authenticate(args.auth_file, email, password)
    password = None
    print('Authentication tokens saved with owner-only permissions. Password was not saved.')


async def authenticate(path, email, password, client_factory=NissanClient):
    if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
        raise ValueError('Email and password are required')
    async with auth_lock(path):
        async with ClientSession() as session:
            client = client_factory(session, country=Country.US, read_only=True)
            await client.async_authenticate(email.strip(), password)
            password = None
            # Verify account access before replacing a previously working session.
            vehicles = await client.async_get_vehicles()
            private_write(path, {'tokens': plain(client.tokens), 'device_id': client.oauth_device_id,
                                 'authenticated_at': datetime.now(timezone.utc).isoformat()})
            return {'connected': True, 'verified': True, 'vehicles': vehicle_labels(vehicles)}


def vehicle_labels(vehicles):
    return [{'model': v.model, 'year': v.year, 'vinSuffix': v.vin[-4:]}
            for v in vehicles if 'ariya' in (v.model or '').lower()]


def auth_status(path):
    try:
        auth = private_read(path)
    except FileNotFoundError:
        return {'connected': False, 'verified': False}
    tokens = auth.get('tokens') or {}
    valid = bool(tokens.get('access_token') and tokens.get('refresh_token') and auth.get('device_id'))
    return {'connected': valid, 'verified': False, 'authenticatedAt': auth.get('authenticated_at')}


async def ui_request(args):
    """One request over private stdin; credentials never enter argv or replies."""
    request = json.loads(await asyncio.to_thread(sys.stdin.readline))
    action = request.get('action')
    if action == 'login':
        email, password = request.pop('email', None), request.pop('password', None)
        result = await authenticate(args.auth_file, email, password)
        email = password = None
        return result
    if action == 'status':
        async with auth_lock(args.auth_file):
            return auth_status(args.auth_file)
    if action == 'check':
        async with ClientSession() as session:
            vehicles = await Adapter(args.auth_file, session).dispatch({'method': 'vehicles'})
        return {'connected': True, 'verified': True,
                'vehicles': [{'model': v['model'], 'year': v['year'], 'vinSuffix': v['vin'][-4:]}
                             for v in vehicles if 'ariya' in (v.get('model') or '').lower()]}
    raise ValueError('Unsupported UI request')


async def serve(args):
    async with ClientSession() as session:
        adapter = Adapter(args.auth_file, session)
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = {}
            try:
                request = json.loads(line)
                result = await adapter.dispatch(request)
                response = {'id': request['id'], 'result': result}
            except Exception as error:
                response = {'id': request.get('id'), 'error': safe_error(error)}
            print(json.dumps(response), flush=True)


async def inspect_vehicle(args):
    if args.auth_file:
        async with auth_lock(args.auth_file):
            return await inspect_unlocked(args)
    return await inspect_unlocked(args)


async def inspect_unlocked(args):
    """Read per-VIN evidence without testing writes or persisting a new login."""
    async with ClientSession() as session:
        if args.auth_file:
            client = Adapter(args.auth_file, session).client()
        else:
            email = credential('MyNISSAN email for read-only feature inspection', dialogs=args.dialogs).strip()
            password = credential('MyNISSAN password (not saved)', hidden=True, dialogs=args.dialogs)
            client = NissanClient(session, country=Country.US, read_only=True)
            await client.async_authenticate(email, password)
            password = None
        vehicles = await client.async_get_vehicles()
        report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'read_only': True, 'vehicles': []}
        for vehicle in vehicles:
            if 'ariya' not in (vehicle.model or '').lower():
                continue
            entry = {'model': vehicle.model, 'year': vehicle.year, 'vin_suffix': vehicle.vin[-4:], 'errors': {}}
            for key, read in {
                'capabilities': lambda: client.async_get_vehicle_capabilities(vehicle.vin),
                'charge_config': lambda: client.async_get_charge_config(vehicle.vin),
                'maintenance': lambda: client.async_get_maintenance_timeline(vehicle.vin),
            }.items():
                try:
                    value = plain(await read())
                    if isinstance(value, dict):
                        value.pop('vin', None)
                    entry[key] = value
                except Exception as error:
                    entry['errors'][key] = safe_error(error)
            report['vehicles'].append(entry)
        if args.report:
            private_write(args.report, report)
        print(json.dumps(report, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--auth-file')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--setup', action='store_true')
    mode.add_argument('--ui', action='store_true', help='Private Homebridge settings request over stdin')
    mode.add_argument('--inspect', action='store_true', help='Read vehicle capability, charge settings, and maintenance evidence; no commands')
    parser.add_argument('--report', help='Optional path for an owner-only inspection report')
    parser.add_argument('--dialogs', action='store_true')
    args = parser.parse_args()
    if not args.inspect and not args.auth_file:
        parser.error('--auth-file is required except for interactive --inspect')
    try:
        if args.ui:
            print(json.dumps({'result': asyncio.run(ui_request(args))}), flush=True)
        else:
            asyncio.run(inspect_vehicle(args) if args.inspect else setup(args) if args.setup else serve(args))
    except KeyboardInterrupt:
        return 1
    except Exception as error:
        print(json.dumps({'error': safe_error(error)}), file=sys.stdout if args.ui else sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
