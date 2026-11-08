#!/usr/bin/python3
"""Host-side idempotent installer. --dry-run is local read-only; never contacts a node.
Apply/rollback require --confirm, pinned known_hosts and the independent admin key.
"""
import argparse, base64, hashlib, json, os, pathlib, re, stat, subprocess
P=pathlib.Path
FILES=('codex-host-controller.py','oc-remote-hostd.py','codex-fixed-mcp.py','codex-mcp-socket.py','remote-engine-resources.py','codex-ssh-guard.py')
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
    plan={'host':a.host,'admin':'ocadmin','controller':controller,'bundle':'/opt/openclaude/codex-remote/'+controller,
        'files':{n:hashlib.sha256(v).hexdigest() for n,v in files.items()},'profile':a.profile,'budget':'MemTotal-768MiB',
        'key':str(P(a.key_dir)/'codex_id_ed25519'),'auth':'mv unique login; ~/.codex -> canonical; no auth copy',
        'rollback':'CAS restore managed public configuration; move latest auth back; retain immutable bundle and host private key'}
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
        'files':{n:base64.b64encode(v).decode() for n,v in files.items()},'publicKey':public,'probeKey':P(a.probe_public_key).read_text()}
    source=base64.b64encode((here/'codex-install-node.py').read_bytes()).decode()
    command="sudo -n /usr/bin/python3 -I -B -c \"import base64;exec(compile(base64.b64decode('"+source+"'),'codex-install-node.py','exec'))\""
    subprocess.run(['/usr/bin/ssh','-F','none','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes',
        '-o','IdentityAgent=none','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ControlMaster=no','-o','ControlPath=none',
        '-o','GlobalKnownHostsFile=/dev/null','-o','UserKnownHostsFile='+a.known_hosts,'-o','ConnectTimeout=10',
        '-i',a.admin_key,'ocadmin@'+a.host,command],input=json.dumps(packet).encode(),check=True,timeout=120)
if __name__=='__main__': main()
