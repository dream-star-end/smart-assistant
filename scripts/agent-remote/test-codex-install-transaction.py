import importlib.util,pathlib,tempfile,unittest,os,json,base64,types,stat,subprocess,sys
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).with_name('codex-install-node.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def transaction_worker(root, action, cut):
    """Fresh process, real syscalls/journal; only paths/account and crash boundary are injected."""
    home=root/'home/box';source=home/'.codex';dest=home/'.oc-remote-codex/profiles/default/codex-home'
    files={n:pathlib.Path(__file__).with_name(n).read_bytes() for n in (*m.FILES,'codex-ssh-guard.py')}
    ident=m.digest(files['codex-host-controller.py']);journal=root/'var/lib/openclaude-codex-install'/(ident+'.json')
    m.P=lambda p:root/str(p).lstrip('/')
    m.pwd.getpwnam=lambda _:types.SimpleNamespace(pw_dir='/home/box',pw_uid=1000,pw_gid=1000)
    counts={}
    def event(kind, call):
        counts[kind]=counts.get(kind,0)+1;label=kind+':'+str(counts[kind])
        def boundary(side):
            point=label+':'+side
            print('BOUNDARY '+point,flush=True)
            if cut==point:os._exit(86)
        boundary('before');result=call();boundary('after');return result
    rename,symlink,chmod,replace,unlink=os.rename,os.symlink,os.chmod,os.replace,os.unlink
    def move(a,b,*args,**kwargs):
        call=lambda:rename(a,b,*args,**kwargs)
        return event('rename',call) if pathlib.Path(a) in (source,dest) else call()
    def link(a,b,*args,**kwargs):
        call=lambda:symlink(a,b,*args,**kwargs)
        return event('symlink',call) if pathlib.Path(b)==source else call()
    def mode(p,*args,**kwargs):
        call=lambda:chmod(p,*args,**kwargs);p=pathlib.Path(p)
        if p in (source,dest):return event('chmod-login',call)
        if p in (source/'auth.json',dest/'auth.json'):return event('chmod-auth',call)
        return call()
    def commit(a,b,*args,**kwargs):
        call=lambda:replace(a,b,*args,**kwargs)
        return event('journal',call) if pathlib.Path(b)==journal else call()
    def remove(p,*args,**kwargs):
        call=lambda:unlink(p,*args,**kwargs)
        return event('unlink',call) if pathlib.Path(p)==source else call()
    os.rename=move;os.symlink=link;os.chmod=mode;os.replace=commit;os.unlink=remove
    m.main({'action':action,'profile':'default','controller':ident,
        'files':{n:base64.b64encode(v).decode() for n,v in files.items()},
        'publicKey':'ssh-ed25519 CODEXKEY','probeKey':'ssh-ed25519 PROBEKEY'})

class CrashRecoveryTests(unittest.TestCase):
    def fixture(self, root):
        self.assertEqual(os.getuid(),0,'run via host root; only a TemporaryDirectory is modified')
        for name in ['home/box/.ssh','home/box/.codex','var/lib','proc','usr/local/libexec/oc-remote-cc']:
            (root/name).mkdir(parents=True,exist_ok=True)
        home=root/'home/box'
        for p in [home,home/'.ssh',home/'.codex']:os.chown(p,1000,1000);os.chmod(p,0o700)
        os.chmod(home/'.codex',0o755)  # prove permission convergence, not a pre-secured fixture
        auth=home/'.codex/auth.json';auth.write_text('synthetic-first');os.chown(auth,1000,1000);os.chmod(auth,0o644)
        cc='from="38.55.252.217",restrict,command="cc-guard" ssh-ed25519 CCCCKEY oc-rpool-123-exec\n'
        keys=home/'.ssh/authorized_keys';keys.write_text(cc+'command="oc-remote-hostd.py --serve-mux" ssh-ed25519 PROBEKEY oc-rpool-123\n')
        os.chown(keys,1000,1000);os.chmod(keys,0o600)
        guard=root/'usr/local/libexec/oc-remote-cc/cc-ssh-guard.py';guard.write_text('synthetic CC guard, do not touch\n')
        return {'root':root,'source':home/'.codex','dest':home/'.oc-remote-codex/profiles/default/codex-home',
            'inode':auth.stat().st_ino,'dir_inode':(home/'.codex').stat().st_ino,'token':'synthetic-first',
            'keys':keys,'keys_before':keys.read_bytes(),'cc':cc,'guard':guard,'guard_before':guard.read_bytes(),'guard_inode':guard.stat().st_ino}
    def run_worker(self, f, action, cut='', expected=0):
        result=subprocess.run([sys.executable,'-B',__file__,'--worker',str(f['root']),action,cut],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,expected,result.stdout+'\n'+result.stderr)
        if expected==0:self.assertIn('"ok": true',result.stdout)
        if expected==86:self.assertNotIn('"ok": true',result.stdout)
        self.assertTrue(f['keys'].read_text().startswith(f['cc']))
        self.assertEqual(f['guard'].read_bytes(),f['guard_before']);self.assertEqual(f['guard'].stat().st_ino,f['guard_inode'])
        return result
    def assert_login(self, f, applied):
        source,dest=f['source'],f['dest'];login=dest if applied else source
        self.assertEqual(source.is_symlink(),applied)
        if applied:self.assertEqual(source.readlink(),dest)
        else:self.assertFalse(os.path.lexists(dest));self.assertEqual(f['keys'].read_bytes(),f['keys_before'])
        self.assertTrue(login.is_dir(),'original login must be restored, not merely journaled')
        self.assertEqual(login.stat().st_ino,f['dir_inode'])
        self.assertEqual((login/'auth.json').stat().st_ino,f['inode'])
        self.assertEqual((login/'auth.json').read_text(),f['token'])
        if applied or self.journal(f)[1].get('loginIntent'):
            self.assertEqual(stat.S_IMODE(login.stat().st_mode),0o700)
            self.assertEqual(stat.S_IMODE((login/'auth.json').stat().st_mode),0o600)
        else:
            self.assertEqual(stat.S_IMODE(login.stat().st_mode),0o755)
            self.assertEqual(stat.S_IMODE((login/'auth.json').stat().st_mode),0o644)
    def renew(self, f):
        login=f['dest'] if f['dest'].exists() else f['source']
        self.assertEqual(login.stat().st_ino,f['dir_inode'])
        self.assertEqual((login/'auth.json').stat().st_ino,f['inode'])
        token=login/'auth.new';token.write_text('synthetic-renewed');os.chown(token,1000,1000);os.chmod(token,0o644)
        f['inode']=token.stat().st_ino;f['token']='synthetic-renewed';token.replace(login/'auth.json')
    def journal(self, f):
        path=next((f['root']/'var/lib/openclaude-codex-install').glob('*.json'))
        return path,json.loads(path.read_text())
    def boundaries(self, action):
        with tempfile.TemporaryDirectory(prefix='oc746-trace-') as directory:
            f=self.fixture(pathlib.Path(directory))
            if action=='rollback':self.run_worker(f,'apply')
            result=self.run_worker(f,action)
            points=[line.split()[1] for line in result.stdout.splitlines() if line.startswith('BOUNDARY ')]
            kinds={point.split(':')[0] for point in points}
            self.assertTrue({'rename','journal','chmod-login'}<=kinds)
            if action=='apply':self.assertTrue({'symlink','chmod-auth'}<=kinds)
            else:self.assertIn('unlink',kinds)
            return points
    def test_audit_rename_before_checkpoint_direct_rollback(self):
        with tempfile.TemporaryDirectory(prefix='oc746-audit-') as directory:
            f=self.fixture(pathlib.Path(directory));self.run_worker(f,'apply','rename:1:after',86)
            self.assertFalse(os.path.lexists(f['source']));self.assertTrue(f['dest'].is_dir())
            self.assertTrue(self.journal(f)[1]['loginIntent']);self.assertFalse(self.journal(f)[1].get('loginMoved',False))
            self.renew(f);self.run_worker(f,'rollback');self.assert_login(f,False)
            self.run_worker(f,'rollback');self.assert_login(f,False)
    def test_apply_interruption_matrix(self):
        for cut in self.boundaries('apply'):
            for recovery in ['rollback','apply']:
                with self.subTest(cut=cut,recovery=recovery),tempfile.TemporaryDirectory(prefix='oc746-crash-') as directory:
                    f=self.fixture(pathlib.Path(directory));self.run_worker(f,'apply',cut,86);self.renew(f)
                    self.run_worker(f,recovery);self.assert_login(f,recovery=='apply')
                    if recovery=='apply':self.run_worker(f,'apply');self.assert_login(f,True)
                    self.run_worker(f,'rollback');self.assert_login(f,False)
                    self.run_worker(f,'rollback');self.assert_login(f,False)
                    print('RECOVERED apply '+cut+' via '+recovery,flush=True)
    def test_rollback_interruption_matrix(self):
        for cut in self.boundaries('rollback'):
            with self.subTest(cut=cut),tempfile.TemporaryDirectory(prefix='oc746-revert-') as directory:
                f=self.fixture(pathlib.Path(directory));self.run_worker(f,'apply');self.renew(f)
                self.run_worker(f,'rollback',cut,86)
                path,state=self.journal(f)
                if state.get('loginRollbackIntent') and not state.get('rolledBack'):
                    before=path.read_bytes();keys=f['keys'].read_bytes()
                    result=self.run_worker(f,'apply',expected=1)
                    self.assertIn('login rollback in progress',result.stderr)
                    self.assertNotIn('"ok": true',result.stdout)
                    self.assertEqual(path.read_bytes(),before);self.assertEqual(f['keys'].read_bytes(),keys)
                self.run_worker(f,'rollback');self.assert_login(f,False)
                self.run_worker(f,'rollback');self.assert_login(f,False)
                print('RECOVERED rollback '+cut,flush=True)
    def test_conflicts_fail_without_success_or_mutation(self):
        for conflict in ['both','neither','wrong-link','dest-link','replacement','missing-auth','legacy-intent']:
            for action in ['apply','rollback']:
                with self.subTest(conflict=conflict,action=action),tempfile.TemporaryDirectory(prefix='oc746-conflict-') as directory:
                    f=self.fixture(pathlib.Path(directory));self.run_worker(f,'apply','rename:1:after',86)
                    if conflict=='both':f['source'].mkdir()
                    elif conflict=='neither':f['dest'].rename(f['dest'].with_name('parked'))
                    elif conflict=='wrong-link':f['source'].symlink_to(f['root'])
                    elif conflict in ['replacement','dest-link']:
                        parked=f['dest'].with_name('parked');f['dest'].rename(parked)
                        if conflict=='dest-link':f['dest'].symlink_to(parked)
                        else:
                            f['dest'].mkdir();os.chown(f['dest'],1000,1000)
                            (f['dest']/'auth.json').write_text('unrelated');os.chown(f['dest']/'auth.json',1000,1000)
                    elif conflict=='missing-auth':(f['dest']/'auth.json').unlink()
                    else:
                        path,state=self.journal(f);state.pop('loginIdentity',None);path.write_text(json.dumps(state))
                    path,_=self.journal(f);before=path.read_bytes();keys=f['keys'].read_bytes()
                    result=self.run_worker(f,action,expected=1)
                    self.assertNotIn('"ok": true',result.stdout);self.assertIn('login',result.stderr)
                    self.assertEqual(path.read_bytes(),before);self.assertEqual(f['keys'].read_bytes(),keys)
    def test_repeated_rollback_checks_disk_instead_of_success_flag(self):
        with tempfile.TemporaryDirectory(prefix='oc746-drift-') as directory:
            f=self.fixture(pathlib.Path(directory));self.run_worker(f,'apply');self.run_worker(f,'rollback')
            f['source'].rename(f['source'].with_name('parked'))
            result=self.run_worker(f,'rollback',expected=1);self.assertNotIn('"ok": true',result.stdout)

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
if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':transaction_worker(pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4])
    else:unittest.main()
