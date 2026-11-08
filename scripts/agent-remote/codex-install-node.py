#!/usr/bin/python3
"""Root-only node transaction, transported by codex-install.py over pinned admin SSH.
Never copies auth. Immutable bundles are retained on rollback for stop/proof recovery.
"""
import base64, fcntl, hashlib, json, os, pathlib, pwd, re, stat, sys, tempfile
P = pathlib.Path
FILES = ('codex-host-controller.py','oc-remote-hostd.py','codex-fixed-mcp.py','codex-mcp-socket.py','remote-engine-resources.py')
def need(ok, message):
    if not ok: raise RuntimeError(message)
def digest(data): return hashlib.sha256(data).hexdigest()
def atomic(path, data, mode=0o600, uid=0, gid=0):
    fd, name = tempfile.mkstemp(prefix='.'+path.name+'.install-', dir=path.parent)
    tmp = pathlib.Path(name)
    try:
        with os.fdopen(fd,'wb') as out:
            out.write(data); out.flush(); os.fchmod(out.fileno(),mode); os.fchown(out.fileno(),uid,gid); os.fsync(out.fileno())
        os.replace(tmp,path)
        fd = os.open(path.parent,os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if tmp.exists(): tmp.unlink()
def safe_dir(path, uid, mode=None):
    if not path.exists(): path.mkdir(); os.chown(path,uid,uid); os.chmod(path,mode or 0o755)
    s = path.lstat(); need(stat.S_ISDIR(s.st_mode) and s.st_uid == uid and not s.st_mode & 0o022, 'unsafe directory: '+str(path))
def login_paths(home, profile):
    need(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}',profile), 'invalid profile')
    return home/'.codex', home/'.oc-remote-codex'/'profiles'/profile/'codex-home'
def login_layout(home, profile, state):
    """Journal intent proves ownership; only the actual namespace proves progress."""
    source,dest=login_paths(home,profile);uid=home.stat().st_uid
    for p in [home/'.oc-remote-codex',home/'.oc-remote-codex/profiles',dest.parent]:
        if os.path.lexists(p):
            s=p.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and not s.st_mode&0o022,'unsafe login ancestor')
    if source.is_symlink():
        need(source.readlink()==dest and dest.is_dir() and not dest.is_symlink(),'unexpected login symlink')
        layout,login='linked',dest
    elif source.is_dir() and not os.path.lexists(dest):layout,login='original',source
    elif not os.path.lexists(source) and dest.is_dir() and not dest.is_symlink():layout,login='moved',dest
    else:raise RuntimeError('ambiguous login layout; inspect source and canonical directories')
    s=login.lstat();need(s.st_uid==uid,'login owner mismatch')
    identity={'dev':s.st_dev,'ino':s.st_ino}
    if state.get('loginIntent'):
        need(state.get('loginIdentity')==identity,'login identity missing/mismatch; manual inspection required')
    else:
        need(layout=='original' and not state.get('loginMoved') and not state.get('loginRollbackIntent'),
            'login migration has no durable identity/intent')
    auth=login/'auth.json'
    need(auth.is_file() and not auth.is_symlink() and auth.stat().st_uid==uid and auth.stat().st_nlink==1,'unsafe/missing login auth')
    return layout,identity
