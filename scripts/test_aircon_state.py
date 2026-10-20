"""Verify timestamped control state survives cloud import and local telemetry writes."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

temporary = tempfile.TemporaryDirectory(prefix='ecotrack-state-test-')
os.environ['ECOTRACK_SQLITE_DB_PATH'] = str(Path(temporary.name) / 'telemetry.db')
spec = importlib.util.spec_from_file_location('state_backend', Path(__file__).resolve().parents[1] / 'backend/app.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

class StateTests(unittest.TestCase):
    def test_cloud_and_local_snapshots_survive_round_trip(self):
        api = backend.app.test_client()
        original = {'desired_state': {'power': 'on', 'mode': 'cool', 'fan': 'quiet', 'temp': 24, 'eco': False, 'turbo': True, 'swing_vertical': True, 'swing_horizontal': False, 'display': True, 'filter': False, 'quiet': None}, 'command_status': 'transmitted'}
        row = {'id': 'cloud-state', 'node_id': 'n1', 'created': '2026-10-03T10:00:00Z', 'control_snapshot': original, 'aircon_id': 'ac1'}
        backend.import_cloud_telemetry([row])
        row['control_snapshot'] = {'desired_state': {'mode': 'fan'}}
        self.assertEqual(backend.import_cloud_telemetry([row])['skipped'], 1)
        self.assertEqual(api.get('/api/telemetry/cloud-state').get_json()['control_snapshot'], original)
        self.assertEqual(api.get('/api/telemetry/cloud-state').get_json()['aircon_id'], 'ac1')
        result = api.post('/api/telemetry', json={**row, 'id': 'local-state', 'control_snapshot': original, 'ac_state': 'fan only'})
        self.assertEqual(result.status_code, 201)
        self.assertEqual(api.get('/api/telemetry/local-state').get_json()['control_snapshot'], original)
        self.assertEqual(api.get('/api/telemetry/local-state').get_json()['ac_state'], 'fan only')
        result = api.post('/api/telemetry', json={**row, 'id': 'local-state'})
        self.assertEqual(result.get_json()['control_snapshot'], original)
        self.assertIsNone(api.get('/api/telemetry/cloud-state').get_json()['ac_on'])

if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        temporary.cleanup()
