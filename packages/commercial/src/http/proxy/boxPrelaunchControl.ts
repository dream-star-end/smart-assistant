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

const GUARDED_STAGE = COMMON + String.raw`
nonce,want,encoded,*argv=sys.argv[1:]
dfd,lfd,_closed=open_control(nonce,want)
try:
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
/** CLOSED is only a write fence. It is not CLEANED and never licenses journal
 * terminalization or capacity release. */
export function makeBoxPrelaunchCloseFence(receipt: BoxPrelaunchReceipt): BoxCcExecRequest {
  if (!HEX24.test(receipt.runNonce) || !HEX64.test(receipt.identityHash)) {
    throw new BoxPrelaunchControlError("BOX_PRELAUNCH_CLOSE_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", CLOSE_WRITE_FENCE,
    receipt.runNonce, receipt.identityHash], cwd: "/tmp", environment: ENV };
}
