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
import { makeBoxStageFiles, type BoxStageFile } from "./boxStageFiles.js";

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
  readonly stageAssets: BoxCcExecRequest;
  readonly assetManifest: string;
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

const STAGE_SUPERVISOR = String.raw`import base64,hashlib,os,re,stat,sys
items=sys.argv[1:]
if len(items)<4 or len(items)>16 or len(items)%4:raise SystemExit(1)
manifest=[]
for index in range(0,len(items),4):
 p,encoded,want,tmpid=items[index:index+4]
 if not re.fullmatch(r'/tmp/ocv5-289-v2-(?:supervisor|keeper|box-virtual-mcp|detached-runner)-[a-f0-9]{16}\.py',p) or not re.fullmatch(r'[a-f0-9]{24}',tmpid):raise SystemExit(1)
 raw=base64.b64decode(encoded,validate=True)
 if len(raw)>32768 or hashlib.sha256(raw).hexdigest()!=want or want[:16] not in p:raise SystemExit(1)
 parent=os.open('/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 name=os.path.basename(p);tmp=name+'.part.'+tmpid
 try:
  try:
   existing=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  except FileNotFoundError:existing=None
  if existing is None:
   fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
   try:
    n=0
    while n<len(raw):n+=os.write(fd,raw[n:])
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size!=len(raw) or st.st_nlink!=1:raise SystemExit(1)
    os.fsync(fd)
   finally:os.close(fd)
   try:os.link(tmp,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
   except FileExistsError:pass
   existing=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  try:
   st=os.fstat(existing)
   if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size!=len(raw):raise SystemExit(1)
   digest=hashlib.sha256()
   while True:
    part=os.read(existing,65536)
    if not part:break
    digest.update(part)
   if digest.hexdigest()!=want:raise SystemExit(1)
  finally:os.close(existing)
  try:os.unlink(tmp,dir_fd=parent)
  except FileNotFoundError:pass
  os.fsync(parent)
 finally:os.close(parent)
 manifest.append(want)
print(','.join(manifest))`;

export function makeBoxAssetStage(asset: Buffer, path: string): {
  hash: string; request: BoxCcExecRequest;
} {
  if (!Buffer.isBuffer(asset) || asset.length < 1 || asset.length > 32768) {
    throw new BoxTextPlanError("BOX_ASSET_STAGE_INVALID");
  }
  const hash = sha(asset);
  const match = /^\/tmp\/ocv5-289-v2-(?:supervisor|keeper|box-virtual-mcp|detached-runner)-([a-f0-9]{16})\.py$/.exec(path);
  if (!match || match[1] !== hash.slice(0, 16)) {
    throw new BoxTextPlanError("BOX_ASSET_STAGE_INVALID");
  }
  return { hash, request: { command: PYTHON,
    args: ["-I", "-c", STAGE_SUPERVISOR, path, asset.toString("base64"), hash,
      randomBytes(12).toString("hex")],
    cwd: "/tmp", environment: BASE_ENV } };
}

/** One remote Exec for the small immutable helpers; each file retains its own
 * content-addressed no-clobber verification. A failed batch never arms launch. */
export function makeBoxAssetsStage(assets: readonly { asset: Buffer; path: string }[]): {
  manifest: string; request: BoxCcExecRequest;
} {
  if (assets.length < 1 || assets.length > 4) {
    throw new BoxTextPlanError("BOX_ASSET_STAGE_INVALID");
  }
  const stages = assets.map(({ asset, path }) => makeBoxAssetStage(asset, path));
  if (new Set(assets.map(({ path }) => path)).size !== assets.length) {
    throw new BoxTextPlanError("BOX_ASSET_STAGE_INVALID");
  }
  return { manifest: stages.map(({ hash }) => hash).join(","),
    request: { ...stages[0]!.request, args: ["-I", "-c", STAGE_SUPERVISOR,
      ...stages.flatMap(({ request }) => request.args.slice(3))] } };
}

export function makeBoxTextPlan(input: {
  body: ProxyBody;
  upstreamModel: string;
  /** Model-specific verified output cap, supplied by the catalog route. */
  maxOutputTokensLimit: number;
  supervisorAsset: Buffer;
  keeperAsset: Buffer;
  /** Private virtual MCP catalog only. Other extra paths are forbidden. */
  extraStageFiles?: readonly BoxStageFile[];
  runNonce?: string;
  leaseEpoch?: string;
  /** Detached tool bridge only; text path keeps its existing 110s default. */
  supervisorDeadlineSeconds?: number;
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
  const supervisorDeadlineSeconds = input.supervisorDeadlineSeconds ?? 110;
  if (!Number.isSafeInteger(supervisorDeadlineSeconds)
    || supervisorDeadlineSeconds < 1 || supervisorDeadlineSeconds > 900) {
    throw new BoxTextPlanError("BOX_SUPERVISOR_DEADLINE_INVALID");
  }
  const runNonce = input.runNonce ?? randomBytes(12).toString("hex");
  const leaseEpoch = input.leaseEpoch ?? randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{24}$/.test(runNonce)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  if (!/^[0-9a-f]{32}$/.test(leaseEpoch)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  if (input.extraStageFiles?.length
    && (input.extraStageFiles.length !== 1
      || input.extraStageFiles[0]?.path !== `${cwd}/tool-catalog.json`)) {
    throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  }
  const proofDir = `/tmp/ocv5-289-proof-${runNonce}`;
  const mapped = compileBoxCliSyntheticTurn({ ...input.body, model: input.upstreamModel },
    { cwd, cliVersion: "2.1.280" });
  const supervisorHash = sha(input.supervisorAsset);
  const supervisorPath = `/tmp/ocv5-289-v2-supervisor-${supervisorHash.slice(0, 16)}.py`;
  const keeperHash = sha(input.keeperAsset);
  const keeperPath = `/tmp/ocv5-289-v2-keeper-${keeperHash.slice(0, 16)}.py`;
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
  const stageSupervisor = makeBoxAssetStage(input.supervisorAsset, supervisorPath).request;
  const stageKeeper = makeBoxAssetStage(input.keeperAsset, keeperPath).request;
  const assetBatch = makeBoxAssetsStage([
    { asset: input.supervisorAsset, path: supervisorPath },
    { asset: input.keeperAsset, path: keeperPath },
  ]);
  const staged = makeBoxStageFiles({ cwd, project,
    files: [
      ...(hasHistory ? [{ path: snapshotPath, raw: snapshot, hash: snapshotHash! }] : []),
      { path: stdinPath, raw: stdin, hash: stdinHash },
      { path: systemPath, raw: system, hash: systemHash },
      ...(input.extraStageFiles ?? []),
    ] });
  const run: BoxCcExecRequest = {
    command: PYTHON,
    args: ["-I", keeperPath, supervisorPath, "--proof-dir", proofDir,
      "--lease-epoch", leaseEpoch, "--deadline", String(supervisorDeadlineSeconds), "--kill-after", "2",
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
    stageSupervisor, stageKeeper, stageAssets: assetBatch.request,
    assetManifest: assetBatch.manifest, stageInputs: staged.requests, run, cleanup,
    supervisorHash, keeperHash,
    snapshotHash, stdinHash, systemHash };
}
