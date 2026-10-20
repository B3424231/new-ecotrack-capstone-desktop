"""Real trained model and isolated Flask API; never touch the live telemetry DB."""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

SOURCE = Path(os.environ.get('ECOTRACK_SOURCE_ROOT', Path(__file__).resolve().parents[1]))
ROOT = Path(os.environ.get('ECOTRACK_DESKTOP_ROOT', SOURCE))
MODEL = SOURCE / 'backend/ml/control_only_hist_gradient_boosting'
sys.path.insert(0, str(ROOT))
sandbox = tempfile.TemporaryDirectory(prefix='ecotrack-recorded-model-')
os.environ['ECOTRACK_SQLITE_DB_PATH'] = str(Path(sandbox.name) / 'telemetry.db')
os.environ['ECOTRACK_TELEMETRY_SYNC'] = '0'
os.environ['ECOTRACK_SQLITE_SCHEMA_BACKUP_DIR'] = sandbox.name
spec = importlib.util.spec_from_file_location('backend.energy_prediction', SOURCE / 'backend/energy_prediction.py')
energy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = energy
spec.loader.exec_module(energy)
spec = importlib.util.spec_from_file_location('recorded_columns_backend', SOURCE / 'backend/app.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
EnergyPredictor = energy.EnergyPredictor
backend.energy_predictor = EnergyPredictor(MODEL)
SETTINGS = {'temp': 21, 'mode': 'auto', 'fan': 'auto', 'eco': False, 'turbo': False,
            'swing_vertical': False, 'swing_horizontal': False, 'display': True}


class RecordedColumnsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in MODEL.iterdir() if p.is_file()}

    @classmethod
    def tearDownClass(cls):
        assert cls.hashes == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in MODEL.iterdir() if p.is_file()}

    def setUp(self):
        self.api = backend.app.test_client()

    def post(self, settings=None, **extra):
        with patch.object(backend.requests, 'get', side_effect=AssertionError('Unexpected network')), \
             patch.object(backend.requests, 'post', side_effect=AssertionError('Unexpected network')):
            return self.api.post('/api/predict-recorded-energy', json={
                'model': 'hist_gradient_boosting', 'settings': dict(SETTINGS if settings is None else settings), **extra})

    def test_screenshot_columns_predict_without_environment_or_quiet(self):
        response = self.post()
        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()
        self.assertEqual(result['prediction_basis'], 'control_settings_only')
        self.assertEqual(result['unrecorded_functions'], ['quiet'])
        self.assertNotIn('quiet', result['settings'])
        self.assertEqual(result['settings']['setpoint_c'], 21)
        self.assertFalse(result['settings']['eco'])
        self.assertIsNone(result['measured_energy_kwh'])
        self.assertIsNone(result['physically_confirmed_ac_on'])
        self.assertFalse(result['physical_accuracy_validated'])
        self.assertGreater(result['kwh'], 0)

    def test_average_and_envelope_equal_the_existing_model_predictions(self):
        model = backend.energy_predictor
        result = model.predict_recorded({'settings': SETTINGS})
        normalized = result['settings']
        columns = {name: index for index, name in enumerate(energy.CONTROLS)}
        matches = [row for row in model._support if all(row[columns[name]] == value for name, value in normalized.items())]
        values = [model.predict({'settings': {
            name: bool(value) if name in energy.FLAGS else value
            for name, value in zip(energy.CONTROLS, row)}})['kwh'] for row in matches]
        self.assertAlmostEqual(result['kwh'], math.fsum(values) / len(values), places=12)
        self.assertAlmostEqual(result['reference_range_kwh']['min'], min(values), places=12)
        self.assertAlmostEqual(result['reference_range_kwh']['max'], max(values), places=12)
        self.assertEqual(result['reference_variant_count'], len(values))

    def test_explicit_recorded_flags_are_fixed_and_only_missing_flags_are_averaged(self):
        original = {'temp': 24, 'mode': 'cool', 'fan': 'high', 'turbo': True, 'quiet': False,
                    'eco': False, 'swing_vertical': False, 'swing_horizontal': False, 'display': True}
        before = json.dumps(original, sort_keys=True)
        result = self.post(original).get_json()
        self.assertEqual(result['unrecorded_functions'], [])
        self.assertTrue(result['settings']['turbo'])
        self.assertFalse(result['settings']['quiet'])
        self.assertEqual(json.dumps(original, sort_keys=True), before)

    def test_missing_special_flags_remain_unknown_and_are_disclosed(self):
        result = self.post({'temp': 24, 'mode': 'cool', 'fan': 'high'}).get_json()
        self.assertEqual(set(result['unrecorded_functions']), set(energy.FLAGS))
        self.assertEqual(set(result['settings']), {'setpoint_c', 'fan_command', 'operating_mode'})
        self.assertGreater(result['reference_variant_count'], result['reference_condition_count'])

    def test_invalid_or_missing_core_columns_are_rejected(self):
        for change in ({'temp': True}, {'temp': 21.5}, {'temp': None}, {'temp': 31},
                       {'fan': 'invalid'}, {'mode': 'invalid'}, {'eco': None},
                       {'quiet': True}, {'turbo': True}, {'filter': True}):
            with self.subTest(change=change):
                response = self.post({**SETTINGS, **change})
                self.assertIn(response.status_code, [400, 422])
                self.assertNotIn('kwh', response.get_json())
        self.assertEqual(self.post({'mode': 'auto', 'fan': 'auto'}).status_code, 400)

    def test_strict_control_contract_and_legacy_scenario_compatibility(self):
        response = self.api.post('/api/predict-energy', json={'settings': SETTINGS})
        self.assertEqual(response.status_code, 400)
        self.assertIn('quiet', response.get_json()['error'])
        full = {**SETTINGS, 'quiet': False}
        response = self.api.post('/api/predict-energy', json={'settings': full, 'scenario_id': 'lab_hot'})
        self.assertEqual(response.status_code, 200)
        baseline = self.api.post('/api/predict-energy', json={'settings': full})
        self.assertEqual(baseline.status_code, 200)
        self.assertEqual(response.get_json()['kwh'], baseline.get_json()['kwh'])
        self.assertEqual(response.get_json()['ignored_parameters'], ['scenario_id'])
        self.assertNotIn('environment', response.get_json())

    def test_extra_request_fields_and_wrong_models_are_not_ignored(self):
        self.assertEqual(self.post(scenario_id='lab_hot').status_code, 400)
        self.assertEqual(self.api.post('/api/predict-recorded-energy', json={
            'model': 'retired', 'settings': SETTINGS}).status_code, 404)
        self.assertEqual(self.api.post('/api/predict-recorded-energy', json=None).status_code, 400)

    def test_prediction_does_not_write_telemetry(self):
        with closing(backend.get_db_connection()) as connection:
            connection.execute("INSERT INTO telemetry(id,node_id,created,temperature,ac_on) VALUES(?,?,?,?,?)",
                               ('isolated-fixture', 'fixture', '2026-10-18T06:00:00Z', None, None))
            connection.commit()
            before = [tuple(row) for row in connection.execute('SELECT * FROM telemetry')]
        self.assertEqual(self.post().status_code, 200)
        with closing(backend.get_db_connection()) as connection:
            self.assertEqual([tuple(row) for row in connection.execute('SELECT * FROM telemetry')], before)

    def test_nonfinite_predictions_never_become_a_zero_or_cached_result(self):
        model = EnergyPredictor(MODEL)
        model._load()
        with patch.object(model._bundle['model'], 'predict', return_value=[float('nan')]):
            with self.assertRaises(energy.PredictionError) as caught:
                model.predict_recorded({'settings': SETTINGS})
            self.assertEqual(caught.exception.status, 503)
        self.assertEqual(model._recorded_cache, {})


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        backend._schedule_executor.shutdown(wait=False)
        sandbox.cleanup()
