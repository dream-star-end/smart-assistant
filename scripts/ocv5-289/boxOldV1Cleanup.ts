/** One-time old-v1 prelaunch orphan cleanup. Never runs Claude or mutates PG.
 * No retry after an ambiguous Exec; the immutable root proof is a precondition
 * for a separately reviewed journal CAS. */
import { closeSync, constants, fsyncSync, lstatSync, openSync, unlinkSync,
  writeSync } from "node:fs";
import { createProductionBoxAccountResolver } from "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const REQUEST_ID = "2d83f86c132bbbf39ad93adc64426b09";
const NONCE = "23aa4f1a6e60b1d4efcdcaac";
const EPOCH = "4885d52ce7c1038d516e8bbbe247fe06";
const RUNTIME = "dbbd6c1dbc96f64b0a8a";
const RUN_HASH = "ad69e45fbd7da8b0080042ba598512b3bc44c0e3392298e30a6eba71d1f9b207";
const PROJECT_HASH = "8c449c837d310dd1fe42853fdf930db558652d9fbb2b9dc57f990961564468ed";
const EVIDENCE_DIR = "/var/lib/openclaude/ocv5-289-box-operator";
const LOCK = `${EVIDENCE_DIR}/old-v1-${NONCE}.mutex`;
const PROOF = `${EVIDENCE_DIR}/old-v1-${NONCE}.cleaned.json`;

const CLEAN = String.raw`import hashlib,json,os,re,secrets,stat,sys
nonce,want_runtime,want_run,want_project=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or not re.fullmatch(r'[a-f0-9]{20}',want_runtime) or not re.fullmatch(r'[a-f0-9]{64}',want_run) or not re.fullmatch(r'[a-f0-9]{64}',want_project):raise SystemExit(126)
run='ocv5-289-run-'+nonce
project='-tmp-'+run
proof='/tmp/ocv5-289-proof-'+nonce
def parent_project():
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 chain=[]
 try:
  for part in ('home','box','.claude','projects'):
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=nxt
   st=os.fstat(fd);chain.append((st.st_dev,st.st_ino))
  if os.fstat(fd).st_uid!=os.getuid():raise SystemExit(126)
  return fd,chain
 except BaseException:os.close(fd);raise
def metadata(dfd):
 s=os.fstat(dfd)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700:raise SystemExit(126)
 names=os.listdir(dfd)
 if len(names)>1:raise SystemExit(126)
 entries=[]
 for name in names:
  t=os.stat(name,dir_fd=dfd,follow_symlinks=False)
  kind='history' if re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl',name) else 'other'
  if kind!='history' or not stat.S_ISREG(t.st_mode) or t.st_uid!=os.getuid() or stat.S_IMODE(t.st_mode)!=0o600 or t.st_nlink!=1:raise SystemExit(126)
  entries.append((kind,t.st_dev,t.st_ino,t.st_size,t.st_mtime_ns,stat.S_IMODE(t.st_mode),True,True,t.st_nlink))
 encoded=json.dumps([s.st_dev,s.st_ino,s.st_mtime_ns,sorted(entries)],separators=(',',':')).encode()
 return hashlib.sha256(encoded).hexdigest(),names,s,entries
def scan():
 ancestors=set();pid=os.getpid()
 while pid>1 and pid not in ancestors:
  ancestors.add(pid)
  try:raw=open('/proc/'+str(pid)+'/stat').read();pid=int(raw.rsplit(') ',1)[1].split()[1])
  except (OSError,ValueError,IndexError):raise SystemExit(126)
 errors=0;truncated=0;matched=0
 for name in os.listdir('/proc'):
  if not name.isdigit() or int(name) in ancestors:continue
  path='/proc/'+name
  try:owner=os.stat(path).st_uid
  except OSError:errors+=1;continue
  if owner!=os.getuid():continue
  try:state=open(path+'/stat').read().rsplit(') ',1)[1].split()[0]
  except (OSError,IndexError):errors+=1;continue
  if state=='Z':continue
  argv=b'';cwd=''
  try:
   argv=open(path+'/cmdline','rb').read(262145)
   if len(argv)>262144:truncated+=1
  except OSError:errors+=1
  try:cwd=os.readlink(path+'/cwd')
  except OSError:errors+=1
  if nonce.encode() in argv or '/tmp/'+run in cwd:matched+=1
 if errors or truncated or matched:raise SystemExit(126)
stat1=open('/proc/1/stat').read().rsplit(') ',1)[1].split()
runtime=hashlib.sha256((os.uname().nodename+'|'+stat1[19]).encode()).hexdigest()[:20]
if runtime!=want_runtime or os.path.lexists(proof):raise SystemExit(126)
tmp=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
home,chain=parent_project()
try:
 runfd=os.open(run,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=tmp)
 projfd=os.open(project,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=home)
 try:
  run_hash,run_names,runst,_run_entries=metadata(runfd)
  proj_hash,proj_names,projst,proj_entries=metadata(projfd)
  if run_hash!=want_run or proj_hash!=want_project or run_names or len(proj_names)!=1:raise SystemExit(126)
  scan()
  for parent,name,old in ((tmp,run,runst),(home,project,projst)):
   current=os.stat(name,dir_fd=parent,follow_symlinks=False)
   if (old.st_dev,old.st_ino)!=(current.st_dev,current.st_ino):raise SystemExit(126)
  qname='.ocv5-289-recovery-'+secrets.token_hex(16)
  os.mkdir(qname,0o700,dir_fd=projfd)
  qfd=os.open(qname,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=projfd)
  try:
   os.rename(proj_names[0],'history.jsonl',src_dir_fd=projfd,dst_dir_fd=qfd)
   moved=os.open('history.jsonl',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=qfd)
   try:
    st=os.fstat(moved)
    expected=proj_entries[0]
    if (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,stat.S_IMODE(st.st_mode),stat.S_ISREG(st.st_mode),st.st_uid==os.getuid(),st.st_nlink)!=(expected[1],expected[2],expected[3],expected[4],expected[5],expected[6],expected[7],expected[8]):raise SystemExit(126)
    os.unlink('history.jsonl',dir_fd=qfd)
    if os.fstat(moved).st_nlink!=0:raise SystemExit(126)
   finally:os.close(moved)
   os.fsync(qfd)
  finally:os.close(qfd)
  os.rmdir(qname,dir_fd=projfd)
  os.fsync(projfd)
  os.rmdir(project,dir_fd=home);os.fsync(home)
  os.rmdir(run,dir_fd=tmp);os.fsync(tmp)
  fresh,fresh_chain=parent_project()
  try:
   if fresh_chain!=chain or (os.fstat(fresh).st_dev,os.fstat(fresh).st_ino)!=(os.fstat(home).st_dev,os.fstat(home).st_ino):raise SystemExit(126)
   for parent,name in ((tmp,run),(fresh,project)):
    try:os.stat(name,dir_fd=parent,follow_symlinks=False)
    except FileNotFoundError:pass
    else:raise SystemExit(126)
  finally:os.close(fresh)
  if os.path.lexists(proof):raise SystemExit(126)
  print(json.dumps({'runNonce':nonce,'runtimeHash':runtime,'cleaned':True,
   'projectHistoryFilesRemoved':1,'runFilesRemoved':0},sort_keys=True,separators=(',',':')))
 finally:os.close(projfd);os.close(runfd)
finally:os.close(home);os.close(tmp)`;

