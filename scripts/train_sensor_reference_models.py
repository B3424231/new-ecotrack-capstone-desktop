"""Compare exactly three temperature-only estimators on real NREL AC experiments.

Target is contemporaneous measured electrical W, not a future energy label.
All input lags are present/past actual outlet temperatures. No production reads.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor, HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from threadpoolctl import threadpool_limits
from xgboost import XGBRegressor
from backend.sensor_reference_features import FEATURES, HISTORY_SECONDS, features_for_segment

SEED = 20261020
MODELS = {
    'random_forest': lambda: RandomForestRegressor(n_estimators=160, max_depth=12, min_samples_leaf=8, n_jobs=2, random_state=SEED),
    'hist_gradient_boosting': lambda: HistGradientBoostingRegressor(max_iter=250, max_leaf_nodes=15, learning_rate=.05, l2_regularization=1, early_stopping=False, random_state=SEED),
    'xgboost': lambda: XGBRegressor(n_estimators=250, max_depth=4, learning_rate=.05, min_child_weight=8, reg_lambda=5, subsample=1, colsample_bytree=1, tree_method='hist', n_jobs=2, objective='reg:squarederror', random_state=SEED),
}


def scores(y, predicted, transition=None):
    predicted = np.maximum(0, predicted)
    result = {'rows': len(y), 'mae_w': float(mean_absolute_error(y, predicted)),
              'rmse_w': float(np.sqrt(mean_squared_error(y, predicted))), 'r2': float(r2_score(y, predicted)),
              'bias_w': float(np.mean(predicted - y))}
    if transition is not None:
        result['load_change_rows'] = int(transition.sum())
        result['load_change_mae_w'] = float(mean_absolute_error(y[transition], predicted[transition])) if transition.any() else None
    return result


def data_frames(dataset):
    manifest = json.loads((dataset / 'manifest.json').read_text(encoding='utf-8'))
    experiments, audits = {}, []
    for source in manifest['files']:
        file = dataset / source['file']
        if hashlib.sha256(file.read_bytes()).hexdigest() != source['sha256']:
            raise ValueError('Source checksum mismatch: ' + str(file))
        raw = pd.read_csv(file)
        stamp = pd.to_datetime(raw['TimeStamp'], errors='raise')  # Source timezone deliberately unspecified.
        seconds = (stamp - stamp.iloc[0]).dt.total_seconds().to_numpy()
        if len(raw) != source['rows'] or not np.all(np.diff(seconds) == 1):
            raise ValueError('Source rows/timestamp cadence changed.')
        temp = pd.to_numeric(raw['T_Supply (C)'], errors='coerce').to_numpy()
        outside = pd.to_numeric(raw['Outdoor Unit Power (W)'], errors='coerce').to_numpy()
        inside = pd.to_numeric(raw['Indoor Unit Power (W)'], errors='coerce').to_numpy()
        # One target per minute reduces redundant one-second rows; the raw CSV stays intact.
        positions, x = features_for_segment(seconds, temp, np.ones(len(raw)), np.arange(HISTORY_SECONDS, len(raw), 60))
        valid = np.isfinite(outside[positions]) & np.isfinite(inside[positions]) & (outside[positions] >= 0) & (inside[positions] >= 0)
        positions, x = positions[valid], x[valid]
        frame = pd.DataFrame(x, columns=FEATURES)
        frame['power_w'] = (outside + inside)[positions]
        frame['source_timestamp'] = stamp.iloc[positions].astype(str).to_numpy()
        frame['source_seconds'] = seconds[positions]
        frame['experiment'] = file.stem
        # Load-change audit uses labels for scoring only, never as an input or AC-state evidence.
        delta = np.abs(np.diff(outside + inside, prepend=outside[0] + inside[0]))
        frame['load_change'] = pd.Series(delta).rolling(61, min_periods=1).max().to_numpy()[positions] >= 500
        experiments[file.stem] = frame
        audits.append({'file': source['file'], 'raw_rows': len(raw), 'feature_rows_at_one_minute_stride': len(valid),
                       'invalid_power_targets_removed': int((~valid).sum()), 'retained_rows': len(frame),
                       'source_sha256': source['sha256'], 'source_timezone': 'unspecified; no timezone features used'})
    return manifest, experiments, audits


def train(dataset, output, reports):
    source_manifest, experiments, audits = data_frames(dataset)
    holdout_name = next(name for name in experiments if 'OAT115F_' in name)
    development = {name: rows for name, rows in experiments.items() if name != holdout_name}
    training, temporal_tests, splits = {}, [], []
    for name, frame in development.items():
        cutoff = float(frame['source_seconds'].max() * .7)
        first = frame[frame.source_seconds <= cutoff - HISTORY_SECONDS].copy()
        later = frame[frame.source_seconds >= cutoff + HISTORY_SECONDS].copy()
        if first.empty or later.empty:
            raise ValueError('Insufficient non-overlapping chronological data.')
        assert first.source_seconds.max() < later.source_seconds.min() - HISTORY_SECONDS
        training[name] = first
        temporal_tests.append(later)
        splits.append({'experiment': name, 'training_rows': len(first), 'temporal_test_rows': len(later),
                       'last_train_source_time': first.source_timestamp.iloc[-1], 'first_test_source_time': later.source_timestamp.iloc[0],
                       'history_purge_seconds': HISTORY_SECONDS, 'split_boundary_source_seconds': cutoff})
    cv, fits, final_models = [], [], {}
    output.mkdir(parents=True, exist_ok=True)
    reports.mkdir(parents=True, exist_ok=True)
    for name, factory in MODELS.items():
        print('Training candidate:', name, flush=True)
        for held_name, held in training.items():
            fit = pd.concat([frame for key, frame in training.items() if key != held_name])
            model = factory()
            started = time.perf_counter()
            with threadpool_limits(limits=2):
                model.fit(fit[FEATURES], fit.power_w)
                predicted = model.predict(held[FEATURES])
            row = {'model': name, 'held_out_experiment': held_name, 'fit_seconds': time.perf_counter() - started,
                   **scores(held.power_w.to_numpy(), predicted, held.load_change.to_numpy())}
            row['training_mean_baseline_mae_w'] = float(mean_absolute_error(held.power_w, np.repeat(fit.power_w.mean(), len(held))))
            cv.append(row)
        fit = pd.concat(training.values())
        final = factory()
        with threadpool_limits(limits=2):
            final.fit(fit[FEATURES], fit.power_w)
        artifact = output / (name + '.joblib')
        joblib.dump(final, artifact, compress=3)
        final_models[name] = final
        selected = [row for row in cv if row['model'] == name]
        fits.append({'model': name, 'validation_macro_mae_w': float(np.mean([r['mae_w'] for r in selected])),
                     'validation_macro_rmse_w': float(np.mean([r['rmse_w'] for r in selected])),
                     'validation_macro_r2': float(np.mean([r['r2'] for r in selected])),
                     'baseline_macro_mae_w': float(np.mean([r['training_mean_baseline_mae_w'] for r in selected])),
                     'artifact': artifact.name, 'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest()})
    ranking = sorted(fits, key=lambda row: (row['validation_macro_mae_w'], row['validation_macro_rmse_w']))
    winner = ranking[0]  # Locked before reading untouched test labels for evaluation.
    test_scores, predictions = [], []
    for item in ranking:
        model = final_models[item['model']]
        for label, frame in [('chronological', pd.concat(temporal_tests)), ('unseen_115F_experiment', experiments[holdout_name])]:
            with threadpool_limits(limits=2):
                predicted = np.maximum(0, model.predict(frame[FEATURES]))
            test_scores.append({'model': item['model'], 'test': label, **scores(frame.power_w.to_numpy(), predicted, frame.load_change.to_numpy())})
            result = frame[['experiment', 'source_timestamp', 'power_w', 'load_change']].copy()
            result['model'], result['split'], result['predicted_power_w'] = item['model'], label, predicted
            predictions.append(result)
    fit = pd.concat(training.values())
    domain = {feature: {'min': float(fit[feature].min()), 'max': float(fit[feature].max())} for feature in FEATURES}
    for name in ['SOURCE_LICENSE.txt']:
        shutil.copyfile(dataset / name, output / name)
    manifest = {'id': 'nrel_benefit_temperature_power_v1', 'model': winner['model'], 'artifact': winner['artifact'],
                'sha256': winner['sha256'], 'features': FEATURES, 'output_unit': 'W', 'horizon_seconds': 0,
                'target': 'Outdoor Unit Power (W) + Indoor Unit Power (W), same source timestamp',
                'task': 'contemporaneous_power_estimation', 'history_seconds': HISTORY_SECONDS,
                'history_lags_seconds': [0, 60, 120, 180, 240, 300], 'max_recorded_cadence_seconds': 60,
                'domain': domain, 'physical_accuracy_validated': False, 'experimental': True,
                'selection_rule': 'Lowest macro MAE across four leave-experiment-out validation folds; RMSE tie-break',
                'selected_before_untouched_test_evaluation': True, 'training_rows': len(fit), 'training_seed': SEED,
                'dataset_doi': source_manifest['doi'], 'dataset_source': source_manifest['source_page'],
                'source_equipment': source_manifest['selected_equipment'], 'source_files': audits,
                'citation': source_manifest['citation'], 'trained_utc': datetime.now(timezone.utc).isoformat(),
                'runtime_versions': {key: importlib.metadata.version(key) for key in ['scikit-learn', 'xgboost', 'numpy', 'pandas', 'joblib']},
                'candidates': ranking, 'untouched_tests': test_scores,
                'unsupported_inputs': ['differential_pressure_pa', 'ac_on', 'commands', 'outdoor_temperature', 'equipment_capacity'],
                'limitations': ['One laboratory central AC; no installation validation or capacity scaling.',
                                'Pressure and independent AC-state training fields are absent.',
                                'Not a future forecast or a revenue-grade electricity measurement.',
                                'Use measured temperature history only; no interpolation or missing-input defaults.']}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2, allow_nan=False), encoding='utf-8')
    (reports / 'comparison.json').write_text(json.dumps({'winner': winner['model'], 'selection': ranking, 'validation_folds': cv,
        'untouched_tests': test_scores, 'splits': splits, 'entire_unseen_experiment': holdout_name, 'raw_rows': sum(a['raw_rows'] for a in audits)}, indent=2, allow_nan=False), encoding='utf-8')
    pd.DataFrame(ranking).to_csv(reports / 'model-comparison.csv', index=False)
    pd.concat(predictions).to_csv(reports / 'held-out-predictions.csv', index=False)
    print(json.dumps({'winner': winner['model'], 'validation_ranking': ranking, 'untouched_tests': test_scores}, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=ROOT / 'datasets/sensor_reference_nrel_2024')
    parser.add_argument('--output', type=Path, default=ROOT / 'backend/ml/sensor_nrel_reference')
    parser.add_argument('--reports', type=Path, default=ROOT / 'reports/sensor-nrel-model')
    args = parser.parse_args()
    train(args.dataset, args.output, args.reports)
