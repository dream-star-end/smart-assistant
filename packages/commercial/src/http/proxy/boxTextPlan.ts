/** Fixed Box Exec run plan for a completed-history, no-tool Messages request.
 * OpenClaude remains the agent. Box receives a bounded temporary transcript,
 * structured current user input and system context as files, not Claude argv.
 * This builder is not a live route by itself; the caller must own account,
 * durable invocation lease, terminal evidence and cleanup sequencing.
 */
import { createHash, randomBytes } from "node:crypto";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import { boxApiRunnerFor } from "@openclaude/protocol";
import { currentVerifiedProxyByteBudget, type ProxyBody } from "./shared.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import { validateBoxTextRequest } from "./boxRequestGate.js";
import { makeBoxStageFiles, type BoxStageFile } from "./boxStageFiles.js";
import { makeBoxNativeFileInspect } from "./boxNativeFile.js";
import { mapBoxCliEffort } from "./boxToolCatalog.js";

export class BoxTextPlanError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxTextPlanError"; }
}
export interface BoxTextPlan {
  readonly cwd: string;
  readonly cliCwd: string;
  readonly nativePersistence: boolean;
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
  /** Full deletion when optional native pointer publication did not commit. */
  readonly discardNativeCleanup?: BoxCcExecRequest;
  /** Must run and match before native resume admission; also ensures old cwd. */
  readonly nativePreflight?: BoxCcExecRequest;
  /** OCV5-378: the staged interactive host, when this run's model uses that runner. */
  readonly interactiveHost?: { readonly asset: Buffer; readonly path: string; readonly hash: string };
  /** Its own stage request, for callers that stage helpers one by one (fast path off). */
  readonly stageInteractiveHost?: BoxCcExecRequest;
  readonly supervisorHash: string;
  readonly keeperHash: string;
  readonly snapshotHash: string | null;
  readonly stdinHash: string;
  readonly systemHash: string;
}

/** OCV5-378: how a model with BoxApiRunner "interactive" runs on the Box. The oc-box host
 * (packages/gateway/box-bridge-mod/host.py, print mode) takes the same claude argv and stdio
 * contract as `claude -p` and serves it with an interactive Claude Code in tmux, driven by the
 * oc-bridge mod. The host is staged like the other helpers; the mod rides in the environment. */
export interface BoxInteractiveHostAsset {
  readonly host: Buffer;
  /** JSON {relpath: base64} of the oc-bridge mod (host.py OC_BOX_MOD_FILES). */
  readonly modFiles: string;
  readonly modSha256: string;
}

/** Plan input for a canonical model's Box runner. A model that runs interactively never falls
 * back to `claude -p`: without the host its request is refused. */
/** The interactive runner (box-claude-*: interactive Claude Code on the Box) is a separate approval
 * per installation: the egress loads its host only with OC_BOX_INTERACTIVE_RUNNER=1. Without it every
 * interactive model is refused (BOX_INTERACTIVE_HOST_UNAVAILABLE) whatever the catalog says, and no
 * `claude -p` model is affected. */
export function boxInteractiveRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_BOX_INTERACTIVE_RUNNER === "1";
}

export function boxRunnerPlanInput(canonicalModel: string, host: BoxInteractiveHostAsset | undefined):
  { interactiveHost?: BoxInteractiveHostAsset } {
  if (boxApiRunnerFor(canonicalModel) !== "interactive") return {};
  if (!host) throw new BoxTextPlanError("BOX_INTERACTIVE_HOST_UNAVAILABLE");
  return { interactiveHost: host };
}

/** Logins a canonical model's launch may use: every enabled login for an interactive runner,
 * the default login of each account for `claude -p` (BoxLoginScope). */
export function boxRunnerLoginScope(canonicalModel: string): "default" | "all" {
  return boxApiRunnerFor(canonicalModel) === "interactive" ? "all" : "default";
}

