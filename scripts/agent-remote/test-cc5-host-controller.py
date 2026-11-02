#!/usr/bin/env python3
"""Actual task files and ordinary Python argv only; no SSH, Claude, ps or credentials."""
import base64
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
from subprocess import CompletedProcess, PIPE, Popen
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('cc5-host-controller.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
SCRIPT = Path(__file__).with_name('cc5-fixed-mcp.py').read_bytes()


def packet():
    return {'version': 1, 'operationId': str(uuid4()), 'runId': str(uuid4()),
            'script': base64.b64encode(SCRIPT).decode(),
            'socketScript': base64.b64encode(Path(__file__).with_name('cc5-mcp-socket.py').read_bytes()).decode()}


class ProfileTests(unittest.TestCase):
    def installed(self, root):
        info = {'session': 'synthetic-task', 'cwd': str(root / 'work')}
        (root / 'work').mkdir(mode=0o700)
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(mod, 'owner', lambda _: dict(info)))
        stack.enter_context(patch.object(mod, 'check_sources', lambda *_: None))
        stack.enter_context(patch.object(mod, 'claude_executable', lambda *_args, **_kw: str(root / 'bin/claude-2.1.316')))
        stack.enter_context(patch.object(mod, 'tmux', lambda *_args, **_kw: CompletedProcess([], 1)))
        stack.enter_context(patch.object(mod.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(packet()).encode()))))
        with redirect_stdout(io.StringIO()):
            mod.install_profile(root)
        return info

    def test_real_profile_files_pin_the_sole_mcp_and_preserve_empty_cli_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            manifest = mod.check_profile(root)
            self.assertEqual(manifest['hashes']['cc5-fixed-mcp.py'], mod.PINNED_MCP_SHA)
            config = json.loads((root / 'cprofile/mcp.json').read_bytes())
            self.assertEqual(config, {'mcpServers': {'ocbridge': {'command': '/usr/bin/python3',
                'args': ['-I', str(root / 'cprofile/cc5-fixed-mcp.py'), str(root)]}}})
            args = mod.profile_args(root, info)
            self.assertEqual(args[args.index('--tools') + 1], '')
            self.assertEqual(args[args.index('--setting-sources') + 1], '')
            self.assertIn('--strict-mcp-config', args)
            self.assertEqual(args[-2:], ['--allowedTools', 'mcp__ocbridge__roundtrip'])
            self.assertTrue(all((p.stat().st_mode & 0o777) == 0o400 for p in (root / 'cprofile').iterdir()))

    def test_installer_rejects_running_task_hash_changes_or_extra_packet_fields_before_publish(self):
        for case in ('run', 'session', 'setup', 'hash', 'extra'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                root = Path(temp)
                data = packet()
                if case == 'run': (root / 'run').mkdir()
                if case == 'hash': data['script'] = base64.b64encode(SCRIPT + b'\n# drift').decode()
                if case == 'extra': data['command'] = '/bin/sh'
                stack.enter_context(patch.object(mod, 'owner', lambda _: {'session': 'own-task'}))
                stack.enter_context(patch.object(mod, 'check_sources', lambda *_: None))
                stack.enter_context(patch.object(mod, 'claude_executable', lambda *_: str(root / 'bin/claude-2.1.316')))
                def tmux(_root, *args, **kw):
                    active = '=own-task-setup' if case == 'setup' else '=own-task'
                    return CompletedProcess([], 0 if case in ('session', 'setup') and active in args else 1)
                stack.enter_context(patch.object(mod, 'tmux', tmux))
                stack.enter_context(patch.object(mod.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(data).encode()))))
                with redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError): mod.install_profile(root)
                self.assertFalse((root / 'cprofile').exists())
                self.assertFalse((root / 'cprofile.partial').exists())

    def test_profile_drift_or_mode_changes_block_launch_argument_creation(self):
        for case in ('client', 'config', 'script', 'mode'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                info = self.installed(root)
                path = root / 'cprofile' / {'client': 'client.json', 'config': 'mcp.json',
                    'script': 'cc5-fixed-mcp.py', 'mode': 'client.json'}[case]
                path.chmod(0o600)
                if case != 'mode':
                    path.write_bytes(path.read_bytes() + b' ')
                    path.chmod(0o400)
                with self.assertRaises(RuntimeError): mod.profile_args(root, info)

    def test_proc_preserves_security_significant_empty_arguments_in_a_real_python_child(self):
        child = Popen([sys.executable, '-c', 'import time; print("READY", flush=True); time.sleep(15)', '--tools', '', '--setting-sources', ''], stdout=PIPE)
        self.assertEqual(child.stdout.readline(), b'READY\n')
        try:
            args, start = mod.proc(child.pid)
            self.assertEqual(args[-4:], ['--tools', '', '--setting-sources', ''])
            self.assertTrue(start.isdecimal())
        finally:
            child.terminate()
            child.wait(timeout=3)
            child.stdout.close()

    def test_host_identity_rejects_missing_extra_or_changed_flags(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            (root / 'run').mkdir()
            (root / 'run/host.pid').write_text('444')
            args = ['/usr/bin/python3', str(root / 'install/host.py'), str(root / 'run'), info['session'],
                    *mod.profile_args(root, info)]
            with patch.object(mod, 'proc', lambda _: (args, '100')):
                self.assertEqual(mod.host_identity(root, info), (444, '100'))
            for bad in (args[:-1], args + ['--print'], [a for a in args if a != '']):
                with patch.object(mod, 'proc', lambda _: (bad, '100')):
                    with self.assertRaisesRegex(RuntimeError, 'wrong-host-process'): mod.host_identity(root, info)

    def test_stop_before_ready_does_not_require_a_claude_pid_and_signal_is_not_exit_proof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            (root / 'run').mkdir()
            with patch.object(mod, 'host_identity', lambda *_: (444, '100')), \
                    patch.object(mod, 'proc', lambda _: (['synthetic-task-host'], '100')), \
                    patch.object(mod.os, 'pidfd_open', lambda _: 987), \
                    patch.object(mod.os, 'close') as close, \
                    patch.object(mod.signal, 'pidfd_send_signal') as send, redirect_stdout(io.StringIO()) as out:
                mod.stop(root)
                self.assertEqual(json.loads(out.getvalue())['kind'], 'sent-term-to-verified-task-host')
                send.assert_called_once()
                close.assert_any_call(987)
            with self.assertRaisesRegex(RuntimeError, 'runtime-or-session-present'): mod.prove_stopped(root)

    def test_repeated_inspection_retains_a_real_live_old_descendant_and_blocks_relaunch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            child = Popen([sys.executable, '-c', 'import time; time.sleep(15)'])
            try:
                old_child = mod.process_record(child.pid)
                host = {'pid': 2000000000, 'startTicks': '1'}
                mod.write_lifecycle(root, info, {'host': host, 'claude': None, 'descendants': [old_child]})
                # It no longer appears in a later ancestor scan, but remains alive.
                mod.write_lifecycle(root, info, {'host': host, 'claude': None, 'descendants': []})
                saved = (root / 'LIFECYCLE.json').read_bytes()
                self.assertIn(old_child, json.loads(saved)['descendants'])
                with self.assertRaisesRegex(RuntimeError, 'process-still-alive'): mod.prove_stopped(root)
                with patch.object(mod.os, 'execve') as execute:
                    with self.assertRaisesRegex(RuntimeError, 'process-still-alive'): mod.launch(root)
                    execute.assert_not_called()
                self.assertEqual((root / 'LIFECYCLE.json').read_bytes(), saved)
                child.terminate()
                child.wait(timeout=3)
                with redirect_stdout(io.StringIO()): mod.prove_stopped(root)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=3)

    def test_independent_mcp_socket_process_must_also_exit_before_positive_stop_proof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            profile = mod.check_profile(root)
            child = Popen([sys.executable, '-c', 'import time; print("READY",flush=True); time.sleep(15)'], stdout=PIPE)
            try:
                self.assertEqual(child.stdout.readline(), b'READY\n')
                identity = {'version': 1, 'root': str(root), 'runId': profile['runId'],
                    'operationId': profile['operationId'], **mod.process_record(child.pid)}
                (root / 'MCP-SOCKET.json').write_text(json.dumps(identity))
                (root / 'MCP-SOCKET.json').chmod(0o600)
                mod.write_lifecycle(root, info, {'host': {'pid': 2000000000, 'startTicks': '1'},
                    'claude': None, 'descendants': []})
                with self.assertRaisesRegex(RuntimeError, 'process-still-alive'): mod.prove_stopped(root)
                child.terminate(); child.wait(timeout=3)
                with redirect_stdout(io.StringIO()) as output: mod.prove_stopped(root)
                self.assertEqual(json.loads(output.getvalue())['mcpSocketIdentity'], identity)
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)
                child.stdout.close()

    def test_early_host_identity_stops_real_owned_python_even_without_host_pid_or_runtime(self):
        for with_run in (False, True):
            with self.subTest(with_run=with_run), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                info = self.installed(root)
                if with_run: (root / 'run').mkdir()
                child = Popen([sys.executable, '-c', 'import time; print("READY",flush=True); time.sleep(15)',
                    'launch', str(root)], stdout=PIPE)
                try:
                    self.assertEqual(child.stdout.readline(), b'READY\n')
                    args, ticks = mod.proc(child.pid)
                    identity = {'pid': child.pid, 'startTicks': ticks}
                    mod.write_lifecycle(root, info, {'host': identity, 'claude': None, 'descendants': [],
                        'launchArgvHash': mod.sha(mod.canonical(args))})
                    self.assertEqual(mod.host_identity(root, info), (child.pid, ticks))
                    with redirect_stdout(io.StringIO()) as output: mod.stop(root)
                    self.assertEqual(json.loads(output.getvalue())['kind'], 'sent-term-to-verified-task-host')
                    child.wait(timeout=3)
                    if with_run:
                        with self.assertRaisesRegex(RuntimeError, 'runtime-or-session-present'): mod.prove_stopped(root)
                        (root / 'run').rmdir()  # Fixture only, after waiting for actual child exit.
                    with redirect_stdout(io.StringIO()): mod.prove_stopped(root)
                finally:
                    if child.poll() is None: child.terminate(); child.wait(timeout=3)
                    child.stdout.close()

    def test_stop_before_any_launch_persists_a_terminal_marker_and_blocks_late_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.installed(root)
            with redirect_stdout(io.StringIO()): mod.stop(root)
            marker = (root / 'STOPPING.json').read_bytes()
            with patch.object(mod.os, 'execve') as execute:
                for entry in (mod.launch, mod.tool_socket):
                    with self.assertRaisesRegex(RuntimeError, 'permanently-stopped'): entry(root)
                execute.assert_not_called()
            with redirect_stdout(io.StringIO()): mod.stop(root)
            self.assertEqual((root / 'STOPPING.json').read_bytes(), marker)
            with self.assertRaises(FileNotFoundError): mod.prove_stopped(root)

    def test_control_lock_waits_for_real_pre_lifecycle_child_and_is_not_inheritable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.installed(root)
            script = "import fcntl,os,sys; f=open(sys.argv[1],'w'); os.chmod(sys.argv[1],0o600); fcntl.flock(f,fcntl.LOCK_EX); print('LOCKED',flush=True); sys.stdin.readline()"
            child = Popen([sys.executable, '-c', script, str(root / 'CONTROL.lock')], stdin=PIPE, stdout=PIPE)
            try:
                self.assertEqual(child.stdout.readline(), b'LOCKED\n')
                # A separate process attempts the same real flock, releases only after our barrier.
                waiter = Popen([sys.executable, '-c',
                    "import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR|os.O_CLOEXEC); print('WAIT',flush=True); fcntl.flock(f,fcntl.LOCK_EX); print('ACQUIRED',flush=True)",
                    str(root / 'CONTROL.lock')], stdout=PIPE)
                self.assertEqual(waiter.stdout.readline(), b'WAIT\n')
                self.assertIsNone(waiter.poll())
                child.stdin.write(b'release\n'); child.stdin.flush(); child.wait(timeout=3)
                self.assertEqual(waiter.stdout.readline(), b'ACQUIRED\n'); waiter.wait(timeout=3)
                waiter.stdout.close()
                with mod.control_lock(root):
                    matches = [int(p.name) for p in Path('/proc/self/fd').iterdir()
                        if p.exists() and p.resolve() == root / 'CONTROL.lock']
                    self.assertEqual(len(matches), 1)
                    self.assertFalse(os.get_inheritable(matches[0]))
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)
                child.stdin.close(); child.stdout.close()

    def test_independent_socket_stop_rechecks_real_pid_identity_before_signalling(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.installed(root)
            profile = mod.check_profile(root)
            path = root / 'cprofile/cc5-mcp-socket.py'
            path.chmod(0o600)
            path.write_text("import time; print('READY',flush=True); time.sleep(15)")
            path.chmod(0o400)
            child = Popen(['/usr/bin/python3', '-I', '-B', str(path), str(root)], stdout=PIPE)
            try:
                self.assertEqual(child.stdout.readline(), b'READY\n')
                record = {'version': 1, 'root': str(root), 'runId': profile['runId'],
                    'operationId': profile['operationId'], **mod.process_record(child.pid)}
                target = root / 'MCP-SOCKET.json'
                target.write_text(json.dumps({**record, 'startTicks': '1'})); target.chmod(0o600)
                # This fixture deliberately runs ordinary Python in place of the pinned sidecar.
                with patch.object(mod, 'check_profile', lambda _: profile), redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, 'wrong-stop-mcp-process'): mod.stop_socket(root)
                    self.assertIsNone(child.poll())
                    target.write_text(json.dumps(record))
                    mod.stop_socket(root)
                child.wait(timeout=3)
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)
                child.stdout.close()

    def test_cleanup_refuses_own_live_process_or_main_setup_session(self):
        for case in ('live', 'main', 'setup', 'stopped'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / 'root'
                root.mkdir(mode=0o700)
                info = self.installed(root)
                mod.write_lifecycle(root, info, {'host': {'pid': 444, 'startTicks': '100'},
                    'claude': {'pid': 445, 'startTicks': '101'}, 'descendants': []})
                def proc(pid):
                    if case == 'live' and pid == 444: return ([], '100')
                    raise FileNotFoundError()
                def tmux(_root, *args, **kw):
                    active = '=synthetic-task-setup' if case == 'setup' else '=synthetic-task'
                    return CompletedProcess([], 0 if case in ('main', 'setup') and active in args else 1)
                with patch.object(mod, 'proc', proc), patch.object(mod, 'tmux', tmux), redirect_stdout(io.StringIO()):
                    if case == 'stopped':
                        mod.prove_stopped(root)
                        mod.cleanup(root)
                        self.assertFalse(root.exists())
                    else:
                        with self.assertRaises(RuntimeError): mod.cleanup(root)
                        self.assertTrue(root.exists())


if __name__ == '__main__': unittest.main()
