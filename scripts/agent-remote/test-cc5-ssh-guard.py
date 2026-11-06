#!/usr/bin/env python3
"""Local Python children and exec spies only; no SSH, keys, Claude or model calls."""
from contextlib import ExitStack, redirect_stderr
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

GUARD_PATH = Path(__file__).with_name('cc5-ssh-guard.py')
spec = importlib.util.spec_from_file_location('guard', GUARD_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
CONTROLLER = Path(__file__).with_name('cc5-host-controller.py').read_bytes()
OTHER_CONTROLLER = b'# second accepted controller build\n' + CONTROLLER
ROOT = '/home/box/oc-agentremote-t1555u-20261102t0121z-3f42e181'
DIGEST = hashlib.sha256(CONTROLLER).hexdigest()
OTHER_DIGEST = hashlib.sha256(OTHER_CONTROLLER).hexdigest()
CONFIG = {
    'version': 1,
    'sourceIps': ['38.55.252.217'],
    'user': 'box',
    'home': '/home/box',
    'sshPort': 22,
    'rootPrefix': '/home/box/oc-agentremote-',
    'controllerSha256': [DIGEST, OTHER_DIGEST],
    'models': ['claude-sonnet-5', 'claude-opus-5'],
    'profiles': ['acct-a', 'acct-b'],
}


def gateway_command(role='launch', root=ROOT, source=CONTROLLER, encoded=None, extra=None):
    # Independent transcription of the gateway's wire command. The controller
    # itself is never executed by this fixture.
    if extra is None:
        extra = ('--model', 'claude-sonnet-5') if role == 'launch' else ()
    encoded = base64.b64encode(source).decode() if encoded is None else encoded
    loader = "exec(compile(__import__('base64').b64decode('" + encoded + "'),'cc5-task-controller','exec'))"
    args = ['/usr/bin/python3', '-I', '-B', '-c', loader, role, root, *extra]
    return ' '.join("'" + arg.replace("'", "'\\''") + "'" for arg in args)


def environment(command=None):
    return {'SSH_ORIGINAL_COMMAND': gateway_command() if command is None else command,
            'SSH_CONNECTION': '38.55.252.217 45678 136.86.172.84 22',
            'SSH_CLIENT': '38.55.252.217 45678 22'}


class ReplacedProcess(Exception):
    pass


class GuardTests(unittest.TestCase):
    def invoke(self, env, execute, config=CONFIG, root=ROOT):
        with ExitStack() as stack:
            argv = [str(GUARD_PATH)] if root is None else [str(GUARD_PATH), '--task-root', root]
            stack.enter_context(patch.object(mod.sys, 'argv', argv))
            stack.enter_context(patch.object(mod, 'load_config', lambda: config))
            stack.enter_context(patch.dict(mod.os.environ, env, clear=True))
            stack.enter_context(patch.object(mod.os, 'isatty', lambda _: False))
            stack.enter_context(patch.object(mod.os, 'getuid', lambda: 1001))
            stack.enter_context(patch.object(mod.os, 'geteuid', lambda: 1001))
            stack.enter_context(patch.object(mod.pwd, 'getpwuid', lambda _: SimpleNamespace(pw_name='box', pw_dir='/home/box')))
            stack.enter_context(patch.object(mod.os, 'execve', execute))
            return mod.main()

    def test_all_five_exact_gateway_commands_pass_the_exec_boundary(self):
        for role in ('launch', 'tool-socket', 'stop', 'stop-socket', 'prove-stopped'):
            with self.subTest(role=role):
                calls = []
                def execute(executable, args, env):
                    calls.append((executable, args, env))
                    raise ReplacedProcess()
                incoming = {**environment(gateway_command(role)), 'HOME': '/untrusted',
                    'PYTHONPATH': '/untrusted', 'LD_PRELOAD': '/untrusted', 'BASH_ENV': '/untrusted',
                    'CLAUDE_CODE_MAX_RETRIES': '999', 'CREDENTIAL_FIXTURE': 'do-not-pass'}
                with self.assertRaises(ReplacedProcess):
                    self.invoke(incoming, execute)
                self.assertEqual(len(calls), 1)
                executable, args, env = calls[0]
                self.assertEqual(executable, '/usr/bin/python3')
                self.assertEqual(args[:4], ['/usr/bin/python3', '-I', '-B', '-c'])
                expected_tail = [role, ROOT]
                if role == 'launch':
                    expected_tail += ['--model', 'claude-sonnet-5']
                self.assertEqual(args[5:], expected_tail)
                self.assertEqual(args[4], "exec(compile(__import__('base64').b64decode('" + base64.b64encode(CONTROLLER).decode() + "'),'cc5-task-controller','exec'))")
                self.assertEqual(env, {'HOME': '/home/box', 'USER': 'box', 'LOGNAME': 'box',
                    'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                    'TMPDIR': ROOT + '/tmp', 'TMUX_TMPDIR': ROOT + '/tmux'})

    def test_unpinned_key_serves_every_chat_root_in_the_prefix_and_nothing_else(self):
        chat = '/home/box/oc-agentremote-l0123456789abcdef0123456'
        for role in ('provision', 'reset', 'tool-socket', 'launch', 'prove-stopped'):
            with self.subTest(role=role):
                calls = []
                def execute(executable, args, env):
                    calls.append((args, env))
                    raise ReplacedProcess()
                with self.assertRaises(ReplacedProcess):
                    self.invoke(environment(gateway_command(role, root=chat)), execute, root=None)
                args, env = calls[0]
                self.assertEqual(args[5:7], [role, chat])
                self.assertEqual((env['TMPDIR'], env['TMUX_TMPDIR']), (chat + '/tmp', chat + '/tmux'))
        for root in ('/home/box/oc-agentremote-short', '/home/other/oc-agentremote-l0123456789abcdef0123456',
                     '/home/box/oc-agentremote-l0123456789abcdef0123456/../x', '/home/box/.ssh'):
            with self.subTest(root=root):
                self.assertEqual(self.invoke(environment(gateway_command('reset', root=root)),
                                             lambda *_: self.fail('executed'), root=None), 126)
        # A pinned key still serves only its own root.
        self.assertEqual(self.invoke(environment(gateway_command('reset', root=chat)),
                                     lambda *_: self.fail('executed')), 126)
        self.assertEqual(self.invoke(environment(gateway_command('cleanup', root=chat)),
                                     lambda *_: self.fail('executed'), root=None), 126)

    def test_verified_source_runs_as_an_ordinary_python_child_with_exact_argv(self):
        source = b'import json,os,sys; print(json.dumps({"argv":sys.argv,"home":os.environ["HOME"],"leaked":"PYTHONPATH" in os.environ}))'
        digest = hashlib.sha256(source).hexdigest()
        config = {**CONFIG, 'controllerSha256': [digest]}
        calls = []
        def execute(executable, args, env):
            # Safe synthetic source only; the actual controller/Claude is never run.
            self.assertEqual(executable, '/usr/bin/python3')
            child = subprocess.run(args, env=env, capture_output=True, timeout=5, check=True)
            calls.append(json.loads(child.stdout))
            raise ReplacedProcess()
        with self.assertRaises(ReplacedProcess):
            self.invoke({**environment(gateway_command('prove-stopped', source=source)), 'PYTHONPATH': '/untrusted'}, execute, config)
        self.assertEqual(calls, [{'argv': ['-c', 'prove-stopped', ROOT], 'home': '/home/box', 'leaked': False}])

    def test_a_second_accepted_controller_build_and_an_account_directory_reach_the_child(self):
        calls = []
        def execute(executable, args, env):
            calls.append(args)
            raise ReplacedProcess()
        command = gateway_command(source=OTHER_CONTROLLER,
                                  extra=('--model', 'claude-opus-5', '--profile', 'acct-b'))
        with self.assertRaises(ReplacedProcess):
            self.invoke(environment(command), execute)
        self.assertEqual(calls[0][5:], ['launch', ROOT, '--model', 'claude-opus-5', '--profile', 'acct-b'])
        self.assertEqual(calls[0][4], "exec(compile(__import__('base64').b64decode('" + base64.b64encode(OTHER_CONTROLLER).decode() + "'),'cc5-task-controller','exec'))")

    def test_changed_shell_syntax_argv_source_root_role_or_model_never_execute(self):
        original = gateway_command()
        bad = {
            'concatenated': original + "'; /bin/sh #",
            'pipeline': original + ' | /bin/sh',
            'and': original + ' && /bin/sh',
            'newline': original + '\n/bin/sh',
            'cr': original + '\r',
            'nul': original + '\0',
            'extra-argv': original + " 'extra'",
            'leading-space': ' ' + original,
            'alternative-quoting': original.replace("'/usr/bin/python3'", '/usr/bin/python3', 1),
            'wrong-interpreter': original.replace('/usr/bin/python3', '/usr/bin/python'),
            'wrong-mode': original.replace("'-I'", "'-E'", 1),
            'wrong-code': gateway_command(source=CONTROLLER + b'\n# drift'),
            'wrong-root': gateway_command(root=ROOT + '-else'),
            'root-traversal': gateway_command(root='/home/box/../box/' + ROOT.rsplit('/', 1)[1]),
            'root-subdir': gateway_command(root=ROOT + '/subdir'),
            'other-role': gateway_command(role='snapshot'),
            'setup-role': gateway_command(role='install-profile'),
            'role-case': gateway_command(role='Launch'),
            'bad-base64': gateway_command(encoded='@@@'),
            'whitespace-base64': gateway_command(encoded='\n' + base64.b64encode(CONTROLLER).decode()),
            'noncanonical-base64': gateway_command(encoded=base64.b64encode(CONTROLLER).decode() + '='),
            'empty-source': gateway_command(source=b''),
            'oversized-source': gateway_command(source=b'x' * (mod.MAX_SOURCE_BYTES + 1)),
            'altered-loader': original.replace('cc5-task-controller', 'other-module'),
            'loader-statement': original.replace('cc5-task-controller', "cc5-task-controller;print(1)"),
            'unmatched-quote': "'",
            'empty': '',
            'model-not-configured': gateway_command(extra=('--model', 'claude-haiku-4')),
            'model-uppercase': gateway_command(extra=('--model', 'Claude-Opus-5')),
            'model-injection': gateway_command(extra=('--model', "x' ; /bin/sh #")),
            'model-missing': gateway_command(extra=()),
            'model-duplicated': gateway_command(extra=('--model', 'claude-sonnet-5', '--model', 'claude-opus-5')),
            'profile-not-configured': gateway_command(extra=('--model', 'claude-sonnet-5', '--profile', 'acct-z')),
            'profile-before-model': gateway_command(extra=('--profile', 'acct-a', '--model', 'claude-sonnet-5')),
            'profile-underscore': gateway_command(extra=('--model', 'claude-sonnet-5', '--profile', 'acct_a')),
            'profile-traversal': gateway_command(extra=('--model', 'claude-sonnet-5', '--profile', '../acct-a')),
            'model-on-helper-role': gateway_command('tool-socket', extra=('--model', 'claude-sonnet-5')),
            'profile-on-stop-role': gateway_command('stop', extra=('--profile', 'acct-a')),
        }
        for case, command in bad.items():
            with self.subTest(case=case):
                with self.assertRaises(mod.GuardRejected):
                    mod.verified_argv(command, CONFIG, ROOT)
                # Also exercise main: no malformed command can reach execve.
                if '\0' not in command:  # OS environment variables cannot contain NUL.
                    with patch.object(mod.os, 'execve') as execute, redirect_stderr(io.StringIO()) as err:
                        self.assertEqual(self.invoke(environment(command), execute), 126)
                        execute.assert_not_called()
                        self.assertEqual(err.getvalue(), 'CC5_SSH_COMMAND_REJECTED\n')
        with self.assertRaises(mod.GuardRejected): mod.verified_argv(None, CONFIG, ROOT)
        with self.assertRaises(mod.GuardRejected): mod.verified_argv(original, {**CONFIG, 'controllerSha256': ['0' * 64]}, ROOT)

    def test_configuration_is_exact_and_cannot_be_replaced_by_client_arguments(self):
        good = ['guard', '--task-root', ROOT]
        self.assertEqual(mod.fixed_config(good), ROOT)
        for args in (good + ['launch'], good + ['--controller-sha256', DIGEST], good[1:], good[:-1],
                ['guard', '--task-root', ROOT, '--model', 'claude-opus-5'],
                ['guard', '--controller-sha256', DIGEST, '--task-root', ROOT]):
            with self.subTest(args=args), self.assertRaises(mod.GuardRejected): mod.fixed_config(args)
        for root in ('/home/box/oc-agentremote-short', ROOT + '-x' * 40, ROOT.upper(),
                     ROOT + '/', ROOT + '/subdir',
                     '/home/box/../box/' + ROOT.rsplit('/', 1)[1],
                     '/home/box/oc-agentremote-20261102t0121z-3f42e18!',
                     '/home/other/oc-agentremote-t1555u-20261102t0121z-3f42e181'):
            with self.subTest(root=root), self.assertRaises(mod.GuardRejected):
                mod.task_root(CONFIG, root)
        self.assertEqual(mod.task_root(CONFIG, ROOT), ROOT)

    def test_installed_read_only_config_is_the_only_trust_root(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cc5-ssh-guard.json'
            def load(value, mode=0o600):
                path.write_text(json.dumps(value))
                os.chmod(path, mode)
                return mod.load_config(path)
            self.assertEqual(load(CONFIG), CONFIG)
            self.assertEqual(load({**CONFIG, 'profiles': []}), {**CONFIG, 'profiles': []})
            bad_values = {
                'not-an-object': [],
                'missing-key': {key: value for key, value in CONFIG.items() if key != 'profiles'},
                'extra-key': {**CONFIG, 'gatewayPty': True},
                'version-2': {**CONFIG, 'version': 2},
                'version-bool': {**CONFIG, 'version': True},
                'no-source-ip': {**CONFIG, 'sourceIps': []},
                'bad-source-ip': {**CONFIG, 'sourceIps': ['38.55.252']},
                'too-many-source-ips': {**CONFIG, 'sourceIps': ['38.55.252.217'] * 9},
                'root-user': {**CONFIG, 'user': 'root', 'home': '/home/root'},
                'bad-user': {**CONFIG, 'user': 'Box'},
                'home-mismatch': {**CONFIG, 'home': '/home/other'},
                'relative-home': {**CONFIG, 'home': 'home/box'},
                'port-zero': {**CONFIG, 'sshPort': 0},
                'port-string': {**CONFIG, 'sshPort': '22'},
                'prefix-outside-home': {**CONFIG, 'rootPrefix': '/home/other/oc-agentremote-'},
                'prefix-without-dash': {**CONFIG, 'rootPrefix': '/home/box/oc-agentremote'},
                'prefix-with-slash': {**CONFIG, 'rootPrefix': '/home/box/oc-agentremote-a/'},
                'no-digest': {**CONFIG, 'controllerSha256': []},
                'uppercase-digest': {**CONFIG, 'controllerSha256': [DIGEST.upper()]},
                'too-many-digests': {**CONFIG, 'controllerSha256': [DIGEST] * 9},
                'no-model': {**CONFIG, 'models': []},
                'bad-model': {**CONFIG, 'models': ['claude sonnet']},
                'too-many-models': {**CONFIG, 'models': ['m%d' % index for index in range(33)]},
                'bad-profile': {**CONFIG, 'profiles': ['acct_a']},
                'too-many-profiles': {**CONFIG, 'profiles': ['p%d' % index for index in range(33)]},
            }
            for case, value in bad_values.items():
                with self.subTest(case=case), self.assertRaises(mod.GuardRejected): load(value)
            with self.subTest(case='group-or-world-writable'), self.assertRaises(mod.GuardRejected):
                load(CONFIG, mode=0o666)
            with self.subTest(case='symlink'), self.assertRaises(OSError):
                link = Path(directory) / 'link.json'
                link.symlink_to(path)
                mod.load_config(link)
            with self.subTest(case='directory'), self.assertRaises((OSError, mod.GuardRejected)):
                mod.load_config(Path(directory))
            path.write_text('{')
            os.chmod(path, 0o600)
            with self.subTest(case='truncated-json'), self.assertRaises(ValueError):
                mod.load_config(path)

    def test_pty_forwarding_unknown_ssh_variables_and_wrong_source_are_rejected(self):
        bad_envs = [{**environment(), name: 'forbidden'} for name in (
            'SSH_TTY', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'DISPLAY', 'SSH_UNKNOWN', 'SSH_ASKPASS')]
        bad_envs.extend([{**environment(), 'SSH_CONNECTION': value} for value in (
            '', '38.55.252.218 45678 136.86.172.84 22', '38.55.252.217 0 136.86.172.84 22',
            '38.55.252.217 65536 136.86.172.84 22', '38.55.252.217 x 136.86.172.84 22',
            '38.55.252.217 45678 invalid 22', '38.55.252.217 45678 136.86.172.84 2222')])
        bad_envs.append({**environment(), 'SSH_CLIENT': '38.55.252.217 55555 22'})
        for env in bad_envs:
            with self.subTest(env=env), patch.object(mod.os, 'execve') as execute, redirect_stderr(io.StringIO()) as err:
                self.assertEqual(self.invoke(env, execute), 126)
                self.assertEqual(err.getvalue(), 'CC5_SSH_COMMAND_REJECTED\n')
                execute.assert_not_called()
        with patch.object(mod.os, 'isatty', lambda fd: fd == 1), self.assertRaises(mod.GuardRejected):
            mod.checked_environment(environment(), CONFIG, ROOT)
        # The sshd port and the accepted source addresses come from the installed
        # config, not from a constant or from the client.
        with patch.object(mod.os, 'isatty', lambda _: False), \
                patch.object(mod.os, 'getuid', lambda: 1001), \
                patch.object(mod.os, 'geteuid', lambda: 1001), \
                patch.object(mod.pwd, 'getpwuid', lambda _: SimpleNamespace(pw_name='box', pw_dir='/home/box')):
            self.assertEqual(mod.checked_environment(environment(), CONFIG, ROOT)['TMPDIR'], ROOT + '/tmp')
            for config in ({**CONFIG, 'sshPort': 2222}, {**CONFIG, 'sourceIps': ['38.55.252.1']}):
                with self.subTest(config=config), self.assertRaises(mod.GuardRejected):
                    mod.checked_environment(environment(), config, ROOT)

    def test_wrong_local_identity_and_exec_failure_are_closed_and_do_not_echo_input(self):
        with patch.object(mod.os, 'isatty', lambda _: False), \
                patch.object(mod.os, 'getuid', lambda: 0), self.assertRaises(mod.GuardRejected):
            mod.checked_environment(environment(), CONFIG, ROOT)
        for account in (SimpleNamespace(pw_name='other', pw_dir='/home/box'),
                        SimpleNamespace(pw_name='box', pw_dir='/home/other')):
            with patch.object(mod.os, 'isatty', lambda _: False), \
                    patch.object(mod.os, 'getuid', lambda: 1001), \
                    patch.object(mod.os, 'geteuid', lambda: 1001), \
                    patch.object(mod.pwd, 'getpwuid', lambda _, account=account: account), \
                    self.assertRaises(mod.GuardRejected):
                mod.checked_environment(environment(), CONFIG, ROOT)
        def denied(*_): raise PermissionError('sensitive-exec-detail')
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(self.invoke(environment(), denied), 126)
        self.assertEqual(err.getvalue(), 'CC5_SSH_COMMAND_REJECTED\n')
        child = subprocess.run([sys.executable, '-I', '-B', str(GUARD_PATH)],
            env={**os.environ, 'SSH_ORIGINAL_COMMAND': 'SECRET-FIXTURE'}, capture_output=True, timeout=5)
        self.assertEqual(child.returncode, 126)
        self.assertEqual(child.stdout, b'')
        self.assertEqual(child.stderr, b'CC5_SSH_COMMAND_REJECTED\n')


if __name__ == '__main__': unittest.main()
