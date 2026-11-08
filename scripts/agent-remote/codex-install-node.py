#!/usr/bin/python3
"""Root-only node transaction, transported by codex-install.py over pinned admin SSH.
Never copies auth. Immutable bundles are retained on rollback for stop/proof recovery.
"""
import base64, fcntl, hashlib, json, os, pathlib, pwd, re, stat, sys, tempfile
P = pathlib.Path
FILES = ('codex-host-controller.py','oc-remote-hostd.py','codex-fixed-mcp.py','codex-mcp-socket.py','remote-engine-resources.py')
PLAIN_DIR_PREFIX='.oc-codex-plain-'
def need(ok, message):
    if not ok: raise RuntimeError(message)
def digest(data): return hashlib.sha256(data).hexdigest()
def tree_digest(files):
    """Same digest hostd computes over the oc-bridge tree (and master loadBoxBridgeMod)."""
    h=hashlib.sha256()
    for rel in sorted(files):
        data=files[rel];h.update(f'{rel}\0{len(data)}\0'.encode('utf-8'));h.update(data)
    return h.hexdigest()
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
    """Journal intent proves ownership; only the actual namespace proves progress.

    Steady state after this installer: the auth lives in the canonical
    `~/.oc-remote-codex/profiles/<profile>/codex-home`, and `~/.codex` is a plain
    0700 directory owned by the user that holds no auth. Gate G rejects any
    symlink or group/other-writable credential path, so the installer never
    creates the legacy `~/.codex -> canonical` symlink; it only converts one.

    The recorded identity is a directory inode, so it survives both the move
    (rename keeps the inode) and the rollback rename; it still fences an
    unrelated directory swapped in at either path.
    """
    source,dest=login_paths(home,profile);uid=home.stat().st_uid
    for p in [home/'.oc-remote-codex',home/'.oc-remote-codex/profiles',dest.parent]:
        if os.path.lexists(p):
            s=p.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and not s.st_mode&0o022,'unsafe login ancestor')
    def has_auth(p):
        a=p/'auth.json'
        return a.is_file() and not a.is_symlink()
    if source.is_symlink():
        # Legacy layout from the pre-fix installer; converted by migrate_login.
        need(source.readlink()==dest and dest.is_dir() and not dest.is_symlink() and has_auth(dest),'unexpected login symlink')
        layout,login='linked',dest
    elif source.is_dir() and not os.path.lexists(dest):
        need(has_auth(source),'empty ~/.codex without a canonical login; manual inspection required')
        layout,login='original',source
    elif source.is_dir() and dest.is_dir() and not dest.is_symlink():
        need(not has_auth(source),'both ~/.codex and canonical login hold auth; manual inspection required')
        layout,login='moved',dest
    elif not os.path.lexists(source) and dest.is_dir() and not dest.is_symlink():
        layout,login='moved',dest
    else:raise RuntimeError('ambiguous login layout; inspect source and canonical directories')
    s=login.lstat();need(s.st_uid==uid,'login owner mismatch')
    identity={'dev':s.st_dev,'ino':s.st_ino}
    if state.get('loginIntent'):
        need(state.get('loginIdentity')==identity,'login identity missing/mismatch; manual inspection required')
    else:
        need(layout in ('original','linked','moved') and not state.get('loginMoved') and not state.get('loginRollbackIntent'),
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
def _fsync_dir(path):
    fd=os.open(path,os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
def plain_prestate(source):
    """Namespace state recorded before this transaction touches `~/.codex`."""
    if not os.path.lexists(source):return {'present':False}
    s=source.lstat()
    return {'present':True,'dev':s.st_dev,'ino':s.st_ino,'dir':stat.S_ISDIR(s.st_mode),
        'symlink':stat.S_ISLNK(s.st_mode),'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode)}
def same_identity(record,s):
    """Ownership is the device/inode this journal recorded when it created the
    entry. Path, shape, owner and other journal fields are never evidence: the
    older installer wrote `loginLayout`/`loginIntent` before it rejected a
    pre-existing root-owned directory, and a path can be replaced by name."""
    return (record.get('dev') is not None and record.get('ino') is not None
        and record.get('dev')==s.st_dev and record.get('ino')==s.st_ino)
def recover_plain_temps(home,state):
    """Remove only the temporary directory this journal recorded by dev/ino.

    A name match alone never proves ownership: any other `.oc-codex-plain-*`
    entry stops the transaction for manual inspection, and so does the recorded
    path itself when the crash came before its device/inode was journaled — a
    path can be replaced by name while the installer is down. All entries are
    validated before the single recorded temporary path is deleted.
    """
    record=state.get('plainDir') or {}
    expected=record.get('tmp')
    for path in sorted(home.glob(PLAIN_DIR_PREFIX+'*')):
        need(expected and os.path.abspath(str(path))==os.path.abspath(expected),
            'unowned temporary ~/.codex directory; manual inspection required: '+str(path))
    if not expected:return
    path=pathlib.Path(expected)
    need(path.parent==home and path.name.startswith(PLAIN_DIR_PREFIX),'unsafe temporary ~/.codex name')
    if not os.path.lexists(path):
        record.pop('tmp',None);return
    need(not path.is_symlink(),'unsafe temporary ~/.codex symlink: '+str(path))
    s=path.lstat()
    need(stat.S_ISDIR(s.st_mode),'unsafe temporary ~/.codex entry: '+str(path))
    need(stat.S_IMODE(s.st_mode)==0o700,'unsafe temporary ~/.codex mode: '+str(path))
    need(s.st_uid in (0,home.stat().st_uid),'unsafe temporary ~/.codex owner: '+str(path))
    # Without a recorded inode the journal never proved it created this entry:
    # a same-named directory can have replaced it after the crash. Keep it and
    # require the operator to confirm the exact path named below.
    need(record.get('dev') is not None and record.get('ino') is not None,
        'unowned temporary ~/.codex directory has no journaled identity; manual inspection required: '+str(path))
    need(same_identity(record,s),'temporary ~/.codex identity mismatch')
    need(not any(path.iterdir()),'temporary ~/.codex directory is not empty: '+str(path))
    path.rmdir();record.pop('tmp',None)
def plain_login_dir(source,uid,state,checkpoint):
    """`~/.codex` must be a real 0700 directory owned by the user, never a symlink.

    Creation is published atomically: the journal records the private temporary
    path before mkdir (and its device/inode right after), then the directory is
    chowned/chmodded and renamed into place. Only a directory whose device/inode
    this journal recorded may be chowned or later removed; a user-owned
    directory is only normalized to 0700 and is never deleted. A pre-existing
    root-owned directory proves nothing: the older installer also checkpointed
    `loginLayout`/`loginIntent` before it rejected exactly such a directory, so
    shape and journal text are not ownership evidence.
    """
    home=source.parent
    record=state.get('plainDir') or {}
    s=source.lstat() if os.path.lexists(source) else None
    if s is not None:
        need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode),'unsafe ~/.codex directory')
        need(s.st_uid==uid or same_identity(record,s),
            'unsafe ~/.codex directory: not owned by the user and no journal-recorded inode proves this installer created it; manual inspection required')
    recover_plain_temps(home,state)
    if 'plainDirBefore' not in state:
        # Durable pre-state before any namespace change, so a later run can tell
        # a pre-existing directory from one this transaction created.
        state['plainDirBefore']=plain_prestate(source);checkpoint()
    if s is None:
        tmp=home/(PLAIN_DIR_PREFIX+os.urandom(12).hex())
        state['plainDir']={'tmp':str(tmp),'uid':uid,'published':False};checkpoint()
        try:
            os.mkdir(tmp,0o700)
            t=tmp.lstat();state['plainDir'].update({'dev':t.st_dev,'ino':t.st_ino});checkpoint()
            os.chmod(tmp,0o700);os.chown(tmp,uid,uid);_fsync_dir(home)
            need(not os.path.lexists(source),'~/.codex appeared during installation')
            os.rename(tmp,source);_fsync_dir(home)
            state['plainDir']['published']=True;state['plainDir'].pop('tmp',None);checkpoint()
        finally:
            if os.path.lexists(tmp):
                t=tmp.lstat()
                need(stat.S_ISDIR(t.st_mode) and not stat.S_ISLNK(t.st_mode),'unsafe temporary ~/.codex entry')
                need(not any(tmp.iterdir()),'temporary ~/.codex directory is not empty')
                tmp.rmdir()
    else:
        if s.st_uid!=uid:
            need(same_identity(record,s),'unsafe ~/.codex directory')
            os.chown(source,uid,uid)
        need(not (source/'auth.json').exists(),'auth must live in the canonical login directory only')
        os.chmod(source,0o700);_fsync_dir(home)
    s=source.lstat()
    need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid==uid and stat.S_IMODE(s.st_mode)==0o700,'unsafe ~/.codex directory')
