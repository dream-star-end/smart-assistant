/** Read-only bounded metadata for a Claude native transcript. Never returns
 * prompt/history bytes. Used after proven terminal and before a cache claim. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const RUN = /^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 64 * 1024 * 1024;

const INSPECT = String.raw`import hashlib,json,os,re,stat,sys
if len(sys.argv)!=5:raise SystemExit(126)
cwd,sid,want,ensure=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[a-f0-9]{24}',cwd) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',sid) or (want!='-' and not re.fullmatch(r'[a-f0-9]{64}',want)) or ensure not in ('0','1'):raise SystemExit(126)
parent=os.open('/home/box/.claude/projects',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 project=os.open(cwd.replace('/','-'),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  st=os.fstat(project)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(126)
  fd=os.open(sid+'.jsonl',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=project)
  try:
   st=os.fstat(fd)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or not 1<=st.st_size<=67108864:raise SystemExit(126)
   size=st.st_size
   digest=hashlib.sha256()
   while True:
    part=os.read(fd,65536)
    if not part:break
    digest.update(part)
   actual=digest.hexdigest()
   if want!='-' and actual!=want:raise SystemExit(126)
  finally:os.close(fd)
 finally:os.close(project)
finally:os.close(parent)
if ensure=='1':
 try:os.mkdir(cwd,0o700)
 except FileExistsError:pass
 dfd=os.open(cwd,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  st=os.fstat(dfd)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(126)
 finally:os.close(dfd)
print(json.dumps({'sha256':actual,'size':size},sort_keys=True,separators=(',',':')))`;

export interface BoxNativeFileIdentity {
  readonly cliCwd: string;
  readonly nativeSessionId: string;
}
export interface BoxNativeFileEvidence {
  readonly sha256: string;
  readonly size: number;
}

export function makeBoxNativeFileInspect(input: BoxNativeFileIdentity & {
  expectedSha256?: string; ensureCwd?: boolean;
}): BoxCcExecRequest {
  if (!RUN.test(input.cliCwd) || !UUID.test(input.nativeSessionId)
    || (input.expectedSha256 !== undefined && !HEX64.test(input.expectedSha256))) {
    throw new Error("BOX_NATIVE_FILE_IDENTITY_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", INSPECT, input.cliCwd,
    input.nativeSessionId, input.expectedSha256 ?? "-", input.ensureCwd ? "1" : "0"],
    cwd: "/tmp", environment: ENV };
}

export function parseBoxNativeFileEvidence(raw: string,
  expectedSha256?: string): BoxNativeFileEvidence {
  let value: unknown;
  try { value = JSON.parse(raw.trim()); }
  catch { throw new Error("BOX_NATIVE_FILE_EVIDENCE_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BOX_NATIVE_FILE_EVIDENCE_INVALID");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "sha256,size"
    || typeof item.sha256 !== "string" || !HEX64.test(item.sha256)
    || !Number.isSafeInteger(item.size) || Number(item.size) < 1
    || Number(item.size) > MAX_BYTES
    || (expectedSha256 !== undefined && item.sha256 !== expectedSha256)) {
    throw new Error("BOX_NATIVE_FILE_EVIDENCE_INVALID");
  }
  return item as unknown as BoxNativeFileEvidence;
}
