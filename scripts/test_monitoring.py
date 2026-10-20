"""Monitoring API and data integrity in a disposable SQLite database; no live network."""
import csv
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sandbox = tempfile.TemporaryDirectory(prefix='ecotrack-monitoring-tests-')
os.environ['ECOTRACK_SQLITE_DB_PATH'] = str(Path(sandbox.name) / 'telemetry.db')
os.environ['ECOTRACK_TELEMETRY_SYNC'] = '0'
os.environ['ECOTRACK_MONITOR_SYNC'] = '0'
spec = importlib.util.spec_from_file_location('monitoring_test_backend', ROOT / 'backend/app.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
service = backend.monitoring_service


class MonitoringTests(unittest.TestCase):
    def setUp(self):
        self.api = backend.app.test_client()
        self.headers = {'Authorization': 'Bearer ' + service.admin_token}
        with service.connection() as conn:
            for table in ['sensor_schedules', 'monitor_sync_outbox', 'monitor_samples', 'monitor_calibrations', 'monitor_nodes']:
                conn.execute('DELETE FROM ' + table)
            conn.execute("INSERT OR IGNORE INTO telemetry(id,node_id,created) VALUES('preserved-control-record','control-device','2026-10-18T00:00:00Z')")

    def create(self, **extra):
        data = {'name': 'Fixture monitor', 'aircon_id': 'existing-ac-id', 'aircon_name': 'Fixture AC',
                'pressure_sensor': 'MPX5010DP', 'pressure_min_pa': 0, 'pressure_max_pa': 10000,
                'expected_interval_seconds': 5, **extra}
        result = self.api.post('/api/monitoring/devices', json=data, headers=self.headers)
        self.assertEqual(result.status_code, 201, result.json.get('error'))
        return result.json

    def sample(self, sequence=1, **extra):
        return {'boot_id': 'fixture-boot', 'sequence': sequence, 'observed_at': '2026-10-18T00:00:00Z',
                'clock_quality': 'synchronized', 'interval_seconds': 5, 'outlet_temperature_c': 18,
                'differential_pressure_pa': 0, 'ac_on': None, **extra}

    def upload(self, node, samples, remote=False):
        return self.api.post('/api/monitoring/telemetry', json={'device_id': node['id'], 'samples': samples},
            headers={'Authorization': 'Bearer ' + node['device_token']},
            environ_overrides={'REMOTE_ADDR': '192.168.1.25'} if remote else {})

    def analytics(self, **filters):
        result = self.api.get('/api/monitoring/analytics', query_string={'from': '2026-10-18T00:00:00Z', 'to': '2026-10-19T00:00:00Z', **filters})
        self.assertEqual(result.status_code, 200, result.json)
        return result.json

    def test_empty_and_control_records_preserved(self):
        self.assertEqual(self.api.get('/api/monitoring/devices').json['items'], [])
        result = self.analytics()
        self.assertIsNone(result['temperature_avg'])
        self.assertIsNone(result['pressure_avg'])
        self.assertEqual(result['sample_count'], 0)
        self.assertTrue(all(point['temperature'] is None for point in result['points']))
        with service.connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM telemetry WHERE id='preserved-control-record'").fetchone()[0], 1)

    def test_registered_sensor_import_preserves_identity_credentials_history_and_unknown_state(self):
        identity = '11111111-1111-4111-8111-111111111111'
        metadata = {'name': 'Registered sensor', 'aircon_id': 'registered-ac', 'aircon_name': 'Registered AC',
                    'pressure_sensor': 'MPX5010DP', 'pressure_min_pa': 0, 'pressure_max_pa': 10000, 'expected_interval_seconds': 3600}
        url = '/api/monitoring/registry/import'
        payload = {'id': identity, 'device': metadata}
        self.assertEqual(self.api.post(url, json=payload).status_code, 401)
        self.assertEqual(self.api.post(url, json={**payload, 'device': {'token_hash': 'untrusted'}}, headers=self.headers).status_code, 422)
        response = self.api.post(url, json=payload, headers=self.headers)
        self.assertEqual(response.json, {'changed': True})
        with service.connection() as conn:
            credential = conn.execute('SELECT token_hash FROM monitor_nodes WHERE id=?', (identity,)).fetchone()[0]
            calibration = conn.execute('SELECT id FROM monitor_calibrations WHERE node_id=?', (identity,)).fetchone()[0]
        self.assertEqual(self.api.post(url, json=payload, headers=self.headers).json, {'changed': False})
        self.assertEqual(self.api.post(url, json={'id': identity, 'device': {**metadata, 'name': 'Renamed sensor'}}, headers=self.headers).json, {'changed': True})
        with service.connection() as conn:
            self.assertEqual(conn.execute('SELECT token_hash FROM monitor_nodes WHERE id=?', (identity,)).fetchone()[0], credential)
            self.assertEqual(conn.execute('SELECT id FROM monitor_calibrations WHERE node_id=?', (identity,)).fetchone()[0], calibration)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM monitor_samples').fetchone()[0], 0)
        node = self.api.get('/api/monitoring/devices').json['items'][0]
        self.assertEqual(node['id'], identity)
        self.assertIsNone(node['latest'])
        self.assertFalse(node['fresh'])
        self.assertEqual(node['expected_interval_seconds'], 3600)
        self.assertNotIn('device_token', node)
        self.assertEqual(self.api.post(url, json={'id': identity, 'device': {**metadata, 'aircon_id': 'different-ac'}}, headers=self.headers).status_code, 409)

    def test_admin_origin_and_lan_boundaries(self):
        self.assertEqual(self.api.post('/api/monitoring/devices', json={}).status_code, 401)
        self.assertEqual(self.api.get('/api/monitoring/devices', environ_overrides={'REMOTE_ADDR': '192.168.1.25'}).status_code, 403)
        self.assertEqual(self.api.get('/api/monitoring/devices', headers={'Origin': 'https://untrusted.invalid'}).status_code, 403)
        self.assertEqual(self.api.post('/api/monitoring/devices', json={}, headers=self.headers,
                                     environ_overrides={'REMOTE_ADDR': '192.168.1.25'}).status_code, 403)
        node = self.create()
        self.assertEqual(self.upload(node, [self.sample()], remote=True).status_code, 200)

    def test_credentials_never_persist_or_leak_in_reads(self):
        node = self.create()
        response = self.api.get('/api/monitoring/devices').get_data(as_text=True)
        self.assertNotIn('device_token', response)
        self.assertNotIn('token_hash', response)
        with service.connection() as conn:
            queued = ' '.join(row[0] for row in conn.execute('SELECT payload FROM monitor_sync_outbox'))
            self.assertNotIn('token_hash', queued)
            self.assertFalse(node['device_token'] in queued)
            self.assertFalse(node['device_token'] == conn.execute('SELECT token_hash FROM monitor_nodes').fetchone()[0])
        bad = {**node, 'device_token': 'invalid-fixture-token'}
        self.assertEqual(self.upload(bad, [self.sample()]).status_code, 401)

    def test_true_zero_missing_values_and_no_power_inference(self):
        node = self.create()
        self.assertEqual(self.upload(node, [self.sample(outlet_temperature_c=None)]).status_code, 200)
        result = self.analytics()
        self.assertEqual(result['pressure_avg'], 0)
        self.assertIsNone(result['temperature_avg'])
        self.assertEqual(result['unknown_state_samples'], 1)
        self.assertEqual(result['confirmed_state_count'], 0)
        self.assertEqual(result['confirmed_unit_hours'], 0)
        for extra in [{'ac_on': True, 'state_source': 'desired_state'}, {'ac_on': True, 'state_source': 'power_meter'}, {'desired_state': {'power': True}}]:
            self.assertEqual(self.upload(node, [self.sample(sequence=2, **extra)]).status_code, 422)

    def test_duplicate_identity_conflict_and_atomic_batch(self):
        node = self.create()
        sample = self.sample()
        self.assertEqual(self.upload(node, [sample, sample]).json, {'inserted': 1, 'duplicates': 1})
        self.assertEqual(self.upload(node, [self.sample(sequence=2), self.sample(outlet_temperature_c=25)]).status_code, 409)
        self.assertEqual(self.analytics()['sample_count'], 1, 'A conflicting batch rolls back all new records')

    def test_reported_modes_do_not_infer_power_or_backfill_old_samples(self):
        node = self.create(state_source='power_meter')
        samples = [self.sample(ac_on=True, state_source='power_meter'),
                   self.sample(sequence=2, observed_at='2026-10-18T00:10:00Z', operating_mode='cool'),
                   self.sample(sequence=3, observed_at='2026-10-18T00:20:00Z', operating_mode='fan_only')]
        self.assertEqual(self.upload(node, samples).status_code, 200)
        self.assertEqual(self.upload(node, samples).json['duplicates'], 3)
        stats = self.analytics()
        recorded = [point for point in stats['points'] if point['sample_count']]
        self.assertEqual([point['operating_mode'] for point in recorded], [None, 'cool', 'fan_only'])
        self.assertAlmostEqual(stats['confirmed_unit_hours'], 5 / 3600)
        with service.connection() as conn:
            rows = conn.execute('SELECT operating_mode,ac_on FROM monitor_samples ORDER BY sequence').fetchall()
            self.assertIsNone(rows[0]['operating_mode'], 'Power ON cannot imply Cool')
            self.assertIsNone(rows[1]['ac_on'], 'Cool cannot imply confirmed electrical operation')
        self.assertNotIn('operating_mode', service.normalize_sample(samples[0], node), 'Keep legacy upload fingerprints stable')

    def test_missing_and_mixed_modes_remain_unavailable_in_each_bucket(self):
        node = self.create()
        self.assertEqual(self.upload(node, [self.sample(operating_mode='cool'),
            self.sample(sequence=2, observed_at='2026-10-18T00:00:01Z', operating_mode='fan_only'),
            self.sample(sequence=3, observed_at='2026-10-18T00:10:00Z', operating_mode='cool'),
            self.sample(sequence=4, observed_at='2026-10-18T00:10:01Z')]).status_code, 200)
        self.assertTrue(all(point['operating_mode'] is None for point in self.analytics()['points']))
        for invalid in ['auto', 'heat', 'ON', True, 1, ['cool']]:
            self.assertEqual(self.upload(node, [self.sample(sequence=5, operating_mode=invalid)]).status_code, 422)
        self.assertEqual(self.analytics()['sample_count'], 4)

    def test_clock_filters_share_rows_exports_and_clip_runtime_at_boundaries(self):
        node = self.create(state_source='power_meter')
        self.upload(node, [self.sample(observed_at='2026-10-18T01:59:50Z', interval_seconds=30, ac_on=True, state_source='power_meter'),
            self.sample(sequence=2, observed_at='2026-10-18T02:00:20Z', interval_seconds=60, ac_on=True, state_source='power_meter'),
            self.sample(sequence=3, observed_at='2026-10-18T03:00:00Z')])
        filters = {'from': '2026-10-18T00:00:00Z', 'to': '2026-10-19T00:00:00Z', 'start_time': '10:00', 'end_time': '10:00'}
        stats = self.analytics(**filters)
        self.assertEqual(stats['sample_count'], 1)
        self.assertAlmostEqual(stats['confirmed_unit_hours'], 60 / 3600)
        rows = self.api.get('/api/monitoring/telemetry', query_string=filters).json
        self.assertEqual([row['sequence'] for row in rows['items']], [2])
        exported = list(csv.DictReader(io.StringIO(self.api.get('/api/monitoring/export.csv', query_string=filters).text)))
        self.assertEqual(len(exported), 1)
        self.assertEqual(exported[0]['observed_at'], rows['items'][0]['observed_at'])
        for value in ['25:00', '10:60', '1:00', '10:00:00', '']:
            self.assertEqual(self.api.get('/api/monitoring/analytics', query_string={**filters, 'start_time': value}).status_code, 422)

    def test_overnight_clock_filters_and_one_sided_ranges_use_local_time(self):
        node = self.create()
        self.upload(node, [self.sample(sequence=i, observed_at=f'2026-10-18T{hour:02}:00:00Z') for i, hour in enumerate([0, 12, 15, 16, 22])])
        self.assertEqual(self.analytics(start_time='22:00', end_time='06:00')['sample_count'], 3)
        self.assertEqual(self.analytics(start_time='22:00')['sample_count'], 1)
        self.assertEqual(self.analytics(end_time='06:00')['sample_count'], 2)

    def test_invalid_measurements_and_clock_values_are_rejected(self):
        node = self.create()
        for change in [{'observed_at': '1960-01-01T00:00:00Z'}, {'observed_at': '2026-10-18T00:00:00'},
                       {'sequence': True}, {'interval_seconds': 0}, {'outlet_temperature_c': '18'},
                       {'pressure_quality': 'invented'}, {'ac_on': 'on'}]:
            self.assertEqual(self.upload(node, [self.sample(**change)]).status_code, 422)
        self.assertEqual(self.upload(node, [self.sample()] * 501).status_code, 422)
        self.assertEqual(self.analytics()['sample_count'], 0)

    def test_calibration_versions_and_backfilled_samples(self):
        node = self.create()
        self.upload(node, [self.sample()])
        saved = self.api.post(f"/api/monitoring/devices/{node['id']}/calibrations", headers=self.headers,
            json={'temperature_offset_c': 1.5, 'pressure_offset_pa': 10, 'pressure_scale': 2,
                  'airflow_threshold_pa': 20, 'notes': 'Isolated reference instrument fixture'})
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(self.upload(node, [self.sample()]).json['duplicates'], 1)
        self.upload(node, [self.sample(sequence=2, differential_pressure_pa=30)])
        stamp = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
        self.upload(node, [self.sample(sequence=3, observed_at=stamp, differential_pressure_pa=30)])
        with service.connection() as conn:
            rows = conn.execute('SELECT * FROM monitor_samples ORDER BY sequence').fetchall()
            self.assertEqual(rows[0]['outlet_temperature_c'], 18)
            self.assertEqual(rows[1]['differential_pressure_pa'], 30, 'Late uploads retain the calibration applicable at observation time')
            self.assertEqual(rows[2]['outlet_temperature_c'], 19.5)
            self.assertEqual(rows[2]['differential_pressure_pa'], 40)
            self.assertNotEqual(rows[0]['calibration_id'], rows[2]['calibration_id'])

    def test_sensor_faults_out_of_range_and_unsynchronized_clock(self):
        node = self.create()
        response = self.upload(node, [self.sample(temperature_quality='fault', differential_pressure_pa=20000),
            self.sample(sequence=2, observed_at=None, clock_quality='unsynchronized', uptime_ms=1234)])
        self.assertEqual(response.status_code, 200)
        with service.connection() as conn:
            row = conn.execute('SELECT * FROM monitor_samples WHERE sequence=1').fetchone()
            self.assertIsNone(row['outlet_temperature_c'])
            self.assertIsNone(row['differential_pressure_pa'])
            self.assertEqual(row['raw_pressure_pa'], 20000)
            self.assertEqual(row['pressure_quality'], 'out_of_range')
            self.assertIsNone(conn.execute('SELECT observed_at FROM monitor_samples WHERE sequence=2').fetchone()[0])
        self.assertEqual(self.analytics()['sample_count'], 1, 'Unknown observation times cannot be placed on a timeline')

    def test_runtime_uses_actual_time_cadence_and_unknown_boundaries(self):
        node = self.create(state_source='power_meter')
        records = [self.sample(sequence=index, observed_at=f'2026-10-18T00:00:{seconds:02}Z', ac_on=state,
                               state_source='power_meter' if state is not None else None)
                   for index, (seconds, state) in enumerate([(0, True), (5, None), (20, True), (25, False)])]
        self.assertEqual(self.upload(node, records).status_code, 200)
        self.assertAlmostEqual(self.analytics()['confirmed_unit_hours'], 10 / 3600)
        self.assertAlmostEqual(self.analytics(**{'from': '2026-10-18T00:00:02Z', 'to': '2026-10-18T00:00:24Z'})['confirmed_unit_hours'], 7 / 3600)
        self.upload(node, [self.sample(sequence=9, ac_on=False, state_source='power_meter')])
        self.assertAlmostEqual(self.analytics()['confirmed_unit_hours'], 5 / 3600, 'Conflicting simultaneous power feedback stays unknown')

    def test_device_assignment_and_deactivation_preserve_history(self):
        node = self.create()
        self.upload(node, [self.sample()])
        self.assertEqual(self.api.post('/api/monitoring/devices', headers=self.headers, json={
            'name': 'Duplicate', 'aircon_id': node['aircon_id'], 'aircon_name': node['aircon_name'],
            'pressure_sensor': 'SDP32', 'pressure_min_pa': -125, 'pressure_max_pa': 125}).status_code, 409)
        self.api.patch('/api/monitoring/devices/' + node['id'], headers=self.headers,
                       json={'aircon_id': 'other-existing-ac', 'aircon_name': 'Other fixture AC'})
        self.assertIsNone(self.api.get('/api/monitoring/devices').json['items'][0]['latest'])
        self.assertEqual(self.analytics(aircon_id='existing-ac-id')['sample_count'], 1)
        self.api.patch('/api/monitoring/devices/' + node['id'], headers=self.headers, json={'active': False})
        self.assertEqual(self.upload(node, [self.sample(sequence=2)]).status_code, 403)
        self.assertEqual(self.analytics()['sample_count'], 1)

    def test_airflow_duration_uses_calibrated_threshold_without_confirming_power(self):
        node = self.create()
        with patch('backend.monitoring.now', return_value='2026-10-18T00:00:00.000Z'):
            response = self.api.post('/api/monitoring/devices/' + node['id'] + '/calibrations', headers=self.headers,
                json={'airflow_threshold_pa': 10, 'notes': 'Isolated airflow threshold fixture'})
            self.assertEqual(response.status_code, 201)
        rows = [self.sample(sequence=index, observed_at=f'2026-10-18T00:00:{seconds:02}Z', differential_pressure_pa=pressure)
                for index, (seconds, pressure) in enumerate([(0, 20), (5, 5), (20, 20)])]
        self.assertEqual(self.upload(node, rows).status_code, 200)
        data = self.analytics()
        self.assertAlmostEqual(data['airflow_detected_unit_hours'], 10 / 3600)
        self.assertEqual(data['confirmed_state_count'], 0)
        self.assertEqual(data['confirmed_unit_hours'], 0)

    def test_rotation_revokes_previous_credential(self):
        node = self.create()
        response = self.api.post('/api/monitoring/devices/' + node['id'] + '/rotate-token', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.upload(node, [self.sample()]).status_code, 401)
        node['device_token'] = response.json['device_token']
        self.assertEqual(self.upload(node, [self.sample()]).status_code, 200)

    def test_pagination_export_filters_and_spreadsheet_safety(self):
        node = self.create(aircon_name='=UNTRUSTED()')
        self.upload(node, [self.sample(), self.sample(sequence=2, observed_at='2026-10-18T00:00:05Z')])
        query = {'from': '2026-10-18T00:00:00Z', 'to': '2026-10-19T00:00:00Z', 'per_page': 1}
        response = self.api.get('/api/monitoring/telemetry', query_string=query)
        self.assertEqual(response.json['total'], 2)
        self.assertEqual(len(response.json['items']), 1)
        exported = self.api.get('/api/monitoring/export.csv', query_string=query)
        rows = list(csv.DictReader(io.StringIO(exported.get_data(as_text=True))))
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0]['aircon_name'].startswith("'="))
        self.assertEqual(rows[0]['ac_on'], '')
        self.assertEqual(rows[0]['differential_pressure_pa'], '0.0')
        self.assertEqual(self.api.get('/api/monitoring/telemetry?per_page=9999').status_code, 422)
        self.assertEqual(self.api.get('/api/monitoring/analytics?from=2026-10-18').status_code, 422)

    def test_freshness_does_not_promote_buffered_readings_to_live(self):
        node = self.create()
        self.upload(node, [self.sample()])
        result = self.api.get('/api/monitoring/devices').json['items'][0]
        self.assertFalse(result['fresh'])
        self.assertEqual(result['status'], 'Stale')
        self.assertIsNotNone(result['last_received_at'])

    def test_optional_cloud_backup_is_idempotent_and_retains_failures(self):
        node = self.create()
        self.upload(node, [self.sample()])
        with patch('backend.monitoring.requests.post') as post:
            self.assertEqual(service.sync_once(), 0)
            post.assert_not_called()
        with patch.dict(os.environ, {'ECOTRACK_MONITOR_SYNC': '1', 'SUPABASE_URL': 'https://fixture.invalid', 'SUPABASE_SERVICE_ROLE_KEY': 'isolated-test-credential'}):
            with patch('backend.monitoring.requests.post', return_value=Mock(ok=False, status_code=503)):
                with self.assertRaises(ValueError):
                    service.sync_once()
            self.assertEqual(service.sync_status()['pending'], 3)
            with patch('backend.monitoring.requests.post', return_value=Mock(ok=True)) as post:
                self.assertEqual(service.sync_once(), 3)
                tables = [call.args[0].rsplit('/', 1)[-1] for call in post.call_args_list]
                self.assertEqual(tables, ['monitor_nodes', 'monitor_calibrations', 'monitor_samples'])
                for call in post.call_args_list:
                    self.assertNotIn('token_hash', call.kwargs['json'])
                    self.assertEqual(call.kwargs['params'], {'on_conflict': 'id'})
            self.assertEqual(service.sync_status()['pending'], 0)
        self.assertEqual(self.analytics()['sample_count'], 1)

    def test_sensor_schedule_requires_admin_and_preserves_measurement_cadence(self):
        node = self.create(expected_interval_seconds=60)
        url = '/api/monitoring/devices/' + node['id'] + '/schedule'
        data = {'wake_time': '22:00', 'sleep_time': '06:00', 'interval_seconds': 30}
        self.assertEqual(self.api.put(url, json=data).status_code, 401)
        result = self.api.put(url, json=data, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertFalse(result.json['hardware_confirmed'])
        saved = self.api.get('/api/monitoring/devices').json['items'][0]
        self.assertEqual(saved['sensor_schedule']['wake_time'], '22:00')
        self.assertEqual(saved['sensor_schedule']['sleep_time'], '06:00')
        self.assertEqual(saved['sensor_schedule']['interval_seconds'], 30)
        self.assertEqual(saved['expected_interval_seconds'], 60)
        for invalid in [{'wake_time': '25:00'}, {'sleep_time': '6:00'}, {'interval_seconds': 0}, {'interval_seconds': True}, {'interval_seconds': 1.5}, {'command': 'on'}]:
            self.assertEqual(self.api.put(url, json={**data, **invalid}, headers=self.headers).status_code, 422)

    def test_sensor_log_snapshot_and_optional_measurements_preserve_nulls_and_zero(self):
        node = self.create(name='Sensor at observation', location='Building · Floor · Room', aircon_type='Window Type')
        samples = [self.sample(battery_voltage=0, rssi_dbm=0, connection_status='offline'), self.sample(sequence=2)]
        self.assertEqual(self.upload(node, samples).status_code, 200)
        self.assertEqual(self.upload(node, samples).json['duplicates'], 2)
        self.api.patch('/api/monitoring/devices/' + node['id'], json={'name': 'Renamed', 'location': 'New room'}, headers=self.headers)
        rows = self.api.get('/api/monitoring/telemetry?from=2026-10-18T00:00:00Z&to=2026-10-19T00:00:00Z').json['items']
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['sensor_name'] == 'Sensor at observation' for row in rows))
        self.assertTrue(all(row['location'] == 'Building · Floor · Room' for row in rows))
        self.assertTrue(all(row['aircon_type'] == 'Window Type' for row in rows))
        zero = next(row for row in rows if row['sequence'] == 1)
        self.assertEqual(zero['battery_voltage'], 0)
        self.assertEqual(zero['rssi_dbm'], 0)
        self.assertEqual(zero['connection_status'], 'offline')
        self.assertIsNone(zero['ac_on'])
        missing = next(row for row in rows if row['sequence'] == 2)
        self.assertIsNone(missing['battery_voltage'])
        self.assertIsNone(missing['rssi_dbm'])
        for extra in [{'battery_voltage': -1}, {'rssi_dbm': 100}, {'connection_status': 'connected'}]:
            self.assertEqual(self.upload(node, [self.sample(sequence=3, **extra)]).status_code, 422)

    def test_two_model_services_coexist_and_sensor_forecasts_do_not_invent_inputs(self):
        from concurrent.futures import ThreadPoolExecutor
        import math
        import pandas as pd
        def control():
            with backend.app.test_client() as api:
                response = api.post('/api/predict-energy', json={'model': 'hist_gradient_boosting', 'settings': {
                    'setpoint_c': 24, 'fan_command': 'medium', 'operating_mode': 'cool', 'eco': False,
                    'turbo': False, 'swing': True, 'quiet': False, 'horizontal_swing': False, 'display': True}})
                self.assertEqual(response.status_code, 200, response.json)
                self.assertEqual(response.json['model'], 'hist_gradient_boosting')
        def sensor():
            with backend.app.test_client() as api:
                response = api.get('/api/monitoring/energy')
                self.assertEqual(response.status_code, 200)
                self.assertIsNone(response.json['energy_kwh'])
                self.assertEqual(response.json['code'], 'SENSOR_REFERENCE_HISTORY_UNAVAILABLE')
                self.assertFalse(response.json['available'])
                self.assertTrue(api.get('/api/monitoring/energy-model').json['loaded'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda fn: fn(), [control, sensor]))
        # Runtime compatibility probe only: explicit artificial feature vector,
        # never presented as measured data or as a kWh conversion.
        model = service.legacy_sensor_energy.load()
        frame = pd.DataFrame([[0.0] * 10], columns=service.legacy_sensor_energy.manifest()['features'])
        self.assertTrue(math.isfinite(float(model.predict(frame)[0])))
        self.assertEqual(self.api.get('/api/monitoring/energy', environ_overrides={'REMOTE_ADDR': '192.168.1.20'}).status_code, 403)
        self.assertEqual(self.api.get('/api/monitoring/energy-model', headers={'Origin': 'https://outside.invalid'}).status_code, 403)


if __name__ == '__main__':
    unittest.main(verbosity=2)
