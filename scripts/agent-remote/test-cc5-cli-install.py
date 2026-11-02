#!/usr/bin/env python3
"""Exercise real installer files with a tiny ELF fixture, never execute it."""
from contextlib import ExitStack, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prep', Path(__file__).with_name('cc5-smoke-prepare.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class InstallFiles(unittest.TestCase):
    def test_installer_success_and_refusal_cleanup(self):
        binary = b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x3e\0' + b'fixture-not-executable'
        for case in ('success', 'truncated', 'oversize', 'badhash'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                owner = {'session': 'synthetic-task'}
                original = json.dumps(owner)
                (root / 'OWNER.json').write_text(original)
                data = {'truncated': binary[:-1], 'oversize': binary + b'x'}.get(case, binary)
                output = io.StringIO()
                with ExitStack() as stack, redirect_stdout(output):
                    for name, value in {'owner': lambda _: dict(owner), 'check_sources': lambda *_: None,
                                        'tmux': lambda *_, **kw: CompletedProcess([], 1),
                                        'PINNED_CLI_SIZE': len(binary),
                                        'PINNED_CLI_SHA': '0' * 64 if case == 'badhash' else hashlib.sha256(binary).hexdigest()}.items():
                        stack.enter_context(patch.object(mod, name, value))
                    stack.enter_context(patch.object(mod.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(data))))
                    if case == 'success':
                        mod.install_cli(root)
                        info = json.loads((root / 'OWNER.json').read_text())
                        path = root / 'bin/claude-2.1.316'
                        self.assertEqual(path.read_bytes(), binary)
                        self.assertEqual(path.stat().st_mode & 0o777, 0o500)
                        self.assertEqual((root / 'OWNER.json').stat().st_mode & 0o777, 0o600)
                        self.assertEqual(mod.claude_executable(root, info, full_hash=True), str(path))
                        self.assertEqual(json.loads(output.getvalue())['kind'], 'private-pinned-cli-installed-no-chat')
                    else:
                        message = {'truncated': 'input-truncated', 'oversize': 'input-too-large',
                                   'badhash': 'hash-or-identity-mismatch'}[case]
                        with self.assertRaisesRegex(RuntimeError, message): mod.install_cli(root)
                        self.assertFalse((root / 'bin').exists())
                        self.assertEqual((root / 'OWNER.json').read_text(), original)
                        self.assertEqual(output.getvalue(), '')


if __name__ == '__main__': unittest.main()
