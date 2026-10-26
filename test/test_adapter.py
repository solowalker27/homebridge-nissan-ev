import importlib.util
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import date
from unittest.mock import create_autospec
from types import SimpleNamespace

from pynissan import NissanClient, Tokens, ServiceRequest, ServiceRequestKind, ServiceRequestResult, ServiceRequestStatus

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'python' / 'nissan_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'auth.json'
        bridge.private_write(self.path, {'tokens': {'access_token': 'access-secret', 'refresh_token': 'refresh-secret'}, 'device_id': 'device'})
        self.client = create_autospec(NissanClient, instance=True)
        self.modes = []

        def factory(session, **kwargs):
            self.modes.append(kwargs['read_only'])
            return self.client
        self.adapter = bridge.Adapter(self.path, None, factory)

    def tearDown(self):
        self.temp.cleanup()

    async def test_snapshot_is_read_only_and_optional_failures_do_not_lose_status(self):
        self.client.async_get_vehicle_status.return_value = {'battery': {'level': 92}}
        self.client.async_get_vehicle_capabilities.return_value = None
        self.client.async_get_climate_defaults.return_value = None
        self.client.async_get_charge_config.return_value = None
        self.client.async_get_v2l_status.return_value = None
        self.client.async_get_charge_schedules.return_value = []
        self.client.async_get_maintenance_timeline.return_value = None
        self.client.async_get_climate_schedules.side_effect = ValueError('SECRET response')
        result = await self.adapter.dispatch({'method': 'snapshot', 'args': {'vin': 'test'}})
        self.assertEqual(result['status']['battery']['level'], 92)
        self.assertEqual(result['errors']['climate_schedules'], {'type': 'ValueError'})
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(self.modes, [True])
        self.client.async_get_vehicle_location.assert_not_called()
        self.client.async_lock_doors.assert_not_called()

    async def test_maintenance_dates_serialize_and_query_failure_is_isolated(self):
        from pynissan.maintenance_models import MaintenanceTimeline
        from pynissan import DistanceUnit
        timeline = MaintenanceTimeline(date(2026, 1, 1), 7500, date(2026, 7, 1), 15000, 1200, 1, DistanceUnit.MILE, 13800)
        encoded = bridge.plain(timeline)
        self.assertEqual(encoded['next_service_date'], '2026-07-01')
        self.assertEqual(encoded['next_service_mileage'], 15000)
        self.assertEqual(json.loads(json.dumps(encoded))['mileage_unit'], 'MILE')

    async def test_command_submission_and_failed_terminal_status_are_distinct(self):
        self.client.async_unlock_doors.return_value = ServiceRequest('request-1', ServiceRequestKind.DOOR)
        result = await self.adapter.command('test', 'unlock', {})
        self.assertEqual(result, {'complete': False, 'request': {'id': 'request-1', 'kind': ServiceRequestKind.DOOR.value}})
        self.assertEqual(self.modes, [False])
        self.client.async_check_service_request.return_value = ServiceRequestResult(ServiceRequestStatus.FAILED)
        status = await self.adapter.dispatch({'method': 'command_status', 'args': {'vin': 'test', 'request': result['request']}})
        self.assertTrue(status['terminal'])
        self.assertFalse(status['success'])

    async def test_refresh_replacement_is_persisted_without_password(self):
        await self.adapter.save(Tokens('new-access', 'new-refresh', 'new-id'))
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        value = bridge.private_read(self.path)
        self.assertEqual(value['tokens']['refresh_token'], 'new-refresh')
        self.assertNotIn('password', value)

    async def test_ui_login_verifies_account_and_returns_only_masked_vehicle_labels(self):
        self.client.tokens = Tokens('new-access', 'new-refresh', 'new-id')
        self.client.oauth_device_id = 'new-device'
        self.client.async_get_vehicles.return_value = [SimpleNamespace(vin='TESTVIN00000012345', model='ARIYA', year='2023')]
        result = await bridge.authenticate(self.path, 'driver@example.com', 'password-secret', lambda *a, **kw: self.client)
        self.assertTrue(result['verified'])
        self.assertEqual(result['vehicles'][0]['vinSuffix'], '2345')
        self.assertNotIn('TESTVIN', json.dumps(result))
        auth = bridge.private_read(self.path)
        self.assertNotIn('password-secret', json.dumps(auth))
        self.assertEqual(auth['tokens']['refresh_token'], 'new-refresh')
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        self.assertFalse(bridge.auth_status(self.path)['verified'])
        self.client.async_lock_doors.assert_not_called()

    async def test_failed_account_verification_preserves_the_previous_session(self):
        previous = self.path.read_bytes()
        self.client.async_get_vehicles.side_effect = ValueError('SECRET Nissan error')
        with self.assertRaises(ValueError):
            await bridge.authenticate(self.path, 'driver@example.com', 'password-secret', lambda *a, **kw: self.client)
        self.assertEqual(self.path.read_bytes(), previous)

    async def test_auth_lock_serializes_ui_and_worker_and_releases_after_failure(self):
        async with bridge.auth_lock(self.path):
            with self.assertRaises(bridge.AuthBusyError):
                async with bridge.auth_lock(self.path, timeout=0.01):
                    self.fail('Concurrent token access')
        async with bridge.auth_lock(self.path, timeout=0.01):
            pass

    async def test_existing_worker_reloads_tokens_replaced_by_ui(self):
        auth = bridge.private_read(self.path)
        auth['tokens']['access_token'] = 'ui-replaced-access'
        bridge.private_write(self.path, auth)
        self.client.async_get_vehicles.return_value = []
        await self.adapter.dispatch({'method': 'vehicles'})
        self.assertEqual(self.adapter.auth['tokens']['access_token'], 'ui-replaced-access')

    def test_auth_status_distinguishes_missing_invalid_permissions_and_saved_session(self):
        missing = self.path.parent / 'missing.json'
        self.assertEqual(bridge.auth_status(missing), {'connected': False, 'verified': False})
        self.assertTrue(bridge.auth_status(self.path)['connected'])
        os.chmod(self.path, 0o644)
        with self.assertRaises(ValueError):
            bridge.auth_status(self.path)

    async def test_unsupported_command_and_bad_temperature_do_not_invoke_api(self):
        with self.assertRaises(ValueError):
            await self.adapter.command('test', 'delete_account', {})
        with self.assertRaises(ValueError):
            await self.adapter.command('test', 'start_climate', {'temperature': 100})
        self.client.async_delete_account.assert_not_called()
        self.client.async_start_climate.assert_not_called()

    async def test_schedule_input_is_typed_and_timezone_required(self):
        self.client.async_create_charge_schedule.return_value = ServiceRequest('req', ServiceRequestKind.CHARGE_CONFIGURATION)
        await self.adapter.command('test', 'edit_charge_schedule', {'start': '2026-10-21T23:00:00-05:00', 'days': ['MO', 'TU'], 'duration': 'PT2H'})
        args = self.client.async_create_charge_schedule.call_args.args
        self.assertEqual(args[1].duration, 'PT2H')
        with self.assertRaises(ValueError):
            await self.adapter.command('test', 'edit_charge_schedule', {'start': '2026-10-21T23:00:00', 'days': ['MO'], 'duration': 'PT2H'})

    async def test_failed_boolean_command_is_not_reported_as_success(self):
        self.client.async_wake_up_vehicle.return_value = False
        with self.assertRaises(RuntimeError):
            await self.adapter.command('test', 'wake', {})

    def test_public_or_symlink_auth_file_is_rejected(self):
        os.chmod(self.path, 0o644)
        with self.assertRaises(ValueError):
            bridge.private_read(self.path)
        os.chmod(self.path, 0o600)
        link = Path(self.temp.name) / 'link.json'
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            bridge.private_read(link)


if __name__ == '__main__':
    unittest.main()
