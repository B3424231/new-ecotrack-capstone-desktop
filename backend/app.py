"""
EcoTrack Python Backend - Machine Learning Microservice
Telemetry and hardware services with one Histogram Gradient Boosting energy forecast model.
Energy outputs are labeled research-based estimates, not measured telemetry.
"""
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_restful import Api, Resource
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from ipaddress import ip_address
from dotenv import load_dotenv
import requests
import os
import sys
import uuid
import sqlite3
import json
import warnings
import subprocess
import re
import threading
import atexit
import numpy as np

warnings.filterwarnings('ignore')

app = Flask(__name__)
CORS(app)
api = Api(app)

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
from backend.telemetry_schema import remove_legacy_pressure

# ===== NATIVE SQLITE3 SENSOR LOGS DATABASE =====
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
SQLITE_DB_PATH = os.environ.get('ECOTRACK_SQLITE_DB_PATH') or os.path.join(os.path.dirname(__file__), 'telemetry.db')
_schedule_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='ecotrack-schedule')

def get_db_connection():
    """Create a thread-safe connection to the SQLite3 database."""
    conn = sqlite3.connect(SQLITE_DB_PATH, timeout=20.0)
    conn.row_factory = sqlite3.Row
    return conn

def init_sqlite_db():
    """Initialize the SQLite3 database schema for high-frequency sensor logs."""
    conn = get_db_connection()
    try:
        backup = remove_legacy_pressure(conn, backup_dir=os.getenv('ECOTRACK_SQLITE_SCHEMA_BACKUP_DIR'))
        if backup:
            print(f'[*] Removed legacy telemetry pressure column; backup: {backup}')
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS telemetry (
                    id TEXT PRIMARY KEY,
                    node_id TEXT,
                    sensor_name TEXT,
                    room_name TEXT,
                    floor_name TEXT,
                    building_name TEXT,
                    aircon_type TEXT,
                    temperature REAL,
                    battery REAL,
                    rssi REAL,
                    status TEXT,
                    created TEXT,
                    updated TEXT
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_telem_created ON telemetry (created DESC);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_telem_sensor ON telemetry (sensor_name);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_telem_node ON telemetry (node_id);")
            existing_columns = {row['name'] for row in conn.execute('PRAGMA table_info(telemetry)')}
            for column, column_type in [('event_type', 'TEXT'), ('interval_seconds', 'INTEGER'), ('wake_time', 'TEXT'), ('sleep_time', 'TEXT'), ('ac_on', 'INTEGER'), ('aircon_id', 'TEXT'), ('control_snapshot', 'TEXT'), ('ac_state', 'TEXT')]:
                if column not in existing_columns:
                    conn.execute(f'ALTER TABLE telemetry ADD COLUMN {column} {column_type}')
            conn.execute('''CREATE TABLE IF NOT EXISTS schedule_dispatches (
                id TEXT PRIMARY KEY, node_id TEXT, ip TEXT, interval_seconds INTEGER,
                status TEXT, error TEXT, created TEXT, updated TEXT
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS cloud_sync_state (
                source TEXT PRIMARY KEY, cursor_created TEXT NOT NULL, cursor_id TEXT NOT NULL
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS telemetry_local_reset (
                id INTEGER PRIMARY KEY CHECK (id = 1), deleted_through TEXT NOT NULL
            )''')
            # Inserts append rowids. Any edit/deletion invalidates incremental
            # snapshots, including backfilled imports and rowid reuse after clears.
            conn.execute('''CREATE TABLE IF NOT EXISTS telemetry_history_generation (
                id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL
            )''')
            conn.execute('INSERT OR IGNORE INTO telemetry_history_generation VALUES (1, ?)', (uuid.uuid4().hex,))
            for operation in ('UPDATE', 'DELETE'):
                conn.execute(f'''CREATE TRIGGER IF NOT EXISTS telemetry_history_{operation.lower()}
                    AFTER {operation} ON telemetry BEGIN
                    UPDATE telemetry_history_generation SET token=lower(hex(randomblob(16))) WHERE id=1;
                    END''')
        print(f"[*] SQLite3 Sensor Logs Database initialized at: {SQLITE_DB_PATH}")
    finally:
        conn.close()

# Initialize SQLite3 database on startup
init_sqlite_db()

from backend.monitoring import register_monitoring
monitoring_service = register_monitoring(app, get_db_connection,
    os.path.join(os.path.dirname(os.path.abspath(SQLITE_DB_PATH)), '.ecotrack-monitoring-admin.key'))
atexit.register(monitoring_service.stop.set)

# ===== HISTOGRAM GRADIENT BOOSTING RESEARCH-ESTIMATE SERVICE =====
from backend.energy_prediction import EnergyPredictor, PredictionError

energy_predictor = EnergyPredictor(os.path.join(
    PROJECT_ROOT, 'backend', 'ml', 'control_only_hist_gradient_boosting'))


def prediction_error_response(error):
    return {'error': str(error), 'error_code': error.code,
            'model': EnergyPredictor.MODEL_ID,
            'available_models': [EnergyPredictor.MODEL_ID],
            'prediction_status': 'unavailable',
            'physical_accuracy_validated': False}, error.status


class HealthResource(Resource):
    """Report actual model readiness without representing estimates as telemetry."""
    def get(self):
        return {
            'status': 'healthy',
            'service': 'EcoTrack Machine Learning Backend',
            'timestamp': datetime.now().isoformat(),
            'version': '3.0.0',
            **energy_predictor.health()
        }, 200


class PredictionFeaturesResource(Resource):
    """The exact inputs, reference scope and explicit modeled scenarios."""
    def get(self):
        try:
            return energy_predictor.features(
                request.args.get('model', EnergyPredictor.MODEL_ID)), 200
        except PredictionError as error:
            return prediction_error_response(error)
        except Exception:
            app.logger.exception('Histogram Gradient Boosting feature contract unavailable')
            return {'error': 'Histogram Gradient Boosting feature contract unavailable',
                    'prediction_status': 'unavailable'}, 503


class PredictionMetricsResource(Resource):
    """Return the stored test evaluation against generated targets only."""
    def get(self):
        try:
            return energy_predictor.metrics(
                request.args.get('model', EnergyPredictor.MODEL_ID)), 200
        except PredictionError as error:
            return prediction_error_response(error)
        except Exception:
            app.logger.exception('Histogram Gradient Boosting metrics unavailable')
            return {'error': 'Histogram Gradient Boosting metrics unavailable',
                    'prediction_status': 'unavailable'}, 503


class EnergyPredictionResource(Resource):
    """Estimate a fixed future hour; never write predictions into sensor history."""
    def post(self):
        try:
            return energy_predictor.predict(request.get_json(silent=True)), 200
        except PredictionError as error:
            return prediction_error_response(error)
        except Exception:
            app.logger.exception('Histogram Gradient Boosting estimate failed')
            return {'error': 'Histogram Gradient Boosting estimate unavailable',
                    'prediction_status': 'unavailable'}, 503


class RecordedEnergyPredictionResource(Resource):
    """Use recorded control columns with the existing trained reference model."""
    def post(self):
        try:
            return energy_predictor.predict_recorded(request.get_json(silent=True)), 200
        except PredictionError as error:
            return prediction_error_response(error)
        except Exception:
            app.logger.exception('Recorded-column Histogram Gradient Boosting estimate failed')
            return {'error': 'Recorded-column estimate unavailable',
                    'prediction_status': 'unavailable'}, 503


# ===== SQLITE3 TELEMETRY SENSOR LOGS ENDPOINTS =====

def row_to_dict(row):
    """Convert a sqlite3.Row object to a dictionary with proper types."""
    if row is None:
        return None
    d = dict(row)
    if d.get("control_snapshot"):
        d["control_snapshot"] = json.loads(d["control_snapshot"])
    # Ensure numerical fields are floats
    for field in ('temperature', 'battery', 'rssi'):
        if field in d and d[field] is not None:
            try:
                d[field] = float(d[field])
            except (ValueError, TypeError):
                pass
    return d


def normalize_logged_ac_state(item):
    """Preserve explicit feedback; temperature and connectivity do not report AC power."""
    value = next((item[field] for field in ('ac_on', 'acOn', 'power_state', 'powerState', 'ac_state', 'acState')
                  if item.get(field) is not None), None)
    if value is True or value == 1:
        return 1
    if value is False or value == 0:
        return 0
    if value is not None:
        state = str(value).strip().lower().replace('_', ' ').replace('-', ' ')
        if state in ('on', 'true', '1', 'cooling', 'active cooling', 'fan only', 'running'):
            return 1
        if state in ('off', 'false', '0', 'standby', 'idle', 'stopped'):
            return 0
    return None


def analytics_recording_power(item):
    """Read the saved power setting; connectivity never implies AC power."""
    snapshot = item.get('control_snapshot')
    if isinstance(snapshot, str):
        snapshot = json.loads(snapshot)
    best, best_time = None, float('-inf')
    if isinstance(snapshot, dict):
        for key, time_key in [('configured_state', None), ('desired_state', 'commanded_at'),
                              ('reported_state', 'reported_at'), ('observed_remote_state', 'observed_remote_at')]:
            state = snapshot.get(key)
            if not isinstance(state, dict):
                continue
            raw = state.get('power')
            if raw is None:
                continue
            power = True if raw is True or raw == 1 or str(raw).lower() in ('on', 'true', '1') else (
                False if raw is False or raw == 0 or str(raw).lower() in ('off', 'false', '0') else None)
            stamp = snapshot.get(time_key) if time_key else None
            if key == 'observed_remote_state' and isinstance(snapshot.get('observed_remote_field_at'), dict):
                stamp = snapshot['observed_remote_field_at'].get('power') or stamp
            try:
                timestamp = datetime.fromisoformat(normalize_telemetry_timestamp(stamp)).timestamp() if stamp else 0
            except (ValueError, TypeError, AttributeError):
                timestamp = 0
            if timestamp >= best_time:
                best, best_time = power, timestamp
    if best is not None:
        return best
    explicit = normalize_logged_ac_state(item)
    return bool(explicit) if explicit is not None else None


def serialize_control_snapshot(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError('Control snapshot must be an object')
    return json.dumps(value, separators=(',', ':'))


def normalize_telemetry_timestamp(value):
    # Store comparable UTC timestamps; malformed timestamps are not telemetry.
    logged = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if logged.tzinfo is None:
        logged = logged.replace(tzinfo=timezone.utc)
    return logged.astimezone(timezone.utc).isoformat()


def telemetry_reset_at(conn):
    row = conn.execute('SELECT deleted_through FROM telemetry_local_reset WHERE id=1').fetchone()
    return normalize_telemetry_timestamp(row[0]) if row else None


def reset_local_telemetry():
    # Clear analytics history and persist the boundary against old cloud imports.
    with _telemetry_sync_lock:
        conn = get_db_connection()
        try:
            with conn:
                conn.execute('BEGIN IMMEDIATE')
                cutoff = datetime.now(timezone.utc).isoformat()
                previous = telemetry_reset_at(conn)
                if previous and previous > cutoff:
                    cutoff = previous
                removed = conn.execute('DELETE FROM telemetry').rowcount
                conn.execute('''INSERT INTO telemetry_local_reset (id,deleted_through) VALUES (1,?)
                    ON CONFLICT(id) DO UPDATE SET deleted_through=excluded.deleted_through''', (cutoff,))
                conn.execute('''INSERT INTO cloud_sync_state VALUES ('telemetry',?,'')
                    ON CONFLICT(source) DO UPDATE SET cursor_created=excluded.cursor_created,cursor_id=excluded.cursor_id''', (cutoff,))
            return {'success': True, 'deleted_count': removed, 'reset_at': cutoff}
        finally:
            conn.close()


def import_cloud_telemetry(records, checkpoint=None):
    """Idempotent import of real cloud rows, preserving missing measurements and AC state."""
    conn = get_db_connection()
    inserted = 0
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            cutoff = telemetry_reset_at(conn)
            for item in records:
                if not isinstance(item, dict) or not item.get('id') or not item.get('created'):
                    raise ValueError('Cloud telemetry must have an id and created timestamp')
                created = normalize_telemetry_timestamp(item['created'])
                if cutoff and created <= cutoff:
                    continue
                def measurement(field):
                    value = item.get(field)
                    if value is None:
                        return None
                    value = float(value)
                    if not np.isfinite(value):
                        raise ValueError(f'Invalid cloud measurement: {field}')
                    return value
                cadence = measurement('interval_seconds')
                if cadence is not None and cadence <= 0:
                    raise ValueError('Cloud interval_seconds must be positive')
                node_id = item.get('node_id') or item.get('sensor_name')
                cursor = conn.execute('''INSERT OR IGNORE INTO telemetry (
                    id,node_id,sensor_name,room_name,floor_name,building_name,aircon_type,
                    temperature,battery,rssi,status,created,updated,ac_on,
                    interval_seconds,event_type,wake_time,sleep_time,aircon_id,control_snapshot,ac_state
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                    item['id'], node_id, item.get('sensor_name') or node_id,
                    item.get('room_name') or 'Unassigned', item.get('floor_name') or 'Unassigned',
                    item.get('building_name') or 'Unassigned', item.get('aircon_type'),
                    measurement('temperature'), measurement('battery'),
                    measurement('rssi'), item.get('status') or 'unknown', created, item.get('updated') or created,
                    normalize_logged_ac_state(item), cadence, item.get('event_type'),
                    item.get('wake_time'), item.get('sleep_time'), item.get('aircon_id'),
                    serialize_control_snapshot(item.get('control_snapshot')), item.get('ac_state')))
                inserted += cursor.rowcount
            if checkpoint:
                conn.execute('''INSERT INTO cloud_sync_state VALUES ('telemetry',?,?)
                    ON CONFLICT(source) DO UPDATE SET cursor_created=excluded.cursor_created,cursor_id=excluded.cursor_id''', checkpoint)
        return {'transferred': inserted, 'skipped': len(records) - inserted}
    finally:
        conn.close()


_telemetry_sync_lock = threading.Lock()
_telemetry_sync_stop = threading.Event()
_telemetry_sync_thread = None
_telemetry_sync_status = {'running': False, 'last_success': None, 'error': None, 'transferred': 0}


def sync_cloud_telemetry_once():
    """Copy one page using a durable (created,id) cursor; commit rows and cursor atomically."""
    with _telemetry_sync_lock:
        url = os.getenv('SUPABASE_URL', '').rstrip('/')
        key = os.getenv('SUPABASE_SERVICE_ROLE_KEY') or os.getenv('SUPABASE_ANON_KEY') or os.getenv('SUPABASE_KEY')
        if not url or not key:
            raise ValueError('Supabase telemetry sync credentials are not configured')
        conn = get_db_connection()
        try:
            checkpoint = conn.execute("SELECT * FROM cloud_sync_state WHERE source='telemetry'").fetchone()
            cutoff = telemetry_reset_at(conn)
        finally:
            conn.close()
        params = {'select': '*', 'order': 'created.asc,id.asc', 'limit': '500'}
        if cutoff:
            params['created'] = f'gt.{cutoff}'
        if checkpoint:
            created = checkpoint['cursor_created']
            record_id = checkpoint['cursor_id'].replace('\\', '\\\\').replace('"', '\\"')
            params['or'] = f'(created.gt.{created},and(created.eq.{created},id.gt."{record_id}"))'
        response = requests.get(f'{url}/rest/v1/telemetry', params=params,
            headers={'apikey': key, 'Authorization': f'Bearer {key}'}, timeout=(10, 30))
        response.raise_for_status()
        records = response.json()
        if not isinstance(records, list):
            raise ValueError('Supabase telemetry response must be an array')
        next_checkpoint = (records[-1]['created'], records[-1]['id']) if records else None
        result = import_cloud_telemetry(records, next_checkpoint)
        _telemetry_sync_status.update(last_success=datetime.now(timezone.utc).isoformat(), error=None,
            transferred=_telemetry_sync_status['transferred'] + result['transferred'])
        return {**result, 'fetched': len(records)}


def start_telemetry_sync():
    """Run automatic cloud ingestion independently of an open dashboard page."""
    global _telemetry_sync_thread
    if _telemetry_sync_thread and _telemetry_sync_thread.is_alive():
        return
    if os.getenv('ECOTRACK_TELEMETRY_SYNC', '1').lower() in ('0', 'false'):
        return
    def run():
        failures = 0
        _telemetry_sync_status['running'] = True
        try:
            while not _telemetry_sync_stop.is_set():
                try:
                    result = sync_cloud_telemetry_once()
                    failures = 0
                    wait_seconds = 1 if result['fetched'] == 500 else 15
                except (requests.RequestException, ValueError, TypeError, KeyError, sqlite3.Error) as exc:
                    failures += 1
                    _telemetry_sync_status['error'] = str(exc)
                    wait_seconds = min(300, 15 * (2 ** min(failures - 1, 5)))
                    if failures == 1:
                        print(f'[Telemetry Sync] {exc}')
                _telemetry_sync_stop.wait(wait_seconds)
        finally:
            _telemetry_sync_status['running'] = False
    _telemetry_sync_stop.clear()
    _telemetry_sync_thread = threading.Thread(target=run, name='ecotrack-telemetry-sync', daemon=True)
    _telemetry_sync_thread.start()


atexit.register(_telemetry_sync_stop.set)


class TelemetrySyncResource(Resource):
    def get(self):
        return dict(_telemetry_sync_status), 200


TELEMETRY_FIELDS = {
    'id', 'node_id', 'sensor_name', 'room_name', 'floor_name', 'building_name', 'aircon_type',
    'temperature', 'battery', 'rssi', 'status', 'created', 'updated',
    'event_type', 'interval_seconds', 'wake_time', 'sleep_time', 'ac_on', 'aircon_id',
    'control_snapshot', 'ac_state'
}


def telemetry_measurement(item, field, alias=None):
    value = item.get(field, item.get(alias) if alias else None)
    if value is None:
        return None
    value = float(value)
    if not np.isfinite(value):
        raise ValueError(f'{field} must be finite')
    return value


def compile_telemetry_filter(expression):
    """Translate collection filters to parameterized SQL; reject unsupported syntax."""
    if not expression:
        return '', []
    expression = expression.strip()
    if len(expression) > 4096:
        raise ValueError('Telemetry filter is too long')
    pattern = re.compile(r"""\s*(?:(\|\||&&|\(|\)|>=|<=|!=|=|>|<)|([A-Za-z_]\w*(?:\.\w+)?)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(-?\d+(?:\.\d+)?))""")
    tokens, offset = [], 0
    while offset < len(expression):
        match = pattern.match(expression, offset)
        if not match:
            raise ValueError('Unsupported telemetry filter syntax')
        tokens.append(next((kind, value) for kind, value in enumerate(match.groups()) if value is not None))
        offset = match.end()
    index, parameters = 0, []
    def peek(value):
        return index < len(tokens) and tokens[index][1] == value
    def atom(depth):
        nonlocal index
        if depth > 32:
            raise ValueError('Telemetry filter is too deeply nested')
        if peek('('):
            index += 1
            result = disjunction(depth + 1)
            if not peek(')'):
                raise ValueError('Unbalanced telemetry filter')
            index += 1
            return '(' + result + ')'
        if index + 2 >= len(tokens):
            raise ValueError('Incomplete telemetry filter')
        field, operator, literal = tokens[index:index + 3]
        index += 3
        column = 'sensor_name' if field[1] == 'node_id.name' else field[1]
        if field[0] != 1 or column not in TELEMETRY_FIELDS or operator[1] not in ('=', '!=', '>=', '<=', '>', '<'):
            raise ValueError('Unsupported telemetry filter field or operator')
        if literal[0] == 2:
            value = json.loads(literal[1]) if literal[1][0] == '"' else re.sub(r"\\(.)", r"\1", literal[1][1:-1])
        elif literal[0] == 3:
            value = float(literal[1])
        elif literal[0] == 1 and literal[1].lower() in ('true', 'false', 'null'):
            value = {'true': 1, 'false': 0, 'null': None}[literal[1].lower()]
        else:
            raise ValueError('Telemetry filter values must be quoted strings, numbers, booleans or null')
        sql_operator = {'=': 'IS', '!=': 'IS NOT'}.get(operator[1], operator[1]) if value is None else operator[1]
        parameters.append(value)
        return f'"{column}" {sql_operator} ?'
    def conjunction(depth):
        nonlocal index
        result = atom(depth)
        while peek('&&'):
            index += 1
            result += ' AND ' + atom(depth)
        return result
    def disjunction(depth):
        nonlocal index
        result = conjunction(depth)
        while peek('||'):
            index += 1
            result += ' OR ' + conjunction(depth)
        return result
    result = disjunction(0)
    if index != len(tokens):
        raise ValueError('Unsupported telemetry filter syntax')
    return '(' + result + ')', parameters


class TelemetryListResource(Resource):
    """
    CRUD & Querying for Sensor Data Logs in SQLite3.
    Supports pagination, filtering by node, room, date, and time.
    """
    def get(self):
        try:
            page = int(request.args.get('page', 1))
            per_page = int(request.args.get('perPage', request.args.get('limit', 50)))
            sort = request.args.get('sort', '-created')
            column = sort.lstrip('-')
            if page < 1 or per_page < 0 or column not in TELEMETRY_FIELDS:
                raise ValueError('Invalid telemetry pagination or sort')
            filter_sql, filter_params = compile_telemetry_filter(request.args.get('filter'))
            history = request.args.get('history') == '1'
            cursor = request.args.get('cursor', '')
            if cursor and not re.fullmatch(r'[0-9a-f]{32}:\d+', cursor):
                raise ValueError('Invalid history cursor')
            if history and (per_page != 0 or page != 1 or any(request.args.get(k) for k in
                    ('filter', 'node_id', 'node', 'sensor_name', 'date', 'start_time', 'end_time'))):
                raise ValueError('Incremental history requires an unfiltered complete snapshot')
        except (ValueError, TypeError) as error:
            return {'error': str(error)}, 400
        node_id = request.args.get('node_id', request.args.get('node', None))
        sensor_name = request.args.get('sensor_name', None)
        date_key = request.args.get('date', None)
        start_time = request.args.get('start_time', None)
        end_time = request.args.get('end_time', None)

        query = "SELECT * FROM telemetry WHERE 1=1"
        count_query = "SELECT COUNT(*) FROM telemetry WHERE 1=1"
        params = []
        count_params = []

        if filter_sql:
            query += ' AND ' + filter_sql
            count_query += ' AND ' + filter_sql
            params.extend(filter_params)
            count_params.extend(filter_params)

        if node_id:
            query += " AND (node_id = ? OR sensor_name = ?)"
            count_query += " AND (node_id = ? OR sensor_name = ?)"
            params.extend([node_id, node_id])
            count_params.extend([node_id, node_id])

        if sensor_name:
            query += " AND sensor_name = ?"
            count_query += " AND sensor_name = ?"
            params.append(sensor_name)
            count_params.append(sensor_name)

        if date_key and date_key != 'all':
            query += " AND created LIKE ?"
            count_query += " AND created LIKE ?"
            params.append(f"{date_key}%")
            count_params.append(f"{date_key}%")

        if start_time and end_time:
            # Filter by time substring (HH:MM)
            query += " AND strftime('%H:%M', created) >= ? AND strftime('%H:%M', created) <= ?"
            count_query += " AND strftime('%H:%M', created) >= ? AND strftime('%H:%M', created) <= ?"
            params.extend([start_time, end_time])
            count_params.extend([start_time, end_time])

        direction = 'DESC' if sort.startswith('-') else 'ASC'
        query += f' ORDER BY "{column}" {direction}, id {direction}'

        conn = get_db_connection()
        try:
            conn.execute('BEGIN')  # The rows and cursor must describe the same snapshot.
            generation = conn.execute('SELECT token FROM telemetry_history_generation WHERE id=1').fetchone()[0]
            history_count, last_rowid = conn.execute('SELECT COUNT(*), COALESCE(MAX(rowid),0) FROM telemetry').fetchone()
            history_cursor = f'{generation}:{last_rowid}'
            full_history = True
            if history and cursor:
                token, after = cursor.split(':')
                if token == generation and int(after) <= last_rowid:
                    full_history = False
                    # Insert before ORDER BY to keep the existing indexed sort contract.
                    query = query.replace(' ORDER BY ', ' AND rowid > ? ORDER BY ', 1)
                    params.append(int(after))
            total_items = conn.execute(count_query, count_params).fetchone()[0]

            if per_page > 0:
                offset = (page - 1) * per_page
                query += " LIMIT ? OFFSET ?"
                params.extend([per_page, offset])

            rows = conn.execute(query, params).fetchall()
            items = [row_to_dict(r) for r in rows]

            total_pages = 1 if per_page == 0 else max(1, (total_items + per_page - 1) // per_page)

            return {
                "items": items,
                "totalItems": total_items,
                "history_total": history_count,
                "history_cursor": history_cursor,
                "history_revision": f'{history_cursor}:{history_count}',
                "history_full": full_history,
                "reset_at": telemetry_reset_at(conn),
                "page": page,
                "perPage": per_page,
                "totalPages": total_pages
            }, 200
        except Exception as e:
            return {"error": str(e)}, 500
        finally:
            conn.close()

    def post(self):
        """Insert single or multiple telemetry sensor logs into SQLite3."""
        payload = request.get_json(silent=True)
        if not isinstance(payload, (dict, list)) or not payload:
            return {'error': 'Telemetry payload must contain a record or records'}, 400
        if isinstance(payload, list):
            items_to_insert = payload
        else:
            items_to_insert = [payload]

        now_iso = datetime.now(timezone.utc).isoformat()
        inserted_items = []
        skipped_items = 0

        conn = get_db_connection()
        try:
            with conn:
                conn.execute('BEGIN IMMEDIATE')
                cutoff = telemetry_reset_at(conn)
                for item in items_to_insert:
                    if not isinstance(item, dict) or not item:
                        raise ValueError('Each telemetry record must be an object')
                    record_id = item.get('id') or f"telem_{uuid.uuid4().hex[:12]}"
                    node_id = item.get('node_id') or item.get('sensor_name')
                    if not node_id:
                        raise ValueError('Telemetry must identify a node')
                    sensor_name = item.get('sensor_name') or item.get('name') or node_id
                    room_name = item.get('room_name') or 'Unassigned'
                    floor_name = item.get('floor_name') or 'Unassigned'
                    building_name = item.get('building_name') or 'Unassigned'
                    aircon_type = item.get('aircon_type')
                    temperature = telemetry_measurement(item, 'temperature', 'temp')
                    battery = telemetry_measurement(item, 'battery')
                    rssi = telemetry_measurement(item, 'rssi')
                    status = item.get('status') or 'unknown'
                    created = normalize_telemetry_timestamp(item.get('created') or now_iso)
                    if cutoff and created <= cutoff:
                        raise ValueError('Telemetry timestamp is at or before the analytics reset')
                    updated = normalize_telemetry_timestamp(item.get('updated') or now_iso)
                    ac_on = normalize_logged_ac_state(item)
                    try:
                        interval_seconds = float(item.get('interval_seconds'))
                        if not np.isfinite(interval_seconds) or interval_seconds <= 0:
                            interval_seconds = None
                    except (ValueError, TypeError):
                        interval_seconds = None

                    existing = conn.execute('SELECT * FROM telemetry WHERE id=?', (record_id,)).fetchone()
                    if existing is not None:
                        inserted_items.append(row_to_dict(existing))
                        continue
                    # Preserve received OFF/unknown samples as evidence, just like cloud
                    # imports. Only the runtime calculation decides which intervals are
                    # confirmed ON; selected controls must never discard an OFF boundary.

                    conn.execute("""
                        INSERT OR IGNORE INTO telemetry (
                            id, node_id, sensor_name, room_name, floor_name, building_name,
                            aircon_type, temperature, battery, rssi, status, created, updated,
                            ac_on, interval_seconds, aircon_id, control_snapshot, ac_state,
                            event_type, wake_time, sleep_time
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        record_id, node_id, sensor_name, room_name, floor_name, building_name,
                        aircon_type, temperature, battery, rssi, status, created, updated,
                        ac_on, interval_seconds, item.get("aircon_id"), serialize_control_snapshot(item.get("control_snapshot")), item.get("ac_state"),
                        item.get('event_type'), item.get('wake_time'), item.get('sleep_time')
                    ))

                    inserted_items.append({
                        "id": record_id,
                        "node_id": node_id,
                        "sensor_name": sensor_name,
                        "room_name": room_name,
                        "floor_name": floor_name,
                        "building_name": building_name,
                        "aircon_type": aircon_type,
                        "temperature": temperature,
                        "battery": battery,
                        "rssi": rssi,
                        "status": status,
                        "created": created,
                        "updated": updated,
                        "ac_on": ac_on,
                        "interval_seconds": interval_seconds,
                        "aircon_id": item.get("aircon_id"),
                        "control_snapshot": json.loads(serialize_control_snapshot(item.get("control_snapshot"))) if item.get("control_snapshot") is not None else None,
                        "ac_state": item.get("ac_state")
                    })

            inserted_items = [row_to_dict(conn.execute("SELECT * FROM telemetry WHERE id=?", (item["id"],)).fetchone()) for item in inserted_items]
            if len(inserted_items) == 1 and not isinstance(payload, list):
                return inserted_items[0], 201
            return {"items": inserted_items, "count": len(inserted_items), "skipped": skipped_items}, (201 if inserted_items else 200)
        except (ValueError, TypeError) as e:
            return {'error': str(e)}, 400
        except Exception as e:
            return {"error": str(e)}, 500
        finally:
            conn.close()

    def delete(self):
        """Clear all or filtered telemetry sensor logs."""
        node_id = request.args.get('node_id')
        if not node_id:
            try:
                return reset_local_telemetry(), 200
            except Exception as error:
                return {'error': str(error)}, 500
        conn = get_db_connection()
        try:
            with conn:
                if node_id:
                    conn.execute("DELETE FROM telemetry WHERE node_id = ? OR sensor_name = ?", (node_id, node_id))
                else:
                    conn.execute("DELETE FROM telemetry")
            return {"success": True}, 200
        except Exception as e:
            return {"error": str(e)}, 500
        finally:
            conn.close()


class TelemetryItemResource(Resource):
    """Retrieve, update, or delete a single sensor log record by ID."""
    def get(self, item_id):
        conn = get_db_connection()
        try:
            row = conn.execute("SELECT * FROM telemetry WHERE id = ?", (item_id,)).fetchone()
            if not row:
                return {"error": f"Record {item_id} not found"}, 404
            return row_to_dict(row), 200
        finally:
            conn.close()

    def patch(self, item_id):
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict) or not payload:
            return {'error': 'Telemetry update must be a non-empty object'}, 400
        if payload.get('id', item_id) != item_id or set(payload) - TELEMETRY_FIELDS:
            return {'error': 'Unsupported telemetry update field or id'}, 400
        values = {key: value for key, value in payload.items() if key != 'id'}
        if not values:
            return {'error': 'No telemetry fields supplied'}, 400
        try:
            for field in ('temperature', 'battery', 'rssi', 'interval_seconds'):
                if field in values:
                    values[field] = telemetry_measurement(values, field)
            if values.get('interval_seconds') is not None and values['interval_seconds'] <= 0:
                raise ValueError('interval_seconds must be positive')
            if 'control_snapshot' in values:
                values['control_snapshot'] = serialize_control_snapshot(values['control_snapshot'])
            if 'ac_on' in values:
                values['ac_on'] = normalize_logged_ac_state(values)
            for field, value in values.items():
                if field not in ('temperature', 'battery', 'rssi', 'interval_seconds', 'ac_on', 'control_snapshot') and value is not None and not isinstance(value, str):
                    raise ValueError(f'{field} must be text or null')
            values['updated'] = datetime.now(timezone.utc).isoformat()
        except (ValueError, TypeError) as error:
            return {'error': str(error)}, 400
        conn = get_db_connection()
        try:
            with conn:
                columns = ', '.join(f'"{field}"=?' for field in values)
                result = conn.execute(f'UPDATE telemetry SET {columns} WHERE id=?', [*values.values(), item_id])
                if not result.rowcount:
                    return {'error': 'Telemetry record not found'}, 404
            return row_to_dict(conn.execute('SELECT * FROM telemetry WHERE id=?', (item_id,)).fetchone()), 200
        finally:
            conn.close()

    def delete(self, item_id):
        conn = get_db_connection()
        try:
            with conn:
                conn.execute("DELETE FROM telemetry WHERE id = ?", (item_id,))
            return {"success": True}, 200
        finally:
            conn.close()


class TelemetryTransferResource(Resource):
    """
    Bulk transfer endpoint to ingest records from Supabase into SQLite3.
    """
    def post(self):
        data = request.get_json() or {}
        records = data.get('records', []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
        if not records:
            return {"transferred": 0, "skipped": 0, "message": "No records provided"}, 200

        try:
            result = import_cloud_telemetry(records)
            conn = get_db_connection()
            try:
                total = conn.execute('SELECT COUNT(*) FROM telemetry').fetchone()[0]
            finally:
                conn.close()
            return {'success': True, **result, 'total_in_db': total}, 200
        except (ValueError, TypeError) as e:
            return {'error': str(e)}, 400
        except Exception as e:
            return {"error": str(e)}, 500


class HistoricalResource(Resource):
    """Returns historical time-series telemetry data for charts."""
    def get(self):
        conn = get_db_connection()
        try:
            rows = conn.execute("SELECT temperature, created FROM telemetry WHERE temperature IS NOT NULL ORDER BY created ASC LIMIT 500").fetchall()
            return {
                "temperatures": [float(r['temperature']) for r in rows],
                "pressures": [],  # Legacy chart contract; pressure is no longer stored.
                "timestamps": [r['created'] for r in rows]
            }, 200
        finally:
            conn.close()


def lookup_schedule_node(node_id):
    """Resolve a real controller IP using the configured Supabase registry."""
    url = os.getenv('SUPABASE_URL', '').rstrip('/')
    key = os.getenv('SUPABASE_SERVICE_ROLE_KEY') or os.getenv('SUPABASE_ANON_KEY') or os.getenv('SUPABASE_KEY')
    if not url or not key:
        return None
    headers = {'apikey': key, 'Authorization': f'Bearer {key}'}
    for field in ('name', 'id'):
        response = requests.get(f'{url}/rest/v1/nodes', headers=headers,
                                params={'select': '*', field: f'eq.{node_id}', 'limit': '1'}, timeout=(2, 4))
        response.raise_for_status()
        records = response.json()
        if records:
            return records[0]
    return None


def forward_schedule_interval(job_id, node_id, interval_seconds, supplied_ip=None, wake_time=None, sleep_time=None):
    """Background HTTP dispatch; cloud polling remains available when IP is unknown."""
    status, error, device_ip = 'pending_ip', None, supplied_ip
    try:
        if not device_ip:
            node = lookup_schedule_node(node_id)
            device_ip = node.get('ip_address') if node else None
        if device_ip:
            address = ip_address(device_ip)
            host = f'[{address}]' if address.version == 6 else str(address)
            schedule = {'interval_seconds': interval_seconds}
            if wake_time is not None and sleep_time is not None:
                schedule.update(wake_time=wake_time, sleep_time=sleep_time)
            response = requests.post(f'http://{host}/set-interval', json=schedule,
                                     timeout=(2, 4), allow_redirects=False)
            response.raise_for_status()
            acknowledgement = response.json()
            if acknowledgement.get('success') is not True or acknowledgement.get('interval_ms') != interval_seconds * 1000:
                raise ValueError('Controller did not acknowledge the requested interval')
            status = 'sent'
    except (requests.RequestException, ValueError) as exc:
        status, error = 'failed', str(exc)
    conn = get_db_connection()
    try:
        with conn:
            conn.execute('UPDATE schedule_dispatches SET status=?, error=?, ip=?, updated=? WHERE id=?',
                         (status, error, device_ip, datetime.now(timezone.utc).isoformat(), job_id))
    finally:
        conn.close()
    print(f'[Hardware Schedule] Node {node_id}: {status}' + (f' ({error})' if error else ''))


class SetSleepScheduleResource(Resource):
    """
    Queue hardware sleep interval & wake schedule synchronization for an AC controller node.
    """
    def post(self):
        data = request.get_json(force=True, silent=True) or request.form.to_dict() or {}
        node_id = data.get('node_id') or data.get('node')
        sleep_seconds = data.get('sleep_seconds') or data.get('sleep_duration') or 900
        wake_time = data.get('wake_time') or '06:00'
        sleep_time = data.get('sleep_time') or '22:00'
        if not node_id:
            return {"error": "node_id is required"}, 400
        try:
            raw_interval = data.get('sleep_seconds', data.get('sleep_duration', 900))
            if isinstance(raw_interval, bool):
                raise ValueError('sleep_seconds must be numeric')
            interval = float(raw_interval)
            if not np.isfinite(interval) or not interval.is_integer() or not 1 <= interval <= 4294967:
                raise ValueError('sleep_seconds must be a whole number between 1 and 4294967')
            sleep_seconds = int(interval)
            device_ip = data.get('ip') or data.get('ip_address')
            if device_ip:
                device_ip = str(ip_address(device_ip))
            if not isinstance(node_id, str) or not node_id.strip():
                raise ValueError('node_id must be a nonempty string')
            if not all(isinstance(clock, str) and re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', clock)
                       for clock in (wake_time, sleep_time)):
                raise ValueError('wake_time and sleep_time must use HH:MM')
        except (ValueError, TypeError) as exc:
            return {'error': str(exc)}, 400

        now = datetime.now(timezone.utc).isoformat()
        job_id = f'schedule_{uuid.uuid4().hex[:12]}'
        baseline_id = f'telem_{uuid.uuid4().hex[:12]}'
        snapshot = data.get('node_snapshot', {})
        if not isinstance(snapshot, dict):
            return {'error': 'node_snapshot must be an object'}, 400
        conn = get_db_connection()
        try:
            latest = conn.execute('SELECT * FROM telemetry WHERE (node_id=? OR sensor_name=?) AND status != ? ORDER BY created DESC LIMIT 1',
                                  (node_id, node_id, 'schedule')).fetchone()
            baseline = {**(dict(latest) if latest else {}), **snapshot}
            with conn:
                conn.execute('''INSERT INTO telemetry (
                    id, node_id, sensor_name, room_name, floor_name, building_name, aircon_type,
                    temperature, battery, rssi, status, created, updated,
                    event_type, interval_seconds, wake_time, sleep_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', (
                    baseline_id, baseline.get('node_id') or node_id, baseline.get('sensor_name') or node_id,
                    baseline.get('room_name') or 'Unassigned', baseline.get('floor_name') or 'Unassigned',
                    baseline.get('building_name') or 'Unassigned', baseline.get('aircon_type'),
                    baseline.get('temperature'), baseline.get('battery'), baseline.get('rssi'),
                    'schedule', now, now, 'schedule_updated', sleep_seconds, wake_time, sleep_time))
                conn.execute('INSERT INTO schedule_dispatches (id, node_id, ip, interval_seconds, status, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
                             (job_id, node_id, device_ip, sleep_seconds, 'queued', now, now))
        finally:
            conn.close()
        _schedule_executor.submit(forward_schedule_interval, job_id, node_id, sleep_seconds, device_ip, wake_time, sleep_time)

        return {
            "success": True,
            "node_id": node_id,
            "sleep_seconds": int(sleep_seconds),
            "wake_time": wake_time,
            "sleep_time": sleep_time,
            "queued_at": now,
            "job_id": job_id,
            "telemetry_id": baseline_id,
            "delivery_status": "queued",
            "message": f"Schedule recorded; {sleep_seconds}s interval forwarding queued for node {node_id}"
        }, 202

    def get(self):
        conn = get_db_connection()
        try:
            job = conn.execute('SELECT * FROM schedule_dispatches WHERE id=?', (request.args.get('job_id'),)).fetchone()
            return (dict(job), 200) if job else ({'error': 'Schedule dispatch not found'}, 404)
        finally:
            conn.close()


class WifiScanResource(Resource):
    """Scans and returns live nearby 2.4 GHz Wi-Fi networks via Windows netsh and wlanapi."""
    def get(self):
        if sys.platform != 'win32':
            return {"success": False, "networks": [], "error": "Only supported on Windows"}, 400
        try:
            # Trigger hardware scan if script available
            script_path = os.path.join(os.path.dirname(__file__), '..', 'scripts', 'wlan_scan.ps1')
            if os.path.exists(script_path):
                try:
                    subprocess.run(
                        ["powershell", "-ExecutionPolicy", "Bypass", "-File", script_path],
                        capture_output=True,
                        timeout=3
                    )
                except Exception:
                    pass

            output = subprocess.check_output(
                ["netsh", "wlan", "show", "networks", "mode=bssid"],
                stderr=subprocess.STDOUT,
                text=True,
                encoding='cp437',
                timeout=8
            )
            blocks = re.split(r'^\s*SSID \d+\s*:', output, flags=re.MULTILINE)
            blocks.pop(0)
            networks = []
            for b in blocks:
                lines = [l.strip() for l in b.splitlines()]
                ssid = lines[0] if lines else ''
                if not ssid:
                    continue
                auth = 'WPA2-Personal'
                for l in lines:
                    if l.lower().startswith(('authentication', 'autenticaci')):
                        auth = l.split(':', 1)[1].strip()
                        break
                bssid_blocks = re.split(r'^\s*BSSID \d+\s*:', b, flags=re.MULTILINE)
                bssid_blocks.pop(0)
                best_sig = -1
                best_ch = 6
                has_24 = False
                for bb in bssid_blocks:
                    blines = [x.strip() for x in bb.splitlines()]
                    def get_v(prefix):
                        for x in blines:
                            if x.lower().startswith(prefix.lower()):
                                return x.split(':', 1)[1].strip()
                        return ''
                    sig_str = get_v('signal').replace('%', '')
                    ch_str = get_v('channel')
                    try:
                        sig = int(sig_str)
                    except:
                        sig = 0
                    try:
                        ch = int(ch_str)
                    except:
                        ch = 0
                    if ch <= 14:
                        has_24 = True
                        if sig > best_sig:
                            best_sig = sig
                            best_ch = ch
                if not has_24 or best_sig < 0:
                    continue
                rssi = round(-100 + best_sig * 0.65)
                networks.append({
                    "ssid": ssid,
                    "rssi": rssi,
                    "quality": best_sig,
                    "channel": best_ch,
                    "security": auth,
                    "is24Ghz": True,
                    "isRecommended": False
                })
            networks.sort(key=lambda x: x["quality"], reverse=True)
            if networks:
                networks[0]["isRecommended"] = True
            return {"success": True, "networks": networks}, 200
        except Exception as e:
            return {"success": False, "networks": [], "error": str(e)}, 500


class BleScanResource(Resource):
    """Scans and returns nearby real Bluetooth LE devices using native WinRT BLE advertisement watcher."""
    def get(self):
        devices = []
        scanner_exe = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "ble_scanner.exe")
        if sys.platform == 'win32' and os.path.exists(scanner_exe):
            try:
                out = subprocess.check_output([scanner_exe, "3"], text=True, timeout=6)
                if out.strip():
                    import json
                    raw_list = json.loads(out.strip())
                    for item in raw_list:
                        name = item.get("name", "Unknown device")
                        mac = item.get("mac", "")
                        rssi = item.get("rssi", -60)
                        match = re.search(r'node[-_]?([a-zA-Z0-9]+)', name, re.I)
                        if match:
                            node_id = f"node-{match.group(1).lower()}"
                        elif mac:
                            node_id = f"node-{mac[-5:].replace(':', '').lower()}"
                        else:
                            node_id = "node-1"

                        devices.append({
                            "id": name,
                            "nodeId": node_id,
                            "mac": mac,
                            "rssi": rssi,
                            "status": "Ready to pair",
                            "isHardware": True
                        })
            except Exception as e:
                print(f"[BLE] Native scanner error: {e}")

        # Sort so named / EcoTrack devices appear first, followed by signal strength
        devices.sort(key=lambda d: (
            0 if 'ecotrack' in d['id'].lower() else (1 if 'esp' in d['id'].lower() else (2 if d['id'] != 'Unknown device' else 3)),
            -d['rssi']
        ))

        return {"success": True, "devices": devices}, 200


# Register Endpoints
api.add_resource(HealthResource, '/api/health')
api.add_resource(EnergyPredictionResource, '/api/predict-energy')
api.add_resource(RecordedEnergyPredictionResource, '/api/predict-recorded-energy')
api.add_resource(PredictionFeaturesResource, '/api/prediction-features')
api.add_resource(PredictionMetricsResource, '/api/prediction-metrics')
api.add_resource(TelemetryListResource, '/api/telemetry')
api.add_resource(TelemetryItemResource, '/api/telemetry/<string:item_id>')
api.add_resource(TelemetryTransferResource, '/api/telemetry/transfer')
api.add_resource(TelemetrySyncResource, '/api/telemetry/sync')
api.add_resource(HistoricalResource, '/api/historical')
api.add_resource(SetSleepScheduleResource, '/api/set-sleep')
api.add_resource(WifiScanResource, '/api/wifi/scan')
api.add_resource(BleScanResource, '/api/ble/scan')


# ===== ENTRY POINT =====
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', 'False').lower() in ('true', '1')

    print(f"[*] EcoTrack Microservice starting on port {port}")
    print(f"[*] SQLite3 Database : {SQLITE_DB_PATH}")
    print(f"[*] ML model         : {EnergyPredictor.MODEL_ID} (research estimates)")
    print(f"[*] Telemetry API    : http://localhost:{port}/api/telemetry")
    print(f"[*] Prediction API   : http://localhost:{port}/api/predict-energy")

    if not debug or os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        start_telemetry_sync()
        monitoring_service.start_sync()
    app.run(host='0.0.0.0', port=port, debug=debug)