def rollback_plain_dir(home,source,uid,state):
    """Remove the plain `~/.codex` only when this journal proves it owns it.

    Runs even when no auth was moved: an apply may have created the steady plain
    directory, and reporting rollback success over a root-owned leftover keeps
    Gate G failing. A pre-existing user-owned directory is left untouched, and a
    directory with no journal-recorded device/inode is refused rather than
    deleted — an old installer journal naming the same path is not proof.
    """
    record=state.get('plainDir') or {}
    if not os.path.lexists(source):
        # Validate (and clean) any recorded temp first: a refusal must stay
        # read-only, so nothing is written before this check passes.
        recover_plain_temps(home,state)
        return
    s=source.lstat()
    need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode),'unsafe ~/.codex before rollback')
    if not same_identity(record,s):
        need(s.st_uid==uid,
            'unsafe ~/.codex before rollback: not owned by the user and no journal-recorded inode proves this installer created it; manual inspection required')
        recover_plain_temps(home,state)  # validate before any write: refusals stay read-only
        return  # pre-existing steady directory, not ours
    need(not any(source.iterdir()),'~/.codex is not empty; refusing to overwrite')
    need(not (source/'auth.json').exists(),'auth must not live in ~/.codex')
    recover_plain_temps(home,state)
    source.rmdir();_fsync_dir(home)