function writeExclusive(path: string, raw: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(raw);
    for (let offset = 0; offset < bytes.length;) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (n < 1) throw new Error("BOX_OPERATOR_EVIDENCE_WRITE_FAILED");
      offset += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const written = lstatSync(path);
  if (!written.isFile() || written.isSymbolicLink() || written.uid !== 0
    || (written.mode & 0o777) !== 0o600 || written.nlink !== 1) {
    throw new Error("BOX_OPERATOR_EVIDENCE_OWNER_INVALID");
  }
  const parent = openSync(EVIDENCE_DIR, constants.O_RDONLY
    | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

async function main(): Promise<void> {
  if (process.getuid?.() !== 0
    || process.env.OCV5_289_ACK_ACCOUNT_ID !== "20"
    || process.env.OCV5_289_ACK_USER_ID !== "3"
    || process.env.OCV5_289_OLD_V1_CLEANUP_ACK !== REQUEST_ID
    || getRuntimeChannel() !== "v5") throw new Error("BOX_OLD_CLEANUP_ACK_REQUIRED");
  const parent = lstatSync(EVIDENCE_DIR);
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || parent.uid !== 0 || (parent.mode & 0o777) !== 0o700) {
    throw new Error("BOX_OLD_EVIDENCE_DIR_INVALID");
  }
  writeExclusive(LOCK, JSON.stringify({ requestId: REQUEST_ID,
    runNonce: NONCE, pid: process.pid }) + "\n");
  const resolver = createProductionBoxAccountResolver();
  let remoteProven = false;
  let archiveSaved = false;
  try {
    const target = await resolver.resolve({ uid: 3n, sessionId: null,
      requestId: REQUEST_ID, upstreamModel: "claude-opus-5-5",
      requiredAccountId: 20n, signal: new AbortController().signal });
    try {
      if (target.accountId !== 20n) throw new Error("BOX_OLD_ACCOUNT_MISMATCH");
      const result = await target.exec.run({ command: "/usr/bin/python3",
        args: ["-I", "-c", CLEAN, NONCE, RUNTIME, RUN_HASH, PROJECT_HASH],
        cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
      { timeoutMs: 20_000, maxResponseBytes: 4096 });
      const proof = JSON.parse(result.stdout) as Record<string, unknown>;
      if (proof.runNonce !== NONCE || proof.runtimeHash !== RUNTIME
        || proof.cleaned !== true || proof.projectHistoryFilesRemoved !== 1
        || proof.runFilesRemoved !== 0) throw new Error("BOX_OLD_REMOTE_CLEANUP_UNPROVEN");
      remoteProven = true;
      const record = { v: 1, requestId: REQUEST_ID, uid: "3", accountId: "20",
        runNonce: NONCE, leaseEpoch: EPOCH, runtimeHash: RUNTIME,
        runMetadataHash: RUN_HASH, projectMetadataHash: PROJECT_HASH,
        remoteCleanup: proof, paidReplay: false, journalSettled: false,
        observedAt: new Date().toISOString() };
      writeExclusive(PROOF, JSON.stringify(record) + "\n");
      archiveSaved = true;
      process.stdout.write(JSON.stringify({ requestId: REQUEST_ID,
        runNonce: NONCE, remoteCleaned: true, proofPath: PROOF,
        journalSettled: false, paidCalls: 0 }) + "\n");
      unlinkSync(LOCK);
    } finally { await target.dispose?.(); }
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error instanceof Error
      && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
      ? error.message : "BOX_OLD_CLEANUP_FAILED", requestId: REQUEST_ID,
      runNonce: NONCE, remoteProven, proofPath: archiveSaved ? PROOF : null,
      journalSettled: false }) + "\n");
    throw error;
  }
}
void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_OLD_CLEANUP_FAILED";
  process.stderr.write(code + "\n"); process.exitCode = 1;
});
