"""Elapsed-only runtime and export snapshot consistency; disposable SQLite only."""
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import unittest
import test_monitoring as fixture
from backend import monitoring

fixed = datetime(2026, 10, 20, 4, 0, tzinfo=timezone.utc)
class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(fixed.timestamp(), tz or timezone.utc)

class FollowupMonitoringTests(fixture.MonitoringTests):
    def test_confirmed_runtime_stops_at_the_current_time(self):
        with patch.object(monitoring, 'datetime', Clock):
            node=self.create(state_source='power_meter',expected_interval_seconds=3600)
            self.assertEqual(self.upload(node,[self.sample(observed_at='2026-10-20T03:59:30Z',interval_seconds=3600,ac_on=True,state_source='power_meter')]).status_code,200)
            stats=self.analytics(**{'from':'2026-10-19T16:00:00Z','to':'2026-10-20T16:00:00Z'})
            self.assertEqual(stats['confirmed_unit_hours']*3600,30)
            self.assertEqual(stats['observed_unit_hours']*3600,30)
    def test_tolerated_future_clock_samples_do_not_count_as_elapsed_feedback(self):
        with patch.object(monitoring, 'datetime', Clock):
            node=self.create(state_source='power_meter')
            self.assertEqual(self.upload(node,[self.sample(observed_at='2026-10-20T04:04:00Z',interval_seconds=3600,ac_on=True,state_source='power_meter')]).status_code,200)
            stats=self.analytics(**{'from':'2026-10-19T16:00:00Z','to':'2026-10-20T16:00:00Z'})
            self.assertEqual(stats['confirmed_unit_hours'],0)
            self.assertEqual(stats['sample_count'],0)
    def test_export_snapshot_excludes_new_and_backfilled_ingestion_across_pages(self):
        node=self.create()
        start=datetime(2026,10,18,tzinfo=timezone.utc)
        self.assertEqual(self.upload(node,[self.sample(sequence=i,observed_at=(start+timedelta(seconds=i)).isoformat()) for i in range(201)]).status_code,200)
        query={'from':'2026-10-18T00:00:00Z','to':'2026-10-19T00:00:00Z','per_page':200}
        first=self.api.get('/api/monitoring/telemetry',query_string=query).json
        self.assertEqual(first['total'],201)
        self.assertEqual(len(first['items']),200)
        self.assertEqual(self.upload(node,[self.sample(sequence=202,observed_at='2026-10-18T01:00:00Z'),self.sample(sequence=203,observed_at='2026-10-18T00:00:30Z')]).status_code,200)
        frozen={**query,'snapshot':first['snapshot']}
        last=self.api.get('/api/monitoring/telemetry',query_string={**frozen,'page':2}).json
        self.assertEqual(last['total'],201)
        self.assertEqual(len(last['items']),1)
        self.assertEqual(len({row['id'] for row in first['items']+last['items']}),201)
        self.assertEqual(self.analytics(**frozen)['sample_count'],201)
        self.assertEqual(self.analytics(**query)['sample_count'],203)
    def test_snapshot_parameter_is_validated_at_each_read_boundary(self):
        for value in ['-1','invalid','9223372036854775808']:
            for route in ['telemetry','analytics','energy']:
                self.assertEqual(self.api.get('/api/monitoring/'+route,query_string={'snapshot':value}).status_code,422)

if __name__=='__main__':
    unittest.main(verbosity=2)
