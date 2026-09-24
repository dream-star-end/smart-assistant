/** Non-model operator capability probe. Its child self-exits in <=30 seconds.
 * No PID/PGID is ever signalled and no failed/ambiguous launch is retried. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const PYTHON = "/usr/bin/python3";

const LAUNCH = String.raw`import os,re,stat,subprocess,sys,time
d=sys.argv[1]
if not re.fullmatch(r'/tmp/ocv5-289-detached-[0-9a-f]{24}',d):raise SystemExit(2)
os.mkdir(d,0o700)
child=r'''import os,sys,time
d=sys.argv[1];end=time.monotonic()+30;seq=0
try:
 while time.monotonic()<end and not os.path.exists(d+'/stop'):
  seq+=1
  fd=os.open(d+'/alive',os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
  try:os.write(fd,str(seq).encode('ascii'));os.fsync(fd)
  finally:os.close(fd)
  time.sleep(.1)
finally:
 fd=os.open(d+'/done',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:os.write(fd,b'done');os.fsync(fd)
 finally:os.close(fd)'''
p=subprocess.Popen([sys.executable,'-c',child,d],stdin=subprocess.DEVNULL,
 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
time.sleep(.2)
if p.poll() is not None:raise SystemExit(3)
print('started')`;

const OBSERVE = String.raw`import json,os,re,stat,sys,time
d=sys.argv[1]
if not re.fullmatch(r'/tmp/ocv5-289-detached-[0-9a-f]{24}',d):raise SystemExit(2)
dfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(dfd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(3)
 def count():
  fd=os.open('alive',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=dfd)
  try:
   st=os.fstat(fd)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size>16:raise SystemExit(4)
   raw=os.read(fd,17)
   if not re.fullmatch(rb'[1-9][0-9]{0,9}',raw):raise SystemExit(5)
   return int(raw)
  finally:os.close(fd)
 first=count();deadline=time.monotonic()+3
 while time.monotonic()<deadline:
  second=count()
  if second>=first+2:
   print(json.dumps({'first':first,'second':second},separators=(',',':')));break
  time.sleep(.05)
 else:raise SystemExit(6)
finally:os.close(dfd)`;

const STOP = String.raw`import os,re,stat,sys,time
d=sys.argv[1]
if not re.fullmatch(r'/tmp/ocv5-289-detached-[0-9a-f]{24}',d):raise SystemExit(2)
dfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(dfd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(3)
 fd=os.open('stop',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dfd)
 os.close(fd)
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  try:
   fd=os.open('done',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=dfd)
   os.close(fd);break
  except FileNotFoundError:time.sleep(.05)
 else:raise SystemExit(4)
 for name in ('alive','stop','done'):os.unlink(name,dir_fd=dfd)
finally:os.close(dfd)
os.rmdir(d);print('stopped')`;

export function makeBoxDetachedProbePlan(nonce: string): {
  launch: BoxCcExecRequest; observe: BoxCcExecRequest; stop: BoxCcExecRequest;
} {
  if (!/^[0-9a-f]{24}$/.test(nonce)) throw new Error("BOX_DETACHED_NONCE_INVALID");
  const path = `/tmp/ocv5-289-detached-${nonce}`;
  const fixed = (code: string): BoxCcExecRequest => ({ command: PYTHON,
    args: ["-c", code, path], cwd: "/tmp", environment: ENV });
  return { launch: fixed(LAUNCH), observe: fixed(OBSERVE), stop: fixed(STOP) };
}
