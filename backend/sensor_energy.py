"""Independent sensor model caches: preserved legacy model and trained reference.

The supplied legacy model has no documented training target/horizon or mapping
to outlet sensors. Missing features are never replaced with invented values.
"""
import hashlib
import json
from pathlib import Path
import threading
import warnings
import math
import os
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from backend.sensor_reference_features import FEATURES, HISTORY_SECONDS, MAX_CADENCE_SECONDS, features_for_segment


class SensorEnergyPredictor:
    MODEL_ID = 'xgboost'

    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.Lock()
        self.model = None
        self.load_warning_count = 0

    def manifest(self):
        return json.loads((self.directory / 'manifest.json').read_text(encoding='utf-8'))

    def load(self):
        with self.lock:
            if self.model is not None:
                return self.model
            manifest = self.manifest()
            artifact = self.directory / 'model.pkl'
            if hashlib.sha256(artifact.read_bytes()).hexdigest() != manifest['sha256']:
                raise ValueError('Sensor model checksum does not match its manifest.')
            with warnings.catch_warnings(record=True) as caught:
                model = joblib.load(artifact)
            if list(model.feature_names_in_) != manifest['features']:
                raise ValueError('Sensor model features do not match its manifest.')
            if not any(type(step).__name__ == 'XGBRegressor' for _, step in model.steps):
                raise ValueError('The sensor model is not an XGBoost regressor.')
            self.load_warning_count = len(caught)
            self.model = model
            return model

    def status(self):
        manifest = self.manifest()
        return dict(model=self.MODEL_ID, workspace='monitoring', loaded=self.model is not None,
                    required_features=manifest['features'], input_contract_verified=False,
                    output_unit=None, horizon_hours=None, forecast_available=False,
                    reason='The supplied model requires inputs and training metadata absent from the sensor log contract.')

    def forecast(self, available_columns):
        # Named inputs with similar words are not interchangeable physical quantities.
        required = self.manifest()['features']
        return dict(model=self.MODEL_ID, workspace='monitoring', available=False,
                    energy_kwh=None, average_power_kw=None, missing_features=[name for name in required if name not in available_columns],
                    code='SENSOR_MODEL_INPUTS_UNAVAILABLE',
                    reason='XGBoost requires recorded inputs and a verified training target unit/time interval. Fixed substitutes are disabled.', points=[])


