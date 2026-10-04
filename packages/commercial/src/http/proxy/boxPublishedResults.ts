/** OCV5-302: give hash-only recovery paths the tool results OpenClaude actually
 * published, so the result echo can recognize Claude Code's exact rewrites
 * (see boxToolResultEcho) instead of leaving the row unknown forever. The file
 * is the sidecar's own input (`result.<id>.json` in the private run dir); its
 * content is accepted only when it hashes to the journaled contentHash, so it
 * adds evidence and never authority. Any read failure falls back to hashes. */
import { createHash } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxMatchedToolResult } from "./boxToolResultMatcher.js";

type Expected = Pick<BoxMatchedToolResult, "modelToolUseId" | "contentHash" | "isError">;
type Exec = { run(request: BoxCcExecRequest, opts: { timeoutMs: number;
  maxResponseBytes?: number; signal?: AbortSignal }): Promise<{ stdout: string }> };

const RUN_DIR = /^\/tmp\/ocv5-289-run-[0-9a-f]{24}$/;
const TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
const CHUNK = 700_000;
const MAX_FILE = 8 * 1024 * 1024;
const READ_RESULT_CHUNK = String.raw`import base64,json,os,re,stat,sys
d,tool_id,off=sys.argv[1],sys.argv[2],int(sys.argv[3])
if not re.fullmatch(r'/tmp/ocv5-289-run-[0-9a-f]{24}',d) or not re.fullmatch(r'toolu_[A-Za-z0-9_-]{1,120}',tool_id) or off<0:raise SystemExit(2)
dfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(dfd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(3)
 fd=os.open('result.'+tool_id+'.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=dfd)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or not 1<=st.st_size<=${MAX_FILE}:raise SystemExit(4)
  os.lseek(fd,off,0); raw=os.read(fd,${CHUNK})
  sys.stdout.write(json.dumps({'size':st.st_size,'b64':base64.b64encode(raw).decode()}))
 finally:os.close(fd)
finally:os.close(dfd)`;

async function readResultFile(exec: Exec, cwd: string, toolId: string,
  signal?: AbortSignal): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = -1, offset = 0;
  do {
    const response = await exec.run({ command: "/usr/bin/python3",
      args: ["-I", "-c", READ_RESULT_CHUNK, cwd, toolId, String(offset)],
      cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
    { timeoutMs: 20_000, maxResponseBytes: 1_048_576, ...(signal ? { signal } : {}) });
    const chunk = JSON.parse(response.stdout) as { size: unknown; b64: unknown };
    if (!Number.isSafeInteger(chunk.size) || typeof chunk.b64 !== "string"
      || (size >= 0 && chunk.size !== size)) return null;
    size = chunk.size as number;
    const raw = Buffer.from(chunk.b64, "base64");
    if (raw.length === 0 && offset < size) return null;
    parts.push(raw); offset += raw.length;
  } while (offset < size);
  return offset === size ? Buffer.concat(parts) : null;
}

export async function withPublishedBoxResults<T extends Expected>(exec: Exec, cwd: string,
  expected: readonly T[], signal?: AbortSignal): Promise<readonly (T & {
    content?: BoxMatchedToolResult["content"] })[]> {
  if (!RUN_DIR.test(cwd)) return expected;
  return Promise.all(expected.map(async (item) => {
    if (!TOOL_ID.test(item.modelToolUseId)) return item;
    try {
      const raw = await readResultFile(exec, cwd, item.modelToolUseId, signal);
      if (!raw) return item;
      const file = JSON.parse(raw.toString("utf8")) as { modelToolUseId?: unknown;
        content?: unknown; isError?: unknown };
      if (file.modelToolUseId !== item.modelToolUseId || file.isError !== item.isError
        || !Array.isArray(file.content)) return item;
      const hash = createHash("sha256").update(JSON.stringify({
        content: file.content, isError: item.isError })).digest("hex");
      return hash === item.contentHash
        ? { ...item, content: file.content as BoxMatchedToolResult["content"] } : item;
    } catch { return item; }
  }));
}
