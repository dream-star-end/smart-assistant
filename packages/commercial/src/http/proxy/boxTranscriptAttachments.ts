/** OCV5-384: when a Box turn must re-stage a conversation (no native resume), the CLI
 * re-renders its own context records (environment, model, token budget, date) after the
 * newest user message instead of where the session's native transcript has them (after the
 * first user message), so everything after that point became a cache write. The session's
 * previous native transcript still lies on the Box: this reads only the attachment records
 * between its first user message and its first assistant message, so the re-staged
 * transcript can carry them at the same place. Read-only and bounded; never prompt text. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const RUN = /^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Context records the CLI renders into the request. prompt_snapshot is excluded: it holds
 * the whole system prompt and is not rendered as a message. */
export const BOX_STAGED_ATTACHMENT_TYPES: readonly string[] = [
  "environment", "model", "total_tokens_reminder", "session_context", "date", "credential_org",
];
const MAX_OUTPUT_BYTES = 128 * 1024;

const READ = String.raw`import json,os,re,stat,sys
if len(sys.argv)!=4:raise SystemExit(126)
cwd,sid,allow=sys.argv[1],sys.argv[2],set(sys.argv[3].split(','))
if not re.fullmatch(r'/tmp/ocv5-289-run-[a-f0-9]{24}',cwd) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',sid):raise SystemExit(126)
def safeopen(path,flags,dir_fd=None):
 try:return os.open(path,flags,dir_fd=dir_fd)
 except OSError:raise SystemExit(126)
parent=safeopen('/home/box/.claude/projects',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 project=safeopen(cwd.replace('/','-'),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
 try:
  st=os.fstat(project)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid():raise SystemExit(126)
  fd=safeopen(sid+'.jsonl',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=project)
 finally:os.close(project)
finally:os.close(parent)
st=os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_nlink!=1:raise SystemExit(126)
out=[];seen_user=False;budget=64*1024*1024
with os.fdopen(fd,'rb') as f:
 while True:
  raw=f.readline(min(budget,16*1024*1024)+1)
  if not raw:break
  budget-=len(raw)
  if budget<0 or (len(raw)>16*1024*1024 and not raw.endswith(b'\n')):out=[];break
  try:rec=json.loads(raw)
  except ValueError:continue
  if not isinstance(rec,dict):continue
  kind=rec.get('type')
  if kind=='user' and not rec.get('isSidechain'):
   if seen_user:break
   seen_user=True;continue
  if not seen_user:continue
  if kind=='assistant':break
  if kind=='attachment':
   a=rec.get('attachment')
   if isinstance(a,dict) and a.get('type') in allow:out.append(rec)
text=json.dumps({'records':out},sort_keys=True,separators=(',',':'),ensure_ascii=False)
print(text if len(text.encode())<=131072 else '{"records":[]}')`;

export interface BoxTranscriptSource {
  readonly cliCwd: string;
  readonly nativeSessionId: string;
}

export function makeBoxTranscriptAttachmentsRead(source: BoxTranscriptSource): BoxCcExecRequest {
  if (!RUN.test(source.cliCwd) || !UUID.test(source.nativeSessionId)) {
    throw new Error("BOX_TRANSCRIPT_SOURCE_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", READ, source.cliCwd, source.nativeSessionId,
    BOX_STAGED_ATTACHMENT_TYPES.join(",")], cwd: "/tmp", environment: ENV };
}

/** The attachment records to stage, or null when the output is not exactly what READ prints. */
export function parseBoxTranscriptAttachments(raw: string): Record<string, unknown>[] | null {
  if (Buffer.byteLength(raw) > MAX_OUTPUT_BYTES + 2) return null;
  let value: unknown;
  try { value = JSON.parse(raw.trim()); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).join(",") !== "records") return null;
  const records = (value as { records: unknown }).records;
  if (!Array.isArray(records) || records.length > 16) return null;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const item = record as Record<string, unknown>;
    const attachment = item.attachment as Record<string, unknown> | undefined;
    if (item.type !== "attachment" || !attachment || typeof attachment !== "object"
      || !BOX_STAGED_ATTACHMENT_TYPES.includes(String(attachment.type))) return null;
  }
  return records as Record<string, unknown>[];
}
