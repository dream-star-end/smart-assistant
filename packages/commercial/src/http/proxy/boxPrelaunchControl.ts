/** V2 prelaunch write fence for private Box staging. This module only builds
 * bounded Exec requests and verifies bootstrap evidence. CLOSED is NOT a
 * cleanup/terminal proof and must never release paid capacity by itself. */
import { createHash } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";

export class BoxPrelaunchControlError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxPrelaunchControlError"; }
}
export interface BoxPrelaunchIdentity {
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly accountId: string;
  readonly controlId: string;
}
export interface BoxPrelaunchReceipt extends BoxPrelaunchIdentity {
  readonly version: 2;
  readonly controlDev: string;
  readonly controlIno: string;
  readonly lockDev: string;
  readonly lockIno: string;
  readonly identityHash: string;
}
const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const HEX24 = /^[a-f0-9]{24}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
function validIdentity(value: BoxPrelaunchIdentity): void {
  if (!HEX24.test(value.runNonce) || !HEX32.test(value.leaseEpoch)
    || !/^[1-9][0-9]{0,18}$/.test(value.accountId)
    || !HEX32.test(value.controlId)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_IDENTITY_INVALID");
  }
}

// This parent is root-owned sticky /tmp. The control directory, lock and
// identity inode are pinned and never part of run-data cleanup or GC.
const BOOTSTRAP = String.raw`import hashlib,json,os,re,stat,sys
nonce,epoch,account,control=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or not re.fullmatch(r'[a-f0-9]{32}',epoch) or not re.fullmatch(r'[1-9][0-9]{0,18}',account) or not re.fullmatch(r'[a-f0-9]{32}',control):raise SystemExit(126)
parent=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
name='ocv5-289-stage-'+nonce
try:
 os.mkdir(name,0o700,dir_fd=parent)
 dfd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  dst=os.fstat(dfd)
  if not stat.S_ISDIR(dst.st_mode) or dst.st_uid!=os.getuid() or stat.S_IMODE(dst.st_mode)!=0o700:raise SystemExit(126)
  lfd=os.open('lock',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
  try:
   lst=os.fstat(lfd)
   if not stat.S_ISREG(lst.st_mode) or lst.st_uid!=os.getuid() or stat.S_IMODE(lst.st_mode)!=0o600 or lst.st_nlink!=1:raise SystemExit(126)
   os.fsync(lfd)
  finally:os.close(lfd)
  identity={'accountId':account,'controlDev':str(dst.st_dev),'controlId':control,'controlIno':str(dst.st_ino),'leaseEpoch':epoch,'lockDev':str(lst.st_dev),'lockIno':str(lst.st_ino),'runNonce':nonce,'version':2}
  raw=json.dumps(identity,sort_keys=True,separators=(',',':')).encode()
  fd=os.open('identity.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
  try:
   if os.write(fd,raw)!=len(raw):raise SystemExit(126)
   os.fsync(fd)
  finally:os.close(fd)
  os.fsync(dfd);os.fsync(parent)
  identity['identityHash']=hashlib.sha256(raw).hexdigest()
  print(json.dumps(identity,sort_keys=True,separators=(',',':')))
 finally:os.close(dfd)
finally:os.close(parent)`;

