"""Projection unit tests, not effective-systemd or trusted caller enrollment."""
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / 'lib/delegate-consumer-unit-paths.py'
spec = importlib.util.spec_from_file_location('units', source)
units = importlib.util.module_from_spec(spec); spec.loader.exec_module(units)
BASE = '''[Unit]
Description=private unit
[Service]
User=root
WorkingDirectory=/private/release
EnvironmentFile=/private/base.env
Environment="OPENCLAUDE_HOME=/private/inline"
ExecStart=/usr/bin/npx tsx packages/cli/src/index.ts gateway
'''


class UnitPaths(unittest.TestCase):
    def resolve(self, fragments=None, files=None):
        return units.resolve_unit_paths(units.parse_unit(fragments or [BASE]),
            files if files is not None else {'/private/base.env': ''}, '/private/passwd-root')

    def test_file_overrides_inline_even_when_file_directive_comes_first(self):
        r = self.resolve(files={'/private/base.env': 'OPENCLAUDE_HOME=/private/from-file\nTOKEN=secret'})
        self.assertEqual(r['database'], '/private/from-file/delegate-jobs.db')
        self.assertNotIn('secret', str(r))
        self.assertNotIn('TOKEN', str(r))

    def test_db_override_has_original_resolver_priority(self):
        r = self.resolve(files={'/private/base.env': 'OPENCLAUDE_DELEGATE_JOBS_DB="/private/db file.db"'})
        self.assertEqual(r['database'], '/private/db file.db')

    def test_reset_files_and_inline_then_use_actual_root_passwd_home(self):
        r = self.resolve([BASE, '[Service]\nEnvironmentFile=\nEnvironment='])
        self.assertEqual(r['database'], '/private/passwd-root/.openclaude/delegate-jobs.db')

    def test_later_environment_file_wins_and_optional_missing_is_explicit(self):
        r = self.resolve([BASE, '[Service]\nEnvironmentFile=/private/later.env\nEnvironmentFile=-/private/missing.env'],
            {'/private/base.env': 'OPENCLAUDE_HOME=/private/first',
             '/private/later.env': 'OPENCLAUDE_HOME=/private/last', '/private/missing.env': None})
        self.assertEqual(r['database'], '/private/last/delegate-jobs.db')
        with self.assertRaises(units.Unknown): self.resolve(files={})
        with self.assertRaises(units.Unknown): self.resolve(files={'/private/base.env': None})

    def test_unknown_expansion_shell_exports_and_multiline_are_rejected(self):
        for body in ['export HOME=/private/x', 'TOKEN="multiline\nHOME=/private/x\n"',
                     'TOKEN=continued\\\nHOME=/private/x', 'HOME=/private/a\nHOME=/private/b']:
            with self.subTest(body=body), self.assertRaises(units.Unknown):
                self.resolve(files={'/private/base.env': body})
        with self.assertRaises(units.Unknown):
            self.resolve([BASE, '[Service]\nEnvironment="OPENCLAUDE_HOME=/private/%u"'])

    def test_unknown_exec_user_rootnamespace_or_missing_effective_command_refused(self):
        for extra in ['User=agent', 'RootDirectory=/private/jail', 'PassEnvironment=HOME',
                      'UnsetEnvironment=HOME', 'ExecStart=/bin/bash /private/start.sh', 'ExecStart=',
                      'ProtectHome=tmpfs', 'PrivateTmp=yes', 'ExtensionImages=/private/overlay']:
            with self.subTest(extra=extra), self.assertRaises(units.Unknown):
                self.resolve([BASE, '[Service]\n' + extra])

    def test_known_slot_argv_is_kept_without_npx_or_pid_fork(self):
        r = self.resolve([BASE, '[Service]\nExecStart=\nExecStart=/usr/bin/node --import tsx packages/commercial/src/egress/main.ts\nEnvironment="OC_EGRESS_SLOT=%i"'])
        self.assertEqual(r['argv'], ['/usr/bin/node', '--import', 'tsx', 'packages/commercial/src/egress/main.ts'])
        self.assertNotIn('OC_EGRESS_SLOT', r['pathEnvironment'])

    def test_empty_home_is_unknown_not_current_python_home(self):
        with self.assertRaises(units.Unknown):
            self.resolve([BASE, '[Service]\nEnvironment='], {'/private/base.env': 'HOME='})

    def test_runtime_projection_is_separate_from_paths_and_secrets(self):
        result = self.resolve([BASE, '[Service]\nEnvironment=OC_RUNTIME_IMAGE=inline:old'],
            {'/private/base.env': 'OC_RUNTIME_IMAGE=file:new\nOC_RUNTIME_IMAGE_ID=sha256:private\n'
             'OC_RUNTIME_RELEASE=/private/runtime\nOC_PLATFORM_BUNDLE=\nTOKEN=hidden'})
        self.assertEqual(result['runtimeEnvironment'], {'OC_RUNTIME_IMAGE': 'file:new',
            'OC_RUNTIME_IMAGE_ID': 'sha256:private', 'OC_RUNTIME_RELEASE': '/private/runtime',
            'OC_PLATFORM_BUNDLE': ''})
        self.assertNotIn('OC_RUNTIME_IMAGE', result['pathEnvironment'])
        self.assertNotIn('TOKEN', str(result))

    def test_duplicate_runtime_keys_and_specifier_are_unknown(self):
        with self.assertRaises(units.Unknown):
            self.resolve(files={'/private/base.env': 'OC_RUNTIME_RELEASE=/a\nOC_RUNTIME_RELEASE=/b'})
        with self.assertRaises(units.Unknown):
            self.resolve([BASE, '[Service]\nEnvironment=OC_RUNTIME_IMAGE=%i'])


class TupleRestoreProjection(unittest.TestCase):
    def test_unset_reveals_original_inline_value_not_ambient(self):
        plan = units.parse_unit([BASE + '\nEnvironment=OC_RUNTIME_IMAGE=inline:old'])
        values = {key: '' for key in units.TUPLE_KEYS}
        values['OC_RUNTIME_IMAGE'] = '<UNSET>'
        r = units.resolve_unit_paths(plan, {'/private/base.env': 'OC_RUNTIME_IMAGE=file:new'},
            '/private/passwd', tuple_replacement=('/private/base.env', values))
        self.assertEqual(r['runtimeEnvironment']['OC_RUNTIME_IMAGE'], 'inline:old')

    def test_unknown_target_file_cannot_replace_effective_tuple(self):
        plan = units.parse_unit([BASE])
        with self.assertRaises(units.Unknown):
            units.resolve_unit_paths(plan, {'/private/base.env': ''}, '/private/passwd',
                tuple_replacement=('/private/not-referenced.env', {key: '' for key in units.TUPLE_KEYS}))


if __name__ == '__main__': unittest.main()
