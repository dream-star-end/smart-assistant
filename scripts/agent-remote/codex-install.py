#!/usr/bin/python3
"""Host-side idempotent installer. --dry-run is local read-only; never contacts a node.
Apply/rollback require --confirm, pinned known_hosts and the independent admin key.
"""
import argparse, base64, hashlib, json, os, pathlib, re, stat, subprocess
P=pathlib.Path
FILES=('codex-host-controller.py','oc-remote-hostd.py','codex-fixed-mcp.py','codex-mcp-socket.py','remote-engine-resources.py','codex-ssh-guard.py')
OC_BRIDGE_DEST='/opt/openclaude/box-bridge-mod/oc-bridge'
def oc_bridge_tree(root):
    """Exact file set/digest hostd's compute_oc_bridge_digest accepts (same as master
    gateway `loadBoxBridgeMod`): skip .claude-plugin/types, *.test.ts, tsconfig.json."""
    files={}
    for p in sorted(root.rglob('*')):
        if not p.is_file(): continue
        rel=p.relative_to(root).as_posix()
        if rel.startswith('.claude-plugin/types') or rel.endswith('.test.ts') or rel=='tsconfig.json': continue
        files[rel]=p.read_bytes()
    return files
def tree_digest(files):
    h=hashlib.sha256()
    for rel in sorted(files):
        data=files[rel]
        h.update(f'{rel}\0{len(data)}\0'.encode('utf-8'));h.update(data)
    return h.hexdigest()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host',default='136.86.253.46'); p.add_argument('--admin-key',required=True); p.add_argument('--known-hosts',required=True)
    p.add_argument('--key-dir',default='/etc/openclaude/remote-pool-keys/oc-rpool-7ba0f86e-exec')
    p.add_argument('--probe-public-key',default='/etc/openclaude/remote-pool-keys/oc-rpool-7ba0f86e/id_ed25519.pub')
    p.add_argument('--profile',choices=['default'],default='default')
    g=p.add_mutually_exclusive_group(required=True); g.add_argument('--dry-run',action='store_true'); g.add_argument('--apply',action='store_true'); g.add_argument('--rollback',action='store_true')
    p.add_argument('--confirm',action='store_true'); a=p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}',a.host): p.error('invalid host')
    here=P(__file__).resolve().parent; files={n:(here/n).read_bytes() for n in FILES}
    controller=hashlib.sha256(files[FILES[0]]).hexdigest()
    bridge=oc_bridge_tree(here.parent.parent/'packages/gateway/box-bridge-mod/oc-bridge')
    for required in ('.claude-plugin/plugin.json','hooks/hooks.json'):
        if required not in bridge: p.error('oc-bridge reference tree incomplete: '+required)
    plan={'host':a.host,'admin':'ocadmin','controller':controller,'bundle':'/opt/openclaude/codex-remote/'+controller,
        'files':{n:hashlib.sha256(v).hexdigest() for n,v in files.items()},'profile':a.profile,'budget':'MemTotal-768MiB',
        'key':str(P(a.key_dir)/'codex_id_ed25519'),'auth':'mv unique login; ~/.codex stays a plain 0700 dir (no symlink, no auth); no auth copy',
        'ocBridge':{'dest':OC_BRIDGE_DEST,'files':len(bridge),'sha256':tree_digest(bridge),
            'owner':'root:root','mode':'0644 files / 0755 dirs, group/other write refused'},
        'rollback':'CAS restore managed public configuration and oc-bridge files; move latest auth back; retain immutable bundle and host private key'}
    if a.dry_run: print(json.dumps(plan,indent=2)); return
    if not a.confirm or os.getuid()!=0: p.error('root and --confirm required')
    for name in [a.admin_key,a.known_hosts,a.probe_public_key]:
        s=P(name).lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=0 or s.st_mode&0o022: p.error('unsafe root-owned file: '+name)
        if name==a.admin_key and s.st_mode&0o077: p.error('admin key must be 0600')
    keydir=P(a.key_dir)
    for parent in list(reversed(keydir.parents)) + [keydir]:
        s=parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022: p.error('unsafe key ancestor: '+str(parent))
    key=keydir/'codex_id_ed25519'
    if not key.exists():
        if a.rollback: p.error('no key to roll back')
        subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','oc-codex-commissioning-exec','-f',str(key)],check=True)
    s=key.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077 or s.st_nlink!=1: p.error('unsafe Codex private key')
    public=subprocess.check_output(['ssh-keygen','-y','-f',str(key)],text=True).strip()
    packet={'action':'rollback' if a.rollback else 'apply','controller':controller,'profile':a.profile,
        'files':{n:base64.b64encode(v).decode() for n,v in files.items()},
        'ocBridge':{'sha256':tree_digest(bridge),'files':{rel:base64.b64encode(v).decode() for rel,v in bridge.items()}},
        'publicKey':public,'probeKey':P(a.probe_public_key).read_text()}
    source=base64.b64encode((here/'codex-install-node.py').read_bytes()).decode()
    command="sudo -n /usr/bin/python3 -I -B -c \"import base64;exec(compile(base64.b64decode('"+source+"'),'codex-install-node.py','exec'))\""
    subprocess.run(['/usr/bin/ssh','-F','none','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',
        '-o','IdentityAgent=none','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ControlMaster=no','-o','ControlPath=none',
        '-o','GlobalKnownHostsFile=/dev/null','-o','UserKnownHostsFile='+a.known_hosts,'-o','ConnectTimeout=10',
        '-i',a.admin_key,'ocadmin@'+a.host,command],input=json.dumps(packet).encode(),check=True,timeout=120)
if __name__=='__main__': main()
