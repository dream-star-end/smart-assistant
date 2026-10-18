import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from boxUid765Egress import enable_box_egress


@unittest.skipUnless(os.geteuid() == 0, 'operation requires root ownership')
class EgressFileTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / 'proxy.json'
        self.config.write_text(json.dumps({'inbounds': [{'type': 'mixed', 'listen': '172.31.0.1',
                                                       'listen_port': 18992}]}))
        self.parent = self.root / 'cursor-v5-u765'
        self.file = self.parent / '.https-proxy'

    def tearDown(self):
        self.temp.cleanup()

    def test_creation_and_idempotence_only_uid765(self):
        other = self.root / 'cursor-v5-u3'
        other.mkdir()
        (other / 'untouched').write_text('fixture')
        self.assertEqual(enable_box_egress(self.root, self.config)['action'], 'created')
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o600)
        self.assertEqual(self.file.read_text(), 'http://172.31.0.1:18992\n')
        inode = self.file.stat().st_ino
        self.assertEqual(enable_box_egress(self.root, self.config)['action'], 'unchanged')
        self.assertEqual(self.file.stat().st_ino, inode)
        self.assertEqual((other / 'untouched').read_text(), 'fixture')

    def test_refuse_existing_different_value(self):
        self.parent.mkdir(mode=0o700)
        self.file.write_text('old fixture\n')
        self.file.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_CONFIGURED'):
            enable_box_egress(self.root, self.config)
        self.assertEqual(self.file.read_text(), 'old fixture\n')

    def test_refuse_symlink_directory_file_and_unsafe_permissions(self):
        target = self.root / 'target'
        target.mkdir(mode=0o700)
        self.parent.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'DIRECTORY_UNSAFE'):
            enable_box_egress(self.root, self.config)
        self.parent.unlink()
        self.parent.mkdir(mode=0o700)
        self.file.symlink_to(self.config)
        with self.assertRaisesRegex(RuntimeError, 'PROXY_UNSAFE'):
            enable_box_egress(self.root, self.config)
        self.file.unlink()
        self.parent.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'DIRECTORY_UNSAFE'):
            enable_box_egress(self.root, self.config)

    def test_refuse_wrong_listener_before_creating_directory(self):
        self.config.write_text('{"inbounds": []}')
        with self.assertRaisesRegex(RuntimeError, 'INBOUND_NOT_UNIQUE'):
            enable_box_egress(self.root, self.config)
        self.assertFalse(self.parent.exists())


if __name__ == '__main__':
    unittest.main()
