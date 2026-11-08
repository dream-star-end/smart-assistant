"""Filesystem transaction tests; no network, auth copy, or real node mutation."""
import importlib.util, pathlib, tempfile, unittest, os, json
spec = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).with_name('codex-install-node.py'))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

class InstallTests(unittest.TestCase):
    def test_login_move_and_rollback_preserves_latest_token(self):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d); source = home / '.codex'; source.mkdir(); auth = source / 'auth.json'
            auth.write_text('first'); inode = auth.stat().st_ino
            state = {}; mod.migrate_login(home, 'default', state, lambda: None)
            dest = home / '.oc-remote-codex/profiles/default/codex-home'
            self.assertTrue(source.is_symlink()); self.assertEqual(dest.stat().st_mode & 0o777, 0o700)
            self.assertEqual((dest/'auth.json').stat().st_ino, inode)
            mod.migrate_login(home, 'default', state, lambda: None)
            token = dest/'auth.new'; token.write_text('renewed'); token.replace(dest/'auth.json')
            mod.rollback_login(home, 'default', state, lambda: None)
            self.assertFalse(source.is_symlink()); self.assertEqual(auth.read_text(), 'renewed')
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
