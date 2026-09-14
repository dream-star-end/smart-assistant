"""Private filesystem + Docker metadata adapter, not a live daemon/cgroup test."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'lib/delegate-consumer-inventory.py'
spec = importlib.util.spec_from_file_location('inventory', SOURCE)
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class Inventory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='oc-delegate-inventory-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.data = self.root / 'volume'
        self.data.mkdir()
        self.master = str(self.root / 'master.db')
        self.volume = {'Name': 'oc-v5-data-u3', 'Driver': 'local', 'Scope': 'local',
                       'Options': None, 'Mountpoint': str(self.data)}
        self.container = {'Id': 'a' * 64, 'Name': '/oc-v5-u3', 'Image': 'sha256:' + 'b' * 64,
            'Config': {'Labels': {inventory.CHANNEL: 'v5', inventory.MANAGED: '1', inventory.UID: '3'},
                       'User': '1000:1000', 'Env': ['HOME=/home/agent']},
            'HostConfig': {'RestartPolicy': {'Name': 'no'}},
            'Mounts': [{'Type': 'volume', 'Name': self.volume['Name'], 'Source': str(self.data),
                        'Destination': inventory.DATA_TARGET, 'RW': True}],
            'State': {'Status': 'running', 'Pid': 123, 'StartedAt': '2026-01-01T00:00:00Z'}}

    def collect(self, volumes=None, containers=None):
        return inventory.collect(volumes if volumes is not None else [self.volume],
                                 containers if containers is not None else [self.container], [self.master])

    def test_offline_retained_volume_and_missing_master_are_included(self):
        result = self.collect(containers=[])
        self.assertEqual({d['path'] for d in result['databases']},
                         {self.master, str(self.data / 'delegate-jobs.db')})
        self.assertEqual(result['writers'], [])
        self.assertTrue(all(d['absent'] for d in result['databases']))

    def test_foreign_bind_writer_cannot_be_omitted(self):
        foreign = {'Name': '/unmanaged', 'Config': {}, 'Mounts': [
            {'Type': 'bind', 'Source': str(self.data), 'Destination': '/data', 'RW': True}]}
        with self.assertRaises(inventory.Unknown):
            self.collect(containers=[foreign])

    def test_foreign_ancestor_bind_writer_cannot_be_omitted(self):
        foreign = {'Name': '/unmanaged', 'Config': {}, 'Mounts': [
            {'Type': 'bind', 'Source': str(self.root), 'Destination': '/all', 'RW': True}]}
        with self.assertRaises(inventory.Unknown):
            self.collect(containers=[foreign])

    def test_malformed_nested_docker_data_is_typed_unknown(self):
        for field, value in [('Config', ['bad']), ('HostConfig', None), ('State', ['bad']),
                             ('Image', None), ('Mounts', [None])]:
            with self.subTest(field=field):
                bad = copy.deepcopy(self.container); bad[field] = value
                with self.assertRaises(inventory.Unknown):
                    self.collect(containers=[bad])

    def test_labels_mount_identity_and_restart_policy_fail_closed(self):
        for mutate in [lambda c: c['Config']['Labels'].update({inventory.UID: '4'}),
                       lambda c: c['HostConfig']['RestartPolicy'].update(Name='always'),
                       lambda c: c['Mounts'][0].update(Source=str(self.root)),
                       lambda c: c['Config'].update(User='root')]:
            bad = copy.deepcopy(self.container); mutate(bad)
            with self.assertRaises(inventory.Unknown): self.collect(containers=[bad])

    def test_private_override_uses_longest_exact_persistent_mount(self):
        override = self.root / 'override'; override.mkdir()
        self.container['Mounts'].append({'Type': 'bind', 'Source': str(override),
                                         'Destination': '/custom', 'RW': True})
        self.container['Config']['Env'].append('OPENCLAUDE_DELEGATE_JOBS_DB=/custom/alt.db')
        result = self.collect()
        self.assertIn(str(override / 'alt.db'), {d['path'] for d in result['databases']})
        self.assertEqual(len(result['writers']), 1)

    def test_duplicate_env_and_shadow_mounts_are_not_defaults(self):
        self.container['Config']['Env'] += ['HOME=/home/agent']
        with self.assertRaises(inventory.Unknown): self.collect()
        self.container['Config']['Env'] = ['HOME=/home/agent']
        self.container['Mounts'].append({'Type': 'tmpfs', 'Destination': inventory.DATA_TARGET + '/x'})
        self.container['Config']['Env'].append('OPENCLAUDE_DELEGATE_JOBS_DB=' + inventory.DATA_TARGET + '/x/job.db')
        with self.assertRaises(inventory.Unknown): self.collect()

    def test_symlink_database_and_swapped_root_fail_closed(self):
        db = self.data / 'delegate-jobs.db'; db.symlink_to(self.root / 'absent')
        with self.assertRaises(inventory.Unknown): self.collect()
        db.unlink(); proof = self.collect()
        self.data.rename(self.root / 'old-volume'); self.data.mkdir()
        with self.assertRaises(inventory.Unknown): inventory.revalidate(proof)

    def test_network_volume_duplicate_volume_and_missing_master_reject(self):
        bad = {**self.volume, 'Options': {'type': 'nfs'}}
        with self.assertRaises(inventory.Unknown): self.collect(volumes=[bad])
        with self.assertRaises(inventory.Unknown): self.collect(volumes=[self.volume, self.volume])
        with self.assertRaises(inventory.Unknown): inventory.collect([], [], [])

    def test_capture_checks_fixed_local_daemon_and_complete_listing(self):
        responses = ['oc-v5-data-u3\n', 'a' * 64 + '\n', json.dumps([self.volume]),
                     json.dumps([self.container]), 'oc-v5-data-u3\n', 'a' * 64 + '\n']
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, responses.pop(0).encode())
        with patch.object(inventory.os, 'geteuid', return_value=0), patch.object(inventory.subprocess, 'run', side_effect=run):
            result = inventory.capture_local([self.master], time.monotonic() + 5)
        self.assertEqual(len(result['writers']), 1)
        self.assertEqual(len(calls), 6)
        for argv, kwargs in calls:
            self.assertEqual(argv[:2], ['/usr/bin/docker', '--host=unix:///var/run/docker.sock'])
            self.assertNotIn('DOCKER_HOST', kwargs['env'])
            self.assertGreater(kwargs['timeout'], 0)

    def test_timeout_never_yields_partial_inventory(self):
        with patch.object(inventory.os, 'geteuid', return_value=0), patch.object(inventory.subprocess, 'run',
             side_effect=subprocess.TimeoutExpired('private-docker', 0.1)):
            with self.assertRaises(inventory.Unknown):
                inventory.capture_local([self.master], time.monotonic() + 0.1)

    def test_master_bind_alias_is_not_an_unrelated_writer(self):
        alias = self.root / 'alias'; alias.symlink_to(self.root, target_is_directory=True)
        foreign = {'Name': '/unmanaged', 'Config': {}, 'Mounts': [
            {'Type': 'bind', 'Source': str(alias / 'master.db'), 'Destination': '/db', 'RW': True}]}
        with self.assertRaises(inventory.Unknown): self.collect(containers=[foreign])

    def test_bad_inspect_or_changed_full_list_returns_no_partial_proof(self):
        for inspect, final in [('{"wrong":1}', ''), (json.dumps([self.volume]), 'new-volume\n')]:
            outputs = ['oc-v5-data-u3\n', '', inspect, final, '']
            def run(argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, outputs.pop(0).encode())
            with patch.object(inventory.os, 'geteuid', return_value=0), patch.object(inventory.subprocess, 'run', side_effect=run):
                with self.assertRaises(inventory.Unknown):
                    inventory.capture_local([self.master], time.monotonic() + 5)

    def test_unhashable_mount_and_state_fields_never_escape_as_type_errors(self):
        for mutate in [lambda c: c['Mounts'][0].update(Name=[]),
                       lambda c: c['State'].update(Status=[])]:
            c = copy.deepcopy(self.container); mutate(c)
            with self.assertRaises(inventory.Unknown): self.collect(containers=[c])


if __name__ == '__main__':
    unittest.main()
