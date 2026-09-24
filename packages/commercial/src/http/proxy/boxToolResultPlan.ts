/** Fixed owner-scoped Box sidecar result transfer. Caller must first claim a
 * durable resume CAS; an ambiguous write is never replayed. No tool executes
 * here: the content already came from OpenClaude's user container. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxToolUse } from "./boxCliToolHandoff.js";
import { hashBoxToolInput, type BoxToolUseDigest } from "./boxToolInputHash.js";
import type { BoxMatchedToolResult } from "./boxToolResultMatcher.js";
import { makeBoxStageFiles } from "./boxStageFiles.js";

const RUN_DIR = /^\/tmp\/ocv5-289-run-[0-9a-f]{24}$/;
const TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
const READ_PENDING = String.raw`import os,re,stat,sys
d,tool_id=sys.argv[1:]
if not re.fullmatch(r'/tmp/ocv5-289-run-[0-9a-f]{24}',d) or not re.fullmatch(r'toolu_[A-Za-z0-9_-]{1,120}',tool_id):raise SystemExit(2)
dfd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(dfd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(3)
 fd=os.open('pending.'+tool_id+'.json',os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=dfd)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or not 1<=st.st_size<=1048576:raise SystemExit(4)
  raw=os.read(fd,1048577)
  if len(raw)!=st.st_size:raise SystemExit(5)
  os.write(1,raw)
 finally:os.close(fd)
finally:os.close(dfd)`;

export class BoxToolResultPlanError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolResultPlanError"; }
}
export interface BoxPendingToolCall {
  version: 1;
  modelToolUseId: string;
  mcpRequestId: string | number;
  name: string;
  arguments: Record<string, unknown>;
}

export function makeBoxPendingRead(cwd: string, toolId: string): BoxCcExecRequest {
  if (!RUN_DIR.test(cwd) || !TOOL_ID.test(toolId)) {
    throw new BoxToolResultPlanError("BOX_PENDING_PATH_INVALID");
  }
  return { command: PYTHON, args: ["-c", READ_PENDING, cwd, toolId],
    cwd: "/tmp", environment: ENV };
}

export function parseBoxPendingCall(raw: string,
  expected: BoxToolUse | BoxToolUseDigest): BoxPendingToolCall {
  if (Buffer.byteLength(raw) > 1_048_576) {
    throw new BoxToolResultPlanError("BOX_PENDING_INVALID");
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new BoxToolResultPlanError("BOX_PENDING_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxToolResultPlanError("BOX_PENDING_INVALID");
  }
  const x = value as Record<string, unknown>;
  let sameArguments = false;
  try { sameArguments = "inputHash" in expected
    ? hashBoxToolInput(x.arguments) === expected.inputHash
    : isDeepStrictEqual(x.arguments, expected.input); }
  catch { sameArguments = false; }
  if (Object.keys(x).sort().join(",") !== "arguments,mcpRequestId,modelToolUseId,name,version"
    || x.version !== 1 || x.modelToolUseId !== expected.id
    || !TOOL_ID.test(expected.id)
    || x.name !== expected.boxName.replace(/^mcp__ocbridge__/, "")
    || !sameArguments
    || (typeof x.mcpRequestId !== "string" && !Number.isSafeInteger(x.mcpRequestId))
    || (typeof x.mcpRequestId === "string" && x.mcpRequestId.length > 128)) {
    throw new BoxToolResultPlanError("BOX_PENDING_INVALID");
  }
  return x as unknown as BoxPendingToolCall;
}

export function makeBoxToolResultPlan(input: {
  cwd: string;
  expected: BoxToolUse | BoxToolUseDigest;
  pending: BoxPendingToolCall;
  matched: BoxMatchedToolResult;
}): { requests: readonly BoxCcExecRequest[]; resultHash: string; path: string } {
  if (!RUN_DIR.test(input.cwd) || !TOOL_ID.test(input.expected.id)
    || input.matched.modelToolUseId !== input.expected.id) {
    throw new BoxToolResultPlanError("BOX_RESULT_IDENTITY_INVALID");
  }
  parseBoxPendingCall(JSON.stringify(input.pending), input.expected);
  const contentHash = createHash("sha256").update(JSON.stringify({
    content: input.matched.content, isError: input.matched.isError })).digest("hex");
  if (contentHash !== input.matched.contentHash) {
    throw new BoxToolResultPlanError("BOX_RESULT_CONTENT_CHANGED");
  }
  const result = { version: 1, modelToolUseId: input.expected.id,
    mcpRequestId: input.pending.mcpRequestId,
    content: input.matched.content, isError: input.matched.isError };
  const raw = Buffer.from(JSON.stringify(result), "utf8");
  if (raw.length > 8 * 1024 * 1024) {
    throw new BoxToolResultPlanError("BOX_RESULT_TOO_LARGE");
  }
  const resultHash = createHash("sha256").update(raw).digest("hex");
  const path = `${input.cwd}/result.${input.expected.id}.json`;
  const staged = makeBoxStageFiles({ cwd: input.cwd, project: "",
    files: [{ path, raw, hash: resultHash }], initialize: false });
  return { requests: staged.requests, resultHash, path };
}
