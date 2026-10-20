"""Verified cloud-registry lifecycle against disposable SQLite; no live services."""
import copy
import json
import unittest
import test_monitoring as fixture


class RegistryReconciliationTests(fixture.MonitoringTests):
    def entry(self, identity='11111111-1111-4111-8111-111111111111', source='cloud-node-one', ac='fixture-ac'):
        return {'id': identity, 'registry_node_id': source, 'device': {
            'name': 'Fixture monitor', 'aircon_id': ac, 'aircon_name': 'Fixture AC',
            'pressure_sensor': 'MPX5010DP', 'pressure_min_pa': 0, 'pressure_max_pa': 10000,
            'expected_interval_seconds': 60}}

    def reconcile(self, *entries):
        return self.api.post('/api/monitoring/registry/reconcile', json={'devices': list(entries)}, headers=self.headers)

    def test_replacement_retires_cloud_sensor_preserves_samples_credentials_and_standalone(self):
        standalone = self.create(aircon_id='standalone-ac')
        first = self.entry()
        self.assertEqual(self.reconcile(first).json, {'changed': 1})
        # Provision only the isolated fixture so an actual measurement can be preserved.
        token = self.api.post('/api/monitoring/devices/' + first['id'] + '/rotate-token', headers=self.headers).json['device_token']
        self.assertEqual(self.upload({'id': first['id'], 'device_token': token}, [self.sample()]).status_code, 200)
        with fixture.service.connection() as conn:
            before = dict(conn.execute('SELECT * FROM monitor_samples').fetchone())
            credential = conn.execute('SELECT token_hash FROM monitor_nodes WHERE id=?', (first['id'],)).fetchone()[0]
        replacement = self.entry('22222222-2222-4222-8222-222222222222', 'cloud-node-two')
        self.assertEqual(self.reconcile(replacement).json, {'changed': 2})
        nodes = {node['id']: node for node in self.api.get('/api/monitoring/devices').json['items']}
        self.assertFalse(nodes[first['id']]['active'])
        self.assertTrue(nodes[replacement['id']]['active'])
        self.assertTrue(nodes[standalone['id']]['active'])
        with fixture.service.connection() as conn:
            self.assertEqual(dict(conn.execute('SELECT * FROM monitor_samples').fetchone()), before)
            self.assertEqual(conn.execute('SELECT token_hash FROM monitor_nodes WHERE id=?', (first['id'],)).fetchone()[0], credential)
        self.assertEqual(self.upload({'id': first['id'], 'device_token': token}, [self.sample(sequence=2)]).status_code, 403)

    def test_removal_role_change_reactivation_and_noop(self):
        entry = self.entry()
        self.assertEqual(self.reconcile(entry).json, {'changed': 1})
        self.assertEqual(self.reconcile(entry).json, {'changed': 0})
        self.assertEqual(self.reconcile().json, {'changed': 1})
        self.assertEqual(self.reconcile().json, {'changed': 0})
        self.assertEqual(self.reconcile(entry).json, {'changed': 1})

    def test_legacy_mirror_is_adopted_and_retired_without_replacing_credentials(self):
        entry = self.entry()
        self.assertEqual(self.api.post('/api/monitoring/registry/import', json={'id': entry['id'], 'device': entry['device']}, headers=self.headers).status_code, 200)
        with fixture.service.connection() as conn:
            credential = conn.execute('SELECT token_hash FROM monitor_nodes WHERE id=?', (entry['id'],)).fetchone()[0]
        self.assertEqual(self.reconcile(entry).json, {'changed': 1})
        self.assertEqual(self.reconcile().json, {'changed': 1})
        with fixture.service.connection() as conn:
            self.assertEqual(conn.execute('SELECT token_hash FROM monitor_nodes WHERE id=?', (entry['id'],)).fetchone()[0], credential)

    def test_explicit_local_deactivation_is_preserved_during_metadata_sync(self):
        entry = self.entry()
        self.reconcile(entry)
        self.assertEqual(self.api.patch('/api/monitoring/devices/' + entry['id'], json={'active': False}, headers=self.headers).status_code, 200)
        self.assertEqual(self.reconcile(entry).json, {'changed': 0})
        entry['device']['name'] = 'Renamed while inactive'
        self.assertEqual(self.reconcile(entry).json, {'changed': 1})
        self.assertFalse(self.api.get('/api/monitoring/devices').json['items'][0]['active'])

    def test_invalid_snapshot_rolls_back_retirement_and_outbox(self):
        first = self.entry()
        self.reconcile(first)
        with fixture.service.connection() as conn:
            count = conn.execute('SELECT COUNT(*) FROM monitor_sync_outbox').fetchone()[0]
        invalid = self.entry('22222222-2222-4222-8222-222222222222', 'cloud-two')
        invalid['device']['pressure_max_pa'] = -1
        self.assertEqual(self.reconcile(invalid).status_code, 422)
        with fixture.service.connection() as conn:
            self.assertEqual(conn.execute('SELECT active FROM monitor_nodes WHERE id=?', (first['id'],)).fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM monitor_sync_outbox').fetchone()[0], count)

    def test_reconciliation_never_takes_over_a_standalone_assignment(self):
        standalone = self.create(aircon_id='fixture-ac')
        self.assertEqual(self.reconcile(self.entry()).status_code, 409)
        self.assertTrue(self.api.get('/api/monitoring/devices').json['items'][0]['active'])
        self.assertEqual(self.api.get('/api/monitoring/devices').json['items'][0]['id'], standalone['id'])

    def test_reassignment_keeps_historical_ac_identity(self):
        entry = self.entry()
        self.reconcile(entry)
        token = self.api.post('/api/monitoring/devices/' + entry['id'] + '/rotate-token', headers=self.headers).json['device_token']
        self.upload({'id': entry['id'], 'device_token': token}, [self.sample()])
        moved = copy.deepcopy(entry)
        moved['device']['aircon_id'] = 'new-ac'
        self.assertEqual(self.reconcile(moved).status_code, 200)
        node = self.api.get('/api/monitoring/devices').json['items'][0]
        self.assertEqual(node['aircon_id'], 'new-ac')
        self.assertIsNone(node['latest'])
        with fixture.service.connection() as conn:
            self.assertEqual(conn.execute('SELECT aircon_id FROM monitor_samples').fetchone()[0], 'fixture-ac')

    def test_admin_boundary_validation_and_local_marker_privacy(self):
        route = '/api/monitoring/registry/reconcile'
        self.assertEqual(self.api.post(route, json={'devices': []}).status_code, 401)
        self.assertEqual(self.api.post(route, json={'devices': []}, headers=self.headers, environ_overrides={'REMOTE_ADDR': '192.168.1.25'}).status_code, 403)
        self.assertEqual(self.api.post(route, json={'devices': []}, headers={**self.headers, 'Origin': 'https://untrusted.invalid'}).status_code, 403)
        entry = self.entry()
        self.assertEqual(self.reconcile(entry, entry).status_code, 409)
        self.assertEqual(self.reconcile(entry).status_code, 200)
        self.assertNotIn('registry_node_id', self.api.get('/api/monitoring/devices').json['items'][0])
        self.assertNotIn('registry_retired', self.api.get('/api/monitoring/devices').json['items'][0])
        with fixture.service.connection() as conn:
            for row in conn.execute('SELECT payload FROM monitor_sync_outbox'):
                self.assertNotIn('registry_node_id', json.loads(row[0]))
                self.assertNotIn('registry_retired', json.loads(row[0]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
