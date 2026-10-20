"""Test the actual Flask API with a temporary SQLite DB and mocked networking."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

temporary_db = tempfile.TemporaryDirectory(prefix='ecotrack-schedule-test-')
os.environ['ECOTRACK_SQLITE_DB_PATH'] = str(Path(temporary_db.name) / 'telemetry.db')
spec = importlib.util.spec_from_file_location('ecotrack_backend', Path(__file__).resolve().parents[1] / 'backend' / 'app.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class SchedulePipelineTests(unittest.TestCase):
    def setUp(self):
        self.api = backend.app.test_client()
        self.executor = patch.object(backend._schedule_executor, 'submit')
        self.submit = self.executor.start()
        self.addCleanup(self.executor.stop)

    def schedule(self, **overrides):
        return self.api.post('/api/set-sleep', json={'node_id': 'node-1', 'sleep_seconds': 30, **overrides})

    def test_baseline_and_forwarding(self):
        reading = self.api.post('/api/telemetry', json={'node_id': 'node-1', 'sensor_name': 'node-1', 'temperature': 25.3, 'pressure': 0.4, 'battery': 3.9, 'rssi': -62})
        self.assertEqual(reading.status_code, 201)
        response = self.schedule(ip='192.168.1.44')
        self.assertEqual(response.status_code, 202)
        result = response.get_json()
        rows = self.api.get('/api/telemetry?perPage=0').get_json()['items']
        event = next(row for row in rows if row['id'] == result['telemetry_id'])
        self.assertEqual(event['event_type'], 'schedule_updated')
        self.assertEqual(event['status'], 'schedule')
        self.assertEqual(event['temperature'], 25.3)
        self.assertEqual(event['interval_seconds'], 30)
        self.submit.assert_called_once_with(backend.forward_schedule_interval, result['job_id'], 'node-1', 30, '192.168.1.44', '06:00', '22:00')
        acknowledgement = Mock()
        acknowledgement.json.return_value = {'success': True, 'interval_ms': 30000}
        with patch.object(backend.requests, 'post', return_value=acknowledgement) as post:
            backend.forward_schedule_interval(result['job_id'], 'node-1', 30, '192.168.1.44')
            post.assert_called_once_with('http://192.168.1.44/set-interval', json={'interval_seconds': 30}, timeout=(2, 4), allow_redirects=False)
        self.assertEqual(self.api.get('/api/set-sleep?job_id=' + result['job_id']).get_json()['status'], 'sent')

    def test_invalid_intervals_and_ip_are_rejected(self):
        for interval in [0, -1, 'oops', 0.5, 4294968, None]:
            with self.subTest(interval=interval):
                self.assertEqual(self.schedule(sleep_seconds=interval).status_code, 400)
        self.assertEqual(self.schedule(ip='not-an-ip').status_code, 400)
        self.assertEqual(self.schedule(node_snapshot=[]).status_code, 400)
        self.assertEqual(self.schedule(wake_time='24:00').status_code, 400)
        self.assertEqual(self.schedule(sleep_time='10:99').status_code, 400)
        self.submit.assert_not_called()

    def test_reported_ac_state_and_cadence_are_persisted(self):
        samples = [({}, None), ({'ac_on': True}, 1), ({'ac_on': False}, 0),
                   ({'power_state': 'ON'}, 1), ({'ac_state': 'OFF'}, 0), ({'power_state': 'unknown'}, None)]
        for index, (fields, expected) in enumerate(samples):
            with self.subTest(fields=fields):
                result = self.api.post('/api/telemetry', json={'id': f'power_fixture_{index}', 'node_id': 'power_fixture',
                    'temperature': 24, 'status': 'online', 'interval_seconds': 30, **fields})
                self.assertEqual(result.status_code, 201)
                self.assertEqual(result.get_json()['ac_on'], expected)
                saved = self.api.get(f'/api/telemetry/power_fixture_{index}').get_json()
                self.assertEqual(saved['ac_on'], expected)
                self.assertEqual(saved['interval_seconds'], 30)

    def test_registry_lookup_and_failed_acknowledgement(self):
        result = self.schedule().get_json()
        response = Mock()
        response.json.return_value = {'success': False, 'interval_ms': 900000}
        with patch.object(backend, 'lookup_schedule_node', return_value={'ip_address': '192.168.1.45'}) as lookup, patch.object(backend.requests, 'post', return_value=response):
            backend.forward_schedule_interval(result['job_id'], 'node-1', 30)
            lookup.assert_called_once_with('node-1')
        self.assertEqual(self.api.get('/api/set-sleep?job_id=' + result['job_id']).get_json()['status'], 'failed')

    def test_unknown_ip_uses_cloud_polling_fallback(self):
        result = self.schedule().get_json()
        with patch.object(backend, 'lookup_schedule_node', return_value=None), patch.object(backend.requests, 'post') as post:
            backend.forward_schedule_interval(result['job_id'], 'node-1', 30)
            post.assert_not_called()
        self.assertEqual(self.api.get('/api/set-sleep?job_id=' + result['job_id']).get_json()['status'], 'pending_ip')


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        backend._schedule_executor.shutdown(wait=False)
        temporary_db.cleanup()
