/** Idempotent, owner-scoped privacy cleanup after a nonce/epoch-bound remote
 * terminal proof has already been persisted. It keeps an empty stdout spool
 * inode as the Box-side O_EXCL replay tombstone. Unknown runs must never call
 * this request. */
import type { BoxExecTransport } from "./boxExecTransport.js";
type BoxCcExecRequest = Parameters<BoxExecTransport["run"]>[0];

const CLEAN = String.raw`import os,re,stat,sys
nonce,keep=sys.argv[1:] if len(sys.argv)==3 else ('','')
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or keep not in ('0','1'):raise SystemExit(126)
cwd='/tmp/ocv5-289-run-'+nonce
project='/home/box/.claude/projects/'+cwd.replace('/','-')
def private_dir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 st=os.fstat(fd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
  os.close(fd);raise SystemExit(126)
 return fd
def clear_memory(parent):
 fd=os.open('memory',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  if not stat.S_ISDIR(os.fstat(fd).st_mode) or os.fstat(fd).st_uid!=os.getuid():raise SystemExit(126)
  for name in sorted(os.listdir(fd)):
   if not re.fullmatch(r'(?!\.)[^/]{1,251}\.md',name):raise SystemExit(126)
   st=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1:raise SystemExit(126)
   os.unlink(name,dir_fd=fd)
  os.fsync(fd)
 finally:os.close(fd)
 os.rmdir('memory',dir_fd=parent)
def clear_session(parent,name):
 # OCV5-645: Claude Code spills an over-50k or image tool result to
 # <session>/tool-results/, the tree boxNativeGcFile.ts removes (same rules).
 st=os.stat(name,dir_fd=parent,follow_symlinks=False)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid():raise SystemExit(126)
 fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  got=os.fstat(fd)
  if (got.st_dev,got.st_ino)!=(st.st_dev,st.st_ino):raise SystemExit(126)
  kids=os.listdir(fd)
  if kids not in ([],['tool-results']):raise SystemExit(126)
  if kids:
   tfd=os.open('tool-results',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   try:
    if os.fstat(tfd).st_uid!=os.getuid():raise SystemExit(126)
    files=os.listdir(tfd)
    if len(files)>1024:raise SystemExit(126)
    for item in files:
     seen=os.stat(item,dir_fd=tfd,follow_symlinks=False)
     if not stat.S_ISREG(seen.st_mode) or seen.st_uid!=os.getuid() or seen.st_nlink!=1:raise SystemExit(126)
    for item in files:os.unlink(item,dir_fd=tfd)
    os.fsync(tfd)
   finally:os.close(tfd)
   os.rmdir('tool-results',dir_fd=fd)
  os.fsync(fd)
 finally:os.close(fd)
 os.rmdir(name,dir_fd=parent)
def private_file(dfd,name):
 st=os.stat(name,dir_fd=dfd,follow_symlinks=False)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1:
  raise SystemExit(126)
 return st
run=private_dir(cwd)
try:
 for name in ('stdout.jsonl','stderr.log'):
  expected=private_file(run,name)
  fd=os.open(name,os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=run)
  try:
   actual=os.fstat(fd)
   if actual.st_dev!=expected.st_dev or actual.st_ino!=expected.st_ino or actual.st_nlink!=1:
    raise SystemExit(126)
   os.ftruncate(fd,0);os.fsync(fd)
  finally:os.close(fd)
 allowed=re.compile(r'(?:(?:stdin\.jsonl|system\.txt|tool-catalog\.json|pending\.toolu_[A-Za-z0-9_-]{1,120}\.json|result\.toolu_[A-Za-z0-9_-]{1,120}\.json)(?:\.part)?|pending\.toolu_[A-Za-z0-9_-]{1,120}\.json\.[1-9][0-9]{0,9}\.[1-9][0-9]{0,19}\.tmp)')
 for name in sorted(os.listdir(run)):
  if name in ('stdout.jsonl','stderr.log'):continue
  if not allowed.fullmatch(name):raise SystemExit(126)
  private_file(run,name)
  os.unlink(name,dir_fd=run)
 os.fsync(run)
finally:os.close(run)
if keep=='0':
 try:history=private_dir(project)
 except FileNotFoundError:history=None
 if history is not None:
  try:
   uuid=r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
   pattern=re.compile(uuid+r'\.jsonl(?:\.part)?')
   for name in sorted(os.listdir(history)):
    # OCV5-509: Claude Code's auto-memory folder (*.md only) went to every run
    # project; refusing it left each cleanup pending and retried forever.
    if name=='memory':clear_memory(history);continue
    # OCV5-645: a recovered run has no native pointer, so it always lands here.
    if re.fullmatch(uuid,name):clear_session(history,name);continue
    if not pattern.fullmatch(name):raise SystemExit(126)
    private_file(history,name)
    os.unlink(name,dir_fd=history)
   os.fsync(history)
  finally:os.close(history)
print('clean')`;

export function makeBoxRunCleanup(runNonce: string,
  preserveNativeProject = false): BoxCcExecRequest {
  if (!/^[a-f0-9]{24}$/.test(runNonce)) throw new Error("BOX_RUN_CLEANUP_ID_INVALID");
  return { command: "/usr/bin/python3", args: ["-I", "-c", CLEAN, runNonce,
    preserveNativeProject ? "1" : "0"],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}