def sync_login_dirs(source,dest):
    # Also run on recovery: a crash may have preceded the previous directory fsync.
    for p in [source.parent,dest.parent]:
        fd=os.open(p,os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
def migrate_login(home, profile, state, checkpoint):
    need(not state.get('loginRollbackIntent'),'login rollback in progress; finish rollback before installing')
    source,dest = login_paths(home,profile); uid=home.stat().st_uid
    for p in [home/'.oc-remote-codex',home/'.oc-remote-codex/profiles',dest.parent]: safe_dir(p,uid,0o700)
    layout,identity=login_layout(home,profile,state)
    if not state.get('loginIntent'):
        need(source.stat().st_dev == dest.parent.stat().st_dev, 'login device mismatch')
        for name in ['config.toml','AGENTS.md','AGENTS.override.md']:
            need(not (source/name).exists(), 'remove/review Codex configuration before migration: '+name)
        # Bind the directory, not auth.json: token refresh may atomically replace that file.
        state['loginIdentity']=identity;state['loginIntent']=True;checkpoint()
    if layout=='original':source.rename(dest)
    sync_login_dirs(source,dest);state['loginMoved']=True;checkpoint()
    if layout!='linked':source.symlink_to(dest)
    sync_login_dirs(source,dest)
    os.chmod(dest,0o700)
    os.chmod(dest/'auth.json',0o600)
    need(login_layout(home,profile,state)[0]=='linked','login migration incomplete')
    checkpoint()
def rollback_login(home,profile,state,checkpoint):
    source,dest=login_paths(home,profile)
    layout,_=login_layout(home,profile,state)
    if not state.get('loginIntent'):return  # proven original layout; rename was never authorized
    if not state.get('loginRollbackIntent'):
        state['loginRollbackIntent']=True; checkpoint()
    if layout=='linked':source.unlink();sync_login_dirs(source,dest)
    if layout!='original':dest.rename(source)  # move CURRENT auth; never restore a token backup
    sync_login_dirs(source,dest)
    os.chmod(source,0o700);os.chmod(source/'auth.json',0o600)
    need(login_layout(home,profile,state)[0]=='original','login rollback incomplete')
    state['loginMoved']=False;checkpoint()
def replace_key(text,blob,line,allow_probe=False):
    rows=text.splitlines(); matches=[i for i,r in enumerate(rows) if re.search(r'\bssh-ed25519 '+re.escape(blob)+r'(?:\s|$)',r)]
    need(len(matches)<=1,'duplicate key')
    if matches:
        old=rows[matches[0]]
        need(old==line or (allow_probe and ('oc-remote-hostd.py --serve-mux' in old or re.search(r' oc-rpool-[a-f0-9]+(?:-probe)?$', old))) or ' oc-codex-commissioning-exec' in old,'refuse replacing non-Codex execution key')
        rows[matches[0]]=line
    else: rows.append(line)
    return '\n'.join(rows)+'\n'
def idle(home):
    # Any unproven lane/claim or running Codex rejects both auth migration and rollback.
    need(not list(home.glob('oc-codexremote-*')), 'existing lane roots: prove stopped and archive manually first')
    for p in P('/proc').glob('[0-9]*/cmdline'):
        try:
            raw=p.read_bytes()
            if b'codex' in raw and b'codex-install' not in raw and int(p.parent.name)!=os.getpid():
                raise RuntimeError('Codex process is running; stop it before auth migration')
        except (FileNotFoundError,PermissionError,ProcessLookupError): pass

def main(packet):
    need(os.getuid()==0,'root required'); need(packet['profile']=='default','only shared default account is commissioned')
    account=pwd.getpwnam('box'); home=P(account.pw_dir); uid,gid=account.pw_uid,account.pw_gid
    need(home==P('/home/box') and not home.is_symlink(),'unexpected box home')
    root=P('/var/lib/openclaude-codex-install'); safe_dir(root,0,0o700)
    with open(root/'lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        ident=packet['controller']; need(re.fullmatch('[a-f0-9]{64}',ident),'invalid controller digest')
        journal=root/(ident+'.json')
        state=json.loads(journal.read_text()) if journal.exists() else {'version':1,'controller':ident,'files':{}}
        save=lambda: atomic(journal,json.dumps(state,sort_keys=True).encode())
        if packet['action']=='rollback':
            idle(home)
            # Validate all CAS before first rollback write. Never restore over a concurrent admin edit.
            def file_bytes(path):
                need(not path.is_symlink(), 'rollback symlink conflict')
                return path.read_bytes() if path.exists() else None
            def before(r): return None if r['before'] is None else base64.b64decode(r['before'])
            for name,r in state['files'].items():
                current=file_bytes(pathlib.Path(name))
                need(current==before(r) or current is not None and digest(current)==r['after'], 'rollback CAS mismatch: '+name)
            rollback_login(home,packet['profile'],state,save)
            for name,r in state['files'].items():
                path=pathlib.Path(name)
                if file_bytes(path)==before(r): continue  # previous invocation restored this step
                if r['before'] is None: path.unlink()
                else: atomic(path,before(r),r['mode'],r['uid'],r['gid'])
            state['rolledBack']=True; save(); print(json.dumps({'ok':True,'action':'rollback','bundleRetained':True})); return
        need(not state.get('rolledBack'),'rolled-back transaction: inspect before a new installation')
        need(not state.get('loginRollbackIntent'),'login rollback in progress; finish rollback before installing')
        idle(home)
        files={k:base64.b64decode(v,validate=True) for k,v in packet['files'].items()}
        need(set(files)==set(FILES)|{'codex-ssh-guard.py'},'bundle list mismatch')
        need(digest(files['codex-host-controller.py'])==ident,'controller mismatch')
        # Verify embedded pins against real bytes, not operator-supplied claimed hashes.
        for parent,children in [('codex-host-controller.py',FILES[1:4]),('oc-remote-hostd.py',('remote-engine-resources.py',))]:
            for child in children: need(digest(files[child]).encode() in files[parent], 'embedded dependency pin mismatch: '+child)
        for p in [P('/opt'),P('/opt/openclaude'),P('/opt/openclaude/codex-remote')]: safe_dir(p,0)
        bundle=P('/opt/openclaude/codex-remote')/ident; safe_dir(bundle,0)
        for name in FILES:
            path=bundle/name
            if path.exists(): need(not path.is_symlink() and path.stat().st_uid==0 and path.stat().st_nlink==1 and not path.stat().st_mode&0o022 and path.read_bytes()==files[name],'immutable bundle mismatch')
            else: atomic(path,files[name],0o644)
        guarddir=P('/usr/local/libexec/oc-remote-codex')
        for p in [P('/usr'),P('/usr/local'),P('/usr/local/libexec'),guarddir]: safe_dir(p,0)
        def managed(path,data,mode=0o600,owner=0,group=0):
            need(not path.is_symlink(),'managed symlink rejected')
            old=path.read_bytes() if path.exists() else None; key=str(path)
            if key in state['files']:
                r=state['files'][key]
                need(digest(data)==r['after'],'same transaction changed inputs')
                if old is not None and digest(old)==r['after']: return
                before=None if r['before'] is None else base64.b64decode(r['before'])
                need(old==before,'install CAS drift: '+key)
                atomic(path,data,mode,owner,group); return
            st=path.stat() if old is not None else None
            state['files'][key]={'before':None if old is None else base64.b64encode(old).decode(), 'after':digest(data),
                'mode':stat.S_IMODE(st.st_mode) if st else mode,'uid':st.st_uid if st else owner,'gid':st.st_gid if st else group}
            save(); atomic(path,data,mode,owner,group)
        managed(guarddir/'codex-ssh-guard.py',files['codex-ssh-guard.py'],0o644)
        conf=guarddir/'codex-ssh-guard.json'; previous=json.loads(conf.read_text()) if conf.exists() else {}
        controller={'path':str(bundle/'codex-host-controller.py'),'sha256':ident}
        controllers=[controller]+[r for r in previous.get('controllers',[]) if r!=controller]
        managed(conf,json.dumps({'version':1,'user':'box','sourceIps':['38.55.252.217'],'sshPort':22,
            'rootPrefix':'/home/box/oc-codexremote-','controllers':controllers},sort_keys=True).encode(),0o644)
        ssh=home/'.ssh'; safe_dir(ssh,uid,0o700); authkeys=ssh/'authorized_keys'
        old=authkeys.read_text() if authkeys.exists() else ''
        pub=packet['publicKey'].split(); probe=packet['probeKey'].split()
        need(len(pub)>=2 and pub[0]=='ssh-ed25519' and len(probe)>=2 and probe[0]=='ssh-ed25519' and pub[1]!=probe[1],'invalid or overlapping public key')
        line='from="38.55.252.217",restrict,command="/usr/bin/python3 -I -B '+str(guarddir/'codex-ssh-guard.py')+'" '+ ' '.join(pub[:2])+' oc-codex-commissioning-exec'
        new=replace_key(old,pub[1],line)
        probe_line='from="38.55.252.217",restrict,command="/usr/bin/python3 -I -B '+str(bundle/'oc-remote-hostd.py')+' --serve-mux" '+' '.join(probe[:2])+' oc-codex-commissioning-probe'
        new=replace_key(new,probe[1],probe_line,True)
        # All non-managed lines, including CC's forced command, are exactly preserved.
        managed(authkeys,new.encode(),0o600,uid,gid)
        migrate_login(home,packet['profile'],state,save)
        state['complete']=True; save()
        print(json.dumps({'ok':True,'controller':ident,'profile':'default','budget':'MemTotal-768MiB','journal':str(journal)}))
if __name__=='__main__': main(json.load(sys.stdin))
