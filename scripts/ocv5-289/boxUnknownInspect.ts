/** Read-only exact-run recovery inspection. No model launch, mutation, retry
 * or cleanup; the fixed account lock remains until proof permits release. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeSync } from "node:fs";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { assessUnknownProbeQuarantine,
  type UnknownObservationSnapshot } from "./boxUnknownQuarantinePolicy.js";

const LOCK = "/var/lib/openclaude/ocv5-289-box-operator/account-20.json";
const MUTEX = "/var/lib/openclaude/ocv5-289-box-operator/account-20.mutex";
const DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const SNAPSHOT = `${DIR}/account-20.unknown-observation.json`;
const READ = String.raw`import hashlib,json,os,re,stat,sys
nonce,*assets=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or len(assets)!=4:raise SystemExit(126)
def inspect(path,want=None):
 try:st=os.lstat(path)
 except FileNotFoundError:return {'present':False}
 if stat.S_ISLNK(st.st_mode):return {'present':True,'kind':'symlink'}
 kind='dir' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'other'
 result={'present':True,'kind':kind,'mode':stat.S_IMODE(st.st_mode),
  'size':st.st_size,'ageSec':max(0,int(__import__('time').time()-st.st_mtime))}
 if want is not None and kind=='file' and st.st_size<=32768:
  with open(path,'rb') as f:result['hashMatches']=hashlib.sha256(f.read()).hexdigest()==want
 return result
def stream_shape(path):
 try:dfd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 except FileNotFoundError:return {'present':False}
 try:
  d=os.fstat(dfd)
  if d.st_uid!=os.getuid() or stat.S_IMODE(d.st_mode)!=0o700:raise SystemExit(126)
  try:fd=os.open('stdout.jsonl',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=dfd)
  except FileNotFoundError:return {'present':False}
  try:
   st=os.fstat(fd)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1:raise SystemExit(126)
   data=os.pread(fd,min(st.st_size,2*1024*1024),0)
  finally:os.close(fd)
  def safe_type(value,allowed):
   if isinstance(value,str) and value in allowed:return value
   return 'other-'+hashlib.sha256(str(value).encode()).hexdigest()[:8]
  allowed={'system','assistant','user','result','rate_limit_event','stream_event','tool_progress','tool_use_summary','auth_status'}
  events={'message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop','ping'}
  all_lines=data.split(b'\n')[:-1]
  result_count=0;tool_use_count=0;tool_result_count=0
  invalid_count=0;unrecognized_count=0
  last_type=None;last_result_error=None;last_result_subtype=None
  def nested_tool_evidence(value,depth=0):
   if depth>12:raise ValueError('nested record too deep')
   if isinstance(value,dict):
    hit=int(value.get('type') in ('tool_use','tool_result')
      or value.get('stop_reason')=='tool_use' or 'tool_use_id' in value)
    return hit+sum(nested_tool_evidence(v,depth+1) for v in value.values())
   if isinstance(value,list):
    if len(value)>4096:raise ValueError('nested record too wide')
    return sum(nested_tool_evidence(v,depth+1) for v in value)
   return 0
  for line in all_lines:
   try:whole=json.loads(line)
   except (UnicodeDecodeError,ValueError):
    invalid_count+=1;last_type='invalid_json';continue
   if not isinstance(whole,dict):
    invalid_count+=1;last_type='non_object';continue
   try:tool_use_count+=nested_tool_evidence(whole)
   except ValueError:unrecognized_count+=1
   last_type=whole.get('type') if whole.get('type') in allowed else 'other'
   if last_type=='other':unrecognized_count+=1
   if whole.get('type')=='result':
    result_count+=1;last_result_error=whole.get('is_error') is True
    subtype=whole.get('subtype')
    last_result_subtype=(subtype if subtype in
      ('success','error','error_during_execution','error_max_turns') else None)
   if whole.get('type') in ('tool_progress','tool_use_summary'):tool_use_count+=1
   if whole.get('type')=='stream_event':
    event=whole.get('event')
    if not isinstance(event,dict) or event.get('type') not in events:
     unrecognized_count+=1
    elif event.get('type')=='message_start':
     msg=event.get('message')
     content=msg.get('content') if isinstance(msg,dict) else None
     if not isinstance(content,list) or any(not isinstance(b,dict)
       or b.get('type') not in ('text','thinking','redacted_thinking','tool_use')
       for b in content):unrecognized_count+=1
    elif event.get('type')=='content_block_start':
     block=event.get('content_block')
     kind=block.get('type') if isinstance(block,dict) else None
     if kind=='tool_use':tool_use_count+=1
     elif kind not in ('text','thinking','redacted_thinking'):unrecognized_count+=1
    elif event.get('type')=='content_block_delta':
     delta=event.get('delta')
     if (not isinstance(delta,dict) or delta.get('type') not in
       ('text_delta','thinking_delta','signature_delta','input_json_delta')):
      unrecognized_count+=1
     elif delta.get('type')=='input_json_delta':tool_use_count+=1
    elif event.get('type')=='message_delta':
     delta=event.get('delta')
     if (not isinstance(delta,dict) or delta.get('stop_reason') not in
       (None,'tool_use','end_turn','max_tokens','stop_sequence')):
      unrecognized_count+=1
     elif delta.get('stop_reason')=='tool_use':tool_use_count+=1
   msg=whole.get('message')
   blocks=msg.get('content') if isinstance(msg,dict) else None
   if whole.get('type') in ('assistant','user') and not isinstance(blocks,list):
    unrecognized_count+=1
   if isinstance(blocks,list):
    tool_use_count+=sum(isinstance(b,dict) and b.get('type')=='tool_use' for b in blocks)
    tool_result_count+=sum(isinstance(b,dict) and b.get('type')=='tool_result' for b in blocks)
    if any(not isinstance(b,dict) or b.get('type') not in
      ('text','thinking','redacted_thinking','tool_use','tool_result','image') for b in blocks):
     unrecognized_count+=1
  records=[];used=0;budget_exceeded=False
  for line in all_lines[:64]:
   try:record=json.loads(line)
   except (UnicodeDecodeError,ValueError):records.append({'type':'invalid_json'});continue
   if not isinstance(record,dict):records.append({'type':'non_object'});continue
   item={'type':safe_type(record.get('type'),allowed)}
   if item['type']=='stream_event':
    event=record.get('event')
    item['event']=safe_type(event.get('type') if isinstance(event,dict) else None,events)
    if isinstance(event,dict) and item['event']=='content_block_start':
     block=event.get('content_block')
     item['block']=safe_type(block.get('type') if isinstance(block,dict) else None,
      {'text','thinking','redacted_thinking','tool_use'})
    if isinstance(event,dict) and item['event']=='message_delta':
     delta=event.get('delta')
     item['stop']=safe_type(delta.get('stop_reason') if isinstance(delta,dict) else None,
      {'tool_use','end_turn','max_tokens','stop_sequence'})
   if item['type']=='system':
    item['subtype']=safe_type(record.get('subtype'),{'init','status','compact_boundary'})
   if item['type']=='assistant':
    msg=record.get('message')
    content=msg.get('content') if isinstance(msg,dict) else None
    item['blocks']=[safe_type(b.get('type') if isinstance(b,dict) else None,
     {'text','thinking','redacted_thinking','tool_use'}) for b in content[:8]] if isinstance(content,list) else []
   if item['type']=='user':
    msg=record.get('message')
    content=msg.get('content') if isinstance(msg,dict) else None
    item['blocks']=[safe_type(b.get('type') if isinstance(b,dict) else None,
     {'text','image','tool_result'}) for b in content[:8]] if isinstance(content,list) else []
   if item['type']=='result':
    item['subtype']=safe_type(record.get('subtype'),{'success','error','error_during_execution','error_max_turns'})
    item['isError']=record.get('is_error') is True
   item_bytes=len(json.dumps(item,separators=(',',':')).encode())+1
   if used+item_bytes>4000:budget_exceeded=True;break
   records.append(item);used+=item_bytes
  try:err=os.stat('stderr.log',dir_fd=dfd,follow_symlinks=False).st_size
  except FileNotFoundError:err=None
  def safe_key(value):
   key=str(value)
   return key if key in ('type','thinking','signature','text','id','name','input','caller') else 'key-'+hashlib.sha256(key.encode()).hexdigest()[:8]
  def safe_shape(value):
   if isinstance(value,str):return {'kind':'string','length':len(value),
    'sha256':hashlib.sha256(value.encode()).hexdigest()[:16]}
   if isinstance(value,dict):return {'kind':'object','keys':sorted(safe_key(k) for k in value)[:16],
    'sha256':hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()[:16]}
   return {'kind':type(value).__name__}
  active={};built=[];snapshot=[]
  for line in all_lines:
   try:item=json.loads(line)
   except (UnicodeDecodeError,ValueError):continue
   if not isinstance(item,dict):continue
   if item.get('type')=='assistant':
    msg=item.get('message')
    if isinstance(msg,dict) and isinstance(msg.get('content'),list):snapshot.extend(msg['content'])
   if item.get('type')!='stream_event':continue
   ev=item.get('event')
   if not isinstance(ev,dict):continue
   kind=ev.get('type');index=ev.get('index')
   if not isinstance(index,int) or index<0 or index>32:continue
   if kind=='content_block_start' and isinstance(ev.get('content_block'),dict):
    active[index]={'block':dict(ev['content_block']),'text':'','thinking':'',
     'signature':None,'partial':''}
   elif kind=='content_block_delta' and index in active:
    delta=ev.get('delta')
    if not isinstance(delta,dict):continue
    if delta.get('type')=='text_delta' and isinstance(delta.get('text'),str):active[index]['text']+=delta['text']
    if delta.get('type')=='thinking_delta' and isinstance(delta.get('thinking'),str):active[index]['thinking']+=delta['thinking']
    if delta.get('type')=='signature_delta' and isinstance(delta.get('signature'),str):active[index]['signature']=delta['signature']
    if delta.get('type')=='input_json_delta' and isinstance(delta.get('partial_json'),str):active[index]['partial']+=delta['partial_json']
   elif kind=='content_block_stop' and index in active:
    state=active.pop(index);block=state['block'];type_=block.get('type')
    if type_=='text':block['text']=state['text']
    if type_=='thinking' and state['thinking']:block['thinking']=(block.get('thinking') or '')+state['thinking']
    if state['signature'] is not None:block['signature']=state['signature']
    if type_=='tool_use' and state['partial']:
     try:block['input']=json.loads(state['partial'])
     except ValueError:pass
    built.append(block)
  parity=[]
  if isinstance(snapshot,list):
   for index in range(min(8,max(len(snapshot),len(built)))):
    left=built[index] if index<len(built) else None
    right=snapshot[index] if index<len(snapshot) else None
    if isinstance(left,dict) and isinstance(right,dict):
     keys=sorted(set(left)|set(right))
     parity.append({'index':index,'streamType':left.get('type') if left.get('type') in ('text','thinking','redacted_thinking','tool_use') else 'other',
      'snapshotType':right.get('type') if right.get('type') in ('text','thinking','redacted_thinking','tool_use') else 'other',
      'different':[{ 'field':safe_key(key), 'stream':safe_shape(left.get(key)),
       'snapshot':safe_shape(right.get(key)) } for key in keys if left.get(key)!=right.get(key)][:8]})
    else:parity.append({'index':index,'shapeMismatch':True})
  partial=bool(data and not data.endswith(b'\n'))
  return {'present':True,'stdoutBytes':st.st_size,'stderrBytes':err,
    'stdoutSha256':hashlib.sha256(data).hexdigest() if st.st_size==len(data) else None,
    'partialLine':partial,
    'truncated':st.st_size>len(data) or len(data.split(b'\n'))-1>64 or partial or budget_exceeded,
    'resultCount':result_count,'lastType':last_type,
    'lastResultIsError':last_result_error,
    'lastResultSubtype':last_result_subtype,
    'invalidCount':invalid_count,'unrecognizedCount':unrecognized_count,
    'toolUseCount':tool_use_count,'toolResultCount':tool_result_count,
    'snapshotParity':parity,
    'records':records}
 finally:os.close(dfd)
def run_entries(path):
 try:dfd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 except FileNotFoundError:return {'present':False}
 try:
  st=os.fstat(dfd)
  if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(126)
  names=os.listdir(dfd)
  return {'present':True,'count':len(names),
   'pendingCount':sum(n.startswith('pending.toolu_') for n in names),
   'resultCount':sum(n.startswith('result.toolu_') for n in names),
   'unexpectedCount':sum(not (n in ('stdin.jsonl','system.txt','tool-catalog.json',
    'stdout.jsonl','stderr.log') or n.startswith('pending.toolu_')
    or n.startswith('result.toolu_')) for n in names)}
 finally:os.close(dfd)
def terminal_shape(path):
 try:dfd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 except FileNotFoundError:return {'present':False}
 try:
  d=os.fstat(dfd)
  if d.st_uid!=os.getuid() or stat.S_IMODE(d.st_mode)!=0o700:raise SystemExit(126)
  try:fd=os.open('terminal.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=dfd)
  except FileNotFoundError:return {'present':False}
  try:
   st=os.fstat(fd)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or st.st_size>4096:raise SystemExit(126)
   raw=os.read(fd,4097)
  finally:os.close(fd)
 finally:os.close(dfd)
 try:proof=json.loads(raw)
 except (UnicodeDecodeError,ValueError):return {'present':True,'invalid':True}
 if not isinstance(proof,dict):return {'present':True,'invalid':True}
 return {'present':True,'nonceMatches':proof.get('runNonce')==nonce,
  'reason':proof.get('reason') if proof.get('reason') in ('worker_complete','keeper_stopped','deadline','unknown') else 'other',
  'revision':proof.get('revision') if isinstance(proof.get('revision'),int) else None}
def process_shape():
 matches=[];scanned=0;unreadable=0;unreadable_young=0
 cmdline_truncated=False;fd_truncated=False;claude_like=[]
 with open('/proc/uptime',encoding='ascii') as f:uptime=float(f.read().split()[0])
 ticks=os.sysconf('SC_CLK_TCK')
 try:runstat=os.stat('/tmp/ocv5-289-run-'+nonce)
 except FileNotFoundError:runstat=None
 run_age=max(0,int(__import__('time').time()-runstat.st_mtime)) if runstat else None
 try:outstat=os.stat('/tmp/ocv5-289-run-'+nonce+'/stdout.jsonl')
 except FileNotFoundError:outstat=None
 for raw_pid in os.listdir('/proc'):
  if not raw_pid.isdigit():continue
  scanned+=1
  if scanned>4096:break
  pid=int(raw_pid)
  if pid==os.getpid():continue
  root='/proc/'+raw_pid
  try:
   if os.stat(root).st_uid!=os.getuid():continue
   with open(root+'/cmdline','rb') as f:cmd=f.read(16385)
   if len(cmd)>16384:cmdline_truncated=True
   with open(root+'/status',encoding='ascii',errors='ignore') as f:lines=f.readlines()[:8]
  except PermissionError:unreadable+=1;unreadable_young+=1;continue
  except (FileNotFoundError,ProcessLookupError):continue
  fields={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in lines if ':' in line}
  name=fields.get('Name','')
  state=fields.get('State','')[:1]
  ppid=fields.get('PPid','')
  age=None
  try:
   with open(root+'/stat',encoding='ascii',errors='ignore') as f:statline=f.read(4096)
   tail=statline.rsplit(')',1)[1].split()
   age=max(0,int(uptime-int(tail[19])/ticks))
  except (OSError,ValueError,IndexError):unreadable+=1
  if name=='claude' or (name in ('node','python3') and b'claude' in cmd.lower()):
   if len(claude_like)<16:claude_like.append({'pid':pid,'name':name,
    'state':state if state in ('R','S','D','T','Z','I') else 'other',
    'ppid':int(ppid) if ppid.isdigit() else None,'ageSec':age})
  same_cwd=False;same_stdout=False
  if runstat is not None:
   try:
    cwd=os.stat(root+'/cwd')
    same_cwd=(cwd.st_dev,cwd.st_ino)==(runstat.st_dev,runstat.st_ino)
   except PermissionError:
    unreadable+=1
    if run_age is None or age is None or age<=run_age+60:unreadable_young+=1
   except (FileNotFoundError,ProcessLookupError):pass
  if outstat is not None:
   try:
    fds=os.listdir(root+'/fd')
    if len(fds)>128:fd_truncated=True
    for fd in fds[:128]:
     try:opened=os.stat(root+'/fd/'+fd)
     except (FileNotFoundError,ProcessLookupError):continue
     if (opened.st_dev,opened.st_ino)==(outstat.st_dev,outstat.st_ino):
      same_stdout=True;break
   except PermissionError:
    unreadable+=1
    if run_age is None or age is None or age<=run_age+60:unreadable_young+=1
   except (FileNotFoundError,ProcessLookupError):pass
  nonce_arg=nonce.encode() in cmd
  if not (nonce_arg or same_cwd or same_stdout):continue
  matches.append({'pid':pid,'ppid':int(ppid) if ppid.isdigit() else None,
    'name':name if name in ('python3','claude','node') else 'other',
    'state':state if state in ('R','S','D','T','Z','I') else 'other',
    'nonceArg':nonce_arg,'sameCwd':same_cwd,'sameStdout':same_stdout})
  if len(matches)>=8:break
 return {'matches':matches,'claudeLikeCount':len(claude_like),
  'claudeLike':claude_like,'scanned':scanned,'unreadable':unreadable,
  'unreadableYoung':unreadable_young,
  'cmdlineTruncated':cmdline_truncated,'fdTruncated':fd_truncated,
  'incomplete':scanned>4096 or len(matches)>=8 or len(claude_like)>=16 or unreadable>0
    or cmdline_truncated or fd_truncated}
out={'run':inspect('/tmp/ocv5-289-run-'+nonce),
 'runEntries':run_entries('/tmp/ocv5-289-run-'+nonce),
 'proof':inspect('/tmp/ocv5-289-proof-'+nonce),
 'terminal':terminal_shape('/tmp/ocv5-289-proof-'+nonce),
 'stream':stream_shape('/tmp/ocv5-289-run-'+nonce),
 'processes':process_shape(),
 'assets':[inspect(path,want) for path,want in
  (item.split(':',1) for item in assets)]}
print(json.dumps(out,separators=(',',':'))) `;

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3"
    || process.env.OCV5_289_INSPECT_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_INSPECT_ACK_REQUIRED");
  const clearing = process.env.OCV5_289_CLEAR_PRESTART_ACK === "1";
  const quarantining = process.env.OCV5_289_QUARANTINE_UNKNOWN_ACK === "1";
  if (clearing && quarantining) throw new Error("BOX_INSPECT_MODE_CONFLICT");
  let mutexHeld = false;
  const syncDirectory = (): void => {
    const fd = openSync(DIR, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  if (clearing || quarantining) {
    let fd: number;
    try { fd = openSync(MUTEX, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("BOX_INSPECT_OPERATOR_BUSY");
      }
      throw error;
    }
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(); mutexHeld = true;
  }
  try {
  const st = lstatSync(LOCK);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid()
    || (st.mode & 0o777) !== 0o600 || st.size < 1 || st.size > 4096) {
    throw new Error("BOX_INSPECT_LOCK_INVALID");
  }
  const rawLock = readFileSync(LOCK, "utf8");
  const record = JSON.parse(rawLock) as Record<string, unknown>;
  if (record.accountId !== "20" || record.uid !== "3"
    || typeof record.runNonce !== "string"
    || !/^[a-f0-9]{24}$/.test(record.runNonce)
    || typeof record.leaseEpoch !== "string"
    || !/^[a-f0-9]{32}$/.test(record.leaseEpoch)) {
    throw new Error("BOX_INSPECT_IDENTITY_INVALID");
  }
  const assets = ["box_supervisor.py", "box_keeper.py",
    "box_virtual_mcp.py", "box_detached_runner.py"].map((file) => {
      const hash = createHash("sha256").update(readFileSync(new URL(`./${file}`,
        import.meta.url))).digest("hex");
      const prefix = file === "box_supervisor.py" ? "supervisor"
        : file === "box_keeper.py" ? "keeper"
        : file === "box_virtual_mcp.py" ? "box-virtual-mcp" : "detached-runner";
      return `/tmp/ocv5-289-${prefix}-${hash.slice(0, 16)}.py:${hash}`;
    });
  const resolver = createProductionBoxAccountResolver();
  const target = await resolver.resolve({ uid: 3n, sessionId: null,
    requestId: `ocv5-289-inspect-${record.runNonce}`,
    upstreamModel: "claude-opus-5-5", requiredAccountId: 20n,
    signal: new AbortController().signal });
  try {
    if (target.accountId !== 20n) throw new Error("BOX_INSPECT_ACCOUNT_MISMATCH");
    const result = await target.exec.run({ command: "/usr/bin/python3",
      args: ["-I", "-c", READ, record.runNonce, ...assets], cwd: "/tmp",
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
    { timeoutMs: 20_000, maxResponseBytes: 8192 });
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    let clearedLock = false;
    let quarantinedLock = false;
    let awaitingSecondObservation = false;
    if (clearing) {
      if (process.env.OCV5_289_EXPECTED_RUN_NONCE !== record.runNonce
        || process.env.OCV5_289_EXPECTED_FIRST_ID !== record.firstId
        || process.env.OCV5_289_EXPECTED_PHASE !== "stage_transport_unknown"
        || (!Object.hasOwn(record, "pid")
          && process.env.OCV5_289_PROBE_PROCESS_EXITED_ACK !== "1")
        || (Object.hasOwn(record, "pid")
          && (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)
            || record.pid <= 0))
        || record.state !== "unresolved"
        || (observed.run as { present?: unknown } | undefined)?.present !== false
        || (observed.proof as { present?: unknown } | undefined)?.present !== false) {
        throw new Error("BOX_INSPECT_PRESTART_NOT_PROVEN");
      }
      if (typeof record.pid === "number" && Number.isSafeInteger(record.pid)
        && record.pid > 0) {
        try { process.kill(record.pid, 0); throw new Error("BOX_INSPECT_PROBE_STILL_RUNNING"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      // The local stage catch ran before markRunning/launch; the exact remote
      // run and proof dirs are absent. Only now may this operator lock release.
      const latest = lstatSync(LOCK);
      if (latest.dev !== st.dev || latest.ino !== st.ino
        || readFileSync(LOCK, "utf8") !== rawLock) {
        throw new Error("BOX_INSPECT_LOCK_CHANGED");
      }
      unlinkSync(LOCK);
      syncDirectory();
      clearedLock = true;
    }
    if (quarantining) {
      if (process.env.OCV5_289_EXPECTED_RUN_NONCE !== record.runNonce
        || process.env.OCV5_289_EXPECTED_FIRST_ID !== record.firstId
        || process.env.OCV5_289_EXPECTED_PHASE !== "first_round_unknown"
        || record.state !== "unresolved"
        || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)
        || record.pid <= 0) throw new Error("BOX_UNKNOWN_QUARANTINE_IDENTITY_INVALID");
      try { process.kill(record.pid, 0); throw new Error("BOX_UNKNOWN_PROBE_STILL_RUNNING"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const lockSha256 = createHash("sha256").update(rawLock).digest("hex");
      let previous: UnknownObservationSnapshot | undefined;
      try {
        const prior = lstatSync(SNAPSHOT);
        if (!prior.isFile() || prior.isSymbolicLink() || prior.uid !== process.getuid()
          || (prior.mode & 0o777) !== 0o600 || prior.size < 1 || prior.size > 4096) {
          throw new Error("BOX_UNKNOWN_SNAPSHOT_INVALID");
        }
        previous = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as UnknownObservationSnapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const assessed = assessUnknownProbeQuarantine({ observed,
        runNonce: record.runNonce, lockSha256, nowMs: Date.now(), previous });
      const writeOnce = (path: string, raw: string): void => {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
          | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const data = Buffer.from(raw, "utf8");
          let written = 0;
          while (written < data.length) written += writeSync(fd, data, written);
          fsyncSync(fd);
        } finally { closeSync(fd); }
        syncDirectory();
      };
      if (!assessed.ready) {
        writeOnce(SNAPSHOT, JSON.stringify(assessed.snapshot));
        awaitingSecondObservation = true;
      } else {
        const archive = `${DIR}/account-20.quarantined-${record.runNonce}.json`;
        const archiveRecord = { kind: "synthetic_unknown_cli_error",
          terminalProof: false, settledUsage: false, replayAllowed: false,
          originalLock: record, first: previous, second: assessed.snapshot,
          quarantinedAt: new Date().toISOString() };
        try {
          const archiveFd = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
          const priorArchive = fstatSync(archiveFd);
          if (!priorArchive.isFile() || priorArchive.uid !== process.getuid()
            || (priorArchive.mode & 0o777) !== 0o600
            || priorArchive.nlink !== 1
            || priorArchive.size < 1 || priorArchive.size > 8192) {
            throw new Error("BOX_UNKNOWN_ARCHIVE_INVALID");
          }
          const saved = JSON.parse(readFileSync(archiveFd, "utf8")) as Record<string, unknown>;
          const first = saved.first as Record<string, unknown> | undefined;
          const second = saved.second as Record<string, unknown> | undefined;
          if (saved.kind !== "synthetic_unknown_cli_error"
            || saved.terminalProof !== false || saved.settledUsage !== false
            || saved.replayAllowed !== false
            || JSON.stringify(saved.originalLock) !== JSON.stringify(record)
            || !first || first.lockSha256 !== lockSha256
            || first.runNonce !== record.runNonce
            || first.stdoutSha256 !== assessed.snapshot.stdoutSha256
            || !second || second.stdoutSha256 !== assessed.snapshot.stdoutSha256
            || second.stdoutBytes !== assessed.snapshot.stdoutBytes
            || second.lockSha256 !== lockSha256
            || second.runNonce !== record.runNonce
            || typeof first.observedAtMs !== "number"
            || typeof second.observedAtMs !== "number"
            || second.observedAtMs - first.observedAtMs < 60_000) {
            throw new Error("BOX_UNKNOWN_ARCHIVE_CONFLICT");
          }
          // A previous process may have crashed after writing but before the
          // file fsync. Re-establish durability before deleting the only lock.
          fsyncSync(archiveFd);
          } finally { closeSync(archiveFd); }
          syncDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          writeOnce(archive, JSON.stringify(archiveRecord));
        }
        const latest = lstatSync(LOCK);
        if (latest.dev !== st.dev || latest.ino !== st.ino
          || readFileSync(LOCK, "utf8") !== rawLock) {
          throw new Error("BOX_INSPECT_LOCK_CHANGED");
        }
        // This releases ONLY the synthetic operator mutex. It does not alter
        // the live billing journal, claim keeper proof, or delete Box files.
        unlinkSync(SNAPSHOT);
        syncDirectory();
        unlinkSync(LOCK);
        syncDirectory();
        quarantinedLock = true;
      }
    }
    process.stdout.write(JSON.stringify({ accountId: "20", runNonce: record.runNonce,
      observed, clearedLock, quarantinedLock, awaitingSecondObservation }) + "\n");
  } finally { await target.dispose?.(); }
  } finally {
    if (mutexHeld) { unlinkSync(MUTEX); syncDirectory(); }
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_INSPECT_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
