"""History transfer correctness; all records live in a disposable SQLite file."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

sandbox = tempfile.TemporaryDirectory(prefix='ecotrack-history-')
os.environ['ECOTRACK_SQLITE_DB_PATH'] = str(Path(sandbox.name) / 'history.db')
os.environ['ECOTRACK_TELEMETRY_SYNC'] = '0'
spec = importlib.util.spec_from_file_location('history_backend', Path(__file__).resolve().parents[1] / 'backend/app.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.api = backend.app.test_client()
        conn = backend.get_db_connection()
        with conn:
            conn.execute('DELETE FROM telemetry')
            conn.executemany('INSERT INTO telemetry (id,node_id,created,ac_on,interval_seconds) VALUES (?,?,?,?,?)',
                [(f'row-{i}', 'node-1', f'2026-10-01T00:{i % 60:02}:00+00:00', i % 2, 30) for i in range(1000)])
        conn.close()

    def history(self, cursor=None):
        args = {'history': 1, 'perPage': 0}
        if cursor: args['cursor'] = cursor
        result = self.api.get('/api/telemetry', query_string=args)
        self.assertEqual(result.status_code, 200, result.get_json())
        return result.get_json()

    def test_append_and_backfill_preserve_entire_history(self):
        first = self.history()
        self.assertTrue(first['history_full'])
        self.assertEqual(len(first['items']), 1000)
        self.assertEqual(self.history(first['history_cursor'])['items'], [])
        # A newly imported row can have an older created timestamp.
        self.assertEqual(self.api.post('/api/telemetry', json={'id': 'backfill', 'node_id': 'node-1',
            'created': '2022-01-01T00:00:00Z', 'ac_on': False}).status_code, 201)
        delta = self.history(first['history_cursor'])
        self.assertFalse(delta['history_full'])
        self.assertEqual([r['id'] for r in delta['items']], ['backfill'])
        combined = {r['id']: r for r in first['items'] + delta['items']}
        self.assertEqual(combined, {r['id']: r for r in self.history()['items']})
        self.assertEqual(delta['history_total'], 1001)
        print('Transfer evidence: 1 appended row instead of 1001 full-history rows; identical merged history.')

    def test_updates_deletes_and_clear_invalidate_cursor(self):
        for operation in ['update', 'delete', 'clear']:
            old = self.history()
            conn = backend.get_db_connection()
            with conn:
                if operation == 'update': conn.execute("UPDATE telemetry SET ac_on=0 WHERE id='row-1'")
                elif operation == 'delete': conn.execute("DELETE FROM telemetry WHERE id='row-999'")
                else: conn.execute('DELETE FROM telemetry')
            conn.close()
            changed = self.history(old['history_cursor'])
            self.assertTrue(changed['history_full'])
            self.assertNotEqual(old['history_revision'], changed['history_revision'])
            self.assertEqual(changed['items'], self.history()['items'])

    def test_validation_and_legacy_queries(self):
        for args in [{'history': 1}, {'history': 1, 'perPage': 0, 'node': 'node-1'},
                     {'history': 1, 'perPage': 0, 'cursor': 'invalid'}]:
            self.assertEqual(self.api.get('/api/telemetry', query_string=args).status_code, 400)
        self.assertEqual(len(self.api.get('/api/telemetry?perPage=1').get_json()['items']), 1)
        self.assertEqual(self.api.get('/api/telemetry?perPage=0').get_json()['totalItems'], 1000)

    def test_received_states_and_operating_window_survive_ingestion(self):
        for index, power in enumerate([True, False, None]):
            response = self.api.post('/api/telemetry', json={'id': f'state-{index}', 'node_id': 'node-1',
                'ac_on': power, 'interval_seconds': 30, 'pressure': 0.4,
                'wake_time': '22:00', 'sleep_time': '06:00',
                'control_snapshot': {'desired_state': {'power': True}}})
            self.assertEqual(response.status_code, 201)
            row = response.get_json()
            self.assertEqual(row['ac_on'], power)
            self.assertNotIn('pressure', row)  # Legacy sender field is ignored.
            self.assertEqual((row['wake_time'], row['sleep_time']), ('22:00', '06:00'))

    def test_pressure_free_schema_and_local_reader_writer_contract(self):
        conn = backend.get_db_connection()
        try:
            columns = [row['name'] for row in conn.execute('PRAGMA table_info(telemetry)')]
            self.assertEqual(len(columns), 21)
            self.assertNotIn('pressure', columns)
        finally:
            conn.close()
        saved = self.api.post('/api/telemetry', json={'id': 'legacy-input', 'node_id': 'node-1',
            'temperature': 24.5, 'pressure': 1012.3, 'battery': 3.9, 'rssi': -62,
            'control_snapshot': {'desired_state': {'power': 'on'}}})
        self.assertEqual(saved.status_code, 201)
        self.assertNotIn('pressure', saved.get_json())
        self.assertIsNone(saved.get_json()['ac_on'], 'Desired power must not become physical feedback')
        updated = self.api.patch('/api/telemetry/legacy-input', json={'temperature': 25.0})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()['temperature'], 25.0)
        self.assertNotIn('pressure', updated.get_json())
        for args in [{'sort': 'pressure'}, {'filter': 'pressure > 0'}]:
            self.assertEqual(self.api.get('/api/telemetry', query_string=args).status_code, 400)
        self.assertEqual(self.api.patch('/api/telemetry/legacy-input', json={'pressure': 1}).status_code, 400)
        for row in self.history()['items']:
            self.assertNotIn('pressure', row)

    def test_temperature_history_does_not_require_removed_pressure(self):
        for identifier, created, temperature in [('later', '2026-10-11T00:00:00Z', 25.2),
                                                  ('earlier', '2026-10-10T00:00:00Z', 24.1),
                                                  ('missing', '2026-10-12T00:00:00Z', None)]:
            self.assertEqual(self.api.post('/api/telemetry', json={'id': identifier, 'node_id': 'node-1',
                'created': created, 'temperature': temperature}).status_code, 201)
        result = self.api.get('/api/historical')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.get_json(), {'temperatures': [24.1, 25.2], 'pressures': [],
            'timestamps': ['2026-10-10T00:00:00+00:00', '2026-10-11T00:00:00+00:00']})


if __name__ == '__main__':
    unittest.main()