const COMMON = String.raw`import base64,fcntl,hashlib,json,os,re,stat,sys,time
def project_parent():
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for name in ('home','box','.claude','projects'):
   nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=nxt
  if os.fstat(fd).st_uid!=os.getuid():raise SystemExit(126)
  return fd
 except BaseException:os.close(fd);raise
def read_owned(dfd,name):
 fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dfd)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or st.st_size<3 or st.st_size>48:raise SystemExit(126)
  raw=os.read(fd,49)
  if len(raw)!=st.st_size or not re.fullmatch(rb'[1-9][0-9]{0,19}:[1-9][0-9]{0,19}\n',raw):raise SystemExit(126)
  return raw.decode().strip()
 finally:os.close(fd)
def write_owned(dfd,name,st):
 raw=(str(st.st_dev)+':'+str(st.st_ino)+'\n').encode()
 fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
 try:
  if os.write(fd,raw)!=len(raw):raise SystemExit(126)
  os.fsync(fd)
 finally:os.close(fd)
 os.fsync(dfd)
def open_control(nonce,want,allow_closed=False):
 if not re.fullmatch(r'[a-f0-9]{24}',nonce) or not re.fullmatch(r'[a-f0-9]{64}',want):raise SystemExit(126)
 parent=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 name='ocv5-289-stage-'+nonce
 try:dfd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 except BaseException:os.close(parent);raise
 try:
  dst=os.fstat(dfd)
  if not stat.S_ISDIR(dst.st_mode) or dst.st_uid!=os.getuid() or stat.S_IMODE(dst.st_mode)!=0o700:raise SystemExit(126)
  lfd=os.open('lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dfd)
  try:
   lst=os.fstat(lfd)
   if not stat.S_ISREG(lst.st_mode) or lst.st_uid!=os.getuid() or stat.S_IMODE(lst.st_mode)!=0o600 or lst.st_nlink!=1:raise SystemExit(126)
   until=time.monotonic()+5
   while True:
    try:fcntl.flock(lfd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
    except BlockingIOError:
     if time.monotonic()>=until:raise SystemExit(126)
     time.sleep(.025)
   now=os.stat('lock',dir_fd=dfd,follow_symlinks=False)
   if (lst.st_dev,lst.st_ino)!=(now.st_dev,now.st_ino):raise SystemExit(126)
   # A same-UID rename must not redirect a later stage to a new directory.
   current=os.stat(name,dir_fd=parent,follow_symlinks=False)
   if (dst.st_dev,dst.st_ino)!=(current.st_dev,current.st_ino):raise SystemExit(126)
   fd=os.open('identity.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dfd)
   try:
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or st.st_size<1 or st.st_size>512:raise SystemExit(126)
    raw=os.read(fd,513)
    if len(raw)!=st.st_size or hashlib.sha256(raw).hexdigest()!=want:raise SystemExit(126)
    identity=json.loads(raw)
    if identity.get('version')!=2 or identity.get('runNonce')!=nonce or identity.get('controlDev')!=str(dst.st_dev) or identity.get('controlIno')!=str(dst.st_ino) or identity.get('lockDev')!=str(lst.st_dev) or identity.get('lockIno')!=str(lst.st_ino):raise SystemExit(126)
   finally:os.close(fd)
   try:os.stat('CLOSED',dir_fd=dfd,follow_symlinks=False)
   except FileNotFoundError:closed=False
   else:closed=True
   if closed and not allow_closed:raise SystemExit(126)
   os.close(parent)
   return dfd,lfd,closed
  except BaseException:os.close(lfd);raise
 except BaseException:os.close(dfd);os.close(parent);raise
`;

const GUARDED_INIT = COMMON + String.raw`
nonce,want,project=sys.argv[1:]
dfd,lfd,_closed=open_control(nonce,want)
try:
 cwd='ocv5-289-run-'+nonce
 expected='/home/box/.claude/projects/-tmp-'+cwd
 if project not in ('',expected):raise SystemExit(126)
 tmp=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  os.mkdir(cwd,0o700,dir_fd=tmp)
  run=os.open(cwd,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=tmp)
  try:
   st=os.fstat(run)
   if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(126)
   write_owned(dfd,'OWNED_RUN',st)
  finally:os.close(run)
  os.fsync(tmp)
 finally:os.close(tmp)
 if project:
  parent=project_parent()
  try:
   name='-tmp-'+cwd
   os.mkdir(name,0o700,dir_fd=parent)
   child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
   try:
    st=os.fstat(child)
    if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(126)
    write_owned(dfd,'OWNED_PROJECT',st)
   finally:os.close(child)
   os.fsync(parent)
  finally:os.close(parent)
 print('ready')
finally:os.close(lfd);os.close(dfd)`;

