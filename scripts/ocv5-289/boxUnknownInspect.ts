/** Read-only exact-run recovery inspection. No model launch, mutation, retry
 * or cleanup; the fixed account lock remains until proof permits release. */
import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, openSync,
  readFileSync, unlinkSync } from "node:fs";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const LOCK = "/var/lib/openclaude/ocv5-289-box-operator/account-20.json";
const MUTEX = "/var/lib/openclaude/ocv5-289-box-operator/account-20.mutex";
const DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const READ = String.raw`import hashlib,json,os,re,stat,sys
nonce,*assets=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or len(assets)!=4:raise SystemExit(126)
def inspect(path,want=None):
 try:st=os.lstat(path)
 except FileNotFoundError:return {'present':False}
 if stat.S_ISLNK(st.st_mode):return {'present':True,'kind':'symlink'}
 kind='dir' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'other'
 result={'present':True,'kind':kind,'mode':stat.S_IMODE(st.st_mode),'size':st.st_size}
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
  records=[];used=0;budget_exceeded=False
  for line in data.split(b'\n')[:-1][:64]:
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
  partial=bool(data and not data.endswith(b'\n'))
  return {'present':True,'stdoutBytes':st.st_size,'stderrBytes':err,
   'partialLine':partial,
   'truncated':st.st_size>len(data) or len(data.split(b'\n'))-1>64 or partial or budget_exceeded,
   'records':records}
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
 matches=[];scanned=0;unreadable=0;cmdline_truncated=False
 for raw_pid in os.listdir('/proc'):
  if not raw_pid.isdigit():continue
  scanned+=1
  if scanned>4096:break
  pid=int(raw_pid)
  if pid==os.getpid():continue
  try:
   with open('/proc/'+raw_pid+'/cmdline','rb') as f:cmd=f.read(4097)
   if len(cmd)>4096:cmdline_truncated=True
   if nonce.encode() not in cmd:continue
   with open('/proc/'+raw_pid+'/status',encoding='ascii',errors='ignore') as f:lines=f.readlines()[:8]
  except PermissionError:unreadable+=1;continue
  except (FileNotFoundError,ProcessLookupError):continue
  fields={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in lines if ':' in line}
  name=fields.get('Name','')
  state=fields.get('State','')[:1]
  ppid=fields.get('PPid','')
  matches.append({'pid':pid,'ppid':int(ppid) if ppid.isdigit() else None,
   'name':name if name in ('python3','claude','node') else 'other',
   'state':state if state in ('R','S','D','T','Z','I') else 'other'})
  if len(matches)>=8:break
 return {'matches':matches,
  'incomplete':scanned>4096 or len(matches)>=8 or unreadable>0 or cmdline_truncated}
out={'run':inspect('/tmp/ocv5-289-run-'+nonce),
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
  let mutexHeld = false;
  const syncDirectory = (): void => {
    const fd = openSync(DIR, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  if (clearing) {
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
    process.stdout.write(JSON.stringify({ accountId: "20", runNonce: record.runNonce,
      observed, clearedLock }) + "\n");
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
