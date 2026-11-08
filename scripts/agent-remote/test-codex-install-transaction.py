import importlib.util,pathlib,tempfile,unittest,os,json,base64,types,stat
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).with_name('codex-install-node.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TransactionTests(unittest.TestCase):
    def test_atomic_fsync_observes_complete_bytes_and_failure_preserves_original(self):
        self.assertEqual(os.getuid(),0)
        with tempfile.TemporaryDirectory() as directory:
            target=pathlib.Path(directory)/'journal.json';target.write_bytes(b'old')
            payload=b'{"version":1}';real_sync=os.fsync;observed=[]
            def sync(fd):
                if stat.S_ISREG(os.fstat(fd).st_mode):observed.append(os.fstat(fd).st_size)
                real_sync(fd)
            try:
                os.fsync=sync;m.atomic(target,payload)
                self.assertEqual(observed,[len(payload)])
                def fail(fd): raise OSError('injected fsync failure')
                os.fsync=fail
                with self.assertRaises(OSError):m.atomic(target,b'new')
                self.assertEqual(target.read_bytes(),payload)
            finally:os.fsync=real_sync
    def test_login_rollback_recovers_after_rename_before_checkpoint(self):
        self.assertEqual(os.getuid(),0)
        with tempfile.TemporaryDirectory() as directory:
            home=pathlib.Path(directory);(home/'.codex').mkdir();(home/'.codex/auth.json').write_text('latest')
            state={};durable={}
            def save(): durable.update(json.loads(json.dumps(state)))
            m.migrate_login(home,'default',state,save)
            def fail_after_move():
                if (home/'.codex').is_dir() and not (home/'.codex').is_symlink(): raise RuntimeError('power loss')
                save()
            with self.assertRaisesRegex(RuntimeError,'power loss'):m.rollback_login(home,'default',state,fail_after_move)
            m.rollback_login(home,'default',durable,lambda:None)
            self.assertEqual((home/'.codex/auth.json').read_text(),'latest')
    def test_full_transaction_repeat_and_interrupted_rollback(self):
        self.assertEqual(os.getuid(),0,'run via host root; no production path is used')
        with tempfile.TemporaryDirectory(prefix='oc746-install-test-') as directory:
            root=pathlib.Path(directory)
            for name in ['home/box/.ssh','home/box/.codex','var/lib','proc']:(root/name).mkdir(parents=True,exist_ok=True)
            home=root/'home/box';os.chown(home,1000,1000)
            for p in [home/'.ssh',home/'.codex']:os.chown(p,1000,1000);os.chmod(p,0o700)
            auth=home/'.codex/auth.json';auth.write_text('first-token');os.chown(auth,1000,1000);inode=auth.stat().st_ino
            cc='from="38.55.252.217",restrict,command="cc-guard" ssh-ed25519 CCCCKEY oc-rpool-123-exec\n'
            keys=home/'.ssh/authorized_keys';keys.write_text(cc+'command="oc-remote-hostd.py --serve-mux" ssh-ed25519 PROBEKEY oc-rpool-123\n');os.chown(keys,1000,1000);os.chmod(keys,0o600)
            original=keys.read_bytes()
            files={n:pathlib.Path(__file__).with_name(n).read_bytes() for n in (*m.FILES,'codex-ssh-guard.py')}
            packet={'action':'apply','profile':'default','controller':m.digest(files['codex-host-controller.py']),
                'files':{n:base64.b64encode(v).decode() for n,v in files.items()},'publicKey':'ssh-ed25519 CODEXKEY', 'probeKey':'ssh-ed25519 PROBEKEY'}
            originalP,originalPwd=m.P,m.pwd.getpwnam
            def mapped(p): return root/str(p).lstrip('/')
            m.P=mapped;m.pwd.getpwnam=lambda _:types.SimpleNamespace(pw_dir='/home/box',pw_uid=1000,pw_gid=1000)
            try:
                m.main(packet);m.main(packet)
                dest=home/'.oc-remote-codex/profiles/default/codex-home'
                self.assertEqual((dest/'auth.json').stat().st_ino,inode);self.assertTrue(keys.read_text().startswith(cc))
                renewal=dest/'auth.tmp';renewal.write_text('latest-token');os.chown(renewal,1000,1000);renewal.replace(dest/'auth.json')
                real_atomic=m.atomic;broken=False
                def fail_after_restore(path,*args,**kwargs):
                    nonlocal broken
                    real_atomic(path,*args,**kwargs)
                    if path==keys and not broken:broken=True;raise RuntimeError('injected power loss after restore')
                packet['action']='rollback';m.atomic=fail_after_restore
                with self.assertRaisesRegex(RuntimeError,'power loss'):m.main(packet)
                m.atomic=real_atomic;m.main(packet);m.main(packet)
                self.assertEqual(keys.read_bytes(),original);self.assertEqual(auth.read_text(),'latest-token');self.assertFalse((home/'.codex').is_symlink())
            finally:m.P=originalP;m.pwd.getpwnam=originalPwd;m.atomic=real_atomic if 'real_atomic' in locals() else m.atomic
if __name__=='__main__':unittest.main()