def migrate_login(home, profile, state, checkpoint):
    need(not state.get('loginRollbackIntent'),'login rollback in progress; finish rollback before installing')
    source,dest = login_paths(home,profile); uid=home.stat().st_uid
    for p in [home/'.oc-remote-codex',home/'.oc-remote-codex/profiles',dest.parent]: safe_dir(p,uid,0o700)
    layout,identity=login_layout(home,profile,state)
    if not state.get('loginIntent'):
        # Only a real move creates rollback ownership; the already-steady layout stays unowned.
        if layout in ('original','linked'):
            if layout=='original':
                need(source.stat().st_dev == dest.parent.stat().st_dev, 'login device mismatch')
                for name in ['config.toml','AGENTS.md','AGENTS.override.md']:
                    need(not (source/name).exists(), 'remove/review Codex configuration before migration: '+name)
            # Bind the directory, not auth.json: token refresh may atomically replace that file.
            state['loginIdentity']=identity;state['loginIntent']=True;state['loginLayout']=layout;checkpoint()
        else:
            state['loginLayout']='moved'
    if layout=='original':source.rename(dest)
    elif layout=='linked':source.unlink()
    # Only a journal-owned move may later be rolled back; a rerun over the steady layout is a no-op.
    state['loginMoved']=bool(state.get('loginIntent'))
    sync_login_dirs(source,dest);checkpoint()
    plain_login_dir(source,uid,state,checkpoint)
    sync_login_dirs(source,dest)
    os.chmod(dest,0o700)
    os.chmod(dest/'auth.json',0o600)
    need(login_layout(home,profile,state)[0]=='moved','login migration incomplete')
    checkpoint()