const GUARDED_STAGE = COMMON + String.raw`
nonce,want,encoded,*argv=sys.argv[1:]
dfd,lfd,_closed=open_control(nonce,want)
try:
 cwd=argv[0] if argv else ''
 project=argv[1] if len(argv)>1 else ''
 if cwd!='/tmp/ocv5-289-run-'+nonce or project not in ('','/home/box/.claude/projects/-tmp-ocv5-289-run-'+nonce):raise SystemExit(126)
 run=os.open(cwd,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  st=os.fstat(run)
  if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700 or read_owned(dfd,'OWNED_RUN')!=str(st.st_dev)+':'+str(st.st_ino):raise SystemExit(126)
 finally:os.close(run)
 if project:
  parent=project_parent()
  try:
   child=os.open('-tmp-ocv5-289-run-'+nonce,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
   try:
    st=os.fstat(child)
    if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700 or read_owned(dfd,'OWNED_PROJECT')!=str(st.st_dev)+':'+str(st.st_ino):raise SystemExit(126)
   finally:os.close(child)
  finally:os.close(parent)
 source=base64.b64decode(encoded,validate=True)
 if not source or len(source)>16384:raise SystemExit(126)
 sys.argv=['-c',*argv]
 scope={'__name__':'__main__'}
 exec(compile(source,'<box-private-stage>','exec'),scope,scope)
finally:os.close(lfd);os.close(dfd)`;

const CLOSE_WRITE_FENCE = COMMON + String.raw`
nonce,want=sys.argv[1:]
dfd,lfd,closed=open_control(nonce,want,True)
try:
 if closed:
  fd=os.open('CLOSED',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dfd)
  try:
   st=os.fstat(fd)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or st.st_size!=0:raise SystemExit(126)
  finally:os.close(fd)
 else:
  fd=os.open('CLOSED',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
  try:os.fsync(fd)
  finally:os.close(fd)
  os.fsync(dfd)
 print('closed:'+want)
finally:os.close(lfd);os.close(dfd)`;

// This is only safe before a durable launch permit. The caller/reconciler must
// prove that from the journal, not infer it from the absence of CLI output.
// The lock is held across CLOSED, exact private-file removal, and CLEANED.
const CLEAN_PRELAUNCH = COMMON + String.raw`
nonce,want=sys.argv[1:]
dfd,lfd,closed=open_control(nonce,want,True)
def marker(name):
 try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=dfd)
 except FileNotFoundError:return False
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or st.st_size!=0:raise SystemExit(126)
  return True
 finally:os.close(fd)
def clean_dir(parent_path,name,allowed):
 try:parent=project_parent() if parent_path=='project' else os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 except FileNotFoundError:return
 try:
  try:target=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
  except FileNotFoundError:return
  try:
   original=os.fstat(target)
   if not stat.S_ISDIR(original.st_mode) or original.st_uid!=os.getuid() or stat.S_IMODE(original.st_mode)!=0o700:raise SystemExit(126)
   owned=read_owned(dfd,'OWNED_PROJECT' if parent_path=='project' else 'OWNED_RUN')
   if owned!=str(original.st_dev)+':'+str(original.st_ino):raise SystemExit(126)
   entries=os.listdir(target)
   if len(entries)>256:raise SystemExit(126)
   for entry in entries:
    if not allowed(entry):raise SystemExit(126)
    st=os.stat(entry,dir_fd=target,follow_symlinks=False)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1:raise SystemExit(126)
   for entry in entries:os.unlink(entry,dir_fd=target)
   os.fsync(target)
   now=os.stat(name,dir_fd=parent,follow_symlinks=False)
   if (original.st_dev,original.st_ino)!=(now.st_dev,now.st_ino):raise SystemExit(126)
   os.rmdir(name,dir_fd=parent)
   os.fsync(parent)
  finally:os.close(target)
 finally:os.close(parent)
try:
 if not closed:
  fd=os.open('CLOSED',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
  try:os.fsync(fd)
  finally:os.close(fd)
  os.fsync(dfd)
 elif not marker('CLOSED'):raise SystemExit(126)
 already_cleaned=marker('CLEANED')
 if True:
  run='ocv5-289-run-'+nonce
  project='-tmp-ocv5-289-run-'+nonce
  def run_allowed(x):
   return bool(re.fullmatch(r'(?:stdin\.jsonl|system\.txt|tool-catalog\.json)(?:\.part)?',x))
  def project_allowed(x):
   return bool(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl(?:\.part)?',x))
  clean_dir('project',project,project_allowed)
  clean_dir('/tmp',run,run_allowed)
  if not already_cleaned:
   fd=os.open('CLEANED',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
   try:os.fsync(fd)
   finally:os.close(fd)
   os.fsync(dfd)
 print('cleaned:'+want)
finally:os.close(lfd);os.close(dfd)`;

