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
        recoverable from disk on both apply rerun and rollback, for both starting
        layouts. The one window with no journaled inode (crash immediately after
        mkdir) must refuse and name the directory instead of deleting a path it
        cannot prove it owns."""
        for layout in ('original','moved'):
            for cut in self.plain_boundaries(layout):
                for recovery in ('apply','rollback'):
                    with self.subTest(layout=layout,cut=cut,recovery=recovery),tempfile.TemporaryDirectory(prefix='oc746-plain-') as directory:
                        f=self.fixture(pathlib.Path(directory),layout);self.run_worker(f,'apply',cut,86)
                        self.renew(f)
                        self.recover_after_cut(f,recovery);self.assert_plain(f,recovery=='apply')
                        self.run_worker(f,'rollback');self.assert_plain(f,False)
                        self.run_worker(f,'rollback');self.assert_plain(f,False)
                        self.assertTrue(self.gate_g(f['home']),'Gate G must accept the recovered layout')
                        print('RECOVERED plain '+layout+' '+cut+' via '+recovery,flush=True)
    def old_journal(self, f):
        """Rewrite the journal into the shape the older installer leaves behind.

        The older installer checkpointed `loginLayout='moved'` (or, after a real
        move, `loginIntent`/`loginIdentity`/`loginLayout='original'`) *before* it
        inspected the default directory, so a journal that ended in its normal
        `unsafe ~/.codex` rejection carries login evidence without any dev/ino
        for a directory it never created."""
        path,state=self.journal(f)
        for key in ('plainDirTxn','plainDir','plainDirBefore','plainDirLegacy',
                    'complete','rolledBack'):state.pop(key,None)
        path.write_text(json.dumps(state))
        return path,state
    def plain_record(self, f):
        paths=sorted((f['root']/'var/lib/openclaude-codex-install').glob('*.json'))
        return (json.loads(paths[0].read_text()).get('plainDir') or {}) if paths else {}
    def recorded_temp(self, f):
        record=self.plain_record(f)
        return pathlib.Path(record['tmp']) if record.get('tmp') else None
    def recover_after_cut(self, f, action):
        """Run one recovery step, honouring the only state with no journaled
        inode: a crash between mkdir and the dev/ino checkpoint. Ownership is
        unprovable there, so the step must refuse, preserve the directory, and
        let the operator remove exactly the path the journal names."""
        temp=self.recorded_temp(f);record=self.plain_record(f)
        if temp is not None and temp.is_dir() and record.get('ino') is None:
            result=self.run_worker(f,action,expected=1)
            self.assertIn('unowned temporary ~/.codex directory',result.stderr)
            self.assertNotIn('"ok": true',result.stdout)
            self.assertTrue(temp.is_dir(),'a directory with no journaled inode must be preserved')
            temp.rmdir()  # documented operator step for exactly this window
        self.run_worker(f,action)
    def test_old_installer_rejection_does_not_authorize_takeover(self):
        """R2 critical: an older installer that *normally refused* a pre-existing
        root-owned ~/.codex still left `loginLayout='moved'` in the journal. That
        journal text is not ownership evidence, so apply must not chown the
        directory and rollback must not delete it."""
        for action in ('apply','rollback'):
            with self.subTest(action=action),tempfile.TemporaryDirectory(prefix='oc746-r2-reject-') as directory:
                f=self.fixture(pathlib.Path(directory),'moved');self.run_worker(f,'apply')
                path,state=self.old_journal(f)
                self.assertEqual(state.get('loginLayout'),'moved')
                self.assertIsNone(state.get('loginIntent'))
                source=f['source'];source.rmdir();source.mkdir(mode=0o700);os.chown(source,0,0)
                inode=source.stat().st_ino;before=path.read_bytes()
                result=self.run_worker(f,action,expected=1)
                self.assertIn('unsafe ~/.codex',result.stderr)
                self.assertIn('manual inspection required',result.stderr)
                self.assertNotIn('"ok": true',result.stdout)
                self.assertTrue(source.is_dir() and not source.is_symlink())
                self.assertEqual(source.lstat().st_uid,0,'the pre-existing root dir must keep its owner')
                self.assertEqual(stat.S_IMODE(source.stat().st_mode),0o700)
                self.assertEqual(source.stat().st_ino,inode)
                _,state=self.journal(f)
                self.assertNotEqual((state.get('plainDir') or {}).get('ino'),inode,
                    'a rejected directory must never be journaled as adopted')
                if action=='rollback':self.assertEqual(path.read_bytes(),before,'a refused rollback must stay read-only')
                print('REFUSED old-installer journal takeover via '+action,flush=True)
    def test_old_installer_mkdir_artifact_is_refused_not_adopted(self):
        """An old installer that really moved the login and then died between
        mkdir and chown also leaves no recorded inode for the root-owned
        directory. Its shape cannot distinguish it from the rejected case above,
        so both apply and rollback refuse and leave it for manual confirmation."""
        for action in ('apply','rollback'):
            with self.subTest(action=action),tempfile.TemporaryDirectory(prefix='oc746-r2-artifact-') as directory:
                f=self.fixture(pathlib.Path(directory),'moved');self.run_worker(f,'apply')
                path,state=self.old_journal(f)
                # Old first-move journal: the durable intent and identity were
                # written before the move; the layout field still says 'original'.
                state['loginIntent']=True;state['loginLayout']='original';state['loginMoved']=True
                state['loginIdentity']={'dev':f['dest'].stat().st_dev,'ino':f['dest'].stat().st_ino}
                path.write_text(json.dumps(state))
                source=f['source'];source.rmdir();source.mkdir(mode=0o700);os.chown(source,0,0)
                inode=source.stat().st_ino;before=path.read_bytes()
                result=self.run_worker(f,action,expected=1)
                self.assertIn('unsafe ~/.codex',result.stderr)
                self.assertIn('manual inspection required',result.stderr)
                self.assertNotIn('"ok": true',result.stdout)
                self.assertEqual(source.lstat().st_uid,0)
                self.assertEqual(source.stat().st_ino,inode)
                _,state=self.journal(f)
                self.assertNotEqual((state.get('plainDir') or {}).get('ino'),inode)
                if action=='rollback':self.assertEqual(path.read_bytes(),before,'a refused rollback must stay read-only')
                print('REFUSED old-installer mkdir artifact via '+action,flush=True)
    def test_unbound_temp_is_never_deleted(self):
        """R2 warning: the journal records a temporary path before mkdir, so a
        crash in that window leaves a directory whose inode was never recorded.
        A same-named replacement must not be removed by name alone."""
        for action in ('apply','rollback'):
            with self.subTest(action=action),tempfile.TemporaryDirectory(prefix='oc746-r2-temp-') as directory:
                f=self.fixture(pathlib.Path(directory),'moved');self.run_worker(f,'apply','mkdir:1:after',86)
                temp=self.recorded_temp(f);self.assertTrue(temp.is_dir(),'crash left the recorded temp dir')
                self.assertIsNone((self.journal(f)[1].get('plainDir') or {}).get('ino'),'inode was never recorded')
                parked=f['home']/'parked-temp-aside';temp.rename(parked)  # non-candidate name: no inode reuse
                temp.mkdir(mode=0o700);os.chown(temp,0,0)
                inode=temp.stat().st_ino
                result=self.run_worker(f,action,expected=1)
                self.assertIn('unowned temporary ~/.codex directory',result.stderr)
                self.assertNotIn('"ok": true',result.stdout)
                self.assertTrue(temp.is_dir() and temp.stat().st_ino==inode,'the replacement must survive')
                self.assertTrue(parked.is_dir(),'the moved-aside original must survive too')
                print('REFUSED unbound temp replacement via '+action,flush=True)
    def test_unbound_temp_requires_manual_clear_then_recovers(self):
        """The single documented manual step for the mkdir window: the journal
        names the empty root-owned staging directory, so an operator removes
        exactly that path and the rerun converges."""
        with tempfile.TemporaryDirectory(prefix='oc746-r2-manual-') as directory:
            f=self.fixture(pathlib.Path(directory),'moved');self.run_worker(f,'apply','mkdir:1:after',86)
            temp=self.recorded_temp(f)
            result=self.run_worker(f,'apply',expected=1)
            self.assertIn('unowned temporary ~/.codex directory',result.stderr)
            self.assertTrue(temp.is_dir())
            temp.rmdir()  # operator removes the empty root-owned staging directory the journal names
            self.run_worker(f,'apply');self.assert_plain(f,True)
            self.assertTrue(self.gate_g(f['home']))
            self.run_worker(f,'rollback');self.assert_plain(f,False)
    def test_old_journal_steady_state_rerun_is_idempotent(self):
        """The on-site steady node keeps an old journal: apply must converge
        without touching the existing box-owned 0700 ~/.codex, and rollback must
        not delete a directory this transaction never created."""
        with tempfile.TemporaryDirectory(prefix='oc746-r2-steady-') as directory:
            f=self.fixture(pathlib.Path(directory),'moved');self.run_worker(f,'apply')
            self.old_journal(f)
            source=f['source'];self.assertTrue(source.is_dir())
            (source/'tmp').mkdir();(source/'note').write_text('keep')
            for p in (source/'tmp',source/'note'):os.chown(p,1000,1000)
            inode=source.stat().st_ino
            for _ in range(2):self.run_worker(f,'apply')
            self.assertEqual(source.stat().st_ino,inode)
            self.assertEqual(source.lstat().st_uid,1000)
            self.assertEqual(stat.S_IMODE(source.stat().st_mode),0o700)
            self.assertEqual((source/'note').read_text(),'keep')
            self.assertTrue((source/'tmp').is_dir())
            self.run_worker(f,'rollback')
            self.assertEqual(source.stat().st_ino,inode,'rollback must not remove a pre-existing steady dir')
            self.assertEqual((source/'note').read_text(),'keep')
            print('IDEMPOTENT old-journal steady rerun',flush=True)
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

    def test_rollback_never_deletes_unrelated_user_dir(self):
        """R3: a recorded move lets rollback remove the plain ~/.codex it created,
        but only by the recorded inode. A different (user-owned) empty directory
        at that path belongs to someone else: refuse instead of deleting it and
        claiming success."""
        with tempfile.TemporaryDirectory(prefix='oc746-r3-userdir-') as directory:
            f=self.fixture(pathlib.Path(directory),'original');self.run_worker(f,'apply')
            source=f['source'];source.rename(f['home']/'parked-ours')
            source.mkdir(mode=0o700);os.chown(source,1000,1000)
            inode=source.stat().st_ino
            path,_=self.journal(f);before=path.read_bytes()
            result=self.run_worker(f,'rollback',expected=1)
            self.assertIn('unsafe ~/.codex before rollback',result.stderr)
            self.assertNotIn('"ok": true',result.stdout)
            self.assertTrue(source.is_dir(),'an unrelated user directory must survive rollback')
            self.assertEqual(source.stat().st_ino,inode)
            self.assertTrue((f['home']/'parked-ours').is_dir())
            self.assertEqual(path.read_bytes(),before,'a refused rollback must stay read-only')
            print('REFUSED rollback over unrelated user dir',flush=True)
    def test_cleanup_never_deletes_an_unbound_replacement(self):
        """R3: the publish step's own cleanup runs in a directory the target user
        can write. A same-named replacement must be reported, not deleted."""
        self.assertEqual(os.getuid(),0)
        with tempfile.TemporaryDirectory(prefix='oc746-r3-cleanup-') as directory:
            home=pathlib.Path(directory);source=home/'.codex';state={}
            real_rename,real_mkdir=os.rename,os.mkdir
            def hijack(src,dst):
                src=pathlib.Path(src)
                real_rename(src,home/'parked-staging')
                real_mkdir(src,0o700);os.chown(src,0,0)
                raise RuntimeError('publish failed')
            os.rename=hijack
            try:
                with self.assertRaisesRegex(RuntimeError,'identity mismatch'):m.plain_login_dir(source,0,state,lambda:None)
            finally:os.rename=real_rename
            tmp=pathlib.Path(state['plainDir']['tmp'])
            self.assertTrue((home/'parked-staging').is_dir(),'the real staging dir must be preserved')
            self.assertTrue(tmp.is_dir(),'the replacement must survive')
            self.assertEqual(tmp.stat().st_uid,0)
            print('REFUSED cleanup of unbound replacement',flush=True)
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
                    self.recover_after_cut(f,recovery);self.assert_login(f,recovery=='apply')
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
    def test_full_main_old_journal_steady_state_is_idempotent(self):
        """On-site steady model: box-owned 0700 ~/.codex holding contents, a
        hand-installed oc-bridge tree, and the journal an older installer left.
        apply twice and rollback twice must all succeed without deleting or
        changing that directory, and the hand-installed bridge must keep its
        bytes."""
        self.assertEqual(os.getuid(),0,'run via host root; no production path is used')
        with tempfile.TemporaryDirectory(prefix='oc746-steady-main-') as directory:
            root=pathlib.Path(directory)
            for name in ['home/box/.ssh','home/box/.codex','var/lib','proc']:(root/name).mkdir(parents=True,exist_ok=True)
            home=root/'home/box';os.chown(home,1000,1000)
            for p in [home/'.ssh',home/'.codex']:os.chown(p,1000,1000);os.chmod(p,0o700)
            auth=home/'.codex/auth.json';auth.write_text('first-token');os.chown(auth,1000,1000)
            cc='from="38.55.252.217",restrict,command="cc-guard" ssh-ed25519 CCCCKEY oc-rpool-123-exec\n'
            keys=home/'.ssh/authorized_keys';keys.write_text(cc+'command="oc-remote-hostd.py --serve-mux" ssh-ed25519 PROBEKEY oc-rpool-123\n');os.chown(keys,1000,1000);os.chmod(keys,0o600)
            files={n:pathlib.Path(__file__).with_name(n).read_bytes() for n in (*m.FILES,'codex-ssh-guard.py')}
            packet={'action':'apply','profile':'default','controller':m.digest(files['codex-host-controller.py']),
                'files':{n:base64.b64encode(v).decode() for n,v in files.items()},'ocBridge':bridge_packet(),
                'publicKey':'ssh-ed25519 CODEXKEY', 'probeKey':'ssh-ed25519 PROBEKEY'}
            bridge=root/'opt/openclaude/box-bridge-mod/oc-bridge'
            for rel,data in packet['ocBridge']['files'].items():
                path=bridge/rel;path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(base64.b64decode(data));os.chmod(path,0o644)
            bridge_before={p.relative_to(bridge).as_posix():p.read_bytes() for p in bridge.rglob('*') if p.is_file()}
            originalP,originalPwd=m.P,m.pwd.getpwnam
            def mapped(p): return root/str(p).lstrip('/')
            m.P=mapped;m.pwd.getpwnam=lambda _:types.SimpleNamespace(pw_dir='/home/box',pw_uid=1000,pw_gid=1000)
            try:
                m.main(packet)  # first-class install from the original layout
                journal=root/'var/lib/openclaude-codex-install'/(packet['controller']+'.json')
                state=json.loads(journal.read_text())
                for key in ('plainDirTxn','plainDir','plainDirBefore','loginIntent',
                            'loginIdentity','loginLayout','loginMoved','complete'):
                    state.pop(key,None)
                state['loginLayout']='moved';state['loginMoved']=False  # older installer's steady rerun journal
                journal.write_text(json.dumps(state))
                source=home/'.codex';inode=source.stat().st_ino
                (source/'tmp').mkdir();(source/'note').write_text('keep')
                for p in (source/'tmp',source/'note'):os.chown(p,1000,1000)
                m.main(packet);m.main(packet)
                self.assertEqual(source.stat().st_ino,inode,'apply must not recreate a pre-existing steady dir')
                self.assertEqual(source.lstat().st_uid,1000)
                self.assertEqual(stat.S_IMODE(source.stat().st_mode),0o700)
                self.assertEqual((source/'note').read_text(),'keep');self.assertTrue((source/'tmp').is_dir())
                packet['action']='rollback';m.main(packet);m.main(packet)
                self.assertEqual(source.stat().st_ino,inode,'rollback must not delete a pre-existing steady dir')
                self.assertEqual((source/'note').read_text(),'keep')
                self.assertEqual({p.relative_to(bridge).as_posix():p.read_bytes() for p in bridge.rglob('*') if p.is_file()},bridge_before)
                self.assertEqual((home/'.oc-remote-codex/profiles/default/codex-home/auth.json').read_text(),'first-token')
            finally:m.P=originalP;m.pwd.getpwnam=originalPwd
if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':transaction_worker(pathlib.Path(sys.argv[2]),sys.argv[3],sys.argv[4])
    else:unittest.main()
