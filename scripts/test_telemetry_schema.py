"""Migration preservation, compatibility and failure checks on disposable DBs."""
from contextlib import closing
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('telemetry_schema', Path(__file__).resolve().parents[1] / 'backend/telemetry_schema.py')
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)


class TelemetrySchemaTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix='ecotrack-schema-')
        self.addCleanup(self.sandbox.cleanup)
        self.path = Path(self.sandbox.name) / 'telemetry.db'
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.executescript('''
            CREATE TABLE telemetry (id TEXT PRIMARY KEY, temperature REAL, pressure REAL,
                ac_on INTEGER, interval_seconds INTEGER, control_snapshot TEXT, created TEXT);
            CREATE INDEX telemetry_created ON telemetry(created);
            CREATE TABLE cloud_sync_state (source TEXT PRIMARY KEY, cursor_created TEXT, cursor_id TEXT);
            INSERT INTO cloud_sync_state VALUES ('telemetry','2026-10-10T09:08:21+00:00','row-b');
            CREATE TABLE telemetry_local_reset (id INTEGER PRIMARY KEY, deleted_through TEXT);
            INSERT INTO telemetry_local_reset VALUES (1,'2026-10-01T00:00:00+00:00');
            CREATE TABLE telemetry_history_generation (id INTEGER PRIMARY KEY, token TEXT);
            INSERT INTO telemetry_history_generation VALUES (1,'original-token');
            CREATE TRIGGER telemetry_history_update AFTER UPDATE ON telemetry BEGIN
                UPDATE telemetry_history_generation SET token='updated' WHERE id=1; END;
            INSERT INTO telemetry(rowid,id,temperature,pressure,ac_on,interval_seconds,control_snapshot,created)
                VALUES (4,'row-a',24.5,1012.3,NULL,30,'{"desired_state":{"power":"on"}}','2026-10-10T09:00:00+00:00'),
                       (9,'row-b',NULL,NULL,0,60,NULL,'2026-10-10T09:08:21+00:00');
        ''')

    def columns(self):
        return [row[1] for row in self.conn.execute('PRAGMA table_info(telemetry)')]

    def test_backup_preserves_old_values_and_migration_preserves_remaining_state(self):
        remaining = [field for field in self.columns() if field != 'pressure']
        query = 'SELECT rowid,' + ','.join(remaining) + ' FROM telemetry ORDER BY rowid'
        before = self.conn.execute(query).fetchall()
        objects = self.conn.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name").fetchall()
        helpers = {name: self.conn.execute('SELECT * FROM ' + name).fetchall()
                   for name in ['cloud_sync_state', 'telemetry_local_reset']}
        backup_path = schema.remove_legacy_pressure(self.conn)
        self.assertEqual(self.columns(), remaining)
        self.assertEqual(self.conn.execute(query).fetchall(), before)
        self.assertEqual(self.conn.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name").fetchall(), objects)
        for name, values in helpers.items():
            self.assertEqual(self.conn.execute('SELECT * FROM ' + name).fetchall(), values)
        self.assertNotEqual(self.conn.execute('SELECT token FROM telemetry_history_generation').fetchone()[0], 'original-token')
        self.assertEqual(self.conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        with closing(sqlite3.connect(backup_path)) as backup:
            self.assertEqual(backup.execute('SELECT pressure FROM telemetry ORDER BY rowid').fetchall(), [(1012.3,), (None,)])
            self.assertEqual(backup.execute(query).fetchall(), before)
            self.assertEqual(backup.execute('SELECT token FROM telemetry_history_generation').fetchone()[0], 'original-token')
            self.assertEqual(backup.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.conn.execute("UPDATE telemetry SET temperature=25 WHERE id='row-a'")
        self.assertEqual(self.conn.execute('SELECT token FROM telemetry_history_generation').fetchone()[0], 'updated')

    def test_repeated_migration_has_no_writes_or_extra_backups(self):
        schema.remove_legacy_pressure(self.conn)
        token = self.conn.execute('SELECT token FROM telemetry_history_generation').fetchone()[0]
        self.assertIsNone(schema.remove_legacy_pressure(self.conn))
        self.assertEqual(len(list((self.path.parent / 'backups').glob('*.db'))), 1)
        self.assertEqual(self.conn.execute('SELECT token FROM telemetry_history_generation').fetchone()[0], token)

    def test_dependent_index_failure_rolls_back_schema_and_data(self):
        self.conn.execute('CREATE INDEX legacy_pressure ON telemetry(pressure)')
        before = self.conn.execute('SELECT rowid,* FROM telemetry ORDER BY rowid').fetchall()
        with self.assertRaises(sqlite3.OperationalError):
            schema.remove_legacy_pressure(self.conn)
        self.assertIn('pressure', self.columns())
        self.assertFalse(self.conn.in_transaction)
        self.assertEqual(self.conn.execute('SELECT rowid,* FROM telemetry ORDER BY rowid').fetchall(), before)
        self.assertEqual(self.conn.execute('SELECT token FROM telemetry_history_generation').fetchone()[0], 'original-token')
        self.assertEqual(len(list((self.path.parent / 'backups').glob('*.db'))), 1)

    def test_backup_failure_keeps_original_column_and_records(self):
        blocked_folder = self.path.parent / 'not-a-directory'
        blocked_folder.write_text('existing file', encoding='utf-8')
        before = self.conn.execute('SELECT rowid,* FROM telemetry ORDER BY rowid').fetchall()
        with self.assertRaises(OSError):
            schema.remove_legacy_pressure(self.conn, backup_dir=blocked_folder)
        self.assertIn('pressure', self.columns())
        self.assertEqual(self.conn.execute('SELECT rowid,* FROM telemetry ORDER BY rowid').fetchall(), before)
        self.assertFalse(self.conn.in_transaction)

    def test_fresh_database_is_a_noop(self):
        self.conn.close()
        with closing(sqlite3.connect(':memory:')) as fresh:
            self.assertIsNone(schema.remove_legacy_pressure(fresh))
            fresh.execute('CREATE TABLE telemetry(id TEXT PRIMARY KEY,temperature REAL)')
            self.assertIsNone(schema.remove_legacy_pressure(fresh))
        self.assertFalse((self.path.parent / 'backups').exists())


if __name__ == '__main__':
    unittest.main()