const MODEL = "/home/box/.local/bin/claude";
const BOX_PRINT_ONLY_FLAGS = new Set(["-p", "--include-partial-messages", "--verbose", "--no-session-persistence"]);
const BOX_PRINT_VALUE_FLAGS = new Set(["--input-format", "--output-format"]);
const PYTHON = "/usr/bin/python3";
const BASE_ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
function sha(raw: Buffer): string { return createHash("sha256").update(raw).digest("hex"); }

const STAGE_SUPERVISOR = String.raw`import base64,hashlib,os,re,stat,sys
items=sys.argv[1:]
if len(items)<4 or len(items)>20 or len(items)%4:raise SystemExit(1)
manifest=[]
for index in range(0,len(items),4):
 p,encoded,want,tmpid=items[index:index+4]
 if not re.fullmatch(r'/tmp/ocv5-289-v2-(?:supervisor|keeper|box-virtual-mcp|detached-runner|interactive-host)-[a-f0-9]{16}\.py',p) or not re.fullmatch(r'[a-f0-9]{24}',tmpid):raise SystemExit(1)
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
  const match = /^\/tmp\/ocv5-289-v2-(?:supervisor|keeper|box-virtual-mcp|detached-runner|interactive-host)-([a-f0-9]{16})\.py$/.exec(path);
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
  if (assets.length < 1 || assets.length > 5) {
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
  /** Off-by-default native completed-turn cache. Account/history/CAS preflight
   * belongs to the caller; this builder only emits the pinned CLI plan. */
  nativePersistence?: boolean;
  nativeResume?: { cliCwd: string; sessionId: string; expectedSha256: string };
  /** OCV5-304: resume a tool exchange whose live owner is gone (see mapper). */
  resumeToolResults?: boolean;
  /** Client tool name -> virtual-MCP alias of this invocation (tool plan only). */
  toolAliases?: ReadonlyMap<string, string>;
  /** Appended to the staged system prompt (tool plan: the alias table). */
  systemSuffix?: string;
  /** OCV5-378: run through the interactive host (models with BoxApiRunner "interactive"). */
  interactiveHost?: BoxInteractiveHostAsset;
  /** OCV5-384: see compileBoxCliSyntheticTurn. Ignored on native resume (nothing is staged). */
  stagedAttachments?: readonly Record<string, unknown>[];
}): BoxTextPlan {
  const unsupported = validateBoxTextRequest(input.body,
    input.resumeToolResults ? { resumeToolResults: true } : {});
  if (unsupported) throw new BoxTextPlanError(unsupported);
  // OCV5-305: a text-only turn runs at the user's effort too.
  const effort = input.body.thinking === undefined && input.body.output_config === undefined
    ? null : mapBoxCliEffort(input.body.thinking, input.body.output_config);
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
  const host = input.interactiveHost;
  if (host && (host.host.length === 0 || host.host.length > 32768
    || !/^[a-f0-9]{64}$/.test(host.modSha256)
    || host.modFiles.length === 0 || host.modFiles.length > 256 * 1024)) {
    throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  }
  const supervisorDeadlineSeconds = input.supervisorDeadlineSeconds ?? 110;
  if (!Number.isSafeInteger(supervisorDeadlineSeconds)
    || supervisorDeadlineSeconds < 1 || supervisorDeadlineSeconds > 14_400) {
    throw new BoxTextPlanError("BOX_SUPERVISOR_DEADLINE_INVALID");
  }
  const runNonce = input.runNonce ?? randomBytes(12).toString("hex");
  const leaseEpoch = input.leaseEpoch ?? randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{24}$/.test(runNonce)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  if (!/^[0-9a-f]{32}$/.test(leaseEpoch)) throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const nativePersistence = input.nativePersistence === true || input.nativeResume !== undefined;
  if (input.nativeResume && (input.nativePersistence === false
    || !/^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/.test(input.nativeResume.cliCwd)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.nativeResume.sessionId)
    || !/^[a-f0-9]{64}$/.test(input.nativeResume.expectedSha256))) {
    throw new BoxTextPlanError("BOX_NATIVE_SESSION_INVALID");
  }
  const cliCwd = input.nativeResume?.cliCwd ?? cwd;
  if (input.extraStageFiles?.length
    && (input.extraStageFiles.length !== 1
      || input.extraStageFiles[0]?.path !== `${cwd}/tool-catalog.json`)) {
    throw new BoxTextPlanError("BOX_TEXT_PLAN_INVALID");
  }
  const proofDir = `/tmp/ocv5-289-proof-${runNonce}`;
  // A text-only turn exposes no tools, so every historical call is staged as
  // text; the tool plan passes its catalog aliases instead (OCV5-299).
  const mapped = compileBoxCliSyntheticTurn({ ...input.body, model: input.upstreamModel },
    { cwd, cliVersion: "2.1.280", sessionId: input.nativeResume?.sessionId,
      toolAliases: input.toolAliases ?? new Map(),
      ...(input.resumeToolResults ? { resumeToolResults: true } : {}),
      ...(input.stagedAttachments?.length && !input.nativeResume
        ? { stagedAttachments: input.stagedAttachments } : {}) });
  const supervisorHash = sha(input.supervisorAsset);
  const supervisorPath = `/tmp/ocv5-289-v2-supervisor-${supervisorHash.slice(0, 16)}.py`;
  const keeperHash = sha(input.keeperAsset);
  const keeperPath = `/tmp/ocv5-289-v2-keeper-${keeperHash.slice(0, 16)}.py`;
  const hostHash = host ? sha(host.host) : "";
  const interactiveHost = host ? { asset: host.host, hash: hostHash,
    path: `/tmp/ocv5-289-v2-interactive-host-${hostHash.slice(0, 16)}.py` } : undefined;
  const hasHistory = !input.nativeResume && mapped.snapshotJsonl.length > 0;
  const project = hasHistory ? `/home/box/.claude/projects/${cwd.replaceAll("/", "-")}` : "";
  const snapshotPath = hasHistory ? `${project}/${mapped.sessionId}.jsonl` : "";
  const stdinPath = `${cwd}/stdin.jsonl`, systemPath = `${cwd}/system.txt`;
  const snapshot = Buffer.from(hasHistory ? mapped.snapshotJsonl : "");
  const stdin = Buffer.from(mapped.stdinJsonl);
  const system = Buffer.from(input.systemSuffix
    ? [mapped.systemPrompt, input.systemSuffix].filter(Boolean).join("\n\n") : mapped.systemPrompt);
  // History snapshot follows the verified envelope. The current-turn stdin file
  // and the system file stay at the original 8 MiB plan cap.
  const snapshotCeiling = currentVerifiedProxyByteBudget().snapshot;
  if (snapshot.length > snapshotCeiling || stdin.length > 8 * 1024 * 1024
    || system.length > 8 * 1024 * 1024) throw new BoxTextPlanError("BOX_TEXT_INPUT_TOO_LARGE");
  const snapshotHash = hasHistory ? sha(snapshot) : null;
  const stdinHash = sha(stdin), systemHash = sha(system);
  const stageSupervisor = makeBoxAssetStage(input.supervisorAsset, supervisorPath).request;
  const stageKeeper = makeBoxAssetStage(input.keeperAsset, keeperPath).request;
  const assetBatch = makeBoxAssetsStage([
    { asset: input.supervisorAsset, path: supervisorPath },
    { asset: input.keeperAsset, path: keeperPath },
    ...(interactiveHost ? [{ asset: interactiveHost.asset, path: interactiveHost.path }] : []),
  ]);
  const staged = makeBoxStageFiles({ cwd, project,
    // OCV5-384: a fresh native session's transcript directory must be ours (0700).
    ensureProject: !hasHistory && !input.nativeResume && nativePersistence,
    snapshotMaxBytes: snapshotCeiling,
    files: [
      ...(hasHistory ? [{ path: snapshotPath, raw: snapshot, hash: snapshotHash! }] : []),
      { path: stdinPath, raw: stdin, hash: stdinHash },
      { path: systemPath, raw: system, hash: systemHash },
      ...(input.extraStageFiles ?? []),
    ] });
  const cliArgs = [MODEL, "-p", "--model", input.upstreamModel,
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--verbose", "--tools", "",
      "--disallowedTools", "mcp__*", "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
      "--disable-slash-commands", ...(nativePersistence ? [] : ["--no-session-persistence"]),
      ...(effort ? ["--effort", effort] : []),
      "--system-prompt-file", systemPath,
      hasHistory || input.nativeResume ? "--resume" : "--session-id", mapped.sessionId];
  // The interactive host gets the interactive argv: no `-p` (or any --print-only flag) appears on
  // the Box for these models; a non-persistent run says so in the environment instead.
  const interactiveCli = cliArgs.filter((arg, i) => !BOX_PRINT_ONLY_FLAGS.has(arg)
    && !(BOX_PRINT_VALUE_FLAGS.has(cliArgs[i - 1] ?? "") && arg === "stream-json")
    && !BOX_PRINT_VALUE_FLAGS.has(arg));
  const run: BoxCcExecRequest = {
    command: PYTHON,
    args: ["-I", keeperPath, supervisorPath, "--proof-dir", proofDir,
      "--lease-epoch", leaseEpoch, "--deadline", String(supervisorDeadlineSeconds), "--kill-after", "2",
      "--max-output", "1048576", "--stdin-file", stdinPath,
      "--stdin-sha256", stdinHash, "--",
      ...(interactiveHost ? [PYTHON, "-I", interactiveHost.path, ...interactiveCli] : cliArgs)],
    cwd: cliCwd,
    environment: { HOME: "/home/box", PATH: "/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8", CLAUDE_CODE_MAX_RETRIES: "0",
      // OCV5-377: on a safety stop the CLI would retry once on its own with a
      // nudge; that hidden answer reaches no client and holds the run. The
      // client's own Claude Code decides what to do with the refusal.
      CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1",
      // OCV5-386: an interactive Claude Code moves an MCP tool call to the background after
      // 120 s and answers the model with its own "still running ... moved to the background"
      // text. Box tools are the container's tools behind one bridge call: the run must wait
      // for their real result (the container enforces each tool's own timeout). 0 = never.
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.body.max_tokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Explicit 0 or 1. Omitting the key would inherit an outer "1".
      // Only the verified box-native-v1 budget, already chosen by the proxy
      // gate, may enable inner auto-compact. Legacy native stays disabled.
      // Non-persistent plans keep the previous omission.
      ...(nativePersistence ? {
        DISABLE_AUTO_COMPACT: currentVerifiedProxyByteBudget().id === "box-native-v1" ? "0" : "1",
      } : {}),
      // The host's print mode reads the same argv; the mod files are checked against the digest.
      ...(host ? { OC_BOX_HOST_MODE: "print", OC_BOX_MOD_FILES: host.modFiles,
        OC_BOX_MOD_SHA256: host.modSha256,
        ...(nativePersistence ? {} : { OC_BOX_NO_SESSION_PERSISTENCE: "1" }) } : {}) },
  };
  const cleanup = nativePersistence && !input.nativeResume
    ? staged.cleanupPreservingNative : staged.cleanup;
  const discardNativeCleanup = nativePersistence && !input.nativeResume
    ? staged.cleanup : undefined;
  const nativePreflight = input.nativeResume ? makeBoxNativeFileInspect({
    cliCwd: input.nativeResume.cliCwd, nativeSessionId: input.nativeResume.sessionId,
    expectedSha256: input.nativeResume.expectedSha256, ensureCwd: true }) : undefined;
  return { ...(interactiveHost ? { interactiveHost,
    stageInteractiveHost: makeBoxAssetStage(interactiveHost.asset, interactiveHost.path).request } : {}),
    cwd, cliCwd, nativePersistence, proofDir, runNonce, leaseEpoch,
    sessionId: mapped.sessionId, expectedModel: input.upstreamModel,
    stageSupervisor, stageKeeper, stageAssets: assetBatch.request,
    assetManifest: assetBatch.manifest, stageInputs: staged.requests, run, cleanup,
    ...(discardNativeCleanup ? { discardNativeCleanup } : {}),
    ...(nativePreflight ? { nativePreflight } : {}),
    supervisorHash, keeperHash,
    snapshotHash, stdinHash, systemHash };
}
