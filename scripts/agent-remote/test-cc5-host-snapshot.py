#!/usr/bin/env python3
"""Synthetic collector guards only: no SSH, TUI, credentials, model or real ps."""
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cc5_prepare', Path(__file__).with_name('cc5-host-controller.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SnapshotGuards(unittest.TestCase):
    def test_synthetic_windows(self):
        for case in ('safe', 'forbidden', 'unknown', 'notty', 'identity', 'ancestry', 'tty-mismatch', 'account', 'window'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / 'run').mkdir()
                (root / 'run/claude.pid').write_text('111')
                calls = []
                cli = ['/private/claude-2.1.316', '--tools', '', '--setting-sources', '', '--allowedTools', 'mcp__ocbridge__roundtrip']
                task_args = cli + ['--plugin-dir', str(root / 'run/mod/oc-bridge')]
                def proc(pid):
                    args = task_args if pid == 111 else {'forbidden': ['claude', '--print'], 'unknown': ['claude', 'secret']}.get(case, ['claude'])
                    return args, '100'
                def tmux(_root, *args, **kwargs):
                    calls.append(args)
                    if args[0] == 'list-panes':
                        target = '121' if case == 'identity' and len(calls) > 1 else '120'
                        return CompletedProcess(args, 0, '%19 ' + target + ' /dev/pts/7\n')
                    self.assertEqual(args, ('capture-pane', '-p', '-S', '-200', '-t', '%19'))
                    return CompletedProcess(args, 0, 'Sign in: secret' if case == 'account' else 'PROMPT_NONCE\nREAL_REPLY\n')
                def ps(args, **kwargs):
                    if args[1] == '-eo':
                        return '111 pts/7 claude\n222 pts/0 claude\n'
                    pid = args[-1]
                    argv = ' '.join(proc(int(pid))[0])
                    tty = '?' if case == 'notty' else ('pts/7' if pid == '111' else 'pts/0')
                    return pid + ' ' + tty + ' ' + argv
                def native(pid):
                    return {'pid': pid, 'ppid': (1 if case == 'ancestry' else 120) if pid == 111 else 1,
                            'pgrp': 120, 'session': 120, 'startTicks': '100' if pid == 111 else '90',
                            'ttyNumber': 2 if case == 'tty-mismatch' and pid == 120 else 1}
                output = io.StringIO()
                with ExitStack() as stack, redirect_stdout(output):
                    for name, value in {'owner': lambda _: {'session': 'owned-task'}, 'check_sources': lambda *_: None,
                                        'host_identity': lambda *_: (99, '90'), 'proc': proc,
                                        'profile_args': lambda *_: list(cli),
                                        'tmux': tmux, 'native_process_identity': native}.items():
                        stack.enter_context(patch.object(mod, name, value))
                    stack.enter_context(patch.object(mod.subprocess, 'check_output', ps))
                    stack.enter_context(patch.object(mod.time, 'monotonic', side_effect=[0, 6 if case == 'window' else 0.01]))
                    if case == 'safe':
                        mod.snapshot(root)
                        value = json.loads(output.getvalue())
                        self.assertEqual(value['taskPaneId'], '%19')
                        self.assertEqual(value['taskPaneProcessIdentity']['panePid'], 120)
                        self.assertEqual(value['taskPid'], 111)
                        self.assertEqual(value['taskArgv'], task_args)
                        self.assertEqual(value['taskArgv'][value['taskArgv'].index('--tools') + 1], '')
                        self.assertEqual([p['pid'] for p in value['claudeProcesses']], [111, 222])
                        self.assertEqual(value['paneText'], 'PROMPT_NONCE\nREAL_REPLY\n')
                    else:
                        expected = {'forbidden': 'forbidden-claude-argv', 'unknown': 'unknown-argv',
                                    'notty': 'without-pts', 'identity': 'pane-not-ancestor',
                                    'ancestry': 'pane-not-ancestor', 'tty-mismatch': 'ancestry-tty-mismatch',
                                    'account': 'account-or-sensitive-pane', 'window': 'window-exceeded'}
                        with self.assertRaisesRegex(RuntimeError, expected[case]): mod.snapshot(root)
                        self.assertEqual(output.getvalue(), '')
                self.assertTrue(all('cc5-login' not in str(call) for call in calls))


if __name__ == '__main__': unittest.main()
