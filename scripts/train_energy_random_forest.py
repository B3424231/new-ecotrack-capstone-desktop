"""Train the one-hour research-estimate model using this project's environment.

Input is the attributed AC_Research_Estimates.zip, never production telemetry.
"""
import argparse
import gzip
import hashlib
import importlib.metadata
import io
import json
import platform
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import (explained_variance_score, mean_absolute_error,
                             mean_squared_error, r2_score)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from threadpoolctl import threadpool_limits

FLAGS = ["eco", "turbo", "swing", "quiet", "horizontal_swing", "display"]
CONTROLS = ["setpoint_c", "fan_command", "operating_mode", *FLAGS]
FEATURES = [*CONTROLS, "indoor_c", "outdoor_c", "relative_humidity_percent"]
PREFIX = "AC_Research_Estimates/"
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "backend/ml/research_random_forest"
RUNTIME_ARTIFACTS = ("model.joblib", "supported_inputs.json.gz", "assumptions.json")
REPORT_ARTIFACTS = ("sources.json", "held_out_predictions.csv", "prediction_probes.json")


def train(dataset, output, reports=None):
    dataset, output = Path(dataset).resolve(), Path(output).resolve()
    reports = Path(reports).resolve() if reports else (
        ROOT / "reports/research-energy-model/artifacts" if output == DEFAULT_MODEL.resolve()
        else output.with_name(output.name + "_reports"))
    if reports == output or output in reports.parents:
        raise ValueError("Keep reports outside the runtime model directory.")
    with zipfile.ZipFile(dataset) as archive:
        if archive.testzip() is not None:
            raise ValueError("Dataset ZIP integrity check failed.")
        manifest = json.loads(archive.read(PREFIX + "manifest.json"))
        for entry in manifest["files"]:
            name = entry["path"]
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError("Unsafe dataset manifest path.")
            if hashlib.sha256(archive.read(PREFIX + name)).hexdigest() != entry["sha256"]:
                raise ValueError("Dataset checksum mismatch: " + name)
        df = pd.read_csv(io.BytesIO(archive.read(PREFIX + "estimated_training_data.csv")))
        assumptions = json.loads(archive.read(PREFIX + "assumptions.json"))
        sources = json.loads(archive.read(PREFIX + "sources/estimator_sources.json"))
    if not (df["row_type"].eq("estimated").all()
            and df["is_measured"].eq(False).all()
            and df["measured_energy_kwh"].isna().all()):
        raise ValueError("Train only the explicitly labeled estimated targets.")
    if not df[FEATURES + ["estimated_energy_kwh"]].notna().all().all():
        raise ValueError("Missing model inputs or generated targets.")
    for field in FLAGS:
        if not df[field].isin([True, False]).all():
            raise ValueError("Invalid function flag: " + field)
    categories = ["fan_command", "operating_mode"]
    numbers = [name for name in FEATURES if name not in categories]
    X = df[FEATURES].copy()
    for name in numbers:
        X[name] = X[name].astype(float)
    y = df["estimated_energy_kwh"].astype(float)
    validation = df["setpoint_c"].isin([20, 26])
    test = df["setpoint_c"].isin([21, 24, 27])
    training = ~(validation | test)
    assert not (training & validation).any() and not (training & test).any()
    preprocessor = ColumnTransformer([
        ("categories", OneHotEncoder(handle_unknown="error", sparse_output=False), categories),
        ("numbers", "passthrough", numbers)])
    train_X = preprocessor.fit_transform(X.loc[training])
    validation_X = preprocessor.transform(X.loc[validation])
    candidates, best = [], None
    for depth in (12, None):
        estimator = RandomForestRegressor(
            n_estimators=150, max_depth=depth, min_samples_leaf=2,
            max_features=1.0, random_state=42, n_jobs=2)
        with threadpool_limits(limits=2):
            estimator.fit(train_X, y.loc[training])
            val = np.maximum(0, estimator.predict(validation_X))
        mae = float(mean_absolute_error(y.loc[validation], val))
        candidates.append({"max_depth": depth, "validation_mae_kwh": mae})
        if best is None or mae < best["mae"]:
            best = {"estimator": estimator, "mae": mae, "max_depth": depth}
    pipeline = Pipeline([("preprocessor", preprocessor), ("regressor", best["estimator"])])
    with threadpool_limits(limits=2):
        predicted = np.maximum(0, pipeline.predict(X.loc[test]))
    metrics = {
        "mae": float(mean_absolute_error(y.loc[test], predicted)),
        "mse": float(mean_squared_error(y.loc[test], predicted)),
        "rmse": float(np.sqrt(mean_squared_error(y.loc[test], predicted))),
        "r2": float(r2_score(y.loc[test], predicted)),
        "evs": float(explained_variance_score(y.loc[test], predicted))}
    versions = {name: importlib.metadata.version(name)
                for name in ("scikit-learn", "joblib", "numpy", "scipy", "pandas")}
    output.mkdir(parents=True, exist_ok=True)
    reports.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": pipeline, "features": FEATURES, "algorithm": "Random Forest",
                 "training_data_type": "research_informed_estimates",
                 "physical_accuracy_validated": False, "versions": versions},
                output / "model.joblib", compress=3)
    support = df[["scenario_id", *CONTROLS]].copy()
    for flag in FLAGS:
        support[flag] = support[flag].astype(int)
    with gzip.open(output / "supported_inputs.json.gz", "wt", encoding="utf-8") as stream:
        json.dump(support.drop_duplicates().values.tolist(), stream, separators=(",", ":"))
    (output / "assumptions.json").write_text(json.dumps(assumptions, indent=2), encoding="utf-8")
    (reports / "sources.json").write_text(json.dumps(sources, indent=2), encoding="utf-8")
    test_rows = df.loc[test, ["record_id", "scenario_id", *CONTROLS]].copy()
    test_rows["generated_target_kwh"] = y.loc[test].to_numpy()
    test_rows["random_forest_estimated_kwh"] = predicted
    test_rows["physical_accuracy_validated"] = False
    test_rows.to_csv(reports / "held_out_predictions.csv", index=False)
    probe_positions = [0, 50, 100, 200, 400, 600, 1000, 1500, 2000, 2500, 3000, 3700]
    probes = []
    for pos in probe_positions:
        record = df.loc[test].iloc[pos]
        settings = {name: bool(record[name]) if name in FLAGS else
                    float(record[name]) if name == "setpoint_c" else str(record[name])
                    for name in CONTROLS}
        probes.append({"settings": settings, "scenario_id": str(record["scenario_id"]),
                       "expected_model_estimate_kwh": float(predicted[pos])})
    (reports / "prediction_probes.json").write_text(json.dumps(probes, indent=2), encoding="utf-8")
    metadata = {
        "model": "random_forest", "algorithm": "RandomForestRegressor",
        "reference_model": assumptions["reference_model"],
        "trained_utc": datetime.now(timezone.utc).isoformat(),
        "python_version": platform.python_version(), "versions": versions,
        "features": FEATURES, "control_features": CONTROLS,
        "output_unit": "kWh", "horizon_hours": 1,
        "training_data_type": "research_informed_estimates",
        "evaluation_kind": "held_out_generated_formula_targets",
        "physical_accuracy_validated": False, "measured_validation_hours": 0,
        "environment_source": "explicit_assumed_scenario",
        "environment_scenarios": assumptions["scenarios"],
        "limitations": assumptions["limitations"],
        "selection_metric": "validation_mae", "validation_candidates": candidates,
        "selected_max_depth": best["max_depth"],
        "validation_mae_kwh": best["mae"],
        "train_rows": int(training.sum()), "validation_rows": int(validation.sum()),
        "test_rows": int(test.sum()), "validation_setpoints_c": [20, 26],
        "test_setpoints_c": [21, 24, 27],
        "test_metrics": metrics,
        "mean_baseline_test_mae_kwh": float(mean_absolute_error(
            y.loc[test], np.full(int(test.sum()), float(y.loc[training].mean())))),
        "dataset_sha256": hashlib.sha256(dataset.read_bytes()).hexdigest(),
        "artifacts": {name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                      for name in RUNTIME_ARTIFACTS},
        "report_artifacts": {name: hashlib.sha256((reports / name).read_bytes()).hexdigest()
                             for name in REPORT_ARTIFACTS}}
    (output / "manifest.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    reloaded = joblib.load(output / "model.joblib")
    with threadpool_limits(limits=2):
        replay = np.maximum(0, reloaded["model"].predict(X.loc[test]))
    np.testing.assert_allclose(replay, predicted, atol=1e-7, rtol=1e-7)
    print(json.dumps({"model": metadata["model"], "output": str(output), "reports": str(reports),
                      "versions": versions, "train_rows": metadata["train_rows"],
                      "validation_rows": metadata["validation_rows"], "test_rows": metadata["test_rows"],
                      "metrics_vs_generated_targets": metrics,
                      "all_saved_test_predictions_verified": True,
                      "physical_accuracy_validated": False}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="Trusted AC_Research_Estimates.zip")
    parser.add_argument("--output", default=str(DEFAULT_MODEL))
    parser.add_argument("--reports-output", help="Optional directory for test results and source attribution")
    args = parser.parse_args()
    train(args.dataset, args.output, args.reports_output)
