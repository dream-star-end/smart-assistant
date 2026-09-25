/** Request stop from the original nonce/epoch-bound keeper, never from a
 * recycled numeric PID or process group. This is only a stop request; remote
 * terminal proof must still be read before releasing capacity or cleaning. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const STOP = String.raw`import os,re,signal,stat,sys
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
 def keeper(pid):
  path='/proc/'+str(pid)
  try:
   if os.stat(path).st_uid!=os.getuid():return False
   cwd=os.stat(path+'/cwd')
   if (cwd.st_dev,cwd.st_ino)!=(runstat.st_dev,runstat.st_ino):return False
   with open(path+'/cmdline','rb') as f:raw=f.read(16384)
   args=raw.split(b'\0')
   if len(args)<8 or args[1]!=b'-I':return False
   if not re.fullmatch(rb'/tmp/ocv5-289-keeper-[a-f0-9]{16}\.py',args[2]):return False
   if not re.fullmatch(rb'/tmp/ocv5-289-supervisor-[a-f0-9]{16}\.py',args[3]):return False
   if args[4:8]!=[b'--proof-dir',proof.encode(),b'--lease-epoch',epoch.encode()]:return False
   return True
  except (FileNotFoundError,ProcessLookupError,PermissionError,OSError):return False
 matches=[]
 for item in os.scandir('/proc'):
  if item.name.isdigit() and keeper(int(item.name)):matches.append(int(item.name))
  if len(matches)>1:raise SystemExit(125)
 if len(matches)!=1:raise SystemExit(125)
 pid=matches[0]
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
