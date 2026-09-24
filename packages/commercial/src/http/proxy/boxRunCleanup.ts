/** Idempotent, owner-scoped privacy cleanup after a nonce/epoch-bound remote
 * terminal proof has already been persisted. It keeps an empty stdout spool
 * inode as the Box-side O_EXCL replay tombstone. Unknown runs must never call
 * this request. */
import type { BoxExecTransport } from "./boxExecTransport.js";
type BoxCcExecRequest = Parameters<BoxExecTransport["run"]>[0];

const CLEAN = String.raw`import os,re,stat,sys
nonce=sys.argv[1] if len(sys.argv)==2 else ''
if not re.fullmatch(r'[a-f0-9]{24}',nonce):raise SystemExit(126)
cwd='/tmp/ocv5-289-run-'+nonce
project='/home/box/.claude/projects/'+cwd.replace('/','-')
def private_dir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 st=os.fstat(fd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
  os.close(fd);raise SystemExit(126)
 return fd
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
try:history=private_dir(project)
except FileNotFoundError:history=None
if history is not None:
 try:
  pattern=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl(?:\.part)?')
  for name in sorted(os.listdir(history)):
   if not pattern.fullmatch(name):raise SystemExit(126)
   private_file(history,name)
   os.unlink(name,dir_fd=history)
  os.fsync(history)
 finally:os.close(history)
print('clean')`;

export function makeBoxRunCleanup(runNonce: string): BoxCcExecRequest {
  if (!/^[a-f0-9]{24}$/.test(runNonce)) throw new Error("BOX_RUN_CLEANUP_ID_INVALID");
  return { command: "/usr/bin/python3", args: ["-I", "-c", CLEAN, runNonce],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}
