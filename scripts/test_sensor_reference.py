"""Real trained artifact + isolated API fixtures; never production telemetry."""
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
import pandas as pd
import test_monitoring as fixture
from backend.sensor_energy import SensorReferencePredictor, selected_spans
from backend.sensor_reference_features import FEATURES, features_for_segment

ROOT = Path(__file__).resolve().parents[1]


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.predictor = SensorReferencePredictor(ROOT/'backend/ml/sensor_nrel_reference', enabled=True)
        self.start = datetime(2026,10,18,tzinfo=timezone.utc)
        self.rows = [dict(node_id='sensor',aircon_id='ac',aircon_name='Fixture AC',sensor_name='Fixture sensor',
            location='Building · Floor · Room',aircon_type='Window',boot_id='boot',calibration_id='cal',
            temperature_quality='ok',clock_quality='synchronized',interval_seconds=5,
            observed_at=(self.start+timedelta(seconds=i*5)).isoformat(),outlet_temperature_c=18+.1*np.sin(i/10),
            differential_pressure_pa=None,ac_on=None) for i in range(121)]

    def estimate(self, rows=None, start=None, end=None, clocks=(None,None)):
        return self.predictor.estimate(self.rows if rows is None else rows,
            (start or self.start).isoformat(),(end or self.start+timedelta(seconds=601)).isoformat(),clocks)

    def test_three_candidates_winner_and_untouched_split_contract(self):
        m=self.predictor.manifest()
        self.assertEqual({v['model'] for v in m['candidates']},{'random_forest','hist_gradient_boosting','xgboost'})
        self.assertEqual(m['model'],min(m['candidates'],key=lambda r:r['validation_macro_mae_w'])['model'])
        self.assertTrue(m['selected_before_untouched_test_evaluation'])
        self.assertEqual(m['features'],FEATURES);self.assertEqual(m['output_unit'],'W');self.assertEqual(m['horizon_seconds'],0)
        self.assertFalse(m['physical_accuracy_validated'])
        for row in json.loads((ROOT/'reports/sensor-nrel-model/comparison.json').read_text())['splits']:
            self.assertGreater((datetime.fromisoformat(row['first_test_source_time'])-datetime.fromisoformat(row['last_train_source_time'])).total_seconds(),300)
        original=json.loads((ROOT/'backend/ml/sensor_xgboost/manifest.json').read_text())
        self.assertEqual(hashlib.sha256((ROOT/'backend/ml/sensor_xgboost/model.pkl').read_bytes()).hexdigest(),original['sha256'])

    def test_watts_to_kwh_uses_actual_timestamps_and_warmup(self):
        result=self.estimate();self.assertTrue(result['available']);self.assertAlmostEqual(result['estimated_unit_hours'],300/3600)
        positions,features=features_for_segment(np.arange(121)*5,[row['outlet_temperature_c'] for row in self.rows],5)
        power=self.predictor.load().predict(pd.DataFrame(features,columns=FEATURES))
        expected=float(np.sum((power[:-1]+power[1:])*.5*np.diff(positions*5))/3600000)
        self.assertAlmostEqual(result['energy_kwh'],expected,places=10)
        self.assertAlmostEqual(sum(point['energy_kwh'] or 0 for point in result['points']),expected,places=10)
        self.assertFalse(result['forecast_available']);self.assertTrue(result['experimental'])

    def test_no_history_single_point_bad_cadence_and_out_of_domain_stay_unavailable(self):
        for rows in [[],self.rows[:60],[self.rows[-1]], [{**row,'interval_seconds':3600} for row in self.rows], [{**row,'outlet_temperature_c':40} for row in self.rows]]:
            result=self.estimate(rows);self.assertFalse(result['available']);self.assertIsNone(result['energy_kwh'])

    def test_fault_gap_boot_and_calibration_changes_restart_history(self):
        for field,value in [('outlet_temperature_c',None),('temperature_quality','fault'),('clock_quality','unsynchronized')]:
            rows=copy.deepcopy(self.rows);rows[60][field]=value
            self.assertFalse(self.estimate(rows)['available'])
        for field in ['boot_id','calibration_id']:
            rows=copy.deepcopy(self.rows)
            for row in rows[60:]:row[field]='new'
            self.assertFalse(self.estimate(rows)['available'])
        self.assertFalse(self.estimate(self.rows[:60]+self.rows[61:])['available'])

    def test_pressure_and_power_state_are_not_fabricated_model_inputs(self):
        before=self.estimate()['energy_kwh']
        rows=[{**row,'ac_on':False,'differential_pressure_pa':9999} for row in self.rows]
        self.assertEqual(self.estimate(rows)['energy_kwh'],before)
        self.assertTrue(all(row['ac_on'] is None for row in self.rows))

    def test_time_window_clipping_and_unknown_buckets(self):
        clipped=self.estimate(start=self.start+timedelta(seconds=330),end=self.start+timedelta(seconds=390))
        self.assertAlmostEqual(clipped['estimated_unit_hours'],60/3600)
        self.assertTrue(any(point['energy_kwh'] is None for point in self.estimate()['points']))
        base=self.start.timestamp()
        self.assertEqual(selected_spans(base,base+86400,base,base+86400,('23:00','01:00')),
            [(base+15*3600,base+16*3600),(base+16*3600,base+17*3600+60)])

    def test_overlapping_sensors_for_same_aircon_do_not_double_count(self):
        duplicate=[{**row,'node_id':'second-sensor'} for row in self.rows]
        result=self.estimate([*self.rows,*duplicate])
        self.assertFalse(result['available']);self.assertGreater(result['ambiguous_intervals'],0)

    def test_disabled_and_checksum_mismatch_fail_without_fake_values(self):
        self.predictor.enabled=False
        result=self.estimate();self.assertEqual(result['code'],'SENSOR_REFERENCE_DISABLED');self.assertIsNone(result['energy_kwh'])
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);manifest=self.predictor.manifest();manifest['sha256']='0'*64
            (root/'manifest.json').write_text(json.dumps(manifest));(root/manifest['artifact']).write_bytes(b'invalid')
            with self.assertRaises(ValueError):SensorReferencePredictor(root).load()

    def test_api_selected_records_and_runtime_remain_independent(self):
        case=fixture.MonitoringTests('test_empty_and_control_records_preserved');case.setUp()
        node=case.create(expected_interval_seconds=5)
        samples=[case.sample(sequence=i,observed_at=row['observed_at'],outlet_temperature_c=row['outlet_temperature_c']) for i,row in enumerate(self.rows)]
        self.assertEqual(case.upload(node,samples).status_code,200)
        query={'from':self.start.isoformat(),'to':(self.start+timedelta(seconds=601)).isoformat(),'node_id':node['id']}
        result=case.api.get('/api/monitoring/energy',query_string=query)
        self.assertEqual(result.status_code,200,result.json);self.assertTrue(result.json['available'])
        runtime=case.api.get('/api/monitoring/analytics',query_string=query).json
        self.assertEqual(runtime['confirmed_state_count'],0);self.assertEqual(runtime['unknown_state_samples'],121)
        self.assertEqual(runtime['confirmed_unit_hours'],0)
        self.assertEqual(case.api.get('/api/monitoring/telemetry',query_string=query).json['total'],121)


if __name__=='__main__':unittest.main(verbosity=2)
