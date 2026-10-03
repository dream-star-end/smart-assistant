/** Request stop from the original nonce/epoch-bound keeper, never from a
 * recycled numeric PID or process group. This is only a stop request; remote
 * terminal proof must still be read before releasing capacity or cleaning. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const STOP = String.raw`import json,os,re,signal,stat,sys
if len(sys.argv)!=3:raise SystemExit(126)
nonce,epoch=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{24}',nonce) or not re.fullmatch(r'[a-f0-9]{32}',epoch):
 raise SystemExit(126)
run='/tmp/ocv5-289-run-'+nonce
proof='/tmp/ocv5-289-proof-'+nonce
def private_dir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 st=os.fstat(fd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
  os.close(fd);raise SystemExit(126)
 return fd,st
runfd,runstat=private_dir(run)
prooffd,_=private_dir(proof)
try:
 try:os.stat('terminal.json',dir_fd=prooffd,follow_symlinks=False)
 except FileNotFoundError:pass
 else:
  print('terminal-present');raise SystemExit(0)
 if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
  raise SystemExit(125)
 try:
  ready_stat=os.stat('stop.ready',dir_fd=prooffd,follow_symlinks=False)
  if (not stat.S_ISREG(ready_stat.st_mode) or ready_stat.st_uid!=os.getuid()
      or stat.S_IMODE(ready_stat.st_mode)!=0o600 or ready_stat.st_nlink!=1
      or not 1<=ready_stat.st_size<=512):raise SystemExit(125)
  ready_fd=os.open('stop.ready',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=prooffd)
  try:raw=os.read(ready_fd,513)
  finally:os.close(ready_fd)
  if len(raw)!=ready_stat.st_size or not raw.endswith(b'\n'):raise SystemExit(125)
  ready=json.loads(raw)
  if (not isinstance(ready,dict)
      or set(ready)!={'runNonce','leaseEpoch','keeperPid','cliPid','revision'}
      or ready['runNonce']!=nonce or ready['leaseEpoch']!=epoch
      or type(ready['keeperPid']) is not int or ready['keeperPid']<1
      or type(ready['cliPid']) is not int or ready['cliPid']<1
      or ready['revision']!=1):raise SystemExit(125)
 except (FileNotFoundError,OSError,ValueError,TypeError):raise SystemExit(125)
 def keeper(pid):
  path='/proc/'+str(pid)
  try:
   if os.stat(path).st_uid!=os.getuid():return False
   cwd=os.stat(path+'/cwd')
   if (cwd.st_dev,cwd.st_ino)!=(runstat.st_dev,runstat.st_ino):return False
   with open(path+'/cmdline','rb') as f:raw=f.read(16384)
   args=raw.split(b'\0')
   if len(args)<8 or args[1]!=b'-I':return False
   if not re.fullmatch(rb'/tmp/ocv5-289-(?:v2-)?keeper-[a-f0-9]{16}\.py',args[2]):return False
   if not re.fullmatch(rb'/tmp/ocv5-289-(?:v2-)?supervisor-[a-f0-9]{16}\.py',args[3]):return False
   if args[4:8]!=[b'--proof-dir',proof.encode(),b'--lease-epoch',epoch.encode()]:return False
   return True
  except (FileNotFoundError,ProcessLookupError,PermissionError,OSError):return False
 pid=ready['keeperPid']
 if not keeper(pid):raise SystemExit(125)
 fd=os.pidfd_open(pid,0)
 try:
  if not keeper(pid):raise SystemExit(125)
  signal.pidfd_send_signal(fd,signal.SIGTERM)
  print('stop-requested')
 finally:os.close(fd)
finally:
 os.close(prooffd);os.close(runfd)`;

export function makeBoxKeeperStop(runNonce: string, leaseEpoch: string): BoxCcExecRequest {
  if (!/^[a-f0-9]{24}$/.test(runNonce) || !/^[a-f0-9]{32}$/.test(leaseEpoch)) {
    throw new Error("BOX_KEEPER_STOP_ID_INVALID");
  }
  return { command: "/usr/bin/python3", args: ["-I", "-c", STOP, runNonce, leaseEpoch],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}
