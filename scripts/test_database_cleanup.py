"""Exercise database cleanup against an isolated SQLite database, with no cloud writes."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import closing

sandbox = tempfile.TemporaryDirectory(prefix='ecotrack-db-cleanup-test-')
os.environ['ECOTRACK_SQLITE_DB_PATH'] = str(Path(sandbox.name) / 'telemetry.db')
os.environ['ECOTRACK_TELEMETRY_SYNC'] = '0'
spec = importlib.util.spec_from_file_location('cleanup_backend', Path(__file__).resolve().parents[1] / 'backend/app.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class DatabaseCleanupTests(unittest.TestCase):
    def setUp(self):
        self.api = backend.app.test_client()
        with closing(backend.get_db_connection()) as conn:
            conn.execute('DELETE FROM telemetry'); conn.commit()
        for row in [{'id': 'a', 'node_id': 'db-a', 'sensor_name': 'node-a', 'battery': 3.7},
                    {'id': 'b', 'node_id': 'db-b', 'sensor_name': 'node-b', 'battery': 3.9},
                    {'id': 'c', 'node_id': 'db-b', 'sensor_name': 'node-b', 'battery': None}]:
            self.assertEqual(self.api.post('/api/telemetry', json=row).status_code, 201)

    def rows(self, expression):
        response = self.api.get('/api/telemetry', query_string={'filter': expression, 'perPage': 0})
        self.assertEqual(response.status_code, 200, response.get_json())
        return {row['id'] for row in response.get_json()['items']}

    def test_filters_and_precedence(self):
        self.assertEqual(self.rows("node_id='db-a' || sensor_name='node-b' && battery>=3.8"), {'a', 'b'})
        self.assertEqual(self.rows("(node_id='db-a' || sensor_name='node-b') && battery>=3.8"), {'b'})
        self.assertEqual(self.rows("node_id.name='node-a'"), {'a'})
        self.assertEqual(self.rows('battery=null'), {'c'})
        self.assertEqual(self.rows("battery != null && battery <= 3.7"), {'a'})

    def test_filter_and_sort_rejections(self):
        for value in ["node_id='a'; DROP TABLE telemetry", "missing='a'", "node_id~'a'", "(node_id='a'", "node_id='a' ||"]:
            self.assertEqual(self.api.get('/api/telemetry', query_string={'filter': value}).status_code, 400)
        for args in [{'sort': 'created; DROP TABLE telemetry'}, {'page': 'bad'}, {'page': 0}, {'perPage': -1}]:
            self.assertEqual(self.api.get('/api/telemetry', query_string=args).status_code, 400)
        self.assertEqual(self.rows('sensor_name="x\' OR 1=1"'), set())
        self.assertEqual(self.api.get('/api/telemetry').get_json()['totalItems'], 3)

    def test_patch_changes_existing_row_only(self):
        response = self.api.patch('/api/telemetry/a', json={'room_name': 'Laboratory', 'battery': 3.8,
            'control_snapshot': {'desired_state': {'power': True}}})
        self.assertEqual(response.status_code, 200)
        with closing(backend.get_db_connection()) as conn:
            row = conn.execute("SELECT * FROM telemetry WHERE id='a'").fetchone()
            self.assertEqual(row['room_name'], 'Laboratory'); self.assertEqual(row['battery'], 3.8)
            self.assertIsNone(row['ac_on'], 'Commanded power cannot turn into measured operation')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM telemetry').fetchone()[0], 3)
        self.assertEqual(self.api.patch('/api/telemetry/missing', json={'room_name': 'Lab'}).status_code, 404)

    def test_invalid_patch_preserves_record(self):
        for payload in [{}, {'id': 'changed'}, {'unknown': True}, {'battery': 'bad'}, {'interval_seconds': -1}, {'room_name': []}]:
            self.assertEqual(self.api.patch('/api/telemetry/a', json=payload).status_code, 400)
        self.assertEqual(self.api.get('/api/telemetry/a').get_json()['battery'], 3.7)

    def test_missing_measurements_are_unknown(self):
        row = self.api.get('/api/telemetry/c').get_json()
        for field in ['temperature', 'pressure', 'battery', 'rssi', 'ac_on']:
            self.assertIsNone(row[field])
        self.assertEqual(self.api.patch('/api/telemetry/b', json={'battery': None, 'ac_on': False}).status_code, 200)
        self.assertIsNone(self.api.get('/api/telemetry/b').get_json()['battery'])
        self.assertEqual(self.api.get('/api/telemetry/b').get_json()['ac_on'], 0)

    def test_invalid_batch_rolls_back(self):
        response = self.api.post('/api/telemetry', json=[{'id': 'new', 'node_id': 'new'}, {'battery': 'bad'}])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.api.get('/api/telemetry').get_json()['totalItems'], 3)

    def test_empty_results_after_delete(self):
        self.assertEqual(self.api.delete('/api/telemetry').status_code, 200)
        result = self.api.get('/api/telemetry').get_json()
        self.assertEqual(result['totalItems'], 0); self.assertEqual(result['items'], [])


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        sandbox.cleanup()
