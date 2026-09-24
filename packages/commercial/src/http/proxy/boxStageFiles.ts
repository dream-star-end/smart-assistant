/** Bounded multi-Exec staging for private Box run files.
 *
 * Every individual argv value is <=64KiB and every request carries <=256KiB
 * of encoded content. The caller MUST execute requests in order, without
 * retrying an ambiguous write, and never start Claude until all finish.
 */
import { createHash } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const RAW_CHUNK_BYTES = 48 * 1024;
const CHUNKS_PER_EXEC = 4;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class BoxStageError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxStageError"; }
}
export interface BoxStageFile { path: string; raw: Buffer; hash: string }

const INIT = String.raw`import os,re,sys
cwd,project=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[0-9a-f]{24}',cwd):raise SystemExit(1)
if project and project!='/home/box/.claude/projects/'+cwd.replace('/','-'):raise SystemExit(1)
os.mkdir(cwd,0o700)
if project:os.mkdir(project,0o700)
print('ready')`;

const WRITE = String.raw`import base64,os,re,stat,sys
cwd,project,path,offset,total,*parts=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[0-9a-f]{24}',cwd):raise SystemExit(1)
if project and project!='/home/box/.claude/projects/'+cwd.replace('/','-'):raise SystemExit(1)
if path not in (cwd+'/stdin.jsonl',cwd+'/system.txt',cwd+'/tool-catalog.json') and not (project and re.fullmatch(re.escape(project)+r'/[0-9a-f-]{36}\.jsonl',path)):raise SystemExit(1)
start=int(offset);want=int(total)
if start<0 or want<0 or want>8*1024*1024 or start>want or not 1<=len(parts)<=4:raise SystemExit(1)
decoded=[]
for part in parts:
 if len(part)>65536:raise SystemExit(1)
 raw=base64.b64decode(part,validate=True)
 if len(raw)>48*1024:raise SystemExit(1)
 decoded.append(raw)
size=sum(len(raw) for raw in decoded)
if start+size>want:raise SystemExit(1)
fd=os.open(path+'.part',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
try:
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size!=start:raise SystemExit(1)
 os.lseek(fd,start,os.SEEK_SET)
 for raw in decoded:
  done=0
  while done<len(raw):done+=os.write(fd,raw[done:])
 os.fsync(fd)
 if os.fstat(fd).st_size!=start+size:raise SystemExit(1)
 print(start+size)
finally:os.close(fd)`;

const FINISH = String.raw`import hashlib,os,re,stat,sys
cwd,project,path,size,want=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[0-9a-f]{24}',cwd):raise SystemExit(1)
if project and project!='/home/box/.claude/projects/'+cwd.replace('/','-'):raise SystemExit(1)
if path not in (cwd+'/stdin.jsonl',cwd+'/system.txt',cwd+'/tool-catalog.json') and not (project and re.fullmatch(re.escape(project)+r'/[0-9a-f-]{36}\.jsonl',path)):raise SystemExit(1)
expected=int(size)
if expected<0 or expected>8*1024*1024 or not re.fullmatch(r'[0-9a-f]{64}',want):raise SystemExit(1)
fd=os.open(path+'.part',os.O_RDONLY|os.O_NOFOLLOW)
try:
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size!=expected:raise SystemExit(1)
 digest=hashlib.sha256();read=0
 while read<=expected:
  chunk=os.read(fd,min(65536,expected+1-read))
  if not chunk:break
  digest.update(chunk);read+=len(chunk)
 if read!=expected or digest.hexdigest()!=want:raise SystemExit(1)
finally:os.close(fd)
os.link(path+'.part',path,follow_symlinks=False)
os.unlink(path+'.part')
directory=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:os.fsync(directory)
finally:os.close(directory)
print(want)`;

const CLEANUP = String.raw`import os,re,stat,sys
cwd,project,*paths=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[0-9a-f]{24}',cwd):raise SystemExit(1)
if project and project!='/home/box/.claude/projects/'+cwd.replace('/','-'):raise SystemExit(1)
for d in (cwd,project):
 if not d:continue
 st=os.lstat(d)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
for path in paths:
 if path not in (cwd+'/stdin.jsonl',cwd+'/system.txt',cwd+'/tool-catalog.json') and not (project and re.fullmatch(re.escape(project)+r'/[0-9a-f-]{36}\.jsonl',path)):raise SystemExit(1)
 for target in (path,path+'.part'):
  try:os.unlink(target)
  except FileNotFoundError:pass
if project:os.rmdir(project)
os.rmdir(cwd)
print('clean')`;

export function makeBoxStageFiles(input: {
  cwd: string; project: string; files: readonly BoxStageFile[];
}): { requests: BoxCcExecRequest[]; cleanup: BoxCcExecRequest } {
  if (!/^\/tmp\/ocv5-289-run-[0-9a-f]{24}$/.test(input.cwd)
    || (input.project !== "" && input.project !==
      `/home/box/.claude/projects/${input.cwd.replaceAll("/", "-")}`)) {
    throw new BoxStageError("BOX_STAGE_PATH_INVALID");
  }
  const paths = new Set<string>();
  for (const file of input.files) {
    const allowedPath = file.path === `${input.cwd}/stdin.jsonl`
      || file.path === `${input.cwd}/system.txt`
      || file.path === `${input.cwd}/tool-catalog.json`
      || (input.project !== "" && new RegExp(`^${input.project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f-]{36}\\.jsonl$`).test(file.path));
    if (!allowedPath || paths.has(file.path) || !Buffer.isBuffer(file.raw)
      || file.raw.length > MAX_FILE_BYTES || !/^[0-9a-f]{64}$/.test(file.hash)
      || createHash("sha256").update(file.raw).digest("hex") !== file.hash) {
      throw new BoxStageError("BOX_STAGE_FILE_INVALID");
    }
    paths.add(file.path);
  }
  const fixed = (script: string, args: string[]): BoxCcExecRequest => ({
    command: PYTHON, args: ["-c", script, ...args], cwd: "/tmp", environment: ENV,
  });
  const requests: BoxCcExecRequest[] = [fixed(INIT, [input.cwd, input.project])];
  for (const file of input.files) {
    const chunks: string[] = [];
    for (let offset = 0; offset < file.raw.length; offset += RAW_CHUNK_BYTES) {
      chunks.push(file.raw.subarray(offset, offset + RAW_CHUNK_BYTES).toString("base64"));
    }
    if (chunks.length === 0) chunks.push("");
    let offset = 0;
    for (let i = 0; i < chunks.length; i += CHUNKS_PER_EXEC) {
      const batch = chunks.slice(i, i + CHUNKS_PER_EXEC);
      requests.push(fixed(WRITE, [input.cwd, input.project, file.path,
        String(offset), String(file.raw.length), ...batch]));
      offset += batch.reduce((total, encoded) => total + Buffer.from(encoded, "base64").length, 0);
    }
    requests.push(fixed(FINISH, [input.cwd, input.project, file.path,
      String(file.raw.length), file.hash]));
  }
  return { requests, cleanup: fixed(CLEANUP, [input.cwd, input.project,
    ...input.files.map((file) => file.path)]) };
}
