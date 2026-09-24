/** Fixed Box Exec run plan for a completed-history, no-tool Messages request.
 * OpenClaude remains the agent. Box receives a bounded temporary transcript,
 * structured current user input and system context as files, not Claude argv.
 * This builder is not a live route by itself; the caller must own account,
 * durable invocation lease, terminal evidence and cleanup sequencing.
 */
import { createHash, randomBytes } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { ProxyBody } from "./shared.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { validateBoxTextRequest } from "./boxRequestGate.js";
import { makeBoxStageFiles } from "./boxStageFiles.js";

export class BoxTextPlanError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxTextPlanError"; }
}
export interface BoxTextPlan {
  readonly cwd: string;
  readonly proofDir: string;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly sessionId: string;
  readonly expectedModel: string;
  readonly stageSupervisor: BoxCcExecRequest;
  readonly stageKeeper: BoxCcExecRequest;
  /** Execute in order; never retry an ambiguous partial write. */
  readonly stageInputs: readonly BoxCcExecRequest[];
  readonly run: BoxCcExecRequest;
  readonly cleanup: BoxCcExecRequest;
  readonly supervisorHash: string;
  readonly keeperHash: string;
  readonly snapshotHash: string | null;
  readonly stdinHash: string;
  readonly systemHash: string;
}

const MODEL = "/home/box/.local/bin/claude";
const PYTHON = "/usr/bin/python3";
const BASE_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
function sha(raw: Buffer): string { return createHash("sha256").update(raw).digest("hex"); }

const STAGE_SUPERVISOR = String.raw`import base64,hashlib,os,stat,sys
p,encoded,want=sys.argv[1:]
raw=base64.b64decode(encoded,validate=True)
if len(raw)>32768 or hashlib.sha256(raw).hexdigest()!=want:raise SystemExit(1)
try:fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError:pass
else:
 try:
  n=0
  while n<len(raw):n+=os.write(fd,raw[n:])
  os.fsync(fd)
 finally:os.close(fd)
st=os.lstat(p)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or hashlib.sha256(open(p,'rb').read()).hexdigest()!=want:raise SystemExit(1)
print(want)`;

export function makeBoxTextPlan(input: {
  body: ProxyBody;
  upstreamModel: string;
  /** Model-specific verified output cap, supplied by the catalog route. */
  maxOutputTokensLimit: number;
  supervisorAsset: Buffer;
  keeperAsset: Buffer;
  runNonce?: string;
  leaseEpoch?: string;
}): BoxTextPlan {
  const unsupported = validateBoxTextRequest(input.body);
  if (unsupported) throw new BoxTextPlanError(unsupported);
  if (!/^claude-[a-z0-9-]{3,64}$/.test(input.upstreamModel)
    || input.supervisorAsset.length === 0 || input.supervisorAsset.length > 32768
    || input.keeperAsset.length === 0 || input.keeperAsset.length > 32768
    || !Number.isSafeInteger(input.maxOutputTokensLimit) || input.maxOutputTokensLimit < 1
    || !Number.isSafeInteger(input.body.max_tokens) || input.body.max_tokens < 1) {
    throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  }
  if (input.body.max_tokens > input.maxOutputTokensLimit) {
    throw new BoxTextPlanError("BOX_MAX_TOKENS_UNSUPPORTED");
  }
  const runNonce = input.runNonce ?? randomBytes(12).toString("hex");
  const leaseEpoch = input.leaseEpoch ?? randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{24}$/.test(runNonce)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  if (!/^[0-9a-f]{32}$/.test(leaseEpoch)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const proofDir = `/tmp/ocv5-289-proof-${runNonce}`;
  const mapped = compileBoxCliSyntheticTurn({ ...input.body, model: input.upstreamModel },
    { cwd, cliVersion: "2.1.280" });
  const supervisorHash = sha(input.supervisorAsset);
  const supervisorPath = `/tmp/ocv5-289-supervisor-${supervisorHash.slice(0, 16)}.py`;
  const keeperHash = sha(input.keeperAsset);
  const keeperPath = `/tmp/ocv5-289-keeper-${keeperHash.slice(0, 16)}.py`;
  const hasHistory = mapped.snapshotJsonl.length > 0;
  const project = hasHistory ? `/home/box/.claude/projects/${cwd.replaceAll("/", "-")}` : "";
  const snapshotPath = hasHistory ? `${project}/${mapped.sessionId}.jsonl` : "";
  const stdinPath = `${cwd}/stdin.jsonl`, systemPath = `${cwd}/system.txt`;
  const snapshot = Buffer.from(mapped.snapshotJsonl), stdin = Buffer.from(mapped.stdinJsonl);
  const system = Buffer.from(mapped.systemPrompt);
  if (snapshot.length > 8 * 1024 * 1024 || stdin.length > 8 * 1024 * 1024
    || system.length > 8 * 1024 * 1024) throw new BoxTextPlanError("BOX_TEXT_INPUT_TOO_LARGE");
  const snapshotHash = hasHistory ? sha(snapshot) : null;
  const stdinHash = sha(stdin), systemHash = sha(system);
  const stageSupervisor: BoxCcExecRequest = {
    command: PYTHON, args: ["-c", STAGE_SUPERVISOR, supervisorPath,
      input.supervisorAsset.toString("base64"), supervisorHash], cwd: "/tmp", environment: BASE_ENV,
  };
  const stageKeeper: BoxCcExecRequest = {
    command: PYTHON, args: ["-c", STAGE_SUPERVISOR, keeperPath,
      input.keeperAsset.toString("base64"), keeperHash], cwd: "/tmp", environment: BASE_ENV,
  };
  const staged = makeBoxStageFiles({ cwd, project,
    files: [
      ...(hasHistory ? [{ path: snapshotPath, raw: snapshot, hash: snapshotHash! }] : []),
      { path: stdinPath, raw: stdin, hash: stdinHash },
      { path: systemPath, raw: system, hash: systemHash },
    ] });
  const run: BoxCcExecRequest = {
    command: PYTHON,
    args: [keeperPath, supervisorPath, "--proof-dir", proofDir,
      "--lease-epoch", leaseEpoch, "--deadline", "110", "--kill-after", "2",
      "--max-output", "1048576", "--stdin-file", stdinPath,
      "--stdin-sha256", stdinHash, "--", MODEL, "-p", "--model", input.upstreamModel,
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--verbose", "--tools", "",
      "--disallowedTools", "mcp__*", "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
      "--disable-slash-commands", "--no-session-persistence",
      "--system-prompt-file", systemPath,
      hasHistory ? "--resume" : "--session-id", mapped.sessionId],
    cwd,
    environment: { HOME: "/home/box", PATH: "/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8", CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.body.max_tokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  };
  const cleanup = staged.cleanup;
  return { cwd, proofDir, runNonce, leaseEpoch,
    sessionId: mapped.sessionId, expectedModel: input.upstreamModel,
    stageSupervisor, stageKeeper, stageInputs: staged.requests, run, cleanup,
    supervisorHash, keeperHash,
    snapshotHash, stdinHash, systemHash };
}
