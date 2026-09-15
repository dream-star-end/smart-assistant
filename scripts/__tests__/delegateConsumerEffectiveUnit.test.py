"""Loaded-property adapter tests; real PID1 coverage lives in the host fixture."""
import importlib.util
from pathlib import Path
import subprocess
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('units', Path(__file__).resolve().parents[1] / 'lib/delegate-consumer-unit-paths.py')
units = importlib.util.module_from_spec(spec); spec.loader.exec_module(units)
NAME = 'openclaude-v5-selfhost.service'


def properties():
    d = {k: '' for k in units.SHOW_EMPTY}
    d.update({k: 'no' for k in units.SHOW_NO})
    d.update(Id=NAME, LoadState='loaded', NeedDaemonReload='no', FragmentPath='/private/master.service',
             DropInPaths='/private/10-base.conf /private/20-final.conf', User='root', Group='', Type='simple',
             WorkingDirectory='/private/release', Environment='HOME=/private/root OPENCLAUDE_HOME=/private/data',
             EnvironmentFiles='/private/a.env (ignore_errors=no) /private/b.env (ignore_errors=yes)',
             ExecStart='{ path=/usr/bin/npx ; argv[]=/usr/bin/npx tsx packages/cli/src/index.ts gateway ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }')
    return d


def output(d): return '\n'.join(k + '=' + v for k, v in d.items()) + '\n'


class EffectiveUnit(unittest.TestCase):
    def test_actual_repeated_environmentfiles_property_lines_keep_order(self):
        d = properties()
        d['EnvironmentFiles'] = '/private/a.env (ignore_errors=no)'
        rendered = output(d) + 'EnvironmentFiles=/private/b.env (ignore_errors=yes)\n'
        actual = units.parse_effective_properties(rendered, NAME)
        self.assertEqual(actual['plan']['environmentFiles'], [
            {'path': '/private/a.env', 'optional': False}, {'path': '/private/b.env', 'optional': True}])
        with self.assertRaises(units.Unknown):
            units.parse_effective_properties(rendered + 'EnvironmentFiles=\n', NAME)

    def test_loaded_order_and_optional_files_preserved(self):
        r = units.parse_effective_properties(output(properties()), NAME)
        self.assertEqual(r['fragments'], ['/private/master.service', '/private/10-base.conf', '/private/20-final.conf'])
        self.assertEqual(r['plan']['environmentFiles'], [{'path': '/private/a.env', 'optional': False},
                                                       {'path': '/private/b.env', 'optional': True}])
        self.assertEqual(r['plan']['argv'], ['/usr/bin/npx', 'tsx', 'packages/cli/src/index.ts', 'gateway'])

    def test_reload_masking_namespace_or_ignored_command_refused(self):
        for key, value in [('NeedDaemonReload', 'yes'), ('LoadState', 'masked'), ('User', 'agent'),
                           ('PrivateTmp', 'yes'), ('RootDirectory', '/jail'), ('Id', 'foreign.service'),
                           ('ExecStart', properties()['ExecStart'].replace('ignore_errors=no', 'ignore_errors=yes'))]:
            with self.subTest(key=key), self.assertRaises(units.Unknown):
                d = properties(); d[key] = value; units.parse_effective_properties(output(d), NAME)

    def test_unknown_argv_duplicate_keys_or_ambiguous_dropins_refused(self):
        d = properties(); d['ExecStart'] = d['ExecStart'].replace('/usr/bin/npx', '/bin/bash')
        with self.assertRaises(units.Unknown): units.parse_effective_properties(output(d), NAME)
        with self.assertRaises(units.Unknown): units.parse_effective_properties(output(properties()) + 'User=root\n', NAME)
        d = properties(); d['DropInPaths'] = '/private/same.conf /private/same.conf'
        with self.assertRaises(units.Unknown): units.parse_effective_properties(output(d), NAME)

    def test_loaded_config_mismatch_never_uses_disk_only_projection(self):
        shown = units.parse_effective_properties(output(properties()), NAME)
        captured = {'unitPlan': {**shown['plan'], 'workingDirectory': '/private/other'}, 'inputs': []}
        with patch.object(units.os, 'geteuid', return_value=0), patch.object(units, '_show_effective', return_value=shown), \
             patch.object(units, 'capture_root_files', return_value=captured):
            with self.assertRaises(units.Unknown): units.capture_effective_unit(NAME, time.monotonic() + 3)

    def test_post_read_effective_change_is_not_a_valid_snapshot(self):
        shown = units.parse_effective_properties(output(properties()), NAME)
        changed = {**shown, 'fragments': ['/private/new.service']}
        captured = {'unitPlan': shown['plan'], 'inputs': [], 'projection': {}}
        with patch.object(units.os, 'geteuid', return_value=0), patch.object(units, '_show_effective', side_effect=[shown, changed]), \
             patch.object(units, 'capture_root_files', return_value=captured):
            with self.assertRaises(units.Unknown): units.capture_effective_unit(NAME, time.monotonic() + 3)

    def test_public_entry_rejects_other_units_before_command(self):
        with patch.object(units, '_show_effective') as show:
            with self.assertRaises(units.Unknown): units.capture_effective_unit('openclaude.service', time.monotonic() + 3)
        show.assert_not_called()

    def test_fixed_systemctl_timeout_is_unknown_not_cached_success(self):
        with patch.object(units.subprocess, 'run', side_effect=subprocess.TimeoutExpired('systemctl', 1)) as run:
            with self.assertRaises(units.Unknown): units._show_effective(NAME, time.monotonic() + 1)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ['/usr/bin/systemctl', '--system', 'show', '--no-pager'])
        self.assertEqual(argv[-2:], ['--', NAME])
        self.assertNotIn('DBUS_SYSTEM_BUS_ADDRESS', run.call_args.kwargs['env'])


if __name__ == '__main__': unittest.main()
