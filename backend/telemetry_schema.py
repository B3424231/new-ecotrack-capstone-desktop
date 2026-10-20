"""Small, backed-up migrations for the local telemetry history database."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import uuid


def remove_legacy_pressure(conn, backup_dir=None):
    """Drop unused pressure once, preserving other data and a full pre-change backup.

    A reserved write lock covers backup and alteration so another writer cannot
    insert between them. A separate reader makes the backup: backing up this
    same connection while it owns a write transaction would block indefinitely.
    Any migration/backup failure rolls back and prevents startup with a partial
    schema. An already migrated or new database requires no backup or writes.
    """
    columns = {row[1].lower() for row in conn.execute('PRAGMA table_info(telemetry)')}
    if 'pressure' not in columns:
        return None
    if conn.in_transaction:
        raise RuntimeError('Telemetry schema migration requires a standalone transaction')
    if sqlite3.sqlite_version_info < (3, 35, 0):
        raise RuntimeError('Removing telemetry pressure requires SQLite 3.35 or newer')
    database = next(row[2] for row in conn.execute('PRAGMA database_list') if row[1] == 'main')
    if not database:
        raise RuntimeError('Legacy telemetry migration requires a file-backed database')
    database = Path(database).resolve()
    backup_folder = Path(backup_dir) if backup_dir else database.parent / 'backups'
    conn.execute('BEGIN IMMEDIATE')
    try:
        # Another startup may have migrated while we waited for its write lock.
        columns = {row[1].lower() for row in conn.execute('PRAGMA table_info(telemetry)')}
        if 'pressure' not in columns:
            conn.rollback()
            return None
        backup_folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup_path = backup_folder / f'{database.stem}-before-pressure-removal-{stamp}-{uuid.uuid4().hex[:8]}.db'
        # Reserve a unique filename; never overwrite an existing backup.
        backup_path.touch(exist_ok=False)
        source = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=20)
        try:
            backup = sqlite3.connect(str(backup_path))
            try:
                source.backup(backup)
                if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Pre-migration telemetry backup failed its integrity check')
            finally:
                backup.close()
        finally:
            source.close()
        conn.execute('ALTER TABLE telemetry DROP COLUMN pressure')
        # Force clients with cached old rows to fetch the new response shape.
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telemetry_history_generation'").fetchone():
            conn.execute('UPDATE telemetry_history_generation SET token=lower(hex(randomblob(16))) WHERE id=1')
        conn.commit()
        return str(backup_path.resolve())
    except Exception:
        conn.rollback()
        raise
