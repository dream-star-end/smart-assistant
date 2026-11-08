import importlib.util,pathlib,tempfile,unittest,os,json,base64,types,stat,subprocess,sys
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).with_name('codex-install-node.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PLAIN_DIR_PREFIX='.oc-codex-plain-'

def bridge_packet():
    """Synthetic oc-bridge tree with the two files hostd requires to digest a tree."""
    files={'.claude-plugin/plugin.json':b'{"name":"oc-bridge"}','hooks/hooks.json':b'{"hooks":{}}'}
    return {'sha256':m.tree_digest(files),'files':{k:base64.b64encode(v).decode() for k,v in files.items()}}

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
    mkdir,chown=os.mkdir,os.chown
    def plain(p):
        p=pathlib.Path(p)
        return p in (source,dest) or (p.parent==home and p.name.startswith(PLAIN_DIR_PREFIX))
    def move(a,b,*args,**kwargs):
        call=lambda:rename(a,b,*args,**kwargs)
        return event('rename',call) if pathlib.Path(a) in (source,dest) or pathlib.Path(b) in (source,dest) else call()
    def make(p,*args,**kwargs):
        call=lambda:mkdir(p,*args,**kwargs)
        return event('mkdir',call) if plain(p) else call()
    def own(p,*args,**kwargs):
        call=lambda:chown(p,*args,**kwargs)
        return event('chown',call) if plain(p) else call()
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
    os.rename=move;os.symlink=link;os.chmod=mode;os.replace=commit;os.unlink=remove;os.mkdir=make;os.chown=own
    m.main({'action':action,'profile':'default','controller':ident,
        'files':{n:base64.b64encode(v).decode() for n,v in files.items()},
        'ocBridge':bridge_packet(),
        'publicKey':'ssh-ed25519 CODEXKEY','probeKey':'ssh-ed25519 PROBEKEY'})

class CrashRecoveryTests(unittest.TestCase):
    def fixture(self, root, layout='original'):
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
        dest=home/'.oc-remote-codex/profiles/default/codex-home'
        f={'root':root,'home':home,'source':home/'.codex','dest':dest,'layout':layout,
            'inode':auth.stat().st_ino,'dir_inode':(home/'.codex').stat().st_ino,'token':'synthetic-first',
            'keys':keys,'keys_before':keys.read_bytes(),'cc':cc,'guard':guard,'guard_before':guard.read_bytes(),'guard_inode':guard.stat().st_ino}
        if layout=='moved':
            # Steady layout: the canonical login already exists and the installer's
            # plain ~/.codex is absent before apply.
            for p in [home/'.oc-remote-codex',home/'.oc-remote-codex/profiles',dest.parent]:
                p.mkdir();os.chown(p,1000,1000);os.chmod(p,0o700)
            f['source'].rename(dest)
        return f
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
        # Gate G: ~/.codex is a real directory, never a symlink, and never holds auth.
        self.assertFalse(source.is_symlink())
        self.assertTrue(source.is_dir())
        if applied:
            self.assertFalse((source/'auth.json').exists(),'the steady ~/.codex holds no auth')
            self.assertEqual(stat.S_IMODE(source.stat().st_mode),0o700)
            self.assertEqual(stat.S_IMODE(dest.stat().st_mode),0o700)
            self.assertEqual(stat.S_IMODE((dest/'auth.json').stat().st_mode),0o600)
        else:
            self.assertFalse(os.path.lexists(dest))
            self.assertEqual(f['keys'].read_bytes(),f['keys_before'])
        self.assertTrue(login.is_dir(),'original login must be restored, not merely journaled')
        self.assertEqual(login.stat().st_ino,f['dir_inode'])
        self.assertEqual((login/'auth.json').stat().st_ino,f['inode'])
        self.assertEqual((login/'auth.json').read_text(),f['token'])
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
            # No symlink is ever created: the steady layout is a plain 0700 ~/.codex.
            self.assertTrue({'rename','journal','chmod-login','chmod-auth'}<=kinds)
            self.assertNotIn('symlink',kinds);self.assertNotIn('unlink',kinds)
            return points
    def plain_boundaries(self, layout):
        """Crash points inside the plain ~/.codex creation step (mkdir/chown/publish)."""
        with tempfile.TemporaryDirectory(prefix='oc746-plain-trace-') as directory:
            f=self.fixture(pathlib.Path(directory),layout)
            result=self.run_worker(f,'apply')
            points=[line.split()[1] for line in result.stdout.splitlines() if line.startswith('BOUNDARY ')]
            selected=[p for p in points if p.split(':')[0] in ('mkdir','chown')]
            renames=[p for p in points if p.startswith('rename:')]
            if renames:
                last=renames[-1].split(':')[1]
                selected+=[p for p in points if p.startswith('rename:'+last+':')]
            return selected
    def assert_plain(self, f, applied):
        if f['layout']=='moved':
            # Pre-install namespace had no ~/.codex; apply creates a plain 0700 dir,
            # rollback removes it, and the canonical auth never moves.
            if applied:
                s=f['source'];self.assertFalse(s.is_symlink());self.assertTrue(s.is_dir())
                self.assertEqual(s.lstat().st_uid,1000)
                self.assertEqual(stat.S_IMODE(s.stat().st_mode),0o700)
                self.assertFalse((s/'auth.json').exists())
            else:
                self.assertFalse(os.path.lexists(f['source']))
            self.assertEqual((f['dest']/'auth.json').stat().st_ino,f['inode'])
            self.assertEqual((f['dest']/'auth.json').read_text(),f['token'])
        else:
            self.assert_login(f,applied)
    def gate_g(self, home):
        """Run hostd's real Gate G check as the box uid against this fixture."""
        code=("import importlib.util,sys,pathlib\n"
            "spec=importlib.util.spec_from_file_location('h',sys.argv[1])\n"
            "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)\n"
            "print(int(mod.check_credential_paths_isolated(pathlib.Path(sys.argv[2]))))")
        root=home.parent.parent
        for p in [home,home.parent,root]:os.chmod(p,0o755)
        hostd=root/'oc-remote-hostd.py'
        hostd.write_bytes(pathlib.Path(__file__).with_name('oc-remote-hostd.py').read_bytes());os.chmod(hostd,0o644)
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(hostd),str(home)],
            user=1000,group=1000,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
        return result.stdout.strip()=='1'
    def test_plain_dir_interruption_matrix(self):
        """The mkdir/chown window between creating ~/.codex and publishing it must be
        recoverable from disk on both apply rerun and rollback, for both starting layouts."""
        for layout in ('original','moved'):
            for cut in self.plain_boundaries(layout):
                for recovery in ('apply','rollback'):
                    with self.subTest(layout=layout,cut=cut,recovery=recovery),tempfile.TemporaryDirectory(prefix='oc746-plain-') as directory:
                        f=self.fixture(pathlib.Path(directory),layout);self.run_worker(f,'apply',cut,86)
                        self.renew(f)
                        self.run_worker(f,recovery);self.assert_plain(f,recovery=='apply')
                        self.run_worker(f,'rollback');self.assert_plain(f,False)
                        self.run_worker(f,'rollback');self.assert_plain(f,False)
                        self.assertTrue(self.gate_g(f['home']),'Gate G must accept the recovered layout')
                        print('RECOVERED plain '+layout+' '+cut+' via '+recovery,flush=True)
    def test_legacy_root_owned_plain_dir_is_recovered(self):
        """The exact audit state: an older installer (journal without the atomic
        plain-dir marker) died between mkdir and chown, leaving an empty root-owned
        0700 ~/.codex. Rerun and rollback must converge from disk instead of
        rejecting, and rollback must not report false success."""
        for layout in ('original','moved'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory(prefix='oc746-legacy-') as directory:
                f=self.fixture(pathlib.Path(directory),layout);self.run_worker(f,'apply')
                path,state=self.journal(f)
                for key in ('plainDirTxn','plainDir','plainDirBefore','complete','rolledBack'):state.pop(key,None)
                path.write_text(json.dumps(state))  # an older-version journal
                source=f['source'];self.assertTrue(source.is_dir())
                source.rmdir();source.mkdir(mode=0o700);os.chown(source,0,0)
                self.assertEqual(source.lstat().st_uid,0)
                self.run_worker(f,'apply');self.assert_plain(f,True)
                self.assertTrue(self.gate_g(f['home']))
                self.run_worker(f,'rollback');self.assert_plain(f,False)
                self.run_worker(f,'rollback');self.assert_plain(f,False)
                self.assertTrue(self.gate_g(f['home']),'Gate G must accept the recovered layout')
                print('RECOVERED legacy root-owned plain dir '+layout,flush=True)
    def test_legacy_journal_without_login_evidence_cannot_adopt(self):
        """R4: an old-installer journal written before the login step has no login
        evidence. This run's own loginLayout write must not become retroactive
        ownership proof, otherwise a pre-existing root-owned ~/.codex is adopted
        and later deleted."""
        for layout in ('original','moved'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory(prefix='oc746-legacy-early-') as directory:
                f=self.fixture(pathlib.Path(directory),layout);self.run_worker(f,'apply')
                path,state=self.journal(f)
                for key in ('plainDirTxn','plainDir','plainDirBefore','plainDirLegacy',
                            'loginIntent','loginLayout','loginMoved','loginIdentity',
                            'complete','rolledBack'):state.pop(key,None)
                path.write_text(json.dumps(state))  # journal from before the login step
                source=f['source'];self.assertTrue(source.is_dir(),'steady ~/.codex exists')
                source.rmdir();source.mkdir(mode=0o700);os.chown(source,0,0)
                inode=source.stat().st_ino
                result=self.run_worker(f,'apply',expected=1)
                self.assertIn('unsafe ~/.codex',result.stderr)
                self.assertTrue(source.is_dir() and not source.is_symlink())
                self.assertEqual(source.lstat().st_uid,0)
                self.assertEqual(stat.S_IMODE(source.stat().st_mode),0o700)
                self.assertEqual(source.stat().st_ino,inode)
                _,state=self.journal(f)
                self.assertIs(state.get('plainDirLegacy'),False,'must stay unproven after upgrade')
                before=path.read_bytes()
                result=self.run_worker(f,'rollback',expected=1)
                self.assertIn('unsafe ~/.codex',result.stderr)
                self.assertEqual(source.lstat().st_uid,0)
                self.assertEqual(source.stat().st_ino,inode)
                self.assertEqual(path.read_bytes(),before,'refused rollback must not write the journal')
                print('REFUSED legacy pre-login journal '+layout,flush=True)
    def test_legacy_right_is_retired_after_successful_rollback(self):
        """R5: the frozen legacy right is a one-shot authorization. After it is
        frozen and the process exits, a direct rollback must retire it; a root
        directory that appears afterwards is not ours and must be refused."""
        with tempfile.TemporaryDirectory(prefix='oc746-legacy-retire-') as directory:
            f=self.fixture(pathlib.Path(directory),'moved');self.run_worker(f,'apply')
            path,state=self.journal(f)
            for key in ('plainDirTxn','plainDir','plainDirBefore','complete','rolledBack'):
                state.pop(key,None)
            self.assertEqual(state.get('loginLayout'),'moved')
            path.write_text(json.dumps(state))  # old installer journal with real mkdir evidence
            source=f['source'];source.rmdir();source.mkdir(mode=0o700);os.chown(source,0,0)
            self.run_worker(f,'apply','journal:1:after',86)  # crash right after freezing the right
            _,state=self.journal(f)
            self.assertIs(state.get('plainDirLegacy'),True)
            self.assertIsNone(state.get('loginIntent'))
            self.assertNotIn('plainDir',state)
            # A refused rollback (unknown temp dir) must not retire the right or
            # rewrite the journal before the obstruction is removed.
            obstruct=f['home']/'.oc-codex-plain-unrelated';obstruct.mkdir()
            before=path.read_bytes()
            result=self.run_worker(f,'rollback',expected=1)
            self.assertIn('unowned temporary ~/.codex directory',result.stderr)
            self.assertTrue(obstruct.is_dir())
            self.assertEqual(path.read_bytes(),before,'a refused rollback must stay read-only')
            obstruct.rmdir()
            self.run_worker(f,'rollback')  # recover the old artifact, then retire the right
            self.assertFalse(os.path.lexists(source))
            _,state=self.journal(f)
            self.assertIs(state.get('rolledBack'),True)
            self.assertIs(state.get('plainDirLegacy'),False,'a finished transaction keeps no recovery right')
            source.mkdir(mode=0o700);os.chown(source,0,0)
            inode=source.stat().st_ino;before=path.read_bytes()
            result=self.run_worker(f,'rollback',expected=1)
            self.assertIn('unsafe ~/.codex',result.stderr)
            self.assertTrue(source.is_dir() and not source.is_symlink())
            self.assertEqual(source.lstat().st_uid,0)
            self.assertEqual(source.stat().st_ino,inode)
            self.assertEqual(path.read_bytes(),before)
            print('RETIRED legacy right after rollback',flush=True)
    def test_unowned_root_plain_dir_is_refused_not_deleted(self):
        """Without a journal, a pre-existing root-owned 0700 ~/.codex is not ours:
        apply must refuse to adopt it and rollback must refuse to delete it."""
        for action in ('apply','rollback'):
            with self.subTest(action=action),tempfile.TemporaryDirectory(prefix='oc746-unowned-root-') as directory:
                f=self.fixture(pathlib.Path(directory),'moved')
                source=f['source'];source.mkdir(mode=0o700);os.chown(source,0,0)
                inode=source.stat().st_ino
                result=self.run_worker(f,action,expected=1)
                self.assertIn('unsafe ~/.codex',result.stderr)
                self.assertTrue(source.is_dir() and not source.is_symlink())
                self.assertEqual(source.lstat().st_uid,0)
                self.assertEqual(source.stat().st_ino,inode)
    def test_unowned_temp_prefix_is_refused_not_deleted(self):
        """A namespaced temp directory is only ours when the journal wrote down its
        path before mkdir; a coincidental name match must stop the transaction."""
        for action in ('apply','rollback'):
            with self.subTest(action=action),tempfile.TemporaryDirectory(prefix='oc746-unowned-temp-') as directory:
                f=self.fixture(pathlib.Path(directory),'moved')
                temp=f['home']/'.oc-codex-plain-unrelated';temp.mkdir();os.chmod(temp,0o777)
                result=self.run_worker(f,action,expected=1)
                self.assertIn('unowned temporary ~/.codex directory',result.stderr)
                self.assertTrue(temp.is_dir() and not temp.is_symlink())
    def test_refused_cleanup_does_not_delete_before_validation(self):
        """A refused rollback must not delete an earlier unowned path before hitting
        a later invalid one, and must leave the journal untouched."""
        with tempfile.TemporaryDirectory(prefix='oc746-partial-') as directory:
            f=self.fixture(pathlib.Path(directory),'original');self.run_worker(f,'apply')
            first=f['home']/'.oc-codex-plain-a-unowned';first.mkdir();os.chown(first,1000,1000);os.chmod(first,0o700)
            later=f['home']/'.oc-codex-plain-z-nonempty';later.mkdir();(later/'note').write_text('keep')
            path,_=self.journal(f);before=path.read_bytes()
            result=self.run_worker(f,'rollback',expected=1)
            self.assertIn('unowned temporary ~/.codex directory',result.stderr)
            self.assertTrue(first.is_dir(),'an earlier unowned directory must not be deleted')
            self.assertTrue((later/'note').exists())
            self.assertEqual(path.read_bytes(),before)

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
                    if conflict=='both':
                        f['source'].mkdir();os.chown(f['source'],1000,1000)
                        (f['source']/'auth.json').write_text('stray');os.chown(f['source']/'auth.json',1000,1000)
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
            # A completed rollback is an idempotent no-op that must not invent state.
            self.run_worker(f,'rollback');self.assert_login(f,False)
            f['source'].rename(f['source'].with_name('parked'))
            result=self.run_worker(f,'rollback',expected=1);self.assertNotIn('"ok": true',result.stdout)
            self.assertFalse(os.path.lexists(f['source']))

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
                'files':{n:base64.b64encode(v).decode() for n,v in files.items()},'ocBridge':bridge_packet(),
                'publicKey':'ssh-ed25519 CODEXKEY', 'probeKey':'ssh-ed25519 PROBEKEY'}
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
