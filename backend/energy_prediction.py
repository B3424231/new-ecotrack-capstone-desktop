"""One Histogram Gradient Boosting service for explicitly scoped research-estimate forecasts."""
import gzip
import hashlib
import importlib.metadata
import json
import math
import threading
from pathlib import Path

import joblib
import pandas as pd
from threadpoolctl import threadpool_limits

FLAGS = ["eco", "turbo", "swing", "quiet", "horizontal_swing", "display"]
CONTROLS = ["setpoint_c", "fan_command", "operating_mode", *FLAGS]
FEATURES = [*CONTROLS, "indoor_c", "outdoor_c", "relative_humidity_percent"]
ALIASES = {"temp": "setpoint_c", "temperature": "setpoint_c", "fan": "fan_command",
           "mode": "operating_mode", "swing_vertical": "swing",
           "swing_horizontal": "horizontal_swing"}


class PredictionError(Exception):
    def __init__(self, message, status=400, code="INVALID_PREDICTION_INPUT"):
        super().__init__(message)
        self.status = status
        self.code = code


class EnergyPredictor:
    MODEL_ID = "hist_gradient_boosting"

    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self._lock = threading.Lock()
        self._bundle = None
        self._manifest = None
        self._support = None
        self._recorded_cache = {}

    def check_model(self, model):
        if model != self.MODEL_ID:
            raise PredictionError("Only the Histogram Gradient Boosting model is available. Use model='hist_gradient_boosting'.",
                                  404, "MODEL_NOT_AVAILABLE")

    def _installed_versions(self):
        try:
            return {name: importlib.metadata.version(name)
                    for name in ("scikit-learn", "joblib", "numpy", "scipy", "pandas")}
        except importlib.metadata.PackageNotFoundError:
            raise PredictionError("A required model library is missing.", 503, "MODEL_UNAVAILABLE") from None

    def _load(self):
        if self._bundle is not None:
            return
        with self._lock:
            if self._bundle is not None:
                return
            try:
                manifest = json.loads((self.directory / "manifest.json").read_text(encoding="utf-8"))
                model_features = CONTROLS if manifest.get("input_scope") == "controls_only" else FEATURES
                if (manifest["model"] != self.MODEL_ID or manifest["features"] != model_features
                        or manifest.get("algorithm") != "HistGradientBoostingRegressor"
                        or manifest.get("input_scope") != "controls_only"
                        or manifest["physical_accuracy_validated"] is not False
                        or manifest["training_data_type"] != "research_informed_estimates"
                        or manifest["horizon_hours"] != 1 or manifest["output_unit"] != "kWh"):
                    raise ValueError("Invalid energy model contract")
                if manifest["versions"] != self._installed_versions():
                    raise PredictionError(
                        "Model library versions differ from training. Retrain the model in this project's "
                        "environment; do not downgrade the app's libraries.",
                        503, "MODEL_VERSION_MISMATCH")
                for name in ("model.joblib", "supported_inputs.json.gz", "assumptions.json"):
                    p = self.directory / name
                    if hashlib.sha256(p.read_bytes()).hexdigest() != manifest["artifacts"][name]:
                        raise ValueError("Artifact checksum mismatch")
                bundle = joblib.load(self.directory / "model.joblib")
                if (bundle["features"] != model_features or list(bundle["model"].feature_names_in_) != model_features
                        or type(bundle["model"].named_steps.get("regressor")).__name__ != "HistGradientBoostingRegressor"
                        or bundle["physical_accuracy_validated"] is not False
                        or bundle["training_data_type"] != "research_informed_estimates"
                        or bundle["versions"] != manifest["versions"]):
                    raise ValueError("Invalid saved pipeline")
                with gzip.open(self.directory / "supported_inputs.json.gz", "rt", encoding="utf-8") as stream:
                    support = {tuple(row) for row in json.load(stream)}
                if not support or any(len(row) != (len(CONTROLS) if manifest.get("input_scope") == "controls_only" else len(CONTROLS) + 1) for row in support):
                    raise ValueError("Invalid reference input support")
            except PredictionError:
                raise
            except (OSError, ValueError, TypeError, KeyError, EOFError, AttributeError):
                raise PredictionError("The Histogram Gradient Boosting model package is missing or failed integrity checks.",
                                      503, "MODEL_UNAVAILABLE") from None
            self._manifest, self._support, self._bundle = manifest, support, bundle

    def _base(self):
        self._load()
        return {"model": self.MODEL_ID, "algorithm": "HistGradientBoostingRegressor",
                "reference_model": self._manifest["reference_model"],
                "output_unit": "kWh", "horizon_hours": 1,
                "training_data_type": "research_informed_estimates",
                "physical_accuracy_validated": False,
                "input_scope": self._manifest.get("input_scope", "controls_and_environment")}

    def health(self):
        try:
            return {**self._base(), "models_available": [self.MODEL_ID],
                    "energy_prediction_models": [self.MODEL_ID],
                    "prediction_status": "research_estimate_ready"}
        except PredictionError as error:
            return {"models_available": [], "energy_prediction_models": [],
                    "prediction_status": "unavailable", "prediction_reason": str(error)}

    def features(self, model):
        self.check_model(model)
        base = self._base()
        controls_only = base["input_scope"] == "controls_only"
        features = CONTROLS if controls_only else FEATURES
        return {**base, "features": features, "n_features": len(features),
                "control_features": CONTROLS,
                "required_request_fields": ["settings"] if controls_only else ["settings", "scenario_id"],
                "settings_aliases": ALIASES,
                "environment_scenarios": [] if controls_only else self._manifest["environment_scenarios"],
                "environment_source": "not_used" if controls_only else "explicit_assumed_scenario",
                "scope": "Reference grid: 16–30 C in 1 C steps; recorded reference combinations only.",
                "unsupported_model_functions": ["filter", "sleep", "clean", "beep", "i_feel"],
                "limitations": self._manifest["limitations"],
                "prediction_status": "research_estimate_ready"}

    def metrics(self, model):
        self.check_model(model)
        return {**self._base(), "metrics": self._manifest["test_metrics"],
                "evaluation_kind": self._manifest["evaluation_kind"],
                "selection_metric": self._manifest["selection_metric"],
                "validation_mae_kwh": self._manifest["validation_mae_kwh"],
                "train_rows": self._manifest["train_rows"],
                "validation_rows": self._manifest["validation_rows"],
                "test_rows": self._manifest["test_rows"],
                "measured_validation_hours": 0,
                "trained_utc": self._manifest["trained_utc"],
                "prediction_status": "research_estimate_ready"}

    @staticmethod
    def _flag(value, field):
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.strip().lower() in ("on", "off"):
            return value.strip().lower() == "on"
        raise PredictionError(field + " must explicitly be true/false or 'on'/'off'.")

    def _settings(self, data, required=CONTROLS):
        raw = data.get("settings")
        if not isinstance(raw, dict):
            raise PredictionError("Provide AC control settings. Temperature/runtime alone cannot supply the model inputs.")
        normalized = {}
        for name, value in raw.items():
            canonical = ALIASES.get(name, name)
            if canonical not in CONTROLS:
                raise PredictionError("Unsupported model setting: " + str(name), 422, "OUTSIDE_MODEL_SCOPE")
            if canonical in normalized:
                raise PredictionError("Duplicate or conflicting setting aliases: " + canonical)
            normalized[canonical] = value
        missing = [name for name in required if name not in normalized]
        if missing:
            raise PredictionError("Missing explicit settings: " + ", ".join(missing))
        value = normalized["setpoint_c"]
        if value is None or isinstance(value, bool):
            raise PredictionError("setpoint_c must be an integer from 16 to 30.")
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            raise PredictionError("setpoint_c must be an integer from 16 to 30.") from None
        if not math.isfinite(number) or not number.is_integer() or not 16 <= number <= 30:
            raise PredictionError("Use the reference model's 16–30 C grid in 1 C steps.",
                                  422, "OUTSIDE_MODEL_SCOPE")
        normalized["setpoint_c"] = number
        for name, choices in (("fan_command", ("auto", "low", "medium", "high", "quiet")),
                              ("operating_mode", ("auto", "cool", "heat", "dry", "fan"))):
            value = normalized[name]
            if not isinstance(value, str) or value.strip().lower() not in choices:
                raise PredictionError("Unsupported " + name + ".", 422, "OUTSIDE_MODEL_SCOPE")
            normalized[name] = value.strip().lower()
        for name in FLAGS:
            if name in normalized:
                normalized[name] = self._flag(normalized[name], name)
        return normalized

    def predict_recorded(self, data):
        """Marginalize unrecorded inputs over saved reference support, without retraining.

        Every supplied control is held fixed. No weather observation or missing
        function state is invented. The mean and envelope describe the supported
        reference combinations, not a calibrated physical prediction interval.
        """
        if not isinstance(data, dict):
            raise PredictionError("A JSON object is required.")
        self.check_model(data.get("model", self.MODEL_ID))
        if set(data) - {"model", "settings"}:
            raise PredictionError("Recorded-column predictions accept model and settings only.")
        settings = self._settings(data, ("setpoint_c", "fan_command", "operating_mode"))
        base = self._base()
        cache_key = tuple(sorted(settings.items()))
        with self._lock:
            cached = self._recorded_cache.get(cache_key)
        if cached is not None:
            return {**base, **cached, "settings": dict(settings)}
        controls_only = base["input_scope"] == "controls_only"
        offset = 0 if controls_only else 1
        positions = {name: index + offset for index, name in enumerate(CONTROLS)}
        matches = sorted(row for row in self._support
                         if all(row[positions[name]] == value for name, value in settings.items()))
        if not matches:
            raise PredictionError("These recorded controls are outside the trained model's supported combinations.",
                                  422, "OUTSIDE_MODEL_SCOPE")
        if controls_only:
            inputs = [dict(zip(CONTROLS, row)) for row in matches]
            model_features = CONTROLS
        else:
            scenarios = {item["scenario_id"]: item for item in self._manifest["environment_scenarios"]}
            inputs = [{**dict(zip(CONTROLS, row[1:])), **scenarios[row[0]]} for row in matches]
            model_features = FEATURES
        frame = pd.DataFrame([{name: item[name] for name in model_features} for item in inputs])
        for name in model_features:
            if name not in ("fan_command", "operating_mode"):
                frame[name] = frame[name].astype(float)
        with threadpool_limits(limits=2):
            values = [float(value) for value in self._bundle["model"].predict(frame)]
        if len(values) != len(matches) or not all(math.isfinite(value) for value in values):
            raise PredictionError("The model returned an invalid reference estimate.", 503, "MODEL_UNAVAILABLE")
        values = [max(0.0, value) for value in values]
        lower, upper = min(values), max(values)
        energy = min(upper, max(lower, math.fsum(values) / len(values)))
        result = {
            "kwh": energy, "estimated_energy_kwh": energy,
            "prediction_status": "research_estimate",
            "prediction_basis": "control_settings_only" if controls_only else "recorded_columns_reference_average",
            "reference_range_kwh": {"min": lower, "max": upper},
            "reference_condition_count": 0 if controls_only else len({row[0] for row in matches}),
            "reference_variant_count": len(matches),
            "unrecorded_functions": [name for name in FLAGS if name not in settings],
            "environment_source": "not_used" if controls_only else "model_reference_average",
            "operation_assumption": ("Conditional one-hour reference estimate from controls only. Missing function flags are averaged over supported control variants; no sensor values or environmental scenarios are supplied. Range is a control-variant envelope, not a confidence interval." if controls_only else "Conditional one-hour operation at the recorded controls. Equal-weight mean over supported reference combinations; range is their envelope, not a confidence interval."),
            "measured_energy_kwh": None, "physically_confirmed_ac_on": None,
        }
        with self._lock:
            if len(self._recorded_cache) >= 256:
                self._recorded_cache.pop(next(iter(self._recorded_cache)))
            self._recorded_cache[cache_key] = result
        return {**base, **result, "settings": dict(settings)}

    def predict(self, data):
        if not isinstance(data, dict):
            raise PredictionError("A JSON object is required.")
        self.check_model(data.get("model", self.MODEL_ID))
        settings = self._settings(data)
        unknown = set(data) - {"model", "settings", "scenario_id"}
        if unknown:
            raise PredictionError("Unsupported request fields: " + ", ".join(sorted(unknown)) +
                                  ". This endpoint estimates one hour, not historical daily/weekly totals.")
        base = self._base()
        if base["input_scope"] == "controls_only":
            result = self.predict_recorded({"model": self.MODEL_ID, "settings": settings})
            if "scenario_id" in data:
                result["ignored_parameters"] = ["scenario_id"]  # Compatibility only; never used as a feature.
            return result
        scenario_id = data.get("scenario_id")
        if not isinstance(scenario_id, str):
            raise PredictionError("scenario_id is required; no weather or sensor values are assumed automatically.")
        scenarios = {s["scenario_id"]: s for s in self._manifest["environment_scenarios"]}
        if scenario_id not in scenarios:
            raise PredictionError("Choose a documented scenario_id: " + ", ".join(scenarios),
                                  422, "OUTSIDE_MODEL_SCOPE")
        support_key = (scenario_id, *[int(settings[n]) if n in FLAGS else settings[n] for n in CONTROLS])
        if support_key not in self._support:
            raise PredictionError(
                "The control/scenario combination is outside the reference dataset's modeled support. "
                "Eco with Turbo/Quiet, Turbo without High fan, and unsupported mode combinations cannot be estimated.",
                422, "OUTSIDE_MODEL_SCOPE")
        inp = {**settings, **scenarios[scenario_id]}
        frame = pd.DataFrame([{n: inp[n] for n in FEATURES}])
        for name in FEATURES:
            if name not in ("fan_command", "operating_mode"):
                frame[name] = frame[name].astype(float)
        with threadpool_limits(limits=2):
            prediction = float(self._bundle["model"].predict(frame)[0])
        if not math.isfinite(prediction):
            raise PredictionError("The model returned a non-finite result.", 503, "MODEL_UNAVAILABLE")
        energy = max(0.0, prediction)
        return {**base, "kwh": energy, "estimated_energy_kwh": energy,
                "prediction_status": "research_estimate", "settings": settings,
                "scenario_id": scenario_id, "environment_source": "explicit_assumed_scenario",
                "environment": {n: inp[n] for n in FEATURES[-3:]},
                "operation_assumption": "AC operates for one hour with these settings and assumed conditions held constant.",
                "measured_energy_kwh": None, "physically_confirmed_ac_on": None}
