#!/usr/bin/env python3
"""Pinned Codex node controller v1. No billing, credentials migration or local tools.

Installed alongside the three digest-pinned dependencies by the administrator.
A generation root is immutable and can be launched at most once. See node contract.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import tempfile
import types

PINNED = {'oc-remote-hostd.py': '304f22eb46ba990081334fbee12c7de81db686957f196d994c53f43b9c7d4377', 'codex-fixed-mcp.py': 'eb27f0a14c1c6dcda98b009ae29e6800b39aeb8905894e0173a8477642e8ce3a', 'codex-mcp-socket.py': 'c8f184d0981c53bffbd9ffeff39dbe7d295e029f972cd85b0af5ad592411974d'}
CLI = Path('/usr/bin/codex')
NATIVE = Path('/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')
MAX_FRAME = 2 * 1024 * 1024
SERVER = 'ocbridge'
SHA = re.compile(r'[0-9a-f]{64}\Z')
IDENT = re.compile(r'[A-Za-z0-9._:-]{1,256}\Z')
ITEMS = {'agentMessage','reasoning','userMessage','contextCompaction','mcpToolCall'}
POLICY = {'tool_mode':'direct','multi_agent_version':'disabled','experimental_supported_tools':[],
          'apply_patch_tool_type':None,'supports_search_tool':False}


def require(value, code='CODEX_POLICY_REJECTED'):
    if not value: raise ValueError(code)


def sha(data): return hashlib.sha256(data).hexdigest()


def file_sha(path):
    # Both the outer controller and the bounded socket worker verify the full native artifact.
    # Never allocate the >100 MiB executable inside a 32 MiB socket scope.
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(256 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()


def strict_json(data):
    def pairs(items):
        result={}
        for k,v in items:
            require(k not in result); result[k]=v
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('CODEX_POLICY_REJECTED')))


def encoded(value): return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def read_file(path, limit=MAX_FRAME, owner=True):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and 0<st.st_size<=limit
                and not st.st_mode & (0o077 if owner else 0o022)
                and st.st_uid in ((os.getuid(),) if owner else (0,os.getuid())))
        data=os.read(fd,limit+1); require(len(data)==st.st_size); return data
    finally: os.close(fd)


def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def record(path,value):
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as out:
        out.write(encoded(value)); out.flush(); os.fsync(out.fileno())
    sync_dir(path.parent)


def directory(path, create=False, mode=0o700):
    if create: path.mkdir(mode=mode)
    st=path.lstat()
    require(stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and not st.st_mode & 0o077
            and path.resolve()==path.absolute())


def task_root(value):
    root=Path(value)
    home=Path.home()
    normal=root.parent==home and re.fullmatch(r'oc-codexremote-[a-z0-9-]{16,60}',root.name)
    experiment=(root.parent.parent==Path('/tmp') and re.fullmatch(r'oc-codex-[a-z0-9-]{8,50}',root.parent.name)
                and re.fullmatch(r'run-[a-z0-9-]{8,40}',root.name))
    require(os.getuid()!=0 and (normal or experiment) and root.absolute()==root)
    return root


def dependency(name):
    path=Path(__file__).resolve().with_name(name)
    data=read_file(path,256*1024,owner=False)
    require(sha(data)==PINNED[name], 'CODEX_CLI_MISMATCH')
    return data


def module(name):
    data=dependency(name); result=types.ModuleType(name)
    result.__file__=str(Path(__file__).resolve().with_name(name))
    exec(compile(data,result.__file__,'exec'),result.__dict__)
    return result


def manifest(root):
    directory(root)
    m=strict_json(read_file(root/'MANIFEST.json',32768))
    require(m.get('version')==1 and m.get('engine')=='codex' and m.get('root')==str(root))
    for field in ('operationId','runId','profileId','authEpoch','generation','model'):
        require(isinstance(m.get(field),str) and IDENT.fullmatch(m[field]))
    require(re.fullmatch(r'[0-9]{1,20}',m['generation']) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}',m['profileId']))
    require(m.get('nativeThreadId') is None or (isinstance(m['nativeThreadId'],str) and IDENT.fullmatch(m['nativeThreadId'])))
    for field in ('controllerSha256','cliSha256','nativeSha256'):
        require(isinstance(m.get(field),str) and SHA.fullmatch(m[field]))
    home=Path(m['codexHome'])
    expected=Path.home()/'.oc-remote-codex/profiles'/m['profileId']/'codex-home'
    experimental=root.parent/'profile/codex-home'
    require(home==expected or (str(root).startswith('/tmp/oc-codex-') and home==experimental))
    directory(home)
    require((home/'auth.json').is_file() and not (home/'auth.json').is_symlink())
    require(sha(Path(__file__).read_bytes())==m['controllerSha256'],'CODEX_CLI_MISMATCH')
    return m


def binding(m):
    return {k:m[k] for k in ('operationId','runId','generation','profileId','authEpoch')}


def lock(path):
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    st=os.fstat(fd)
    require(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and st.st_nlink==1 and not st.st_mode & 0o077)
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd); raise ValueError('CODEX_PROFILE_BUSY') from None
    return fd


def pinned_catalog(model_list, cache):
    require(isinstance(model_list,list) and model_list and isinstance(cache,dict) and isinstance(cache.get('models'),list))
    listed={}
    for m in model_list:
        require(isinstance(m,dict))
        mid=m.get('model') or m.get('id')
        require(isinstance(mid,str) and IDENT.fullmatch(mid) and mid not in listed)
        listed[mid]=m
    raw={}
    for m in cache['models']:
        require(isinstance(m,dict) and isinstance(m.get('slug'),str) and m['slug'] not in raw)
        raw[m['slug']]=m
    require(set(listed)<=set(raw))
    return {'models':[{**raw[mid],**POLICY} for mid in listed]}


def creation_lock(root):
    return lock(root.parent/('.'+root.name+'.create.lock'))


def publish_manifest(root, m):
    # A process crash may leave an unpublished temp file, never a torn authoritative manifest.
    fd, name=tempfile.mkstemp(prefix='.manifest-',dir=root)
    try:
        with os.fdopen(fd,'wb') as out:
            out.write(encoded(m)); out.flush(); os.fsync(out.fileno())
        require(not (root/'MANIFEST.json').exists() and not (root/'MANIFEST.json').is_symlink())
        os.rename(name,root/'MANIFEST.json') # all publishers hold creation_lock; no hard-link crash window
        sync_dir(root)
    finally:
        try: os.unlink(name)
        except FileNotFoundError: pass
        sync_dir(root)


def fence_unprovisioned(root, expected):
    control=creation_lock(root)
    try:
        if not root.exists(): directory(root,create=True); sync_dir(root.parent)
        directory(root)
        if not (root/'MANIFEST.json').exists():
            # Current controllers cannot launch before atomic MANIFEST publication.
            require(not any((root/(r+'-STARTING.json')).exists() for r in ('APP','SOCKET')))
            publish_manifest(root,expected)
        m=manifest(root); require(m==expected)
        fence(root,m)
        return m
    finally: os.close(control)


def provision(root):
    control=creation_lock(root)
    try: provision_locked(root)
    finally: os.close(control)


def provision_locked(root):
    require(not root.exists() and not root.is_symlink())
    line=sys.stdin.buffer.readline(8*1024*1024+1)
    require(len(line)<=8*1024*1024 and line.endswith(b'\n'))
    packet=strict_json(line)
    require(isinstance(packet,dict) and set(packet)=={'manifest','tools','modelList','modelCatalog'})
    m=packet['manifest']; require(isinstance(m,dict) and m.get('root')==str(root))
    directory(root,create=True)
    publish_manifest(root,m); m=manifest(root)
    for sub in ('home','tmp','observations','tool-attempts'): directory(root/sub,create=True)
    directory(root/'cwd',create=True,mode=0o500)
    catalog=pinned_catalog(packet['modelList'],packet['modelCatalog'])
    require(m['model'] in [x['slug'] for x in catalog['models']])
    record(root/'models.json',catalog); record(root/'model-list.json',packet['modelList'])
    record(root/'tools.json',packet['tools'])
    record(root/'client.json',{'version':3,'engine':'codex',**binding(m),'catalogSha256':sha(read_file(root/'tools.json'))})
    for name in ('codex-fixed-mcp.py','codex-mcp-socket.py'):
        data=dependency(name)
        fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
        with os.fdopen(fd,'wb') as out: out.write(data); out.flush(); os.fsync(out.fileno())
    client=module('codex-fixed-mcp.py'); client.read_catalog(root)
    h=module('oc-remote-hostd.py')
    h.codex_check_config_sources(Path(m['codexHome']),root/'cwd')
    argv=[str(CLI),*h.codex_policy_args(),'-c','model_catalog_json='+json.dumps(str(root/'models.json')),
          '-c','mcp_servers.ocbridge.command="/usr/bin/python3"',
          '-c','mcp_servers.ocbridge.args='+json.dumps(['-I','-B',str(root/'codex-fixed-mcp.py'),str(root)]),
          '-c','mcp_servers.ocbridge.required=true','-c','mcp_servers.ocbridge.default_tools_approval_mode="approve"']
    env={'HOME':str(root/'home'),'CODEX_HOME':m['codexHome'],'PATH':'/usr/bin:/bin','LANG':'C.UTF-8',
         'TMPDIR':str(root/'tmp'),'XDG_CONFIG_HOME':str(root/'home/config'),
         'XDG_DATA_HOME':str(root/'home/data'),'XDG_CACHE_HOME':str(root/'home/cache')}
    launch={'argv':argv,'environment':env,'cwd':str(root/'cwd'),'catalogSha256':sha(read_file(root/'models.json')),
            'policySha256':sha(encoded({'catalogOverrides':POLICY,'args':h.codex_policy_args(),'version':'0.167.0'})),
            'argvSha256':sha(encoded(argv)), 'sources':PINNED}
    record(root/'LAUNCH.json',launch)
    record(root/'PROVISIONED.json',{'version':1,**binding(m),'manifestSha256':sha(read_file(root/'MANIFEST.json')),
                                   'launchSha256':sha(read_file(root/'LAUNCH.json'))})
    print(json.dumps({'version':1,'engine':'codex','kind':'provisioned',**binding(m)}),flush=True)


def launch_spec(root,m):
    receipt=strict_json(read_file(root/'PROVISIONED.json'))
    require(receipt['manifestSha256']==sha(read_file(root/'MANIFEST.json'))
            and receipt['launchSha256']==sha(read_file(root/'LAUNCH.json')))
    spec=strict_json(read_file(root/'LAUNCH.json'))
    require(spec['sources']==PINNED and spec['catalogSha256']==sha(read_file(root/'models.json')))
    require(file_sha(CLI.resolve())==m['cliSha256'] and file_sha(NATIVE)==m['nativeSha256'], 'CODEX_CLI_MISMATCH')
    h=module('oc-remote-hostd.py'); h.codex_check_config_sources(Path(m['codexHome']),root/'cwd')
    version=subprocess.run([str(NATIVE),'--version'],env={'PATH':'/usr/bin:/bin'},capture_output=True,timeout=8,text=True)
    require(version.returncode==0 and version.stdout.strip()=='codex-cli 0.167.0','CODEX_CLI_MISMATCH')
    require(not list((root/'cwd').iterdir()))
    return spec


def boot_id(): return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def scope_name(root, m, role):
    return 'oc-codex-'+sha(encoded([str(root),binding(m),role]))[:32]+'.scope'


def lane_admission(root, m, h):
    resources = h.engine_resources(); c = resources.config('codex')
    return resources.admit(str(root), 'codex', m['codexHome'],
                           {scope_name(root,m,role): c['app' if role=='app' else 'socket']
                            for role in ('app','socket')})


def preflight(root):
    status = module('oc-remote-hostd.py').engine_resources().preflight('codex')
    print(json.dumps({'version':1,'engine':'codex','kind':'preflight',**status}), flush=True)


def scope_record(root,role,m):
    return strict_json(read_file(root/(role.upper()+'-SCOPE.json'),32768))


def start_scope(root,role,m,spec,h,**streams):
    control=lock(root/'CONTROL.lock')
    try:
        require(not (root/'STOPPING.json').exists())
        return start_scope_locked(root,role,m,spec,h,**streams)
    finally: os.close(control)


def start_scope_locked(root,role,m,spec,h,**streams):
    name=scope_name(root,m,role)
    record(root/(role.upper()+'-STARTING.json'),{'unit':name,'bootId':boot_id(),**binding(m)})
    cmd=h.codex_scope_command(name,['/usr/bin/python3','-I','-B',str(Path(__file__).resolve()),'_worker',str(root),role],
                             {'HOME':str(Path.home()),'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},role='app' if role=='app' else 'socket')
    p=subprocess.Popen(cmd,cwd=root,env={'PATH':'/usr/bin:/bin','XDG_RUNTIME_DIR':'/run/user/'+str(os.getuid())},**streams)
    try:
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            state=h.codex_scope_state(name); group=state.get('ControlGroup')
            if group and state.get('ActiveState')=='active':
                path=Path('/sys/fs/cgroup'+group); st=path.stat()
                record(root/(role.upper()+'-SCOPE.json'),{'unit':name,'bootId':boot_id(),**binding(m),
                        'cgroup':group,'dev':st.st_dev,'inode':st.st_ino,'controllerSha256':m['controllerSha256']})
                record(root/(role.upper()+'-ADMITTED.json'),{'unit':name,**binding(m)})
                return p
            if p.poll() is not None: break
            time.sleep(.03)
        raise ValueError('CODEX_STOP_UNKNOWN')
    except BaseException:
        h.codex_scope_stop(name); p.wait(timeout=8); raise


def worker(root,role):
    m=manifest(root); require(role in ('app','socket'))
    end=time.monotonic()+12
    while not (root/(role.upper()+'-ADMITTED.json')).exists():
        require(time.monotonic()<end and not (root/'STOPPING.json').exists()); time.sleep(.02)
    require(not (root/'STOPPING.json').exists())
    saved=scope_record(root,role,m)
    require(saved['bootId']==boot_id())
    actual=Path('/proc/self/cgroup').read_text().strip()
    require(actual=='0::'+saved['cgroup'])
    spec=launch_spec(root,m)
    os.chdir(spec['cwd'])
    if role=='app': os.execve(str(CLI),spec['argv'],spec['environment'])
    os.execve('/usr/bin/python3',['/usr/bin/python3','-I','-B',str(root/'codex-mcp-socket.py'),str(root)],spec['environment'])


class Policy:
    def __init__(self,root,m,client):
        self.root,self.m,self.client=root,m,client
        self.thread=m['nativeThreadId']; self.turn=None; self.pending={}; self.seen=set(); self.initialized=False
        self.models=strict_json(read_file(root/'model-list.json'))
    def incoming(self,frame):
        require(isinstance(frame,dict) and set(frame)<= {'id','method','params','jsonrpc'},'CODEX_RPC_REJECTED')
        method=frame.get('method'); p=frame.get('params',{})
        require(isinstance(p,dict),'CODEX_RPC_REJECTED')
        allowed={'initialize','initialized','model/list','account/read','mcpServerStatus/list','thread/start','thread/resume',
                 'thread/read','turn/start','turn/interrupt'}
        require(method in allowed,'CODEX_RPC_REJECTED')
        if method=='initialized':
            require(self.initialized and not p and 'id' not in frame,'CODEX_RPC_REJECTED'); return frame
        ident=frame.get('id'); require(type(ident) in (str,int),'CODEX_RPC_REJECTED')
        key=(type(ident),ident); require(key not in self.seen and len(self.seen)<100000,'CODEX_RPC_REJECTED')
        self.seen.add(key)
        if method=='initialize':
            require(not self.initialized and not self.pending,'CODEX_RPC_REJECTED')
            p={'clientInfo':{'name':'openclaude_remote','version':'1'},'capabilities':{'experimentalApi':True}}
        else: require(self.initialized,'CODEX_RPC_REJECTED')
        if method in ('thread/start','thread/resume'):
            fields={'model','cwd','approvalPolicy','sandbox','baseInstructions','developerInstructions','ephemeral','threadId'}
            require(set(p)<=fields and not p.get('ephemeral',False),'CODEX_RPC_REJECTED')
            require(not self.turn and not any(x.startswith('thread/') for x in self.pending.values()),'CODEX_RPC_REJECTED')
            if method=='thread/start': require(self.thread is None and 'threadId' not in p,'CODEX_RPC_REJECTED')
            else: require(self.thread is not None and p.get('threadId')==self.thread,'CODEX_RPC_REJECTED')
            p={**p,'model':self.m['model'],'cwd':str(self.root/'cwd'),'approvalPolicy':'never','sandbox':'read-only'}
        elif method=='turn/start':
            require(set(p)<={'threadId','input','effort','serviceTier','summary','model','cwd','approvalPolicy','sandboxPolicy'},'CODEX_RPC_REJECTED')
            require(self.thread and p.get('threadId')==self.thread and not self.turn
                    and 'turn/start' not in self.pending.values(),'CODEX_RPC_REJECTED')
            require(isinstance(p.get('input'),list) and p['input'] and all(isinstance(x,dict) and set(x)<={'type','text','text_elements'}
                    and x.get('type')=='text' and isinstance(x.get('text'),str) for x in p['input']),'CODEX_RPC_REJECTED')
            model=next(x for x in self.models if (x.get('model') or x.get('id'))==self.m['model'])
            if 'effort' in p:
                require(p['effort'] in [x['reasoningEffort'] for x in model.get('supportedReasoningEfforts',[])],'CODEX_RPC_REJECTED')
            if p.get('serviceTier') is not None:
                require(p['serviceTier'] in model.get('serviceTiers',[]),'CODEX_RPC_REJECTED')
            p={**p,'model':self.m['model'],'cwd':str(self.root/'cwd'),'approvalPolicy':'never',
               'sandboxPolicy':{'type':'readOnly','networkAccess':False}}
        elif method in ('turn/interrupt','thread/read'):
            require(set(p)<=({'threadId','turnId'} if method=='turn/interrupt' else {'threadId','includeTurns'})
                    and self.thread and p.get('threadId')==self.thread,'CODEX_RPC_REJECTED')
            if method=='turn/interrupt': require(self.turn and p.get('turnId')==self.turn,'CODEX_RPC_REJECTED')
        elif method not in ('initialize','initialized'):
            require(set(p)<=({'cursor','limit','includeHidden'} if method in ('model/list','mcpServerStatus/list') else set()),'CODEX_RPC_REJECTED')
        self.pending[key]=method
        return {**frame,'params':p}
    def outgoing(self,frame):
        require(isinstance(frame,dict),'CODEX_NATIVE_ITEM_REJECTED')
        if 'id' in frame and 'method' in frame: raise ValueError('CODEX_SERVER_REQUEST_REJECTED')
        if 'id' in frame:
            key=(type(frame['id']),frame['id']); method=self.pending.pop(key,None)
            require(method is not None,'CODEX_RPC_REJECTED')
            if 'error' not in frame:
                result=frame.get('result',{})
                if method=='initialize': self.initialized=True
                elif method in ('thread/start','thread/resume'):
                    tid=result.get('thread',{}).get('id'); require(isinstance(tid,str) and IDENT.fullmatch(tid))
                    require(self.thread is None or tid==self.thread); self.thread=tid
                elif method=='mcpServerStatus/list':
                    data=result.get('data'); require(isinstance(data,list) and len(data)==1 and data[0].get('name')==SERVER)
        method=frame.get('method'); p=frame.get('params',{})
        if method=='turn/started':
            require(p.get('threadId')==self.thread and not self.turn)
            self.turn=p.get('turn',{}).get('id'); require(isinstance(self.turn,str) and IDENT.fullmatch(self.turn))
        if method in ('item/started','item/completed'):
            item=p.get('item',{}); kind=item.get('type')
            require(kind in ITEMS,'CODEX_NATIVE_ITEM_REJECTED')
            require(p.get('threadId')==self.thread and p.get('turnId')==self.turn,'CODEX_NATIVE_ITEM_REJECTED')
            if kind=='mcpToolCall':
                require(item.get('server')==SERVER and isinstance(item.get('id'),str) and IDENT.fullmatch(item['id']),'CODEX_NATIVE_ITEM_REJECTED')
                if method=='item/started':
                    catalog=self.client.read_catalog(self.root)
                    args=item.get('arguments')
                    if isinstance(args,str): args=self.client.strict_json(args)
                    digest=self.client.tool_arguments(catalog,item.get('tool'),args)
                    evidence={**{k:self.m[k] for k in ('operationId','runId','generation')},'nativeThreadId':self.thread,
                              'nativeTurnId':self.turn,'callId':item['id'],'server':SERVER,'name':item['tool'],'inputSha256':digest}
                    record(self.root/'observations'/(sha(item['id'].encode())+'.json'),evidence)
        if method=='turn/completed':
            require(p.get('threadId')==self.thread and p.get('turn',{}).get('id')==self.turn)
            self.turn=None
        return frame


def fence(root,m):
    if not (root/'STOPPING.json').exists():
        try: record(root/'STOPPING.json',{'version':1,**binding(m)})
        except FileExistsError: pass


def stop_scopes(root,m,h):
    control=lock(root/'CONTROL.lock')
    try: fence(root,m)
    finally: os.close(control)
    for role in ('app','socket'):
        start=root/(role.upper()+'-STARTING.json')
        if start.exists():
            data=strict_json(read_file(start)); require(data['bootId']==boot_id(),'CODEX_STOP_UNKNOWN')
            h.codex_scope_stop(data['unit'])


def proof(root,m,h):
    details=[]
    require((root/'STOPPING.json').exists(),'CODEX_STOP_UNKNOWN')
    for role in ('app','socket'):
        fd=lock(root/(role.upper()+'-WRITER.lock')); os.close(fd)
        if not (root/(role.upper()+'-STARTING.json')).exists(): continue
        data=scope_record(root,role,m)
        require(data['bootId']==boot_id() and all(data[k]==v for k,v in binding(m).items()),'CODEX_STOP_UNKNOWN')
        state=h.codex_scope_state(data['unit'])
        require(state.get('ActiveState') in ('inactive','failed') and not state.get('ControlGroup'),'CODEX_STOP_UNKNOWN')
        path=Path('/sys/fs/cgroup'+data['cgroup'])
        if path.exists():
            st=path.stat(); require((st.st_dev,st.st_ino)==(data['dev'],data['inode']),'CODEX_STOP_UNKNOWN')
            require(not (path/'cgroup.procs').read_text().strip() and 'populated 0' in (path/'cgroup.events').read_text(),'CODEX_STOP_UNKNOWN')
        fd=lock(root/(role.upper()+'-WRITER.lock')); os.close(fd)
        details.append({**data,'populated':0,'domainRemoved':not path.exists()})
    # A stale socket pathname is not a listener; verify by an actual AF_UNIX connect.
    import socket
    sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); sock.settimeout(.5)
    try:
        sock.connect(str(root/'tool.sock')); raise ValueError('CODEX_STOP_UNKNOWN')
    except (FileNotFoundError,ConnectionRefusedError): pass
    finally: sock.close()
    return {'version':1,'engine':'codex',**binding(m),'bootId':boot_id(),'remoteStopped':True,'scopes':details}


def launch(root,m,h):
    fd=lock(root/'APP-WRITER.lock'); process=None
    seq=0
    def emit(kind,**payload):
        nonlocal seq
        seq+=1
        print(json.dumps({'version':1,'engine':'codex',**binding(m),'kind':kind,'seq':seq,**payload},separators=(',',':')),flush=True)
    try:
        require(not (root/'STOPPING.json').exists() and not (root/'APP-STARTING.json').exists())
        home=Path(m['codexHome'])
        spec=launch_spec(root,m)
        lane_admission(root,m,h)
        process=start_scope(root,'app',m,spec,h,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
        emit('ready',cliVersion='0.167.0',cliSha256=m['cliSha256'],nativeSha256=m['nativeSha256'],
             catalogSha256=spec['catalogSha256'],policySha256=spec['policySha256'],argvSha256=spec['argvSha256'])
        sys.stderr.write('CODEX_REMOTE_READY protocol=1\n'); sys.stderr.flush()
        policy=Policy(root,m,module('codex-fixed-mcp.py'))
        selector=selectors.DefaultSelector()
        selector.register(sys.stdin.buffer,selectors.EVENT_READ,'input')
        selector.register(process.stdout,selectors.EVENT_READ,'stdout')
        selector.register(process.stderr,selectors.EVENT_READ,'stderr')
        buffers={'input':b'','stdout':b''}; running=True
        try:
            while running:
                if (root/'STOPPING.json').exists(): break
                for key,_ in selector.select(.5):
                    channel=key.data; data=os.read(key.fd,65536)
                    if not data:
                        if channel=='stderr': selector.unregister(key.fileobj); continue
                        require(not buffers[channel],'CODEX_RPC_REJECTED'); running=False; break
                    if channel=='stderr':
                        # Native stderr may contain auth/provider diagnostics: never echo its text.
                        emit('stderr',bytes=len(data),sha256=sha(data)); continue
                    buffers[channel]+=data; require(len(buffers[channel])<=MAX_FRAME,'CODEX_RPC_REJECTED')
                    while b'\n' in buffers[channel]:
                        line,buffers[channel]=buffers[channel].split(b'\n',1)
                        if not line: continue
                        frame=strict_json(line)
                        if channel=='input':
                            frame=policy.incoming(frame)
                            process.stdin.write(encoded(frame)+b'\n')
                        else:
                            try: policy.outgoing(frame)
                            except ValueError:
                                if 'id' in frame and 'method' in frame:
                                    process.stdin.write(encoded({'id':frame['id'],'error':{'code':-32601,'message':'Remote policy denied'}})+b'\n')
                                if policy.thread and policy.turn:
                                    process.stdin.write(encoded({'id':'oc-stop','method':'turn/interrupt','params':{'threadId':policy.thread,'turnId':policy.turn}})+b'\n')
                                raise
                            # Append raw evidence before emitting it to the master.
                            with open(root/'native.jsonl','ab',buffering=0) as journal:
                                journal.write(line+b'\n'); os.fsync(journal.fileno())
                            emit('stdout',payload=frame)
        finally: selector.close()
    except (ValueError,OSError,KeyError,TypeError,RuntimeError) as exc:
        code=str(exc)
        if code in ('REMOTE_NODE_MEMORY_EXHAUSTED','REMOTE_NODE_TASKS_EXHAUSTED'):
            emit('error',code=code,activeSessions=exc.status['activeSessions'],admission=exc.status)
        else:
            emit('error',code=code if re.fullmatch(r'CODEX_[A-Z_]+',code) else 'CODEX_POLICY_REJECTED')
        raise
    finally:
        try:
            stop_scopes(root,m,h)
            if process is not None: process.wait(timeout=10)
        finally:
            if process is not None:
                for stream in (process.stdin,process.stdout,process.stderr): stream.close()
            os.close(fd)


def main():
    require(len(sys.argv) in (3,4))
    role=sys.argv[1]; root=task_root(sys.argv[2])
    if role=='provision': provision(root); return 0
    if role=='preflight':
        require(len(sys.argv)==3); preflight(root); return 0
    if role=='fence-stop':
        line=sys.stdin.buffer.readline(32769)
        require(len(line)<=32768 and line.endswith(b'\n'))
        expected=strict_json(line); require(isinstance(expected,dict))
        fence_unprovisioned(root,expected)
    m=manifest(root); h=module('oc-remote-hostd.py')
    if role=='_worker': require(len(sys.argv)==4); worker(root,sys.argv[3]); return 126
    require(len(sys.argv)==3)
    if role=='launch': launch(root,m,h)
    elif role=='tool-socket':
        fd=lock(root/'SOCKET-WRITER.lock')
        try:
            require(not (root/'STOPPING.json').exists() and not (root/'SOCKET-STARTING.json').exists())
            lane_admission(root,m,h)
            p=start_scope(root,'socket',m,launch_spec(root,m),h,stdin=sys.stdin.buffer,stdout=sys.stdout.buffer,stderr=sys.stderr.buffer)
            rc=p.wait(); require(rc==0,'CODEX_STOP_UNKNOWN')
        finally: os.close(fd)
    elif role in ('stop','fence-stop','prove-stopped'):
        if role in ('stop','fence-stop'): stop_scopes(root,m,h)
        end=time.monotonic()+10
        while True:
            try: result=proof(root,m,h); break
            except (ValueError,OSError):
                if time.monotonic()>=end: raise ValueError('CODEX_STOP_UNKNOWN') from None
                time.sleep(.1)
        h.engine_resources().release(str(root))
        print(json.dumps(result,separators=(',',':')),flush=True)
    else: raise ValueError('CODEX_RPC_REJECTED')
    return 0

if __name__=='__main__':
    os.umask(0o077)
    try: sys.exit(main())
    except (ValueError,OSError,KeyError,TypeError,RuntimeError,subprocess.SubprocessError) as exc:
        if str(exc) in ('REMOTE_NODE_MEMORY_EXHAUSTED','REMOTE_NODE_TASKS_EXHAUSTED'):
            print(json.dumps({'version':1,'engine':'codex','kind':'error','code':str(exc),
                              'activeSessions':exc.status['activeSessions'],'admission':exc.status}),flush=True)
        sys.stderr.write('CODEX_NODE_REJECTED_OR_STOP_UNKNOWN\n'); sys.exit(126)