def selected_spans(begin, finish, lower, upper, clocks=(None, None)):
    """Actual elapsed spans clipped to the same UTC+08 date/time filters as logs."""
    begin, finish = max(begin, lower), min(finish, upper)
    if finish <= begin:
        return []
    if not any(clocks):
        return [(begin, finish)]
    def seconds(value, default):
        return int(value[:2]) * 3600 + int(value[3:]) * 60 if value else default
    first, last = seconds(clocks[0], 0), min(86400, seconds(clocks[1], 86340) + 60)
    windows = [(first, last)] if first < last else [(first, 86400), (0, last)]
    result = []
    for day in range(int((begin + 28800) // 86400), int((finish + 28800) // 86400) + 1):
        for start, stop in windows:
            a, b = max(begin, day * 86400 - 28800 + start), min(finish, day * 86400 - 28800 + stop)
            if b > a:
                result.append((a, b))
    return result


class SensorReferencePredictor:
    """Verified lab-derived estimator; never a meter, AC-state detector or future forecast."""
    def __init__(self, directory, enabled=None):
        self.directory = Path(directory)
        self.enabled = enabled if enabled is not None else os.getenv('ECOTRACK_SENSOR_REFERENCE_ESTIMATES', '1') == '1'
        self.model = None
        self.lock = threading.Lock()

    def manifest(self):
        return json.loads((self.directory / 'manifest.json').read_text(encoding='utf-8'))

    def load(self):
        with self.lock:
            if self.model is None:
                manifest = self.manifest()
                if manifest['features'] != FEATURES or manifest['output_unit'] != 'W' or manifest['horizon_seconds'] != 0:
                    raise ValueError('Unsupported sensor reference input/target contract.')
                path = self.directory / manifest['artifact']
                if path.parent.resolve() != self.directory.resolve() or hashlib.sha256(path.read_bytes()).hexdigest() != manifest['sha256']:
                    raise ValueError('Sensor reference model checksum mismatch.')
                model = joblib.load(path)
                if list(model.feature_names_in_) != FEATURES:
                    raise ValueError('Sensor reference feature order mismatch.')
                self.model = model
            return self.model

    def status(self):
        manifest = self.manifest()
        return dict(model=manifest['model'], model_id=manifest['id'], workspace='monitoring',
                    loaded=self.model is not None, enabled=self.enabled, required_features=FEATURES,
                    history_seconds=HISTORY_SECONDS, max_cadence_seconds=MAX_CADENCE_SECONDS,
                    output_unit='W', horizon_hours=0, forecast_available=False, estimation_available=self.enabled,
                    experimental=True, physical_accuracy_validated=False, input_contract_verified=True,
                    task='contemporaneous_power_estimation', source_equipment=manifest['source_equipment'],
                    source_doi=manifest['dataset_doi'], candidates=manifest['candidates'],
                    validation=manifest['untouched_tests'], legacy_model_preserved=True,
                    reason='Laboratory temperature-based power estimates; field accuracy is unverified. Not a future forecast.')

    def estimate(self, rows, start, end, clocks=(None, None)):
        manifest = self.manifest()
        response = dict(model=manifest['model'], model_id=manifest['id'], workspace='monitoring', available=False,
                        experimental=True, physical_accuracy_validated=False, forecast_available=False,
                        task='contemporaneous_power_estimation', horizon_seconds=0, energy_kwh=None,
                        average_power_kw=None, estimated_unit_hours=0, estimated_sample_count=0,
                        missing_features=[], points=[], devices=[],
                        reason='Laboratory reference only; accuracy on this installation is unverified.')
        if not self.enabled:
            return {**response, 'code':'SENSOR_REFERENCE_DISABLED',
                    'reason':'The trained laboratory model is ready. Experimental estimates are disabled pending field validation or explicit preview selection.'}
        model = self.load()
        lower, upper = (datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() for value in [start, end])
        groups, rejected, features, targets = {}, 0, [], []
        for row in rows:
            key = (row['aircon_id'], row['node_id'])
            groups.setdefault(key, []).append(row)
        for key, group in groups.items():
            segment = []
            def append_segment():
                if len(segment) < 2:
                    return
                times = [row['_time'] for row in segment]
                positions, values = features_for_segment(times, [row['outlet_temperature_c'] for row in segment], [row['interval_seconds'] for row in segment])
                for position, values_row in zip(positions, values):
                    if not all(manifest['domain'][name]['min'] <= value <= manifest['domain'][name]['max'] for name, value in zip(FEATURES, values_row)):
                        continue
                    features.append(values_row)
                    targets.append(segment[position])
            for original in group:
                row = dict(original)
                temp, cadence = row.get('outlet_temperature_c'), row.get('interval_seconds')
                good = isinstance(temp, (float, int)) and math.isfinite(temp) and row.get('temperature_quality') == 'ok'
                good &= isinstance(cadence, (float, int)) and math.isfinite(cadence) and 0 < cadence <= MAX_CADENCE_SECONDS
                good &= row.get('clock_quality') == 'synchronized' and bool(row.get('observed_at'))
                if not good:
                    append_segment(); segment = []; rejected += 1; continue
                row['_time'] = datetime.fromisoformat(row['observed_at'].replace('Z', '+00:00')).timestamp()
                if segment:
                    prior = segment[-1]
                    elapsed = row['_time'] - prior['_time']
                    if elapsed <= 0 or elapsed > 1.5 * min(cadence, prior['interval_seconds']) or any(row.get(field) != prior.get(field) for field in ['boot_id', 'calibration_id']):
                        append_segment(); segment = []
                segment.append(row)
            append_segment()
        if not features:
            return {**response, 'code':'SENSOR_REFERENCE_HISTORY_UNAVAILABLE', 'rejected_readings':rejected,
                    'reason':'Requires five minutes of continuous, in-range, good-quality outlet temperatures with cadence at most 60 seconds. Gaps, reboots and calibration changes restart the history.'}
        predictions = np.maximum(0, model.predict(pd.DataFrame(features, columns=FEATURES)))
        by_sensor, intervals = {}, []
        for row, prediction in zip(targets, predictions):
            if not math.isfinite(float(prediction)):
                continue
            key = (row['aircon_id'], row['node_id'])
            previous = by_sensor.get(key)
            if previous:
                prior, power = previous
                elapsed = row['_time'] - prior['_time']
                if 0 < elapsed <= 1.5 * min(row['interval_seconds'], prior['interval_seconds']) and all(row.get(field) == prior.get(field) for field in ['boot_id', 'calibration_id']):
                    intervals.append({'row':row, 'begin':prior['_time'], 'end':row['_time'], 'p0':power, 'p1':float(prediction), 'valid':True})
            by_sensor[key] = (row, float(prediction))
        # Multiple historical sensors for the same AC must not double-count overlapping energy.
        active, ambiguous = {}, 0
        for item in sorted(intervals, key=lambda item: item['begin']):
            ac = item['row']['aircon_id']
            live = [other for other in active.get(ac, []) if other['end'] > item['begin']]
            for other in live:
                other['valid'] = item['valid'] = False
                ambiguous += 1
            active[ac] = [*live, item]
        devices, buckets, total_kwh, covered = {}, {}, 0.0, 0.0
        bucket_seconds = max(60, math.ceil((upper - lower) / 300))
        for item in intervals:
            if not item['valid']:
                continue
            row, begin, finish = item['row'], item['begin'], item['end']
            key = row['node_id']
            device = devices.setdefault(key, {'node_id':key, 'aircon_id':row['aircon_id'], 'sensor_name':row['sensor_name'],
                'aircon_name':row['aircon_name'], 'location':row.get('location') or '', 'aircon_type':row.get('aircon_type'),
                'energy_kwh':0., 'estimated_seconds':0.})
            for left, right in selected_spans(begin, finish, lower, upper, clocks):
                while right > left:
                    bucket = int(left // bucket_seconds)
                    stop = min(right, (bucket + 1) * bucket_seconds)
                    # Trapezoidal integration of estimated watts over actual clipped seconds.
                    def power_at(stamp):
                        return item['p0'] + (item['p1'] - item['p0']) * (stamp - begin) / (finish - begin)
                    span = stop - left
                    kwh = (power_at(left) + power_at(stop)) * .5 * span / 3600000
                    value = buckets.setdefault(bucket, {'energy_kwh':0., 'estimated_seconds':0.})
                    value['energy_kwh'] += kwh; value['estimated_seconds'] += span
                    device['energy_kwh'] += kwh; device['estimated_seconds'] += span
                    total_kwh += kwh; covered += span
                    left = stop
        if covered <= 0:
            return {**response, 'code':'SENSOR_REFERENCE_NO_COVERAGE', 'ambiguous_intervals':ambiguous,
                    'reason':'No complete eligible sensor intervals in this selection. Single readings and missing intervals are not converted to energy.'}
        points = []
        for bucket in range(int(lower // bucket_seconds), int((upper - .001) // bucket_seconds) + 1):
            value = buckets.get(bucket)
            points.append({'observed_at':datetime.fromtimestamp(bucket * bucket_seconds, timezone.utc).isoformat().replace('+00:00','Z'),
                           'energy_kwh':value['energy_kwh'] if value else None,
                           'estimated_seconds':value['estimated_seconds'] if value else 0,
                           'average_power_kw':value['energy_kwh'] / (value['estimated_seconds']/3600) if value else None})
        return {**response, 'available':True, 'code':'EXPERIMENTAL_SENSOR_ESTIMATE', 'energy_kwh':total_kwh,
                'average_power_kw':total_kwh / (covered/3600), 'estimated_unit_hours':covered/3600,
                'estimated_sample_count':len(targets), 'rejected_readings':rejected, 'ambiguous_intervals':ambiguous,
                'points':points, 'devices':[device for device in devices.values() if device['estimated_seconds'] > 0], 'bucket_seconds':bucket_seconds,
                'integration':'Trapezoidal estimated watts over consecutive observed timestamps; clipped to filters; no gap extrapolation.',
                'reason':'Experimental temperature-based estimate from one NREL laboratory central AC. No field validation or capacity scaling; not metered energy or a future forecast.'}

