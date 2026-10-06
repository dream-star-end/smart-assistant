/** Delete only an expired, journal-unreferenced native transcript. The caller
 * must first hold a durable GC claim; this helper never starts Claude.
 * Claude Code 2.1.288 stores an MCP image result as a file under
 * <project>/<session id>/tool-results/; exactly that tree (regular, single-link
 * files owned by the Box user, no symlinks) is removed with the transcript. */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import { parseBoxNativePointer, type BoxNativePointer } from "./boxNativePointer.js";

const DELETE = String.raw`import hashlib,os,re,stat,sys
if len(sys.argv)!=4:raise SystemExit(126)
cwd,sid,want=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[a-f0-9]{24}',cwd) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',sid) or not re.fullmatch(r'[a-f0-9]{64}',want):raise SystemExit(126)
root='/home/box/.claude/projects'
name=cwd.replace('/','-')
filename=sid+'.jsonl'
def directory(path,base=None):
 try:fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base)
 except FileNotFoundError:return None
 st=os.fstat(fd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
  os.close(fd);raise SystemExit(126)
 return fd
parent=directory(root)
if parent is None:raise SystemExit(126)
try:
 project=directory(name,parent)
 if project is None:
  print('absent');raise SystemExit(0)
 try:
  before=os.fstat(project)
  entries=os.listdir(project)
  if not set(entries)<=({filename,sid} if filename in entries else set()):
   print('blocked');raise SystemExit(0)
  subtree=None
  idents={}
  if sid in entries:
   top=os.stat(sid,dir_fd=project,follow_symlinks=False)
   if not stat.S_ISDIR(top.st_mode) or top.st_uid!=os.getuid():
    print('blocked');raise SystemExit(0)
   sfd=os.open(sid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=project)
   try:
    kids=os.listdir(sfd)
    if kids not in ([],['tool-results']):
     print('blocked');raise SystemExit(0)
    files=[]
    if kids:
     tfd=os.open('tool-results',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=sfd)
     try:
      if os.fstat(tfd).st_uid!=os.getuid():
       print('blocked');raise SystemExit(0)
      files=os.listdir(tfd)
      if len(files)>1024:
       print('blocked');raise SystemExit(0)
      for item in files:
       seen=os.stat(item,dir_fd=tfd,follow_symlinks=False)
       if not stat.S_ISREG(seen.st_mode) or seen.st_uid!=os.getuid() or seen.st_nlink!=1:
        print('blocked');raise SystemExit(0)
       idents[item]=(seen.st_dev,seen.st_ino,seen.st_size)
     finally:os.close(tfd)
    subtree=(top.st_dev,top.st_ino,kids,files)
   finally:os.close(sfd)
  if entries:
   listed=os.stat(filename,dir_fd=project,follow_symlinks=False)
   if not stat.S_ISREG(listed.st_mode):
    print('blocked');raise SystemExit(0)
   fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=project)
   try:
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or not 1<=st.st_size<=268435456:
     print('blocked');raise SystemExit(0)
    digest=hashlib.sha256()
    remain=st.st_size
    while remain:
     chunk=os.read(fd,min(65536,remain))
     if not chunk:raise SystemExit(126)
     digest.update(chunk);remain-=len(chunk)
    if os.read(fd,1) or digest.hexdigest()!=want:
     print('blocked');raise SystemExit(0)
    current=os.stat(filename,dir_fd=project,follow_symlinks=False)
    if (current.st_dev,current.st_ino,current.st_size)!=(st.st_dev,st.st_ino,st.st_size):raise SystemExit(126)
   finally:os.close(fd)
   if sorted(os.listdir(project))!=sorted(entries):raise SystemExit(126)
   if subtree:
    sfd=os.open(sid,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=project)
    try:
     again=os.fstat(sfd)
     if (again.st_dev,again.st_ino)!=subtree[:2]:raise SystemExit(126)
     if subtree[2]:
      tfd=os.open('tool-results',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=sfd)
      try:
       if sorted(os.listdir(tfd))!=sorted(subtree[3]) or os.listdir(sfd)!=['tool-results']:raise SystemExit(126)
       def same(item):
        now=os.stat(item,dir_fd=tfd,follow_symlinks=False)
        return stat.S_ISREG(now.st_mode) and now.st_uid==os.getuid() and now.st_nlink==1 and (now.st_dev,now.st_ino,now.st_size)==idents[item]
       if not all(same(item) for item in subtree[3]):raise SystemExit(126)
       for item in subtree[3]:
        if not same(item):raise SystemExit(126)
        os.unlink(item,dir_fd=tfd)
      finally:os.close(tfd)
      os.rmdir('tool-results',dir_fd=sfd)
    finally:os.close(sfd)
    os.rmdir(sid,dir_fd=project)
   again=os.stat(filename,dir_fd=project,follow_symlinks=False)
   if (again.st_dev,again.st_ino,again.st_size)!=(st.st_dev,st.st_ino,st.st_size):raise SystemExit(126)
   os.unlink(filename,dir_fd=project);os.fsync(project)
  current=os.stat(name,dir_fd=parent,follow_symlinks=False)
  if (current.st_dev,current.st_ino)!=(before.st_dev,before.st_ino):raise SystemExit(126)
  if os.listdir(project):
   print('blocked');raise SystemExit(0)
  os.rmdir(name,dir_fd=parent);os.fsync(parent)
  print('deleted' if entries else 'absent')
 finally:os.close(project)
finally:os.close(parent)`;

export function makeBoxNativeGcDelete(pointer: BoxNativePointer): BoxCcExecRequest {
  if (!parseBoxNativePointer(pointer, Date.now(), true)) {
    throw new Error("BOX_NATIVE_GC_IDENTITY_INVALID");
  }
  return { command: "/usr/bin/python3", args: ["-I", "-c", DELETE,
    pointer.cliCwd, pointer.nativeSessionId, pointer.transcriptSha256],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}

export function parseBoxNativeGcResult(raw: string): "deleted" | "absent" | "blocked" {
  const value = raw.trim();
  if (value !== "deleted" && value !== "absent" && value !== "blocked") {
    throw new Error("BOX_NATIVE_GC_RESULT_INVALID");
  }
  return value;
}