export function makeBoxPrelaunchBootstrap(identity: BoxPrelaunchIdentity): BoxCcExecRequest {
  validIdentity(identity);
  return { command: PYTHON, args: ["-I", "-c", BOOTSTRAP, identity.runNonce,
    identity.leaseEpoch, identity.accountId, identity.controlId],
  cwd: "/tmp", environment: ENV };
}
export function parseBoxPrelaunchBootstrap(stdout: string,
  identity: BoxPrelaunchIdentity): BoxPrelaunchReceipt {
  validIdentity(identity);
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()); } catch {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_BOOTSTRAP_INVALID");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_BOOTSTRAP_INVALID");
  }
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !==
      "accountId,controlDev,controlId,controlIno,identityHash,leaseEpoch,lockDev,lockIno,runNonce,version"
    || item.version !== 2 || item.runNonce !== identity.runNonce
    || item.leaseEpoch !== identity.leaseEpoch
    || item.accountId !== identity.accountId || item.controlId !== identity.controlId
    || ![item.controlDev,item.controlIno,item.lockDev,item.lockIno].every((v) =>
      typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v))
    || typeof item.identityHash !== "string" || !HEX64.test(item.identityHash)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_BOOTSTRAP_INVALID");
  }
  const { identityHash, ...manifest } = item;
  const computed = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  if (computed !== identityHash) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_BOOTSTRAP_INVALID");
  }
  return item as unknown as BoxPrelaunchReceipt;
}
export function guardBoxPrivateStage(request: BoxCcExecRequest,
  receipt: BoxPrelaunchReceipt): BoxCcExecRequest {
  if (request.command !== PYTHON || request.args[0] !== "-I"
    || request.args[1] !== "-c" || typeof request.args[2] !== "string"
    || request.args[2].length < 1 || request.args[2].length > 16384
    || !HEX24.test(receipt.runNonce) || !HEX64.test(receipt.identityHash)
    || request.args[3] !== `/tmp/ocv5-289-run-${receipt.runNonce}`) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_STAGE_INVALID");
  }
  return { ...request, args: ["-I", "-c", GUARDED_STAGE,
    receipt.runNonce, receipt.identityHash,
    Buffer.from(request.args[2], "utf8").toString("base64"), ...request.args.slice(3)] };
}
export function makeBoxPrelaunchInit(receipt: BoxPrelaunchReceipt,
  project: string): BoxCcExecRequest {
  if (!HEX24.test(receipt.runNonce) || !HEX64.test(receipt.identityHash)
    || (project !== "" && project !==
      `/home/box/.claude/projects/-tmp-ocv5-289-run-${receipt.runNonce}`)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_INIT_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", GUARDED_INIT,
    receipt.runNonce, receipt.identityHash, project], cwd: "/tmp", environment: ENV };
}
/** CLOSED is only a write fence. It is not CLEANED and never licenses journal
 * terminalization or capacity release. */
export function makeBoxPrelaunchCloseFence(receipt: BoxPrelaunchReceipt): BoxCcExecRequest {
  if (!HEX24.test(receipt.runNonce) || !HEX64.test(receipt.identityHash)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_CLOSE_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", CLOSE_WRITE_FENCE,
    receipt.runNonce, receipt.identityHash], cwd: "/tmp", environment: ENV };
}

/** Caller must hold a durable no-launch permit; CLEANED is not proof of any
 * paid CLI terminal outcome. Never use this for a run whose launch may have
 * been dispatched. */
export function makeBoxPrelaunchCleanup(receipt: BoxPrelaunchReceipt): BoxCcExecRequest {
  if (!HEX24.test(receipt.runNonce) || !HEX64.test(receipt.identityHash)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_CLEAN_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", CLEAN_PRELAUNCH,
    receipt.runNonce, receipt.identityHash], cwd: "/tmp", environment: ENV };
}
