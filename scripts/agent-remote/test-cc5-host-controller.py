#!/usr/bin/env python3
"""Actual task files and ordinary Python argv only; no SSH, Claude, ps or credentials."""
import base64
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import threading
from pathlib import Path
from subprocess import CompletedProcess, PIPE, Popen
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('cc5-host-controller.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
SCRIPT = Path(__file__).with_name('cc5-fixed-mcp.py').read_bytes()


def packet():
    return {'version': 2, 'operationId': str(uuid4()), 'runId': str(uuid4()),
            'script': base64.b64encode(SCRIPT).decode(),
            'socketScript': base64.b64encode(Path(__file__).with_name('cc5-mcp-socket.py').read_bytes()).decode()}


def stat_mode(path):
    return path.stat().st_mode & 0o777


def tool(name='t0', description='ok', schema=None):
    return {'name': name, 'description': description,
            'inputSchema': {'type': 'object'} if schema is None else schema}


def catalog(tools=None):
    return json.dumps({'tools': [tool('t0', 'Read in the personal container.'),
                                 tool('tool_two', 'Nested arguments.')] if tools is None else tools})


def session_packet(text=None, prompt='Platform lane system prompt.\n'):
    text = catalog() if text is None else text
    return {'version': 1, 'catalog': text, 'catalogSha256': mod.sha(text.encode()), 'prompt': prompt}


class ProfileTests(unittest.TestCase):
    def install_session(self, root, data=None):
        with patch.object(mod.sys, 'stdin', SimpleNamespace(
                buffer=io.BytesIO(json.dumps(data or session_packet()).encode()))), \
                redirect_stdout(io.StringIO()) as out:
            mod.session_profile(root)
        return json.loads(out.getvalue())

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
        self.install_session(root)
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
            # Built-in default before any launch record exists; a launch record overrides it.
            self.assertEqual(args[args.index('--model') + 1], 'claude-sonnet-5')
            self.assertEqual(args[args.index('--tools') + 1], '')
            self.assertEqual(args[args.index('--setting-sources') + 1], '')
            self.assertIn('--strict-mcp-config', args)
            # The catalog, in catalog order, decides which tools the model may call at all.
            self.assertEqual(args[args.index('--allowedTools') + 1], 'mcp__ocbridge__t0,mcp__ocbridge__tool_two')
            self.assertEqual(args[args.index('--append-system-prompt-file') + 1], str(root / 'session/prompt.md'))
            self.assertTrue(all((p.stat().st_mode & 0o777) == 0o400 for p in (root / 'cprofile').iterdir()))

    def test_session_profile_writes_exact_bytes_and_modes_and_replaces_a_previous_lane(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.installed(root)
            directory = root / 'session'
            text = catalog()
            self.assertEqual(stat_mode(directory), 0o700)
            self.assertEqual((directory / 'catalog.json').read_bytes(), text.encode())
            self.assertEqual((directory / 'prompt.md').read_bytes(), b'Platform lane system prompt.\n')
            self.assertTrue(all(stat_mode(directory / name) == 0o400
                                for name in ('catalog.json', 'prompt.md', 'SESSION.json')))
            self.assertEqual(json.loads((directory / 'SESSION.json').read_bytes()),
                             {'version': 1, 'task': mod.TASK, 'root': str(root),
                              'catalogSha256': mod.sha(text.encode()),
                              'promptSha256': mod.sha(b'Platform lane system prompt.\n')})
            self.assertEqual([item['name'] for item in mod.check_session(root)['tools']], ['t0', 'tool_two'])
            # A new lane's complete staging directory replaces the old one in one rename.
            changed = catalog([tool('t7', 'only tool')])
            printed = self.install_session(root, session_packet(changed, 'second prompt'))
            self.assertEqual(printed, {'kind': 'session-profile-installed', 'root': str(root),
                'catalogSha256': mod.sha(changed.encode()),
                'promptSha256': mod.sha(b'second prompt'), 'tools': 1})
            self.assertEqual((directory / 'catalog.json').read_bytes(), changed.encode())
            self.assertEqual((directory / 'prompt.md').read_bytes(), b'second prompt')
            self.assertEqual([item['name'] for item in mod.check_session(root)['tools']], ['t7'])
            self.assertEqual({path.name for path in directory.iterdir()},
                             {'catalog.json', 'prompt.md', 'SESSION.json'})
            self.assertFalse((root / 'session.partial').exists())

    def test_session_profile_rejects_bad_catalog_prompt_or_live_runtime_before_any_write(self):
        base = session_packet()
        cases = {
            'bad-sha': {**base, 'catalogSha256': '0' * 64},
            'duplicate-name': session_packet(catalog([tool('t0'), tool('t0')])),
            'bad-name': session_packet(catalog([tool('bad name!')])),
            'long-name': session_packet(catalog([tool('x' * 49)])),
            'empty-name': session_packet(catalog([tool('')])),
            'no-tools': session_packet(catalog([])),
            'too-many-tools': session_packet(catalog([tool('t%d' % index) for index in range(129)])),
            'duplicate-json-key': session_packet('{"tools":[],"tools":[]}'),
            'extra-catalog-key': session_packet('{"tools":[%s],"other":1}' % json.dumps(tool())),
            'extra-tool-key': session_packet(catalog([{**tool(), 'extra': True}])),
            'schema-not-object': session_packet(catalog([tool(schema={'type': 'array'})])),
            'schema-not-dict': session_packet(catalog([tool(schema=[])])),
            'long-description': session_packet(catalog([tool(description='x' * (20 * 1024 + 1))])),
            'catalog-too-large': session_packet(catalog([tool('t%d' % index, 'x' * (19 * 1024))
                                                         for index in range(64)])),
            'prompt-too-large': session_packet(prompt='x' * (256 * 1024 + 1)),
            'prompt-nul': session_packet(prompt='a\x00b'),
            'prompt-not-string': session_packet(prompt=5),
            'catalog-not-string': {**base, 'catalog': 5},
            'packet-extra-key': {**base, 'extra': 1},
            'packet-version': {**base, 'version': 2},
            'runtime': base,
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.installed(root)
            directory = root / 'session'
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            for case, data in cases.items():
                with self.subTest(case=case):
                    if case == 'runtime':
                        (root / 'run').mkdir()
                    try:
                        with self.assertRaises(RuntimeError):
                            self.install_session(root, data)
                    finally:
                        if (root / 'run').exists():
                            (root / 'run').rmdir()
                    self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)
                    self.assertFalse((root / 'session.partial').exists())

    def test_launch_without_an_installed_session_fails_before_exec(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            info['pluginDigest'] = 'fixture'
            files = {'mod/oc-bridge/' + name: b'fixture' for name in mod.PLUGIN}
            shutil.rmtree(root / 'session')
            with patch.object(mod, 'check_sources', lambda *_: files), patch.object(mod.os, 'execve') as execute:
                with self.assertRaisesRegex(RuntimeError, 'missing-session-profile'):
                    mod.launch(root, 'claude-sonnet-5')
                execute.assert_not_called()

    def test_task_root_belongs_to_the_target_account_home(self):
        home = Path.home()
        root = home / 'oc-agentremote-t20261106t0000z-abcdef0123456789'
        with patch.object(mod.os, 'getuid', lambda: 1000):
            self.assertEqual(mod.task_root(str(root)), root)
        with patch.object(mod.os, 'getuid', lambda: 0), self.assertRaises(RuntimeError):
            mod.task_root(str(root))
        for bad in ('/home/someoneelse/oc-agentremote-t20261106t0000z-abcdef0123456789',
                    str(home / 'oc-agentremote-short'),
                    str(home / 'other-task-abcdef0123456789xyz'),
                    str(home / 'oc-agentremote-ABCDEF0123456789xyz'),
                    str(root) + '/sub'):
            with self.subTest(root=bad), self.assertRaises(RuntimeError):
                mod.task_root(bad)

    def test_launch_passes_native_guards_and_the_target_model_to_the_real_exec_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = {**self.installed(root), 'pluginDigest': 'synthetic-plugin-digest'}
            files = {'mod/oc-bridge/' + name: b'synthetic-plugin' for name in mod.PLUGIN}
            with patch.object(mod, 'owner', lambda _: dict(info)), \
                    patch.object(mod, 'check_sources', lambda *_: files), \
                    patch.object(mod, 'process_record', lambda _: {'pid': 444, 'startTicks': '1'}), \
                    patch.object(mod, 'proc', lambda _: (['synthetic-controller'], '1')), \
                    patch.object(mod, 'write_lifecycle') as lifecycle, \
                    patch.object(mod, 'HOME', root), \
                    patch.object(mod.os, 'chdir') as chdir, \
                    patch.object(mod.os, 'execve') as execute, \
                    patch.dict(mod.os.environ, {'CLAUDE_CODE_MAX_RETRIES': '99', 'PYTHONPATH': '/untrusted'}):
                (root / '.claude-acct-a').mkdir()
                with mod.writer_lock(root) as writer_fd:
                    mod.launch_locked(root, writer_fd, 'claude-opus-5', 'acct-a')
            lifecycle.assert_called_once()
            chdir.assert_called_once_with(info['cwd'])
            execute.assert_called_once()
            executable, args, environment = execute.call_args.args
            self.assertEqual(executable, sys.executable)
            self.assertEqual(args[:4], [sys.executable, str(root / 'install/host.py'), str(root / 'run'), info['session']])
            # The model and account directory come from the target, not from a constant.
            self.assertEqual(args[args.index('--model') + 1], 'claude-opus-5')
            self.assertEqual(environment['OC_BOX_CLAUDE_PROFILE'], 'acct-a')
            self.assertEqual(environment['HOME'], str(root))  # The node account's home.
            self.assertTrue(json.loads((root / '.claude-acct-a/.claude.json').read_text())
                            ['projects'][info['cwd']]['hasTrustDialogAccepted'])
            self.assertTrue(all(flag not in args for flag in ('-p', '--print', '--output-format', '--input-format')))
            self.assertEqual({name: environment[name] for name in (
                'CLAUDE_CODE_DISABLE_REFUSAL_RETRY', 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')}, {
                'CLAUDE_CODE_DISABLE_REFUSAL_RETRY': '1', 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS': '0',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'})
            # Same MCP output ceiling as the Box path.
            self.assertEqual(environment['MAX_MCP_OUTPUT_TOKENS'], '4000000')
            # A real chat keeps the CLI's native retries and output limit; the inherited value is dropped too.
            self.assertNotIn('CLAUDE_CODE_MAX_RETRIES', environment)
            self.assertNotIn('CLAUDE_CODE_MAX_OUTPUT_TOKENS', environment)
            self.assertNotIn('PYTHONPATH', environment)
            # First round of a task: it names its one Claude session; nothing to resume yet.
            self.assertEqual(args[-2], '--session-id')
            self.assertRegex(args[-1], mod.UUID)

    def test_profile_args_take_model_resume_and_account_from_the_launch_record(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            session = str(uuid4())
            args = mod.profile_args(root, {**info, 'model': 'claude-opus-5',
                                           'sessionArgs': ['--resume', session], 'profileDir': 'acct-a'})
            self.assertEqual(args[args.index('--model') + 1], 'claude-opus-5')
            self.assertEqual(args[-2:], ['--resume', session])
            self.assertEqual(args[args.index('--tools') + 1], '')
            self.assertEqual(args[args.index('--setting-sources') + 1], '')
            self.assertNotIn('--continue', args)
            for record, error in (({'model': '/bin/sh'}, 'unapproved-model'),
                                  ({'model': 'Claude Sonnet'}, 'unapproved-model'),
                                  ({'sessionArgs': ['--resume', '../../etc/passwd']}, 'bad-claude-session'),
                                  ({'sessionArgs': ['--continue', session]}, 'bad-claude-session'),
                                  ({'profileDir': 'Acct/1'}, 'bad-account-directory')):
                with self.subTest(record=record), self.assertRaisesRegex(RuntimeError, error):
                    if 'profileDir' in record:
                        mod.account_name({**info, **record})
                    else:
                        mod.profile_args(root, {**info, **record})

    def test_stopped_task_starts_a_new_round_in_real_role_order_and_resumes_its_own_session(self):
        """Each start round is tool-socket then launch (Cc5SshHost.initialize), on the same root."""
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / 'task'
            root.mkdir(mode=0o700)
            info = self.installed(root)
            (root / 'OWNER.json').write_text(json.dumps({
                'task': mod.TASK, 'root': str(root), 'uid': os.getuid(), 'session': info['session'],
                'cwd': info['cwd'], 'pluginDigest': 'synthetic-plugin-digest'}))
            (root / 'OWNER.json').chmod(0o600)
            profile = mod.check_profile(root)
            files = {'mod/oc-bridge/' + name: b'synthetic-plugin' for name in mod.PLUGIN}
            dead = {'pid': 2000000000, 'startTicks': '1'}

            def socket_published(identity):
                path = root / 'MCP-SOCKET.json'
                path.write_text(json.dumps({'version': 1, 'root': str(root), 'runId': profile['runId'],
                                            'operationId': profile['operationId'], **identity}))
                path.chmod(0o600)

            def start_round():
                with patch.object(mod.os, 'execve') as socket_exec:
                    mod.tool_socket(root)
                socket_exec.assert_called_once()
                # The new round's socket is alive while the host launches next to it.
                self.assertFalse((root / 'MCP-SOCKET.json').exists())
                socket_published({'pid': os.getpid(), 'startTicks': mod.proc(os.getpid())[1]})
                with patch.object(mod.os, 'chdir'), patch.object(mod.os, 'execve') as host_exec:
                    mod.launch(root, 'claude-opus-5', 'acct-b')
                return host_exec.call_args.args

            def end_round():
                socket_published(dead)  # Both recorded processes of this round have exited.
                with redirect_stdout(io.StringIO()):
                    mod.prove_stopped(root)
                mod.mark_stopping(root)

            with patch.object(mod, 'owner', lambda r: json.loads((r / 'OWNER.json').read_text())), \
                    patch.object(mod, 'check_sources', lambda *_: files), \
                    patch.object(mod, 'tmux', lambda *_a, **_k: CompletedProcess([], 1)), \
                    patch.object(mod, 'process_record', lambda _: dict(dead)), \
                    patch.object(mod, 'HOME', base / 'home'):
                (base / 'home/.claude-acct-b').mkdir(parents=True)
                _exe, first, environment = start_round()
                self.assertEqual(first[-2], '--session-id')
                session = first[-1]
                self.assertEqual(environment['OC_BOX_CLAUDE_PROFILE'], 'acct-b')
                # Claude wrote its transcript into the shared projects tree; a newer foreign one sits beside it.
                projects = base / 'home/.claude/projects' / re.sub(r'[^A-Za-z0-9]', '-', info['cwd'])
                projects.mkdir(parents=True)
                (projects / (session + '.jsonl')).write_text('{}\n')
                os.utime(projects / (session + '.jsonl'), (100, 100))
                (projects / (str(uuid4()) + '.jsonl')).write_text('{}\n')
                end_round()

                _exe, second, _env = start_round()
                self.assertEqual(second[-2:], ['--resume', session])
                self.assertEqual(second[second.index('--model') + 1], 'claude-opus-5')
                self.assertFalse((root / 'STOPPED.json').exists())
                self.assertFalse((root / 'STOPPING.json').exists())
                end_round()
                # Third round still resumes the same session; the root never wears out.
                _exe, third, _env = start_round()
                self.assertEqual(third[-2:], ['--resume', session])
            owner = json.loads((root / 'OWNER.json').read_text())
            self.assertEqual((owner['model'], owner['profileDir'], owner['sessionArgs']),
                             ('claude-opus-5', 'acct-b', ['--resume', session]))

    def test_launch_trusts_only_its_own_work_directory_in_the_launching_account_config(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            (home / '.claude-acct-b').mkdir()
            other = {'projects': {'/elsewhere': {'hasTrustDialogAccepted': False, 'history': [1]}},
                     'oauthAccount': {'kept': True}}
            (home / '.claude.json').write_text(json.dumps(other))
            with patch.object(mod, 'HOME', home):
                mod.trust_task_directory({'cwd': '/t/work', 'profileDir': 'acct-b'})
                mod.trust_task_directory({'cwd': '/t/work', 'profileDir': None})
                # The CLI holds its lock: the controller waits instead of racing its write.
                (home / '.claude.json.lock').mkdir()
                with patch.object(mod.time, 'sleep'), self.assertRaisesRegex(RuntimeError, 'account-config-locked'):
                    mod.trust_task_directory({'cwd': '/t/other', 'profileDir': None})
            account = json.loads((home / '.claude-acct-b/.claude.json').read_text())
            self.assertEqual(account, {'projects': {'/t/work': {'hasTrustDialogAccepted': True}}})
            default = json.loads((home / '.claude.json').read_text())
            self.assertEqual(default['projects']['/t/work'], {'hasTrustDialogAccepted': True})
            self.assertEqual(default['projects']['/elsewhere'], other['projects']['/elsewhere'])
            self.assertEqual(default['oauthAccount'], {'kept': True})
            self.assertNotIn('/t/other', default['projects'])
            self.assertEqual((home / '.claude.json').stat().st_mode & 0o777, 0o600)

    def test_a_round_launches_once_and_an_unproved_old_round_blocks_the_next(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            child = Popen([sys.executable, '-c', 'import time; time.sleep(15)'])
            try:
                mod.write_lifecycle(root, info, {'host': mod.process_record(child.pid), 'claude': None,
                                                 'descendants': []})
                with patch.object(mod.os, 'execve') as execute:
                    with self.assertRaisesRegex(RuntimeError, 'process-still-alive'): mod.tool_socket(root)
                    with self.assertRaisesRegex(RuntimeError, 'process-still-alive'): mod.launch(root, 'claude-sonnet-5')
                    execute.assert_not_called()
                self.assertTrue((root / 'LIFECYCLE.json').exists())
                child.terminate(); child.wait(timeout=3)
                # Exited but this round already launched: only tool-socket may open the next one.
                with patch.object(mod.os, 'execve') as execute:
                    with self.assertRaisesRegex(RuntimeError, 'already-used'): mod.launch(root, 'claude-sonnet-5')
                    execute.assert_not_called()
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)

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

    def test_new_exact_root_keeps_old_profile_unchanged_and_reinstall_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            old = Path(temp) / 'old'; old.mkdir(mode=0o700)
            self.installed(old)
            saved = {p.name: p.read_bytes() for p in (old / 'cprofile').iterdir()}
            new = Path(temp) / 'new'; new.mkdir(mode=0o700)
            self.installed(new)
            self.assertNotEqual(mod.check_profile(old)['runId'], mod.check_profile(new)['runId'])
            with patch.object(mod.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(packet()).encode()))):
                with self.assertRaisesRegex(RuntimeError, 'profile-already-exists'): mod.install_profile(new)
            self.assertEqual({p.name: p.read_bytes() for p in (old / 'cprofile').iterdir()}, saved)

    def test_real_exec_retains_writer_flock_but_stop_control_does_not_deadlock_and_proof_survives(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            (root / 'install').mkdir(mode=0o700)
            # This executable is ordinary local Python, never the real host/Claude.
            (root / 'install/host.py').write_text('''import json,os,sys
from pathlib import Path
root=Path(sys.argv[1]).parent
lock=json.loads((root/'LIFECYCLE.json').read_text())['writerLock']
fd=lock['fd']; st=os.fstat(fd)
info=Path('/proc/self/fdinfo')/str(fd)
print(json.dumps({'pid':os.getpid(),'fd':fd,'dev':st.st_dev,'inode':st.st_ino,'inheritable':os.get_inheritable(fd),'fdinfo':info.read_text() if info.exists() else ''}),flush=True)
sys.stdin.readline()
''')
            wrapper = '''import importlib.util,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('controller',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=Path(sys.argv[2]);m.owner=lambda _: {'session':'synthetic-task','cwd':str(r/'work'),'pluginDigest':'fixture'}
m.check_sources=lambda *_: {'mod/oc-bridge/'+name:b'fixture' for name in m.PLUGIN}
m.claude_executable=lambda *_args,**_kw:'fixture';m.profile_args=lambda *_:[]
m.proc=lambda pid:(['synthetic-controller'],'1');m.process_record=lambda pid:{'pid':pid,'startTicks':'1'}
m.launch(r,'claude-sonnet-5')
'''
            child = Popen([sys.executable, '-I', '-B', '-c', wrapper, str(Path(mod.__file__).resolve()), str(root)], stdin=PIPE, stdout=PIPE)
            try:
                report = json.loads(child.stdout.readline())
                record = json.loads((root / 'LIFECYCLE.json').read_text())
                self.assertEqual(report['pid'], child.pid, 'exec retained original host process')
                self.assertTrue(report['inheritable'])
                self.assertEqual({key: report[key] for key in ('fd', 'dev', 'inode')}, record['writerLock'])
                if sys.platform.startswith('linux'):
                    self.assertRegex(report['fdinfo'], r'FLOCK\s+ADVISORY\s+WRITE\s+' + str(child.pid))
                with self.assertRaisesRegex(RuntimeError, 'writer-already-active'):
                    with mod.writer_lock(root): self.fail('second writer acquired live lock')
                # Actual control flock remains independently acquirable after exec.
                began = time.monotonic()
                with patch.object(mod, 'host_identity', lambda *_: (child.pid, '1')), \
                        patch.object(mod, 'proc', lambda _: (['synthetic-host'], '1')), \
                        patch.object(mod.os, 'pidfd_open', lambda _: os.open(os.devnull, os.O_RDONLY), create=True), \
                        patch.object(mod.signal, 'pidfd_send_signal', lambda *_: child.terminate(), create=True), \
                        redirect_stdout(io.StringIO()):
                    mod.stop(root)
                self.assertLess(time.monotonic() - began, 2)
                child.wait(timeout=3)
                with mod.writer_lock(root): pass
                with patch.object(mod, 'proc', side_effect=FileNotFoundError), redirect_stdout(io.StringIO()):
                    mod.prove_stopped(root)
                    proof = (root / 'STOPPED.json').read_bytes()
                    mod.prove_stopped(root)
                self.assertEqual((root / 'STOPPED.json').read_bytes(), proof)
                self.assertEqual(json.loads(proof)['processes']['writerLock'], record['writerLock'])
                self.assertTrue((root / 'LIFECYCLE.json').exists())
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)
                child.stdin.close(); child.stdout.close()

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
                    with self.assertRaisesRegex(RuntimeError, 'process-still-alive'): mod.launch(root, 'claude-sonnet-5')
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
                for entry in (lambda: mod.launch(root, 'claude-sonnet-5'), lambda: mod.tool_socket(root)):
                    with self.assertRaisesRegex(RuntimeError, 'permanently-stopped'): entry()
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
                with patch.object(mod, 'check_profile', lambda _: profile), redirect_stdout(io.StringIO()) as out:
                    # Another start time on that pid: the recorded sidecar is gone; never signal its successor.
                    mod.stop_socket(root)
                    self.assertEqual(json.loads(out.getvalue())['kind'], 'recorded-mcp-exited-needs-independent-proof')
                    self.assertIsNone(child.poll())
                    target.write_text(json.dumps(record))
                    mod.stop_socket(root)
                child.wait(timeout=3)
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)
                child.stdout.close()

    def provision_fixture(self, base, op=None, run=None):
        """A real master packet (package-provision) for a root in a temporary node home."""
        home = base / 'home'
        home.mkdir(exist_ok=True)
        op, run = op or str(uuid4()), run or str(uuid4())
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(mod, 'HOME', home))
        stack.enter_context(patch.object(mod, 'NODE_CLI', home / '.oc-remote-cc/claude-2.1.316'))
        stack.enter_context(patch.object(mod, 'NODE_ROOT', re.compile(re.escape(str(home)) + r'/oc-agentremote-[a-z0-9-]+\Z')))
        stack.enter_context(patch.object(mod, 'cli_identity', lambda _path: {}))
        stack.enter_context(patch.object(mod, 'tmux', lambda *_a, **_k: CompletedProcess([], 1)))
        packet = mod.package_provision('l0123456789abcdef0123456', str(home), op, run)
        return home, Path(packet['install']['root']), packet

    def provision(self, root, packet):
        with patch.object(mod.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(packet).encode()))), \
                redirect_stdout(io.StringIO()) as out:
            mod.provision(root)
        return json.loads(out.getvalue())

    def test_provision_builds_a_chat_root_on_the_shared_cli_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            home, root, packet = self.provision_fixture(Path(temp))
            self.assertTrue(self.provision(root, packet)['created'])
            info = mod.owner(root)
            self.assertEqual((info['cwd'], info['claudeExecutable']),
                             (str(root / 'work'), str(home / '.oc-remote-cc/claude-2.1.316')))
            self.assertNotIn('cliFileIdentity', info)
            mod.check_sources(root, info)
            self.assertEqual(mod.check_profile(root)['operationId'], packet['profile']['operationId'])
            self.install_session(root)  # The master ships this right before its launch.
            args = mod.profile_args(root, info)
            self.assertEqual(args[0], str(home / '.oc-remote-cc/claude-2.1.316'))
            (root / 'work/kept.txt').write_text('chat files stay')
            (root / 'tool-attempts').mkdir(mode=0o700)
            snapshot = lambda: {p.relative_to(root): p.read_bytes() for p in root.rglob('*')
                                if p.is_file() and p.name not in ('CONTROL.lock', 'OWNER.json')}
            before = snapshot()
            self.assertFalse(self.provision(root, packet)['created'])
            self.assertEqual(snapshot(), before)
            self.assertEqual(mod.owner(root)['cwd'], str(root / 'work'))

    def test_provision_replaces_profile_ids_but_keeps_the_chat_and_refuses_a_live_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            _home, root, packet = self.provision_fixture(base)
            self.provision(root, packet)
            (root / 'work/kept.txt').write_text('chat files stay')
            again = mod.package_provision('l0123456789abcdef0123456', packet['install']['cwd'],
                                          str(uuid4()), str(uuid4()))
            self.provision(root, again)
            self.assertEqual(mod.check_profile(root)['runId'], again['profile']['runId'])
            self.assertEqual((root / 'work/kept.txt').read_text(), 'chat files stay')
            (root / 'LIFECYCLE.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'provision-runtime-present'):
                self.provision(root, packet)

    def test_provision_replaces_a_profile_pinned_by_an_earlier_release(self):
        # 2026-11-07 node smoke: a chat root kept the previous release's fixed MCP, so check_profile failed
        # with wrong-pinned-mcp-source and every existing chat would have stopped provisioning after deploy.
        with tempfile.TemporaryDirectory() as temp:
            _home, root, packet = self.provision_fixture(Path(temp))
            self.provision(root, packet)
            (root / 'work/kept.txt').write_text('chat files stay')
            old = root / 'cprofile/cc5-fixed-mcp.py'
            old.chmod(0o600)
            old.write_bytes(old.read_bytes() + b'\n# previous release\n')
            old.chmod(0o400)
            with self.assertRaisesRegex(RuntimeError, 'wrong-pinned-mcp-source'):
                mod.check_profile(root)
            # The previous release's socket helper record: reset must still identify and clear it.
            manifest = mod.profile_manifest(root)
            fd = os.open(root / 'MCP-SOCKET.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump({'version': 1, 'root': str(root), 'runId': manifest['runId'],
                           'operationId': manifest['operationId'], 'pid': 4194303, 'startTicks': '1'}, stream)
            with redirect_stdout(io.StringIO()) as out:
                mod.reset(root)
            self.assertEqual(json.loads(out.getvalue())['kind'], 'task-reset')
            self.assertFalse((root / 'MCP-SOCKET.json').exists())
            self.provision(root, packet)
            self.assertEqual(mod.check_profile(root)['runId'], packet['profile']['runId'])
            self.assertEqual((root / 'work/kept.txt').read_text(), 'chat files stay')

    def test_reset_ends_the_left_over_round_and_reopens_even_a_never_launched_stopped_root(self):
        with tempfile.TemporaryDirectory() as temp:
            _home, root, packet = self.provision_fixture(Path(temp))
            self.provision(root, packet)
            info = mod.owner(root)
            profile = mod.check_profile(root)
            self.install_session(root)  # A stale catalog/prompt must not survive into the next lane.
            self.assertTrue((root / 'session').is_dir())
            mod.mark_stopping(root)  # The old lane stopped this root before it ever launched.
            # A sidecar the dead master left behind, running as the pinned socket script.
            path = root / 'cprofile/cc5-mcp-socket.py'
            path.chmod(0o600)
            path.write_text("import time; print('READY',flush=True); time.sleep(30)")
            path.chmod(0o400)
            child = Popen(['/usr/bin/python3', '-I', '-B', str(path), str(root)], stdout=PIPE)
            try:
                self.assertEqual(child.stdout.readline(), b'READY\n')
                record = root / 'MCP-SOCKET.json'
                record.write_text(json.dumps({'version': 1, 'root': str(root), 'runId': profile['runId'],
                    'operationId': profile['operationId'], **mod.process_record(child.pid)}))
                record.chmod(0o600)
                mod.write_lifecycle(root, info, {'host': {'pid': 2000000000, 'startTicks': '1'},
                                                'claude': None, 'descendants': []})
                (root / 'run').mkdir()  # The killed host never removed its runtime directory.
                listener = socket.socket(socket.AF_UNIX)
                listener.bind(str(root / 'tool.sock'))
                listener.close()
                with patch.object(mod, 'check_profile', lambda _: profile), redirect_stdout(io.StringIO()) as out:
                    mod.reset(root)
                self.assertEqual(json.loads(out.getvalue())['kind'], 'task-reset')
                self.assertIsNotNone(child.poll(), 'the recorded sidecar received SIGTERM and exited')
                for name in ('LIFECYCLE.json', 'STOPPING.json', 'STOPPED.json', 'MCP-SOCKET.json', 'run',
                             'tool.sock', 'session'):
                    self.assertFalse((root / name).exists(), name)
                self.assertTrue((root / 'work').is_dir())
            finally:
                if child.poll() is None: child.terminate(); child.wait(timeout=3)
                child.stdout.close()

    def test_reset_fails_loudly_while_a_recorded_process_survives(self):
        with tempfile.TemporaryDirectory() as temp:
            _home, root, packet = self.provision_fixture(Path(temp))
            self.provision(root, packet)
            info = mod.owner(root)
            child = Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
            clock = iter(range(0, 1000, 5))
            try:
                mod.write_lifecycle(root, info, {'host': {'pid': 2000000000, 'startTicks': '1'},
                                                'claude': None, 'descendants': [mod.process_record(child.pid)]})
                with patch.object(mod.time, 'monotonic', lambda: next(clock)), patch.object(mod.time, 'sleep'):
                    with self.assertRaisesRegex(RuntimeError, 'reset-processes-still-alive'):
                        mod.reset(root)
                self.assertTrue((root / 'LIFECYCLE.json').exists(), 'records stay until every process is gone')
                self.assertIsNone(child.poll())
            finally:
                child.terminate(); child.wait(timeout=3)

    def test_prove_stopped_role_waits_for_the_control_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = self.installed(root)
            (root / 'OWNER.json').write_text(json.dumps({**info, 'task': mod.TASK, 'root': str(root),
                                                         'uid': os.getuid()}))
            (root / 'OWNER.json').chmod(0o600)
            order = []
            with patch.object(mod, 'prove_stopped', lambda *_a, **_k: order.append('proof')):
                with mod.control_lock(root):
                    worker = threading.Thread(target=mod.prove_stopped_role, args=(root,))
                    worker.start()
                    time.sleep(0.3)
                    order.append('rotate-finished')
                worker.join(timeout=3)
            self.assertEqual(order, ['rotate-finished', 'proof'])

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
