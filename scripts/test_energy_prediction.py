"""Exercise the real forecast API/model with an isolated DB and no network."""
import csv
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ.get('ECOTRACK_SOURCE_ROOT', Path(__file__).resolve().parents[1]))
ROOT = Path(os.environ.get('ECOTRACK_DESKTOP_ROOT', SOURCE))
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('backend.energy_prediction', SOURCE / 'backend/energy_prediction.py')
energy = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = energy
spec.loader.exec_module(energy)
sandbox = tempfile.TemporaryDirectory(prefix="ecotrack-prediction-test-")
os.environ["ECOTRACK_SQLITE_DB_PATH"] = str(Path(sandbox.name) / "telemetry.db")
os.environ["ECOTRACK_TELEMETRY_SYNC"] = "0"
spec = importlib.util.spec_from_file_location("energy_test_backend", SOURCE / "backend/app.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
from backend.energy_prediction import EnergyPredictor, PredictionError

MODEL = SOURCE / "backend/ml/control_only_hist_gradient_boosting"
REPORTS = SOURCE / "reports/control-only-hist-gradient-boosting/artifacts"
backend.energy_predictor = EnergyPredictor(MODEL)


class EnergyPredictionTests(unittest.TestCase):
    def setUp(self):
        self.api = backend.app.test_client()
        self.payload = {
            "model": "hist_gradient_boosting",
            "settings": {"setpoint_c": 24, "fan_command": "medium", "operating_mode": "cool",
                         "eco": False, "turbo": False, "swing": True, "quiet": False,
                         "horizontal_swing": False, "display": True}}

    def post(self, payload=None):
        return self.api.post("/api/predict-energy", json=self.payload if payload is None else payload)

    def test_health_advertises_only_the_ready_hist_gradient_boosting(self):
        data = self.api.get("/api/health").get_json()
        self.assertEqual(data["models_available"], ["hist_gradient_boosting"])
        self.assertEqual(data["energy_prediction_models"], ["hist_gradient_boosting"])
        self.assertFalse(data["physical_accuracy_validated"])
        self.assertEqual(data["prediction_status"], "research_estimate_ready")
        self.assertEqual(data["model"], "hist_gradient_boosting")
        self.assertEqual(data["algorithm"], "HistGradientBoostingRegressor")

    def test_a_random_forest_pipeline_cannot_be_labeled_as_histogram(self):
        bundle = energy.joblib.load(MODEL / 'model.joblib')
        bundle['model'] = energy.joblib.load(ROOT / 'backend/ml/control_only_random_forest/model.joblib')['model']
        with patch('backend.energy_prediction.joblib.load', return_value=bundle):
            with self.assertRaises(PredictionError) as caught:
                EnergyPredictor(MODEL).predict(self.payload)
        self.assertEqual(caught.exception.code, 'MODEL_UNAVAILABLE')
        self.assertEqual(caught.exception.status, 503)

    def test_features_expose_only_nine_controls(self):
        response = self.api.get("/api/prediction-features")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["n_features"], 9)
        self.assertEqual(data["input_scope"], "controls_only")
        self.assertEqual(data["features"], energy.CONTROLS)
        self.assertIn("fan_command", data["features"])
        self.assertIn("horizontal_swing", data["features"])
        self.assertEqual(data["environment_scenarios"], [])
        self.assertEqual(data["required_request_fields"], ["settings"])
        self.assertIn("filter", data["unsupported_model_functions"])

    def test_real_model_forecast_has_explicit_estimate_provenance(self):
        response = self.post()
        self.assertEqual(response.status_code, 200, response.get_json())
        data = response.get_json()
        self.assertEqual(data["model"], "hist_gradient_boosting")
        self.assertEqual(data["output_unit"], "kWh")
        self.assertEqual(data["horizon_hours"], 1)
        self.assertGreaterEqual(data["kwh"], 0)
        self.assertEqual(data["kwh"], data["estimated_energy_kwh"])
        self.assertEqual(data["environment_source"], "not_used")
        self.assertIsNone(data["measured_energy_kwh"])
        self.assertIsNone(data["physically_confirmed_ac_on"])
        self.assertFalse(data["physical_accuracy_validated"])

    def test_complete_controls_have_one_variant_and_no_environment(self):
        data = self.post().get_json()
        self.assertEqual(data['reference_variant_count'], 1)
        self.assertEqual(data['reference_condition_count'], 0)
        self.assertEqual(data['reference_range_kwh']['min'], data['kwh'])
        self.assertEqual(data['reference_range_kwh']['max'], data['kwh'])
        self.assertNotIn('environment', data)
        self.assertNotIn('scenario_id', data)

    def test_metrics_match_saved_generated_test_targets(self):
        response = self.api.get("/api/prediction-metrics")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        with (REPORTS / "held_out_predictions.csv").open(encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream))
        errors = [float(r["hist_gradient_boosting_estimated_kwh"]) - float(r["generated_target_kwh"]) for r in rows]
        self.assertEqual(len(rows), 3712)
        self.assertAlmostEqual(data["metrics"]["mae"], sum(abs(e) for e in errors) / len(errors), places=10)
        self.assertAlmostEqual(data["metrics"]["mse"], sum(e * e for e in errors) / len(errors), places=10)
        self.assertEqual(data["evaluation_kind"], "held_out_generated_formula_targets")
        self.assertEqual(data["measured_validation_hours"], 0)
        self.assertFalse(data["physical_accuracy_validated"])

    def test_saved_histogram_predictions_replay_through_the_api(self):
        with (REPORTS / 'held_out_predictions.csv').open(encoding='utf-8', newline='') as stream:
            expected = list(csv.DictReader(stream))
        with (SOURCE / 'reports/control-only-hist-gradient-boosting/artifacts/control_test_inputs.csv').open(encoding='utf-8', newline='') as stream:
            controls = {row['record_id']: row for row in csv.DictReader(stream)}
        for row in expected[::160] + expected[-1:]:
            original = controls[row['record_id']]
            settings = {name: (bool(int(float(original[name]))) if name in energy.FLAGS else original[name])
                        for name in energy.CONTROLS}
            response = self.post({'model': 'hist_gradient_boosting', 'settings': settings})
            self.assertEqual(response.status_code, 200, response.get_json())
            self.assertAlmostEqual(response.get_json()['kwh'], float(row['hist_gradient_boosting_estimated_kwh']), places=12)

    def test_retired_models_are_rejected_explicitly(self):
        for name in ("random_forest", "xgboost", "decision_tree"):
            with self.subTest(model=name):
                self.assertEqual(self.api.get("/api/prediction-metrics?model=" + name).status_code, 404)
                self.assertEqual(self.api.get("/api/prediction-features?model=" + name).status_code, 404)
                response = self.post({**self.payload, "model": name})
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.get_json()["error_code"], "MODEL_NOT_AVAILABLE")

    def test_old_runtime_payload_cannot_be_converted_to_missing_features(self):
        response = self.post({"model": "hist_gradient_boosting", "avg_temp": 25, "hours_used": 3,
                              "ac_on_ratio": 1, "period": "daily"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("settings", response.get_json()["error"])
        self.assertNotIn("kwh", response.get_json())

    def test_each_missing_or_unknown_flag_is_not_assumed_off(self):
        for name in ("eco", "turbo", "swing", "quiet", "horizontal_swing", "display"):
            with self.subTest(field=name):
                controls = dict(self.payload["settings"])
                del controls[name]
                self.assertEqual(self.post({**self.payload, "settings": controls}).status_code, 400)
                controls[name] = None
                self.assertEqual(self.post({**self.payload, "settings": controls}).status_code, 400)

    def test_sensor_inputs_are_rejected_and_legacy_scenarios_cannot_affect_controls(self):
        baseline = self.post().get_json()['kwh']
        for scenario in ('lab_hot', 'imaginary_weather', {}):
            result = self.post({**self.payload, 'scenario_id': scenario}).get_json()
            self.assertEqual(result['kwh'], baseline)
            self.assertEqual(result['ignored_parameters'], ['scenario_id'])
            self.assertNotIn('environment', result)
        for field in ('indoor_c', 'outdoor_c', 'relative_humidity_percent'):
            response = self.post({**self.payload, 'settings': {**self.payload['settings'], field: 25}})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn('kwh', response.get_json())

    def test_invalid_values_and_unmodeled_functions_are_rejected(self):
        changes = [
            {"setpoint_c": 24.5}, {"setpoint_c": 31}, {"setpoint_c": float("nan")},
            {"fan_command": "max"}, {"operating_mode": "invalid"}, {"eco": True, "turbo": True, "fan_command": "high"},
            {"turbo": True}, {"fan_command": "quiet", "quiet": False}, {"filter": False}]
        for change in changes:
            with self.subTest(change=change):
                self.assertEqual(self.post({**self.payload, "settings": {**self.payload["settings"], **change}}).status_code, 422)
        self.assertEqual(self.post({**self.payload, "settings": {**self.payload["settings"], "setpoint_c": True}}).status_code, 400)
        self.assertEqual(self.api.post("/api/predict-energy", json=[]).status_code, 400)

    def test_existing_control_field_aliases_and_on_off_flags(self):
        controls = {"temp": 24, "fan": "medium", "mode": "cool", "eco": "off", "turbo": "off",
                    "swing_vertical": "on", "quiet": "off", "swing_horizontal": "off", "display": "on"}
        baseline = self.post().get_json()["kwh"]
        response = self.post({**self.payload, "settings": controls})
        self.assertEqual(response.status_code, 200)
        self.assertAlmostEqual(response.get_json()["kwh"], baseline, places=7)
        controls["setpoint_c"] = 25
        self.assertEqual(self.post({**self.payload, "settings": controls}).status_code, 400)

    def test_forecasts_do_not_touch_telemetry_or_hardware(self):
        identifier = "prediction-isolation-fixture"
        row = self.api.post("/api/telemetry/transfer", json={"records": [
            {"id": identifier, "node_id": "isolated-node", "created": "2026-10-12T00:00:00+00:00",
             "temperature": None, "ac_on": None, "battery": 3.8}]})
        self.assertEqual(row.status_code, 200)
        self.assertEqual(row.get_json()["transferred"], 1)
        before = self.api.get("/api/telemetry/" + identifier).get_json()
        count_before = self.api.get("/api/telemetry").get_json()["totalItems"]
        with patch.object(backend.requests, "get", side_effect=AssertionError("Unexpected network")), \
             patch.object(backend.requests, "post", side_effect=AssertionError("Unexpected network")):
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.api.get("/api/telemetry/" + identifier).get_json(), before)
        self.assertEqual(self.api.get("/api/telemetry").get_json()["totalItems"], count_before)
        self.assertIsNone(before["temperature"])
        self.assertIsNone(before["ac_on"])

    def test_model_version_mismatch_never_loads_a_pipeline(self):
        target = Path(sandbox.name) / "mismatched-model"
        target.mkdir(exist_ok=True)
        manifest = json.loads((MODEL / "manifest.json").read_text(encoding="utf-8"))
        manifest["versions"]["scikit-learn"] = "0.0.0"
        (target / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        predictor = EnergyPredictor(target)
        with patch("backend.energy_prediction.joblib.load") as load:
            with self.assertRaises(PredictionError) as caught:
                predictor.predict(self.payload)
            self.assertEqual(caught.exception.code, "MODEL_VERSION_MISMATCH")
            self.assertEqual(caught.exception.status, 503)
            load.assert_not_called()

    def test_nonfinite_model_outputs_do_not_become_zero_energy(self):
        backend.energy_predictor._load()
        for value in (float("nan"), float("inf")):
            with self.subTest(value=value), patch.object(
                    backend.energy_predictor._bundle["model"], "predict", return_value=[value]):
                backend.energy_predictor._recorded_cache.clear()
                response = self.post()
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("kwh", response.get_json())

    def test_missing_and_corrupt_model_packages_do_not_return_fallbacks(self):
        predictor = EnergyPredictor(Path(sandbox.name) / "absent-model")
        self.assertEqual(predictor.health()["prediction_status"], "unavailable")
        with self.assertRaises(PredictionError) as caught:
            predictor.predict(self.payload)
        self.assertEqual(caught.exception.status, 503)
        target = Path(sandbox.name) / "corrupt-model"
        target.mkdir(exist_ok=True)
        shutil.copyfile(MODEL / "manifest.json", target / "manifest.json")
        (target / "model.joblib").write_bytes(b"corrupted")
        with patch("backend.energy_prediction.joblib.load") as load:
            with self.assertRaises(PredictionError) as caught:
                EnergyPredictor(target).predict(self.payload)
            self.assertEqual(caught.exception.status, 503)
            load.assert_not_called()


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        backend._schedule_executor.shutdown(wait=False)
        sandbox.cleanup()