def rollback_login(home,profile,state,checkpoint):
    source,dest=login_paths(home,profile);uid=home.stat().st_uid
    if not state.get('loginIntent'):
        # No auth was moved by this transaction, but a crashed apply may have created
        # the steady plain ~/.codex (and a temp dir before publish). Recover from disk
        # instead of returning success over an installer-owned leftover.
        rollback_plain_dir(home,source,uid,state)
        return
    # Every precondition is read-only: a refused rollback must not dirty the journal
    # (a stray rollback intent would block the next installation).
    layout,_=login_layout(home,profile,state)
    if layout in ('original','linked'):
        # An earlier rollback already restored the pre-install namespace, or the apply
        # crashed before the move. Verify that it really is the recorded namespace
        # (disk, not a success flag), then finish the journal without touching it.
        need(layout==state.get('loginLayout'),'login rollback namespace mismatch; manual inspection required')
        if layout=='original':
            # A restored original move leaves no canonical auth behind; a second copy
            # would mean the rename back never happened and the journal is stale.
            need(not os.path.lexists(dest) or not (dest/'auth.json').exists(),'canonical login still holds auth; rollback incomplete')
    else:
        need(layout=='moved','login rollback requires the steady layout')
        # ~/.codex may be our plain 0700 dir (proven by its recorded device/inode)
        # or absent because it was deleted on-site. Anything else is only removed
        # when the journal recorded that exact inode; a root-owned directory is
        # never assumed to be ours.
        if os.path.lexists(source):
            s=source.lstat()
            need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode),'unsafe ~/.codex before rollback')
            record=state.get('plainDir') or {}
            need(s.st_uid==uid or same_identity(record,s),
                'unsafe ~/.codex before rollback: not owned by the user and no journal-recorded inode proves this installer created it; manual inspection required')
            need(not any(source.iterdir()),'~/.codex is not empty; refusing to overwrite')
    # Recover crash-left temporary directories before the first journal write; a
    # refusal here (non-empty/unexpected entry) leaves the journal untouched.
    recover_plain_temps(home,state)
    if not state.get('loginRollbackIntent'):
        state['loginRollbackIntent']=True; checkpoint()
    if layout in ('original','linked'):
        state['loginRollbackIntent']=False;state['loginMoved']=False;checkpoint()
        return
    if os.path.lexists(source): source.rmdir()
    if state.get('loginLayout')=='linked':
        # Restore the exact pre-install namespace; the legacy symlink is not ours to invent away.
        source.symlink_to(dest);sync_login_dirs(source,dest)
    else:
        dest.rename(source)  # move CURRENT auth; never restore a token backup
        sync_login_dirs(source,dest)
        os.chmod(source,0o700);os.chmod(source/'auth.json',0o600)
    need(login_layout(home,profile,state)[0] in ('original','linked'),'login rollback incomplete')
    state['loginRollbackIntent']=False;state['loginMoved']=False;checkpoint()
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
        # oc-bridge reference tree. The probe refuses with REMOTE_CC_BRIDGE_MOD_REQUIRED unless
        # hostd can digest a complete tree; install exactly the master's published bytes so the
        # digests match, root-owned and not group/other writable.
        ocb=packet.get('ocBridge') or {}
        need(isinstance(ocb.get('files'),dict) and ocb['files'],'oc-bridge bundle missing')
        ocfiles={k:base64.b64decode(v,validate=True) for k,v in ocb['files'].items()}
        need(tree_digest(ocfiles)==ocb.get('sha256'),'oc-bridge digest mismatch')
        for required in ('.claude-plugin/plugin.json','hooks/hooks.json'):
            need(required in ocfiles,'oc-bridge bundle incomplete: '+required)
        modroot=P('/opt/openclaude/box-bridge-mod');bridge=modroot/'oc-bridge'
        for p in [P('/opt'),P('/opt/openclaude'),modroot]: safe_dir(p,0)
        safe_dir(bridge,0,0o755)
        for rel in sorted(ocfiles):
            parts=rel.split('/')
            need(all(parts) and '..' not in parts and not rel.startswith('/'),'unsafe oc-bridge path')
            cur=bridge
            for name in parts[:-1]:
                cur=cur/name;safe_dir(cur,0,0o755)
            path=cur/parts[-1];managed(path,ocfiles[rel],0o644)
            s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'unsafe oc-bridge file: '+rel)
        # Verify the tree hostd actually digests, not just the bytes we wrote: a file left
        # by another master version changes compute_oc_bridge_digest and the probe would
        # still reject with REMOTE_CC_BRIDGE_MOD_REQUIRED after a "successful" install.
        ondisk={}
        for p in sorted(bridge.rglob('*')):
            rel=p.relative_to(bridge).as_posix()
            if rel.startswith('.claude-plugin/types') or rel.endswith('.test.ts') or rel=='tsconfig.json':continue
            if p.is_dir() and not p.is_symlink():continue
            need(p.is_file() and not p.is_symlink(),'oc-bridge tree has an unexpected entry: '+rel)
            ondisk[rel]=p.read_bytes()
        extra=sorted(set(ondisk)-set(ocfiles));missing=sorted(set(ocfiles)-set(ondisk))
        need(not extra and not missing and tree_digest(ondisk)==ocb['sha256'],
            'oc-bridge tree drift; remove stale files before installing (extra=%s missing=%s)'%(extra,missing))
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
