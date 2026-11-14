"""Filesystem transaction tests; no network, auth copy, or real node mutation."""
import importlib.util, pathlib, tempfile, unittest, os, json
spec = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).with_name('codex-install-node.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
_host_spec = importlib.util.spec_from_file_location('hostinstaller', pathlib.Path(__file__).with_name('codex-install.py'))
host = importlib.util.module_from_spec(_host_spec); _host_spec.loader.exec_module(host)
_hostd_spec = importlib.util.spec_from_file_location('hostd', pathlib.Path(__file__).with_name('oc-remote-hostd.py'))
hostd = importlib.util.module_from_spec(_hostd_spec); _hostd_spec.loader.exec_module(hostd)

class InstallTests(unittest.TestCase):
    def dest(self, home): return home / '.oc-remote-codex/profiles/default/codex-home'
    def test_login_move_and_rollback_preserves_latest_token(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home / '.codex'; source.mkdir(); auth = source / 'auth.json'
            auth.write_text('first'); inode = auth.stat().st_ino
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            dest = self.dest(home)
            # Gate G: ~/.codex stays a real 0700 directory, never a symlink, never holding auth.
            self.assertTrue(source.is_dir() and not source.is_symlink())
            self.assertEqual(source.stat().st_mode & 0o777, 0o700)
            self.assertFalse((source/'auth.json').exists())
            self.assertEqual(dest.stat().st_mode & 0o777, 0o700)
            self.assertEqual((dest/'auth.json').stat().st_ino, inode)
            mod.migrate_login(home, 'default', state, lambda: None)  # idempotent rerun
            token = dest/'auth.new'; token.write_text('renewed'); token.replace(dest/'auth.json')
            mod.rollback_login(home, 'default', state, lambda: None)
            self.assertTrue(source.is_dir() and not source.is_symlink())
            self.assertEqual(auth.read_text(), 'renewed')
    def test_legacy_symlink_is_converted_and_rollback_restores_it(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); dest = self.dest(home); dest.mkdir(parents=True)
            (dest/'auth.json').write_text('token'); source = home / '.codex'; source.symlink_to(dest)
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            self.assertTrue(source.is_dir() and not source.is_symlink())
            self.assertEqual(source.stat().st_mode & 0o777, 0o700)
            self.assertEqual((dest/'auth.json').read_text(), 'token')
            mod.rollback_login(home, 'default', state, lambda: None)
            self.assertTrue(source.is_symlink() and source.readlink() == dest)
    def test_live_plain_dir_rerun_is_idempotent_and_rollback_is_noop(self):
        # On-site fixed state: no symlink, plain 0700 ~/.codex, auth already canonical.
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); dest = self.dest(home); dest.mkdir(parents=True)
            (dest/'auth.json').write_text('token'); source = home / '.codex'; source.mkdir(mode=0o700)
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            self.assertFalse(state.get('loginIntent'))
            self.assertTrue(source.is_dir() and not source.is_symlink())
            mod.rollback_login(home, 'default', state, lambda: None)  # truthful no-op
            self.assertTrue(source.is_dir() and not source.is_symlink())
            self.assertEqual((dest/'auth.json').read_text(), 'token')
    def test_rollback_handles_codex_dir_deleted_on_site(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home / '.codex'; source.mkdir(); (source/'auth.json').write_text('t')
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            source.rmdir()  # deleted on site after installation
            mod.rollback_login(home, 'default', state, lambda: None)
            self.assertTrue(source.is_dir() and not source.is_symlink())
            self.assertEqual((source/'auth.json').read_text(), 't')
    def test_rollback_after_apply_crash_before_move_clears_journal(self):
        # Journal intent saved, rename never happened: rollback must undo the intent, not
        # demand the steady layout (an operator must be able to abort a failed install).
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home/'.codex'; source.mkdir(); (source/'auth.json').write_text('t')
            state = {}; durable = {}
            def crash():
                # Crash at the first checkpoint (the login intent write) so the
                # scenario stays "intent durable, namespace untouched".
                durable.clear(); durable.update(json.loads(json.dumps(state)))
                raise RuntimeError('power loss')
            with self.assertRaises(RuntimeError): mod.migrate_login(home, 'default', state, crash)
            self.assertTrue(durable.get('loginIntent')); self.assertTrue((source/'auth.json').exists())
            mod.rollback_login(home, 'default', durable, lambda: None)
            self.assertFalse(durable.get('loginRollbackIntent'))
            self.assertEqual((source/'auth.json').read_text(), 't')
            self.assertFalse(self.dest(home).exists())
            mod.rollback_login(home, 'default', durable, lambda: None)  # truthful rerun
            self.assertFalse(self.dest(home).exists())
    def test_rollback_after_apply_crash_before_symlink_conversion(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); dest = self.dest(home); dest.mkdir(parents=True)
            (dest/'auth.json').write_text('token'); source = home/'.codex'; source.symlink_to(dest)
            state = {}; durable = {}
            def crash():
                # Crash at the intent write, before the symlink is converted.
                durable.clear(); durable.update(json.loads(json.dumps(state)))
                raise RuntimeError('power loss')
            with self.assertRaises(RuntimeError): mod.migrate_login(home, 'default', state, crash)
            self.assertEqual(durable.get('loginLayout'), 'linked')
            mod.rollback_login(home, 'default', durable, lambda: None)
            self.assertTrue(source.is_symlink() and source.readlink() == dest)
            self.assertEqual((dest/'auth.json').read_text(), 'token')
            self.assertFalse(durable.get('loginRollbackIntent'))
    def test_rollback_rerun_after_rename_before_journal_commit(self):
        # Crash after the rename back but before the journal commit: the disk already shows
        # the restored namespace, so the rerun must finish the journal instead of rejecting.
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home/'.codex'; source.mkdir(); (source/'auth.json').write_text('t')
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            durable = {}; calls = {'n': 0}
            def crash_at_end():
                calls['n'] += 1
                if calls['n'] == 2: raise RuntimeError('power loss')  # journal keeps the pre-rename-back snapshot
                durable.clear(); durable.update(json.loads(json.dumps(state)))
            with self.assertRaises(RuntimeError): mod.rollback_login(home, 'default', state, crash_at_end)
            self.assertTrue((source/'auth.json').exists()); self.assertTrue(durable.get('loginRollbackIntent'))
            mod.rollback_login(home, 'default', durable, lambda: None)
            self.assertEqual((source/'auth.json').read_text(), 't')
            self.assertFalse(durable.get('loginRollbackIntent'))
    def test_completed_rollback_then_drifted_disk_still_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home/'.codex'; source.mkdir(); (source/'auth.json').write_text('t')
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            mod.rollback_login(home, 'default', state, lambda: None)
            mod.rollback_login(home, 'default', state, lambda: None)  # idempotent after success
            source.rename(home/'parked')  # drift: the recorded namespace vanished
            with self.assertRaises(RuntimeError): mod.rollback_login(home, 'default', state, lambda: None)
    def test_rollback_refuses_nonempty_codex_dir(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home / '.codex'; source.mkdir(); (source/'auth.json').write_text('t')
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            (source/'admin-note').write_text('do not clobber')
            with self.assertRaises(RuntimeError): mod.rollback_login(home, 'default', state, lambda: None)
            self.assertTrue((source/'admin-note').exists())
    def test_oc_bridge_tree_digest_matches_hostd_acceptance(self):
        # The installer must publish exactly the bytes hostd digests, otherwise the probe
        # rejects the node with REMOTE_CC_BRIDGE_MOD_REQUIRED even though files exist.
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); root = home/'.openclaude/box-bridge-mod/oc-bridge'
            (root/'.claude-plugin').mkdir(parents=True); (root/'hooks').mkdir()
            (root/'.claude-plugin/plugin.json').write_text('{"name":"oc-bridge"}')
            (root/'hooks/hooks.json').write_text('{"hooks":{}}')
            (root/'hooks/x.test.ts').write_text('excluded-by-both')
            (root/'tsconfig.json').write_text('excluded-by-both')
            files = host.oc_bridge_tree(root)
            self.assertEqual(set(files), {'.claude-plugin/plugin.json', 'hooks/hooks.json'})
            self.assertEqual(host.tree_digest(files), hostd.compute_oc_bridge_digest(home))
            self.assertEqual(mod.tree_digest(files), host.tree_digest(files))
    def test_dry_run_lists_oc_bridge_reference_tree(self):
        import subprocess, sys, json
        out = subprocess.check_output([sys.executable, str(pathlib.Path(__file__).with_name('codex-install.py')),
            '--admin-key', '/nonexistent', '--known-hosts', '/nonexistent', '--dry-run'], text=True)
        plan = json.loads(out)
        self.assertIn('ocBridge', plan)
        root = pathlib.Path(__file__).resolve().parent.parent.parent/'packages/gateway/box-bridge-mod/oc-bridge'
        self.assertEqual(plan['ocBridge']['sha256'], host.tree_digest(host.oc_bridge_tree(root)))
        self.assertGreater(plan['ocBridge']['files'], 0)
        self.assertEqual(plan['ocBridge']['dest'], '/opt/openclaude/box-bridge-mod/oc-bridge')
    def test_ambiguous_or_escape_login_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); (home/'.codex').symlink_to('/tmp')
            with self.assertRaises(RuntimeError): mod.migrate_login(home, 'default', {}, lambda: None)
    def test_authorized_keys_does_not_change_cc(self):
        cc = 'from="38.55.252.217",restrict,command="cc-guard" ssh-ed25519 AAAACC cc-exec\n'
        old = cc + 'restrict ssh-ed25519 AAAAPROBE pool-probe\n'
        new = mod.replace_key(old, 'AAAACODEX', 'from="38.55.252.217",restrict,command="codex-guard" ssh-ed25519 AAAACODEX codex-exec')
        self.assertTrue(new.startswith(cc)); self.assertIn('AAAAPROBE',new)
        self.assertEqual(new,mod.replace_key(new,'AAAACODEX',new.splitlines()[-1]))
        with self.assertRaises(RuntimeError): mod.replace_key(cc,'AAAACC','replacement')
        # A mistaken probe public-key argument must never rewrite the existing CC execution line.
        with self.assertRaises(RuntimeError): mod.replace_key(cc,'AAAACC','replacement',True)

if __name__ == '__main__': unittest.main()
