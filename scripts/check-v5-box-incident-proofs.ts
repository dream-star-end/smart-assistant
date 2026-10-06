/** Release gate for Box incidents whose only evidence was unit tests.
 * deploy-v5.sh runs this file from the pinned candidate archive:
 *   tsx scripts/check-v5-box-incident-proofs.ts --expect-sha <40-hex>
 * Each proof sends the request shape recorded for one incident through the
 * product's own admission and matching entry points and requires the outcome
 * the user needed: the turn continues. Shapes that must stay rejected are
 * checked next to it. A proof names its incident in the receipt.
 * --expect-sha is the builder archive SHA; the archive has no .git, so it is
 * recorded in the receipt and not compared here.
 * Incidents whose fix lives in the durable journal run against real Postgres:
 * TEST_DATABASE_URL must name a loopback *_test database (the same explicit
 * DSN the neighbouring success-recovery gate requires). The journal uses
 * session-local TEMP tables; the sessions backend needs several connections,
 * so it gets a randomly named schema that is dropped when the proof ends.
 * The Box account itself is simulated at its exec endpoint; everything
 * between the request and that endpoint is product code.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const LIMIT_MS = 120_000;
const CANDIDATE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const PROXY = join(CANDIDATE, "packages/commercial/src/http/proxy");
const LIVE_ONLY = "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION";

type Body = Record<string, unknown>;
type Expected = { id: string; boxName: string; clientName: string; input: Record<string, unknown> };
type Api = {
  gate: (body: Body, toolBridgeEnabled: boolean) => string | null;
  classify: (body: Body) => { classification: string; rejectCode: string | null; toolIds?: readonly string[];
    answeredToolIds?: readonly string[] };
  match: (body: Body, expected: readonly Expected[]) => ReadonlyArray<Matched>;
  fitForCli: (results: readonly Matched[]) => Promise<readonly Matched[]>;
  echo: (expected: readonly EchoExpected[]) => { accept: (raw: unknown) => void;
    verifyDeferred: () => Promise<void>; assertComplete: () => void };
  decoder: (model: string, tools: unknown[]) => Decoder;
  pollSpool: (input: { exec: unknown; access: unknown; startOffset: number; deadlineMs: number;
    pollIntervalMs: number; retryDelaysMs?: readonly number[] }) => AsyncGenerator<{ text: string; endOffset: number }>;
  spoolAccess: () => unknown;
  transportError: (code: string) => Error;
  firstRound: (input: unknown, deps: unknown) => Promise<{ kind: string }>;
  textFetch: (deps: unknown) => { fetch: (input: unknown) => Promise<Response> };
  registry: () => { open: (input: { uid: bigint; sessionId: string; accountId: bigint }) => unknown;
    confirmRemoteStopped: (lease: unknown) => void };
  waitCapacity: (attempt: () => unknown, signal: AbortSignal, options?: { maxWaitMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number }) => Promise<unknown>;
  capacityWaitMs: number;
  published: (exec: unknown, cwd: string, expected: readonly EchoExpected[]) => Promise<readonly EchoExpected[]>;
  boxEndpoint: string;
  asset: (name: string) => Buffer;
  continuation: (input: unknown, deps: unknown) => Promise<{ kind: string }>;
  catalogHash: (tools: unknown[], mode?: "natural" | "opaque") => string;
  observeText: (input: unknown) => Promise<{ proof: { reason: string }; message: unknown }>;
  journal: (db: Db) => Journal;
  stopCoordinator: (journal: Journal, target: unknown) => { requestStop: (identity: unknown) => Promise<string> };
  billingContext: (input: { sessionId: string; turnKey: string; dispatchId?: string; attemptNo?: number }) => unknown;
  /** egress/main.ts, where production chooses the options the proofs pass by hand. */
  egressSource: string;
  proxySource: string;
  toolFetch: (deps: unknown) => { fetch: (input: unknown) => Promise<Response> };
  findReplay: (input: unknown, deps: unknown) => Promise<ReplayLookup>;
  observeUnknown: (input: unknown, deps: unknown) => Promise<string>;
  waitReplay: (first: ReplayLookup, lookup: () => Promise<ReplayLookup>, opts: { budgetMs: number; intervalMs: number;
    signal: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }) => Promise<ReplayLookup>;
  cleanupWorker: (deps: unknown) => { reconcileStoppedFailures: (limit?: number) => Promise<{ recovered: number; pending: number }> };
  replayStore: (root: string) => { write: unknown; read: unknown };
  stopHandler: (deps: unknown) => RouteHandler;
  idleProofHandler: (deps: unknown) => RouteHandler;
  jsonError: (res: unknown, status: number, code: string, message: string, requestId: string) => void;
  /** The box-resident Claude CLI lane (box-claude-*): the gateway runner and its stdio bridge. */
  boxCli: { runner: (opts: unknown) => { submit: (text: string, requestId: undefined, authority: unknown,
      turnKey: string) => Promise<void>; updateTurnLease: (lease: string) => Promise<void> };
    bridge: (opts: unknown) => Promise<number> };
  ccbAdapter: (runner: unknown) => { submitTurn: (input: unknown) => { submitted: Promise<void>;
    summary: Promise<{ isError?: boolean } | undefined>; end: () => void }; shutdown: () => Promise<void> };
  fetchIdleProof: (input: { sessionId: string; turnKey: string }) => Promise<{ status: string }>;
  /** SessionManager's idle step, which only works from durable state and needs no instance. */
  finishIdle: (session: unknown, source: { sessionId: string; turnKey: string }, dir: string) => Promise<void>;
  idle: IdleFiles;
  boxNative: { model: string; owner: string };
  /** One SessionManager of the gateway; its durable idle state lives under `home`. */
  sessionManager: { submit: (...args: unknown[]) => Promise<unknown> };
  home: string;
  sessionsBackend: (pool: unknown) => SessionsBackend;
  tape: { version: number; partBytes: number };
  /** The Box CLI version gate and the exec transport its read goes through. */
  cliVersion: { gate: () => { read: (target: unknown) => Promise<string> };
    launchResolver: (resolve: (args: { requiredAccountId?: bigint; box: unknown }) => Promise<unknown>,
      gate: unknown) => (args: { requiredAccountId?: bigint; box: unknown }) => Promise<{ cliVersion?: string }>;
    transport: (fetchImpl: (url: string, init: { body: Uint8Array }) => Promise<Response>) => unknown };
  /** The requests a guarded launch sends to a Box before Claude starts, and the staged-file plan. */
  prelaunch: { bootstrap: (identity: PrelaunchIdentity) => BoxRequest;
    parse: (stdout: string, identity: PrelaunchIdentity) => PrelaunchReceipt;
    init: (receipt: PrelaunchReceipt, project: string) => BoxRequest;
    guard: (request: BoxRequest, receipt: PrelaunchReceipt) => BoxRequest;
    cleanup: (receipt: PrelaunchReceipt) => BoxRequest };
  stageFiles: (input: { cwd: string; project: string; files: Array<{ path: string; raw: Buffer; hash: string }> }) =>
    { requests: BoxRequest[]; cleanup: BoxRequest };
  /** The Sand lifecycle coordinator, its provisioning client and the state file it keeps. */
  sand: { coordinator: (deps: unknown) => { tick: () => Promise<void>; stop: () => Promise<void> };
    client: (opts: unknown) => unknown;
    state: (dir: string) => { operations: Record<string, { phase: string; errorCode?: string; hostPid?: number }>;
      accounts: Record<string, { phase: string; errorCode?: string }> } };
};
type BoxRequest = { command: string; args: string[]; cwd: string; environment: Record<string, string> };
type PrelaunchIdentity = { runNonce: string; leaseEpoch: string; controlId: string; accountId: string };
type PrelaunchReceipt = PrelaunchIdentity & { identityHash: string };
type SessionsBackend = { admitUserTurn: (input: unknown) => Promise<{ kind: string }>;
  stageLosslessTurnTapePart: (userId: string, request: unknown, bytes: Buffer) => Promise<unknown>;
  finalizeLosslessTurnTape: (userId: string, request: unknown) => Promise<{ applied: string }>;
  getClientSession: (sessionId: string, userId: string) => Promise<{ messages: Array<{ id?: string }> } | null> };
type RouteHandler = (req: unknown, res: unknown, ctx: { hostUuid: string; boundIp: string }) => Promise<void>;
type IdleOp = { runnerKilledAt?: number; disposition?: string; abandonReason?: string; [key: string]: unknown };
type IdleFiles = { IDLE_STOPPED_GRACE_MS: number;
  readIdleCandidate: (dir: string, key: string) => unknown; readPendingIdle: (dir: string, key: string) => unknown;
  readIdleOp: (dir: string, key: string, revision: string) => IdleOp | undefined;
  writeIdleOp: (dir: string, op: IdleOp) => void; writeIdleCandidate: (dir: string, candidate: unknown) => void;
  startIdleOp: (input: unknown) => { op: IdleOp }; writeIdleNative: (dir: string, native: unknown) => void;
  idleHistoryStillBlocked: (input: { candidate: unknown; pending: unknown; recovered: unknown }) => boolean };
type ReplayLookup = { kind: string; response?: Response;
  identity?: { state?: string; rootLaunchPermit?: boolean; invocationMode?: string } };
type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };
type Journal = { readIdleProof: (input: { uid: bigint; containerId: bigint; sessionId: string; turnKey: string }) =>
  Promise<{ status: string; requestIds?: string[] }>; [method: string]: (...args: never[]) => Promise<unknown> };
type Decoder = {
  push: (chunk: string) => { sse: string; candidate: { toolUses: ReadonlyArray<{ id: string; clientName: string }>;
    inputTokens: number; outputTokens: number; cacheReadTokens: number } | null; finalCandidate: unknown };
  completedMessage: () => { id?: unknown; content?: unknown };
  commitHandoff: (proof: { durableRevision: string; journaledToolUseIds: string[];
    verifiedPendingToolUseIds: string[] }) => string;
};
type Matched = { modelToolUseId: string; isError: boolean; contentHash: string;
  content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }> };
type EchoExpected = { modelToolUseId: string; isError: boolean; contentHash: string; content?: unknown };

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}
function parseArgs(argv: string[]): string {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== "--expect-sha" || !/^[0-9a-f]{40}$/.test(args[1] ?? "")) {
    fail("usage: check-v5-box-incident-proofs.ts --expect-sha <40-hex>");
  }
  return args[1]!;
}
async function load(): Promise<Api> {
  const gate = await import(pathToFileURL(join(PROXY, "boxRequestGate.ts")).href);
  const prepared = await import(pathToFileURL(join(PROXY, "boxPreparedContinuation.ts")).href);
  const matcher = await import(pathToFileURL(join(PROXY, "boxToolResultMatcher.ts")).href);
  const images = await import(pathToFileURL(join(PROXY, "boxToolResultImages.ts")).href);
  const echo = await import(pathToFileURL(join(PROXY, "boxToolResultEcho.ts")).href);
  const handoff = await import(pathToFileURL(join(PROXY, "boxCliToolHandoff.ts")).href);
  const catalog = await import(pathToFileURL(join(PROXY, "boxToolCatalog.ts")).href);
  const poller = await import(pathToFileURL(join(PROXY, "boxSpoolPoller.ts")).href);
  const access = await import(pathToFileURL(join(PROXY, "boxDetachedRunAccess.ts")).href);
  const transport = await import(pathToFileURL(join(PROXY, "boxExecTransport.ts")).href);
  const firstRound = await import(pathToFileURL(join(PROXY, "boxToolFirstRound.ts")).href);
  const textFetch = await import(pathToFileURL(join(PROXY, "boxTextFetch.ts")).href);
  const registry = await import(pathToFileURL(join(PROXY, "boxInvocationRegistry.ts")).href);
  const capacity = await import(pathToFileURL(join(PROXY, "boxCapacityWait.ts")).href);
  const published = await import(pathToFileURL(join(PROXY, "boxPublishedResults.ts")).href);
  const upstream = await import(pathToFileURL(join(PROXY, "upstream.ts")).href);
  const continuation = await import(pathToFileURL(join(PROXY, "boxToolContinuation.ts")).href);
  const observe = await import(pathToFileURL(join(PROXY, "boxDetachedTextObserve.ts")).href);
  const journal = await import(pathToFileURL(join(PROXY, "boxDurableJournal.ts")).href);
  const stop = await import(pathToFileURL(join(PROXY, "boxUserStopCoordinator.ts")).href);
  const billing = await import(pathToFileURL(join(PROXY, "boxBillingContext.ts")).href);
  const toolFetch = await import(pathToFileURL(join(PROXY, "boxToolFetch.ts")).href);
  const replay = await import(pathToFileURL(join(PROXY, "boxReplayCompleted.ts")).href);
  const observer = await import(pathToFileURL(join(PROXY, "boxToolUnknownObserver.ts")).href);
  const replayWait = await import(pathToFileURL(join(PROXY, "boxReplayWait.ts")).href);
  const worker = await import(pathToFileURL(join(PROXY, "boxRemoteCleanupWorker.ts")).href);
  const replaySetup = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/egress/boxReplaySetup.ts")).href);
  const stopRoute = await import(pathToFileURL(join(PROXY, "boxUserStopHandler.ts")).href);
  const idleRoute = await import(pathToFileURL(join(PROXY, "boxIdleProofHandler.ts")).href);
  const shared = await import(pathToFileURL(join(PROXY, "shared.ts")).href);
  const cliVersion = await import(pathToFileURL(join(PROXY, "boxCliVersion.ts")).href);
  const prelaunch = await import(pathToFileURL(join(PROXY, "boxPrelaunchControl.ts")).href);
  const stageFiles = await import(pathToFileURL(join(PROXY, "boxStageFiles.ts")).href);
  const POOL = join(CANDIDATE, "packages/commercial/src/account-pool");
  const sandLifecycle = await import(pathToFileURL(join(POOL, "cursorSandLifecycle.ts")).href);
  const sandProvision = await import(pathToFileURL(join(POOL, "cursorSandProvision.ts")).href);
  const sandState = await import(pathToFileURL(join(POOL, "cursorSandState.ts")).href);
  const GATEWAY = join(CANDIDATE, "packages/gateway/src");
  const ccb = await import(pathToFileURL(join(GATEWAY, "engine/ccbAdapter.ts")).href);
  const boxRunner = await import(pathToFileURL(join(GATEWAY, "subprocessRunner.ts")).href);
  const boxBridge = await import(pathToFileURL(join(GATEWAY, "engine/cursorBoxCcBridge.ts")).href);
  const idleClient = await import(pathToFileURL(join(GATEWAY, "engine/boxIdleProofClient.ts")).href);
  const idleFiles = await import(pathToFileURL(join(GATEWAY, "boxIdleCompact.ts")).href);
  const sessions = await import(pathToFileURL(join(GATEWAY, "sessionManager.ts")).href);
  const authority = await import(pathToFileURL(join(CANDIDATE, "packages/protocol/src/modelAuthority.ts")).href);
  // A commercial container wires its lossless history sink at startup and submit() refuses to run
  // without one. No turn runs in these proofs, so the sink is never used; using it fails the gate.
  const sink = await import(pathToFileURL(join(GATEWAY, "v3MasterSink.ts")).href);
  sink.setV3MasterSinkSingleton({ persistOrQueue: async () => fail("GATEWAY_SINK_USED"),
    attemptOnce: async () => fail("GATEWAY_SINK_USED") });
  const protocol = await import(pathToFileURL(join(CANDIDATE, "packages/protocol/src/index.ts")).href);
  const sessionsBackend = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/db/pgSessionsBackend.ts")).href);
  return { gate: gate.validateBoxRequest, classify: prepared.classifyBoxContinuation,
    match: matcher.matchBoxToolResults, fitForCli: images.normalizeBoxResultImagesForCli,
    echo: (expected) => new echo.BoxToolResultEcho(expected),
    decoder: (model, tools) => new handoff.BoxCliToolHandoffDecoder(model,
      catalog.compileBoxToolCatalog(tools, "natural")),
    pollSpool: poller.pollBoxSpoolLines,
    spoolAccess: () => access.makeBoxDetachedRunAccess({ runNonce: "a".repeat(24), detachedRunnerHash: "b".repeat(64) }),
    transportError: (code) => new transport.BoxExecTransportError(code, false),
    firstRound: firstRound.runBoxToolFirstRound,
    textFetch: (deps) => new textFetch.BoxTextFetch(deps),
    registry: () => new registry.BoxInvocationRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 }),
    waitCapacity: capacity.waitingForBoxCapacity, capacityWaitMs: capacity.BOX_CAPACITY_WAIT_MS,
    published: published.withPublishedBoxResults, boxEndpoint: upstream.BOX_INTERNAL_ENDPOINT,
    asset: (name) => readFileSync(join(CANDIDATE, "scripts/ocv5-289", name)),
    continuation: continuation.runBoxToolContinuation,
    catalogHash: (tools, mode = "natural") => catalog.compileBoxToolCatalog(tools, mode).bindingSha256,
    observeText: observe.observeBoxDetachedText,
    // The journal opens its own transactions; every "connection" is the one pinned session.
    journal: (db) => new journal.BoxDurableJournal({ query: db.query.bind(db),
      connect: async () => ({ query: db.query.bind(db), release: () => {} }) }),
    stopCoordinator: (boxJournal, target) => new stop.BoxUserStopCoordinator({ journal: boxJournal,
      resolver: { resolve: async () => target }, proofWaitMs: 0 }),
    billingContext: billing.serializeBoxBillingContext,
    egressSource: readFileSync(join(CANDIDATE, "packages/commercial/src/egress/main.ts"), "utf8"),
    proxySource: readFileSync(join(PROXY, "index.ts"), "utf8"),
    toolFetch: (deps) => new toolFetch.BoxToolFetch(deps),
    findReplay: replay.findCompletedBoxReplay, observeUnknown: observer.observeBoxToolUnknown,
    waitReplay: replayWait.waitForBoxReplay,
    cleanupWorker: (deps) => new worker.BoxRemoteCleanupWorker(deps),
    replayStore: (root) => ({ write: replaySetup.createBoxReplayWriter(true, root),
      read: replaySetup.createBoxReplayReader(root) }),
    stopHandler: stopRoute.makeBoxUserStopHandler, idleProofHandler: idleRoute.makeBoxIdleProofHandler,
    jsonError: shared.sendJsonError,
    boxCli: { runner: (opts) => new boxRunner.SubprocessRunner(opts), bridge: boxBridge.runBoxCcBridge },
    ccbAdapter: (runner) => new ccb.CcbAdapter({}, runner),
    fetchIdleProof: idleClient.fetchBoxIdleProof,
    finishIdle: (session, source, dir) => sessions.SessionManager.prototype.finishIdleUnderLock.call({}, session, source, dir),
    idle: idleFiles,
    boxNative: { model: authority.BOX_NATIVE_CONTEXT_MODEL, owner: authority.BOX_NATIVE_CONTEXT_OWNER },
    sessionManager: new sessions.SessionManager({ version: 1, gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
      auth: { mode: "subscription", claudeCodePath: "" }, sessions: { dbPath: "" },
      defaults: { permissionMode: "bypassPermissions", model: authority.BOX_NATIVE_CONTEXT_MODEL } }),
    home: process.env.OPENCLAUDE_HOME!,
    sessionsBackend: (pool) => sessionsBackend.createPgSessionsBackend(pool, { expectedGeneration: 1 }),
    tape: { version: protocol.LOSSLESS_TURN_TAPE_VERSION, partBytes: protocol.LOSSLESS_TURN_TAPE_PART_BYTES },
    cliVersion: { gate: () => new cliVersion.BoxCliVersionGate(), launchResolver: cliVersion.gateBoxLaunchResolver,
      transport: (fetchImpl) => new transport.BoxExecTransport({ execUrl: "https://box.invalid/agent.v1.ControlService/Exec",
        execToken: "exec", networkToken: "network" }, fetchImpl, async () => {}) },
    prelaunch: { bootstrap: prelaunch.makeBoxPrelaunchBootstrap, parse: prelaunch.parseBoxPrelaunchBootstrap,
      init: prelaunch.makeBoxPrelaunchInit, guard: prelaunch.guardBoxPrivateStage,
      cleanup: prelaunch.makeBoxPrelaunchCleanup },
    stageFiles: stageFiles.makeBoxStageFiles,
    sand: { coordinator: (deps) => new sandLifecycle.CursorSandLifecycleCoordinator(deps),
      client: (opts) => new sandProvision.CursorSandProvisionClient(opts), state: sandState.readSandLifecycleState } };
}

const MODEL = "box-api-claude-opus-5-5";
const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({ name, description: name, input_schema: { type: "object" } });
const skillUse = (id: string, name: string) => ({ type: "tool_use", id, name: "Skill", input: { skill: name } });
const launch = (id: string, name: string) => ({ type: "tool_result", tool_use_id: id,
  content: `Launching skill: ${name}` });
const skillBody = (name: string) =>
  `Base directory for this skill: /home/agent/.openclaude/skills/${name}\n\n# Title\nSteps.`;
const skillExpected = (id: string, name: string): Expected =>
  ({ id, boxName: "mcp__ocbridge__Skill", clientName: "Skill", input: { skill: name } });
const foldedContent = (name: string, ...bodies: string[]) =>
  [text(`Launching skill: ${name}`), ...bodies.map(text)];

/** The turn continues: admitted, classified as a continuation of exactly these
 * tool calls, and every Skill result carries its own body. */
function continues(api: Api, code: string, body: Body, ids: readonly string[],
  skills: ReadonlyArray<{ id: string; name: string }>, others: readonly Expected[] = []): void {
  const snapshot = JSON.stringify(body);
  const rejected = api.gate(body, true);
  if (rejected !== null) fail(`${code}_GATE_${rejected}`);
  const classified = api.classify(body);
  if (classified.classification !== "continuation_candidate") fail(`${code}_CLASS_${classified.rejectCode}`);
  if (!isDeepStrictEqual([...(classified.toolIds ?? [])], [...ids])) fail(`${code}_TOOL_IDS`);
  const matched = api.match(body, [...others, ...skills.map((skill) => skillExpected(skill.id, skill.name))]);
  for (const skill of skills) {
    const row = matched.find((item) => item.modelToolUseId === skill.id);
    if (!row || !isDeepStrictEqual(row.content, foldedContent(skill.name, skillBody(skill.name)))) {
      fail(`${code}_BODY_${skill.id}`);
    }
  }
  if (JSON.stringify(body) !== snapshot) fail(`${code}_RAW_MUTATED`);
}
/** Text that cannot be attributed to a launch is a new user request. */
function staysRejected(api: Api, code: string, body: Body, reject = LIVE_ONLY): void {
  if (api.gate(body, true) !== reject) fail(`${code}_ADMITTED`);
  if (api.classify(body).classification === "continuation_candidate") fail(`${code}_CLASSIFIED`);
}

// INC-20261001-BOX-SKILL-CONTINUATION, live #aacd65f7: the model called Skill,
// Claude Code answered "Launching skill: X" and appended the skill body as
// user text after the tool_result. The continuation was refused with 409.
function proveSkillContinuation(api: Api): string {
  const name = "deploy";
  const request = (...rest: unknown[]): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Skill"), tool("Read")],
    messages: [{ role: "user", content: "deploy it" },
      { role: "assistant", content: [skillUse("toolu_skill", name)] }, ...rest] });
  const one = [{ id: "toolu_skill", name }];
  continues(api, "SKILL_SAME_MESSAGE", request({ role: "user",
    content: [launch("toolu_skill", name), text(skillBody(name))] }), ["toolu_skill"], one);
  continues(api, "SKILL_CACHED_BODY", request({ role: "user", content: [launch("toolu_skill", name),
    { ...text(skillBody(name)), cache_control: { type: "ephemeral" } }] }), ["toolu_skill"], one);
  continues(api, "SKILL_NEXT_MESSAGE", request({ role: "user", content: [launch("toolu_skill", name)] },
    { role: "user", content: skillBody(name) }), ["toolu_skill"], one);
  staysRejected(api, "SKILL_FAILED_LAUNCH", request({ role: "user",
    content: [{ ...launch("toolu_skill", name), content: "Skill failed" }, text(skillBody(name))] }));
  staysRejected(api, "SKILL_FOREIGN_RESULT", request({ role: "user",
    content: [launch("toolu_other", name), text(skillBody(name))] }));
  return "[ocv5-303-skill-continuation] PASS — a Skill launch with its injected body continues";
}

// INC-20261003-BOX-PARALLEL-SKILL-BODIES, live #72191544: two Skills in one
// step, one injected body per launch. Both bodies stayed in the tool-result
// message and the continuation was refused with 409.
function proveParallelSkillBodies(api: Api): string {
  const a = "v5-session-goal-start-triage";
  const b = "openclaude-instance-topology";
  const request = (...rest: unknown[]): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Skill"), tool("Read")],
    messages: [{ role: "user", content: "deploy it" },
      { role: "assistant", content: [skillUse("toolu_a", a), skillUse("toolu_b", b)] }, ...rest] });
  const both = [{ id: "toolu_a", name: a }, { id: "toolu_b", name: b }];
  const ids = ["toolu_a", "toolu_b"];
  continues(api, "PARALLEL_INTERLEAVED", request({ role: "user", content: [launch("toolu_a", a),
    text(skillBody(a)), launch("toolu_b", b), text(skillBody(b))] }), ids, both);
  continues(api, "PARALLEL_RESULTS_FIRST", request({ role: "user", content: [launch("toolu_a", a),
    launch("toolu_b", b), text(skillBody(b)),
    { ...text(skillBody(a)), cache_control: { type: "ephemeral" } }] }), ids, both);
  continues(api, "PARALLEL_NEXT_MESSAGES", request(
    { role: "user", content: [launch("toolu_a", a), launch("toolu_b", b)] },
    { role: "user", content: skillBody(a) }, { role: "user", content: [text(skillBody(b))] }), ids, both);
  staysRejected(api, "PARALLEL_UNKNOWN_HEADER", request({ role: "user",
    content: [launch("toolu_a", a), launch("toolu_b", b), text(skillBody("other"))] }));
  staysRejected(api, "PARALLEL_TWO_BODIES_ONE_LAUNCH", request({ role: "user",
    content: [launch("toolu_a", a), launch("toolu_b", b), text(skillBody(a)), text(skillBody(a))] }));
  // A following message without a skill header is the user's own new request.
  const userTurn = request({ role: "user", content: [launch("toolu_a", a), launch("toolu_b", b)] },
    { role: "user", content: "and then deploy" });
  if (api.classify(userTurn).classification !== "fresh") fail("PARALLEL_REAL_USER_TURN_NOT_FRESH");
  return "[ocv5-314-parallel-skill-bodies] PASS — each parallel Skill body joins its own launch";
}

// INC-20261003-BOX-SKILL-BUDGET-TAIL, live #b6df9aee, Claude Code 2.1.280:
// after a Bash + Skill step CCB appends the <total_tokens> budget as a system
// message. The tail was stripped before the Skill body was folded, so every
// such step was refused with 409.
function proveSkillBudgetTail(api: Api): string {
  const a = "v5-session-goal-start-triage";
  const b = "openclaude-instance-topology";
  const budget = "<total_tokens>14999985 tokens left</total_tokens>";
  const bash = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "echo a" } });
  const step = (bashId: string, skillId: string, name: string) => [
    { role: "assistant", content: [bash(bashId), skillUse(skillId, name)] },
    { role: "user", content: [{ tool_use_id: bashId, type: "tool_result", content: "a", is_error: false },
      launch(skillId, name), text(skillBody(name))] }];
  const request = (...rest: unknown[]): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Skill"), tool("Read"), tool("Bash")],
    messages: [{ role: "user", content: [text("<system-reminder>\nctx\n</system-reminder>"), text("run")] },
      { role: "system", content: [text("# Environment\nYou have been invoked in the following environment:")] },
      ...rest] });
  const tail = { role: "system", content: [{ ...text(budget), cache_control: { type: "ephemeral" } }] };
  const bashExpected = (id: string): Expected =>
    ({ id, boxName: "mcp__ocbridge__Bash", clientName: "Bash", input: { command: "echo a" } });
  continues(api, "BUDGET_FIRST_STEP", request(...step("toolu_a1", "toolu_a2", a), tail),
    ["toolu_a1", "toolu_a2"], [{ id: "toolu_a2", name: a }], [bashExpected("toolu_a1")]);
  continues(api, "BUDGET_SECOND_STEP", request(...step("toolu_a1", "toolu_a2", a),
    { role: "system", content: budget }, ...step("toolu_b1", "toolu_b2", b), tail),
    ["toolu_b1", "toolu_b2"], [{ id: "toolu_b2", name: b }], [bashExpected("toolu_b1")]);
  const other = request(...step("toolu_a1", "toolu_a2", a),
    { role: "system", content: [text("do something else")] });
  if (api.gate(other, true) === null) fail("BUDGET_FOREIGN_SYSTEM_TAIL_ADMITTED");
  if (api.classify(other).classification === "continuation_candidate") fail("BUDGET_FOREIGN_SYSTEM_TAIL_CLASSIFIED");
  return "[ocv5-317-skill-budget-tail] PASS — a Skill step followed by the CCB budget tail continues";
}

/** A real solid-colour RGB PNG of the given pixel size. */
function png(width: number, height: number): string {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3, 0x60);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

// INC-20261001-BOX-CCB-IMAGE-META-CONTINUATION, live #f82c733f: the client Read
// a 1290x2796 phone screenshot; Claude Code showed it at 923x2000 and appended
// "[Image: original …, displayed at …]" after the tool_result, with its
// prompt-cache breakpoint on that caption. Only two observed sizes were
// accepted, so the continuation was refused with 409.
function proveImageCaption(api: Api): string {
  const shown = png(923, 2000);
  const caption = (ow: number, oh: number, dw: number, dh: number, scale = (ow / dw).toFixed(2)) =>
    `[Image: original ${ow}x${oh}, displayed at ${dw}x${dh}. Multiply coordinates by ${scale} to map to original image.]`;
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: shown } };
  const request = (tail: unknown[], next: unknown[] = []): Body => ({ model: MODEL, stream: true, max_tokens: 64,
    tools: [tool("Read")],
    messages: [{ role: "user", content: "看图" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "Read",
        input: { file_path: "/a.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img", content: [image] }, ...tail] },
      ...next] });
  const cached = (value: string, cache: unknown = { type: "ephemeral" }) => ({ ...text(value), cache_control: cache });
  const continuesWith = (code: string, body: Body, expected: string) => {
    const rejected = api.gate(body, true);
    if (rejected !== null) fail(`${code}_GATE_${rejected}`);
    const classified = api.classify(body);
    if (classified.classification !== "continuation_candidate") fail(`${code}_CLASS_${classified.rejectCode}`);
    const [row] = api.match(body, [{ id: "toolu_img", boxName: "mcp__ocbridge__Read", clientName: "Read",
      input: { file_path: "/a.png" } }]);
    if (!row || !isDeepStrictEqual(row.content,
      [{ type: "image", data: shown, mimeType: "image/png" }, text(expected)])) fail(`${code}_RESULT`);
  };
  // the live image with Claude Code's cache breakpoint on the caption
  continuesWith("IMAGE_LIVE_CACHED", request([cached(caption(1290, 2796, 923, 2000))]), caption(1290, 2796, 923, 2000));
  continuesWith("IMAGE_LIVE_CACHED_1H", request([cached(caption(1290, 2796, 923, 2000), { type: "ephemeral", ttl: "1h" })]),
    caption(1290, 2796, 923, 2000));
  // another phone size: proven by this image's own pixel size, not a size list
  continuesWith("IMAGE_OTHER_SIZE", request([text(caption(1179, 2556, 923, 2000))]), caption(1179, 2556, 923, 2000));
  // CCB sends the caption as its own cached user message
  continuesWith("IMAGE_SEPARATE_MESSAGE", request([], [{ role: "user",
    content: [cached(caption(1179, 2556, 923, 2000))] }]), caption(1179, 2556, 923, 2000));
  for (const [code, tail] of [
    ["IMAGE_WRONG_DISPLAY", [text(caption(1179, 2556, 900, 2000))]],
    ["IMAGE_FORGED_SCALE", [text(caption(1179, 2556, 923, 2000, "1.30"))]],
    ["IMAGE_WRONG_ASPECT", [text(caption(3000, 2000, 923, 2000))]],
    ["IMAGE_NOT_DOWNSCALED", [text(caption(923, 2000, 923, 2000))]],
  ] as const) staysRejected(api, code, request([...tail]));
  // text the user typed after the caption never joins the result: since OCV5-322 it is a new prompt over the
  // answered exchange (proveAnsweredExchangePrompt), and a CLI still waiting for the result keeps the 409
  const extra = request([text(caption(1179, 2556, 923, 2000)), text("also delete my files")]);
  const typed = api.classify(extra);
  if (api.gate(extra, true) !== null || typed.classification !== "fresh"
    || !isDeepStrictEqual(typed.answeredToolIds, ["toolu_img"])) fail(`IMAGE_EXTRA_REQUEST_${typed.classification}`);
  staysRejected(api, "IMAGE_ODD_CACHE_KEY", request([cached(caption(1179, 2556, 923, 2000), { type: "persistent" })]),
    "BOX_CACHE_ANNOTATION_INVALID");
  return "[ocv5-302-image-caption] PASS — a resized Read image continues when the caption is proven by the image";
}

function pngSize(data: string): [number, number] {
  const bytes = Buffer.from(data, "base64");
  if (bytes.readUInt32BE(0) !== 0x89504e47) fail("NOT_A_PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
async function echoCode(run: () => Promise<void> | void): Promise<string> {
  try { await run(); } catch (error) { return String((error as { code?: unknown }).code ?? "THREW"); }
  return "ACCEPTED";
}

// INC-20261001-BOX-CLI-RESULT-REWRITE-ECHO, live #f82c733f: the client Read a
// 1290x2796 screenshot, the Box CLI resized it to 923x2000 before echoing it,
// the strict echo bind saw other bytes and the turn failed. OpenClaude now
// publishes the image already fitted to the CLI limits, so the CLI passes it
// through and the echo is byte-exact; the CLI's two text rewrites are accepted
// only when they are exact rewrites of what was published.
async function proveResultRewriteEcho(api: Api): Promise<string> {
  const original = png(1290, 2796);
  const body: Body = { model: MODEL, stream: true, max_tokens: 64, tools: [tool("Read")],
    messages: [{ role: "user", content: "看图" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_shot", name: "Read",
        input: { file_path: "/shot.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_shot", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: original } }] }] }] };
  if (api.gate(body, true) !== null) fail("REWRITE_GATE");
  const matched = api.match(body, [{ id: "toolu_shot", boxName: "mcp__ocbridge__Read", clientName: "Read",
    input: { file_path: "/shot.png" } }]);
  const [published] = await api.fitForCli(matched);
  const image = published?.content.find((block) => block.type === "image");
  if (!published || !image?.data) fail("REWRITE_NO_IMAGE");
  if (!isDeepStrictEqual(pngSize(image.data), [923, 2000])) fail("REWRITE_IMAGE_NOT_FITTED");
  if (published.contentHash === matched[0]!.contentHash) fail("REWRITE_HASH_NOT_RECOMPUTED");
  const again = await api.fitForCli([published]);
  if (again[0] !== published) fail("REWRITE_NOT_IDEMPOTENT");
  const echoed = (data: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_shot", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] } });
  const bind = (expected: EchoExpected, raw: unknown) => echoCode(async () => {
    const echo = api.echo([expected]);
    echo.accept(raw);
    await echo.verifyDeferred();
    echo.assertComplete();
  });
  // the CLI passes the fitted bytes through: the bind holds and the turn goes on
  if (await bind(published, echoed(image.data)) !== "ACCEPTED") fail("REWRITE_EXACT_ECHO_REFUSED");
  // any other picture of the same size is still refused
  if (await bind(published, echoed(png(923, 2000))) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") fail("REWRITE_OTHER_BYTES");
  const hash = (content: unknown) => createHash("sha256").update(JSON.stringify({ content, isError: false })).digest("hex");
  const textResult = (content: Array<{ type: "text"; text: string }>): EchoExpected =>
    ({ modelToolUseId: "toolu_shot", isError: false, contentHash: hash(content), content });
  const textEcho = (content: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_shot", content }] } });
  const marker = "(mcp__ocbridge__Bash completed with no output)";
  if (await bind(textResult([{ type: "text", text: "" }]), textEcho(marker)) !== "ACCEPTED") fail("REWRITE_EMPTY_MARKER");
  if (await bind(textResult([{ type: "text", text: "data" }]), textEcho(marker)) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") {
    fail("REWRITE_MARKER_FOR_REAL_OUTPUT");
  }
  const skipped = api.echo([textResult([{ type: "text", text: "" }])]);
  skipped.accept(textEcho(marker));
  if (await echoCode(() => skipped.assertComplete()) !== "BOX_TOOL_ECHO_UNVERIFIED") fail("REWRITE_UNVERIFIED_COMPLETES");
  // text over Claude Code's 50k-char limit is echoed as its <persisted-output> preview of what was published
  const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const big = [{ type: "text" as const, text: lines }];
  const size = (chars: number) => chars < 1024 * 1024 ? `${(chars / 1024).toFixed(1).replace(/\.0$/, "")}KB`
    : `${(chars / 1024 / 1024).toFixed(1).replace(/\.0$/, "")}MB`;
  const persisted = (content: Array<{ type: "text"; text: string }>, file = "toolu_shot.json") => {
    const source = JSON.stringify(content, null, 2);
    const newline = source.slice(0, 2000).lastIndexOf("\n");
    return `<persisted-output>\nOutput too large (${size(source.length)}). Full output saved to: `
      + `/home/box/.claude/projects/p/tool-results/${file}\n\nPreview (first 2KB):\n`
      + `${source.slice(0, newline > 1000 ? newline : 2000)}\n...\n</persisted-output>`;
  };
  if (await bind(textResult(big), textEcho(persisted(big))) !== "ACCEPTED") fail("REWRITE_PERSISTED_REFUSED");
  for (const [code, expected, raw] of [
    ["REWRITE_PERSISTED_ALTERED", textResult(big), persisted(big).replace("line 3 ", "line 9 ")],
    ["REWRITE_PERSISTED_OTHER_FILE", textResult(big), persisted(big, "other.json")],
    ["REWRITE_PERSISTED_OTHER_SIZE", textResult([{ type: "text", text: lines + "!".repeat(200_000) }]), persisted(big)],
    ["REWRITE_PERSISTED_BELOW_LIMIT", textResult([{ type: "text", text: lines.slice(0, 40_000) }]),
      persisted([{ type: "text", text: lines.slice(0, 40_000) }])],
  ] as const) {
    if (await bind(expected, textEcho(raw)) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") fail(code);
  }
  // recovery holds only the journaled hash; it reads the published result file back in chunks and
  // accepts it only when it hashes to the journal, after which the same rewrite is recognized
  const journaled: EchoExpected = { modelToolUseId: "toolu_shot", isError: false, contentHash: hash(big) };
  if (await bind(journaled, textEcho(persisted(big))) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH") fail("REWRITE_HASH_ONLY_RELAXED");
  const runDir = `/tmp/ocv5-289-run-${"a".repeat(24)}`;
  const resultFile = (content: unknown, id = "toolu_shot") => {
    const file = Buffer.from(JSON.stringify({ version: 1, modelToolUseId: id, mcpRequestId: 3, content, isError: false }));
    const reads: number[] = [];
    return { reads, run: async (request: { args: string[] }) => {
      const offset = Number(request.args.at(-1));
      reads.push(offset);
      return { stdout: JSON.stringify({ size: file.length, b64: file.subarray(offset, offset + 700_000).toString("base64") }) };
    } };
  };
  const onBox = resultFile(big);
  const [recovered] = await api.published(onBox, runDir, [journaled]);
  if (!recovered || !isDeepStrictEqual(recovered.content, big)) fail("REWRITE_RECOVERY_NO_CONTENT");
  if (onBox.reads.length < 3 || onBox.reads[1] !== 700_000) fail("REWRITE_RECOVERY_NOT_CHUNKED");
  if (await bind(recovered, textEcho(persisted(big))) !== "ACCEPTED") fail("REWRITE_RECOVERY_REFUSED");
  for (const [code, exec, cwd] of [
    ["REWRITE_RECOVERY_ALTERED_FILE", resultFile([{ type: "text", text: `${lines}!` }]), runDir],
    ["REWRITE_RECOVERY_FOREIGN_FILE", resultFile(big, "toolu_other"), runDir],
    ["REWRITE_RECOVERY_FOREIGN_DIR", resultFile(big), "/tmp/elsewhere"],
  ] as const) {
    const [same] = await api.published(exec, cwd, [journaled]);
    if (same !== journaled) fail(code);
  }
  // the turn the user was in: the fitted image is published, the CLI echoes it unchanged and the model answers
  const turn = boxContinuation(api, [published], [echoed(image.data), ...FINAL_ANSWER]);
  const answered = await turn.round().catch((error: unknown) =>
    fail(`REWRITE_TURN_FAILED_${String((error as { code?: unknown }).code)}`));
  if (!endedWithAnswer(answered, turn)) fail("REWRITE_TURN_NO_ANSWER");
  const longTurn = boxContinuation(api, [textResult(big)], [textEcho(persisted(big)), ...FINAL_ANSWER]);
  if (!endedWithAnswer(await must("REWRITE_PERSISTED_TURN", longTurn.round()), longTurn)) fail("REWRITE_PERSISTED_TURN_NO_ANSWER");
  // an echo of other bytes still ends the round unknown rather than billing an unbound result
  const foreign = boxContinuation(api, [published], [echoed(png(923, 2000)), ...FINAL_ANSWER]);
  if (await codeOf(foreign.round) !== "BOX_TOOL_ECHO_CONTENT_MISMATCH"
    || !foreign.sequence.includes("unknown:continuation_echo_rejected") || foreign.sequence.includes("complete")) {
    fail("REWRITE_FOREIGN_ECHO_SETTLED");
  }
  // the launched CLI is told not to truncate MCP results: the client already bounded them
  const launched = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]));
  await must("REWRITE_LAUNCH", launched.round());
  if (!(Number(launched.launchEnvironment.MAX_MCP_OUTPUT_TOKENS) >= 4_000_000)) fail("REWRITE_CLI_TRUNCATION_ON");
  return "[ocv5-302-result-rewrite-echo] PASS — a phone screenshot is published fitted and its echo binds byte for byte";
}

// The CLI stream of a Box tool round, as the detached runner spools it.
const CLI_MODEL = "claude-opus-5-5";
const BOX_BASH = "mcp__ocbridge__Bash";
const CLI_TOOLS = [{ name: "Bash", description: "Synthetic local tool",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }];
const event = (value: unknown) => ({ type: "stream_event", event: value });
const cliInit = { type: "system", subtype: "init", tools: [BOX_BASH], mcp_servers: [{}] };
const start = (id: string, input = 10, read = 0) => event({ type: "message_start", message: {
  id, model: CLI_MODEL, role: "assistant", content: [],
  usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: read } } });
const say = (id: string, index: number, value: string) => [
  event({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
  { type: "assistant", message: { id, model: CLI_MODEL, role: "assistant", content: [text(value)] } },
  event({ type: "content_block_stop", index })];
const call = (id: string, index: number, toolId: string, name: string, prior: unknown[] = []) => [
  event({ type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name, input: {} } }),
  event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
  { type: "assistant", message: { id, model: CLI_MODEL, role: "assistant",
    content: [...prior, { type: "tool_use", id: toolId, name, input: { value: "x" } }] } },
  event({ type: "content_block_stop", index })];
const stop = (reason: string, output: number, input = 10) => [
  event({ type: "message_delta", delta: { stop_reason: reason }, usage: { input_tokens: input, output_tokens: output } }),
  event({ type: "message_stop" })];
const cliError = (id: string, content = "<tool_use_error>Error: No such tool available: Bash</tool_use_error>") =>
  ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content }] },
    parent_tool_use_id: null, session_id: "12345678-1234-4123-8123-123456789abc" });
/** The model calls bare Bash, which this Box invocation does not expose. */
const REJECTED_CALL = [start("msg_a"), ...say("msg_a", 0, "Let me run it."),
  ...call("msg_a", 1, "toolu_bad_1", "Bash", [text("Let me run it.")]), ...stop("tool_use", 7)];
/** Its retry through the bridge, in a new message of the same run. */
const BRIDGE_CALL = [start("msg_b", 30, 5), ...say("msg_b", 0, "Using the bridge."),
  ...call("msg_b", 1, "toolu_good_1", BOX_BASH, [text("Using the bridge.")]), ...stop("tool_use", 9, 30)];
const spoolOf = (records: unknown[]) => Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));

type ExecRequest = { args: string[]; environment?: Record<string, string> };
type ExecReply = { stdout: string; stderrBytes: number; exitCode: 0 };
const reply = (stdout = ""): ExecReply => ({ stdout, stderrBytes: 0, exitCode: 0 });
const isRunner = (args: string[]) => args[0] === "-I" && args[1] === "-c"
  && args[2]?.includes("sys.argv=[p,*argv]") === true
  && args[3]?.startsWith("/tmp/ocv5-289-v2-detached-runner-") === true;
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The awaited product call must succeed; its failure is named after the proof step. */
const must = <T>(label: string, pending: Promise<T>): Promise<T> => pending.catch((error: unknown) =>
  fail(`${label}_${String((error as { code?: unknown }).code ?? (error as Error).message ?? "THREW")}`));
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).message ?? "THREW");
  }
  return "RETURNED";
}

/** A Box account as the product reaches it: the exec endpoint that stages the
 * assets, launches one detached CLI and serves its stdout spool, pending tool
 * files and terminal proof, plus the durable journal. `faults` let one call
 * fail the way the incident recorded it. The round under test is the
 * product's own runBoxToolFirstRound. */
function boxHost(api: Api, initialSpool: Buffer, faults: {
  admit?: (call: number) => Promise<void> | void;
  spoolRead?: (call: number) => void;
  pendingRead?: (call: number) => void;
  proofRead?: (call: number) => void;
  capacityWaitMs?: number;
  signal?: AbortSignal;
  /** The durable journal on real Postgres instead of the in-memory one. */
  real?: { journal: unknown; uid: bigint; requestId: string; sessionId: string; turnKey: string;
    messages?: unknown[]; resumeToolResults?: boolean; proofReason?: string;
    nextSpool?: Buffer; stopIgnored?: boolean; dispatchId?: string;
    /** The Box account this session is pinned to (its capacity is per account). */
    accountId?: bigint;
    stopRejectedRun?: (identity: unknown) => Promise<string> } } = {}) {
  const sequence: string[] = [];
  const emitted: string[] = [];
  const count = { admit: 0, launch: 0, spoolRead: 0, pendingRead: 0, proofRead: 0, stop: 0 };
  let nonce = "", epoch = "", controlHash = "", disposed = false;
  const epochs = new Map<string, string>();
  const stopped = new Set<string>();
  let launchEnvironment: Record<string, string> = {};
  let launchArgs: string[] = [];
  let spool = initialSpool;
  const staged: unknown[] = [];
  /** Files the product wrote into the private run directory, by path. */
  const files = new Map<string, Buffer>();
  const parts = new Map<string, Buffer>();
  const run = async (request: ExecRequest): Promise<ExecReply> => {
    const args = request.args;
    if (args[2]?.includes("identity['identityHash']")) {
      const manifest = { accountId: args[5], controlDev: "2049", controlId: args[6], controlIno: "9001",
        leaseEpoch: args[4], lockDev: "2049", lockIno: "9002", runNonce: args[3], version: 2 };
      controlHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      nonce = args[3]!;
      epoch = args[4]!;
      epochs.set(nonce, epoch);
      return reply(`${JSON.stringify({ ...manifest, identityHash: controlHash })}\n`);
    }
    if (args[2]?.includes("def clean_dir(parent_path,name,allowed):")) return reply(`cleaned:${controlHash}\n`);
    if (isRunner(args) && args[5] !== "--read") {
      sequence.push("launch");
      // a later invocation on this account is another CLI with its own spool
      if (++count.launch > 1 && faults.real?.nextSpool) spool = faults.real.nextSpool;
      launchEnvironment = { ...request.environment };
      launchArgs = [...args];
      return reply("launched\n");
    }
    if (isRunner(args)) {
      faults.spoolRead?.(++count.spoolRead);
      const offset = Number(args[7]);
      const bytes = spool.subarray(offset);
      return reply(JSON.stringify({ data: bytes.toString("base64"), offset: offset + bytes.length }));
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
      faults.pendingRead?.(++count.pendingRead);
      return reply(JSON.stringify({ version: 1, modelToolUseId: args[4], mcpRequestId: 7,
        name: "Bash", arguments: { value: "x" } }));
    }
    if (args.length === 5 && /^[a-f0-9]{24}$/.test(args[3] ?? "") && /^[a-f0-9]{32}$/.test(args[4] ?? "")) {
      // the keeper is asked to stop: a CLI still waiting for tool results stops, one that already exited does not
      count.stop++;
      if (faults.real?.proofReason === undefined && !faults.real?.stopIgnored) stopped.add(args[3]!);
      return reply("stop-requested\n");
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("terminal.json")) {
      faults.proofRead?.(++count.proofRead);
      const asked = args[3]?.slice(-24) ?? nonce;
      return reply(`${JSON.stringify({ runNonce: asked, leaseEpoch: epochs.get(asked) ?? epoch, keeperPid: 101,
        cliPid: 102, reason: stopped.has(asked) ? "keeper_stopped" : faults.real?.proofReason ?? "worker_complete",
        revision: 1 })}\n`);
    }
    if (args[2]?.includes("print('staged:'+str(len(steps)))")) {
      const steps = JSON.parse(Buffer.from(args[3]!, "base64").toString("utf8")) as unknown[];
      staged.push(...steps);
      return reply(`staged:${steps.length}\n`);
    }
    if (args[0] === "-I" && args[1] === "-c" && args[3]?.startsWith("/tmp/ocv5-289-")
      && !args[3].startsWith("/tmp/ocv5-289-run-")) {
      sequence.push("stage");
      return reply(`${Array.from({ length: (args.length - 3) / 4 }, (_, i) => args[5 + i * 4]).join(",")}\n`);
    }
    // a private-stage write, plain or wrapped by the prelaunch guard: [cwd, project, path, ...]
    const guarded = args.length > 6 && /^[a-f0-9]{24}$/.test(args[3] ?? "") && /^[a-f0-9]{64}$/.test(args[4] ?? "");
    const code = guarded ? Buffer.from(args[5]!, "base64").toString("utf8") : args[2] ?? "";
    const rest = guarded ? args.slice(6) : args.slice(3);
    if (code.includes("print(start+size)")) {
      const [path, offset] = [rest[2]!, Number(rest[3])];
      const raw = Buffer.concat(rest.slice(5).map((part) => Buffer.from(part, "base64")));
      parts.set(path, Buffer.concat([(parts.get(path) ?? Buffer.alloc(0)).subarray(0, offset), raw]));
      return reply(`${offset + raw.length}\n`);
    }
    if (code.includes("print(want)")) {
      const [path, want] = [rest[2]!, rest[4]!];
      const raw = parts.get(path) ?? Buffer.alloc(0);
      if (createHash("sha256").update(raw).digest("hex") !== want) fail("BOX_HOST_STAGED_FILE_HASH");
      files.set(path, raw);
      return reply(`${want}\n`);
    }
    if (code.includes("'tool-catalog.json'") && code.includes('"size":st.st_size')) {
      const file = files.get(`/tmp/ocv5-289-run-${args[3]}/tool-catalog.json`);
      if (!file) throw api.transportError("BOX_EXEC_REMOTE_EXIT");
      const offset = Number(args[4]);
      return reply(JSON.stringify({ data: file.subarray(offset, offset + Number(args[5])).toString("base64"),
        dev: "2049", ino: "9003", offset, size: file.length }));
    }
    staged.push(request);
    return reply("ok\n");
  };
  const journal = faults.real?.journal ?? {
    admit: async (identity: { runNonce: string; leaseEpoch: string }) => {
      await faults.admit?.(++count.admit);
      sequence.push("admit");
      nonce = identity.runNonce;
      epoch = identity.leaseEpoch;
    },
    recordPrelaunchControl: async () => {},
    armGuardedLaunch: async () => {},
    markGuardedPrestartStopped: async () => { sequence.push("prestart-stopped"); },
    markPrestartStopped: async () => { sequence.push("prestart-stopped"); },
    markUnknown: async (arg: { phase: string }) => { sequence.push(`unknown:${arg.phase}`); },
    recordToolHandoff: async (arg: { candidate: { toolUses: ReadonlyArray<{ id: string }> };
      verifiedPendingToolUseIds: string[] }) => {
      sequence.push("handoff");
      return { durableRevision: "rev-1", journaledToolUseIds: arg.candidate.toolUses.map((use) => use.id),
        verifiedPendingToolUseIds: arg.verifiedPendingToolUseIds };
    },
    complete: async () => { sequence.push("complete"); },
  };
  const real = faults.real;
  const sessionId = real?.sessionId ?? "session-proof";
  const body = { model: CLI_MODEL, max_tokens: 128, stream: true,
    messages: real?.messages ?? [{ role: "user", content: "run it" }], tools: CLI_TOOLS, tool_choice: { type: "auto" },
    metadata: { user_id: JSON.stringify({ session_id: sessionId, oc_turn_key: real?.turnKey ?? "a".repeat(64) }) } };
  const target = { accountId: real?.accountId ?? 20n, dispose: async () => { disposed = true; }, exec: { run } };
  const call = { uid: real?.uid ?? 3n, sessionId, requestId: real?.requestId ?? "box-proof",
    canonicalModel: MODEL, canonicalBody: { ...body, model: MODEL }, upstreamModel: CLI_MODEL,
    url: api.boxEndpoint, init: { method: "POST", body: JSON.stringify(body),
      ...(faults.signal ? { signal: faults.signal } : {}) } };
  const deps = { supervisorAsset: api.asset("box_supervisor.py"), keeperAsset: api.asset("box_keeper.py"),
    virtualMcpAsset: api.asset("box_virtual_mcp.py"), detachedRunnerAsset: api.asset("box_detached_runner.py"),
    toolAliasMode: "natural", journal, maxOutputTokensForModel: () => 128_000,
    ...(faults.capacityWaitMs === undefined ? {} : { capacityWaitMs: faults.capacityWaitMs }),
    ...(real?.stopRejectedRun ? { stopRejectedRun: real.stopRejectedRun } : {}),
    resolveTarget: async () => target,
    onUnknown: async () => {}, retainUnknownTarget: () => { sequence.push("retain-unknown"); },
    retainCleanupTarget: () => {} };
  const round = () => api.firstRound({ ...call, emit: (sse: string) => { emitted.push(sse); },
    ...(real?.resumeToolResults ? { resumeToolResults: true } : {}) }, deps);
  return { round, call, deps, target, sequence, count, staged, files, sse: () => emitted.join(""),
    /** The CLI goes on and appends to its stdout spool. */
    write: (records: unknown[]) => { spool = Buffer.concat([spool, spoolOf(records)]); },
    get spoolLength() { return spool.length; },
    get disposed() { return disposed; }, get launchEnvironment() { return launchEnvironment; },
    get launchArgs() { return launchArgs; }, get runNonce() { return nonce; }, get leaseEpoch() { return epoch; } };
}

/** Round N of a Box turn: the client's tool results were published to the
 * waiting CLI, which echoes them and lets the model go on. `results` is what
 * OpenClaude published; `records` is what the CLI then wrote to its spool. The
 * round under test is the product's own runBoxToolContinuation. */
function boxContinuation(api: Api, results: readonly EchoExpected[], records: unknown[], faults: {
  spoolRead?: (call: number) => void;
  pendingRead?: (call: number) => void;
  proofRead?: (call: number) => void } = {}, catalogHash = api.catalogHash(CLI_TOOLS)) {
  const sequence: string[] = [];
  const emitted: string[] = [];
  const count = { spoolRead: 0, pendingRead: 0, proofRead: 0 };
  const offsets: number[] = [];
  const claim = { ownerRequestId: "box-owner", accountId: 20n, runNonce: "a".repeat(24),
    leaseEpoch: "b".repeat(32), spoolOffset: 1234, roundNo: 2, detachedRunnerHash: "b".repeat(64),
    catalogHash, durableRevision: "rev-1", results,
    toolUses: results.map((result) => ({ id: result.modelToolUseId, boxName: BOX_BASH, clientName: "Bash",
      inputHash: "f".repeat(64) })) };
  const bytes = spoolOf(records);
  const run = async (request: ExecRequest): Promise<ExecReply> => {
    const args = request.args;
    if (args[5] === "--read") {
      const offset = Number(args[7]);
      offsets.push(offset);
      faults.spoolRead?.(++count.spoolRead);
      const part = bytes.subarray(Math.max(0, offset - claim.spoolOffset), Math.max(0, offset - claim.spoolOffset) + 65536);
      return reply(JSON.stringify({ offset: offset + part.length, data: part.toString("base64") }));
    }
    if (args[2]?.includes("pending.")) {
      faults.pendingRead?.(++count.pendingRead);
      return reply(JSON.stringify({ version: 1, modelToolUseId: args[4], mcpRequestId: 7,
        name: catalogHash === api.catalogHash(CLI_TOOLS) ? "Bash" : "t0", arguments: { value: "x" } }));
    }
    faults.proofRead?.(++count.proofRead);
    return reply(`${JSON.stringify({ runNonce: claim.runNonce, leaseEpoch: claim.leaseEpoch, keeperPid: 101,
      cliPid: 102, reason: "worker_complete", revision: 1 })}\n`);
  };
  const journal = {
    recordToolHandoff: async (arg: { candidate: { toolUses: ReadonlyArray<{ id: string }> };
      verifiedPendingToolUseIds: string[] }) => {
      sequence.push("handoff");
      return { durableRevision: "rev-2", journaledToolUseIds: arg.candidate.toolUses.map((use) => use.id),
        verifiedPendingToolUseIds: arg.verifiedPendingToolUseIds };
    },
    completeToolChain: async () => { sequence.push("complete"); },
    markUnknown: async (arg: { phase: string }) => { sequence.push(`unknown:${arg.phase}`); } };
  const round = () => api.continuation({ published: { claim, target: { accountId: 20n, exec: { run } },
    access: api.spoolAccess() }, uid: 3n, requestId: "box-next",
  canonicalBody: { model: MODEL, max_tokens: 128, stream: true, tools: CLI_TOOLS,
    messages: [{ role: "user", content: "run it" }] }, upstreamModel: CLI_MODEL,
  emit: (sse: string) => { emitted.push(sse); } },
  { journal, retainUnknownTarget: () => { sequence.push("retain-unknown"); }, onUnknown: async () => {} });
  return { round, sequence, count, offsets, sse: () => emitted.join("") };
}
/** The model's closing answer and the CLI's result record. */
const FINAL_ANSWER = [start("msg_final"), ...say("msg_final", 0, "done"), ...stop("end_turn", 4),
  { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 4 } }];
const echoOf = (id: string, content: unknown) => ({ type: "user", message: { role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }] } });
const publishedText = (id: string, value: string): EchoExpected => ({ modelToolUseId: id, isError: false,
  content: [text(value)], contentHash: createHash("sha256")
    .update(JSON.stringify({ content: [text(value)], isError: false })).digest("hex") });
/** The user-visible end of a continued turn: the answer arrived, usage was
 * settled once and nothing was left unknown. */
function endedWithAnswer(result: { kind: string }, round: ReturnType<typeof boxContinuation>): boolean {
  return result.kind === "final" && round.sse().includes("done")
    && (round.sse().match(/event: message_stop/g) ?? []).length === 1
    && isDeepStrictEqual(round.sequence, ["complete"]);
}

const TEXT_MODEL = "claude-opus-5";
const TEXT_USAGE = { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 20 };
/** A no-tool Box text round as the CLI spools it. */
const TEXT_ANSWER = [{ type: "system", subtype: "init", tools: [], mcp_servers: [] },
  event({ type: "message_start", message: { id: "msg_text", model: TEXT_MODEL, role: "assistant", content: [],
    usage: { ...TEXT_USAGE, output_tokens: 0 } } }),
  event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
  { type: "assistant", message: { id: "msg_text", model: TEXT_MODEL, role: "assistant", content: [text("answer")] } },
  event({ type: "content_block_stop", index: 1 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: TEXT_USAGE }),
  event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false, usage: TEXT_USAGE }];
/** The text lane's Box account: BoxTextFetch with the product's own in-memory
 * lease registry, one CLI that answers "answer", its proof and cleanup. */
function boxTextHost(api: Api, capacityWaitMs: number) {
  const model = TEXT_MODEL;
  const body = { model, max_tokens: 256, stream: true,
    metadata: { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64), session_id: "session-proof" }) },
    messages: [{ role: "user", content: "synthetic text only" }] };
  const output = spoolOf(TEXT_ANSWER).toString("utf8");
  const calls: string[] = [];
  let proofDir = "", leaseEpoch = "";
  const run = async (request: ExecRequest, options: { onStdout?: (chunk: string) => void }): Promise<ExecReply> => {
    const args = request.args;
    if (args[0] === "-I" && args[1]?.startsWith("/tmp/ocv5-289-v2-keeper-")) {
      calls.push("model");
      proofDir = args[args.indexOf("--proof-dir") + 1] ?? "";
      leaseEpoch = args[args.indexOf("--lease-epoch") + 1] ?? "";
      options.onStdout?.(output);
      return reply(output);
    }
    if (args[3]?.startsWith("/tmp/ocv5-289-v2-supervisor-") || args[3]?.startsWith("/tmp/ocv5-289-v2-keeper-")) {
      return reply(Array.from({ length: (args.length - 3) / 4 }, (_, i) => args[5 + i * 4]).join(","));
    }
    if (args[2]?.includes("print('staged:'+str(len(steps)))")) {
      const steps = JSON.parse(Buffer.from(args[3]!, "base64").toString("utf8")) as unknown[];
      return reply(`staged:${steps.length}\n`);
    }
    if (args[2]?.includes("print('clean')")) return reply("clean\n");
    if (args[2]?.includes("terminal.json")) {
      return reply(`${JSON.stringify({ runNonce: proofDir.slice(-24), leaseEpoch, keeperPid: 101, cliPid: 102,
        reason: "worker_complete", revision: 1 })}\n`);
    }
    return reply();
  };
  const registry = api.registry();
  const journal = { admit: async () => { calls.push("admit"); }, markRunning: async () => {},
    markPrestartStopped: async () => { calls.push("prestart-stopped"); }, markUnknown: async () => {},
    complete: async () => {} };
  const service = api.textFetch({ supervisorAsset: api.asset("box_supervisor.py"),
    keeperAsset: api.asset("box_keeper.py"), registry, journal,
    maxOutputTokensForModel: () => 128_000, resolveTarget: async () => ({ accountId: 20n, exec: { run } }),
    onUnknown: async () => {}, budgetMs: 600_000, capacityWaitMs });
  const fetch = (signal?: AbortSignal) => service.fetch({ uid: 3n, sessionId: "session-proof",
    requestId: "req-proof", canonicalModel: model, canonicalBody: body, upstreamModel: model,
    url: api.boxEndpoint, init: { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) } });
  return { fetch, registry, journal, calls };
}

// INC-20261001-BOX-CLI-REJECTED-CALL-TURN-FAIL: the model called a tool name
// this Box invocation does not expose (bare Bash). Claude Code answered with
// its own <tool_use_error> and the model retried in a new message of the same
// run; the decoder rejected the first call with BOX_TOOL_ID_OR_NAME_INVALID
// and the turn failed. The client must see one continuing message and receive
// only the retried call, billed for both model calls.
// The same incident: a message sent right after the previous turn of the
// session, which was still settling, was refused with BOX_CAPACITY_HELD
// ("消息未开始处理"). Admission waits up to 45s for the slot; a caller that left
// never gets a late admission, and one that commits anyway is prestart-closed.
async function proveCliRejectedCall(api: Api): Promise<string> {
  const model = CLI_MODEL;
  const boxName = BOX_BASH;
  const tools = CLI_TOOLS;
  const init = cliInit;
  const rejected = REJECTED_CALL;
  const retry = BRIDGE_CALL;
  const feed = (records: unknown[]) => {
    const decoder = api.decoder(model, tools);
    let sse = "";
    let last: ReturnType<Decoder["push"]> | null = null;
    for (const record of records) {
      last = decoder.push(`${JSON.stringify(record)}\n`);
      sse += last.sse;
      if (last.candidate || last.finalCandidate) break;
    }
    return { decoder, sse, last };
  };
  const failsWith = (records: unknown[]): string => {
    try { feed(records); } catch (error) { return String((error as { code?: unknown }).code ?? "THREW"); }
    return "ACCEPTED";
  };
  let run: ReturnType<typeof feed>;
  try { run = feed([init, ...rejected, cliError("toolu_bad_1"), ...retry]); } catch (error) {
    fail(`REJECTED_CALL_TURN_FAILED_${String((error as { code?: unknown }).code ?? "THREW")}`);
  }
  const candidate = run.last?.candidate;
  if (!candidate) fail("REJECTED_CALL_NO_HANDOFF");
  if ((run.sse.match(/event: message_start/g) ?? []).length !== 1) fail("REJECTED_CALL_SECOND_MESSAGE");
  if (run.sse.includes("toolu_bad_1")) fail("REJECTED_CALL_VISIBLE");
  if (!run.sse.includes("Let me run it.") || !run.sse.includes("Using the bridge.")) fail("REJECTED_CALL_TEXT_LOST");
  if (!isDeepStrictEqual(candidate.toolUses.map((use) => [use.id, use.clientName]), [["toolu_good_1", "Bash"]])) {
    fail("REJECTED_CALL_WRONG_HANDOFF");
  }
  if (!isDeepStrictEqual([candidate.inputTokens, candidate.outputTokens, candidate.cacheReadTokens], [40, 16, 5])) {
    fail("REJECTED_CALL_USAGE");
  }
  if (!isDeepStrictEqual(run.decoder.completedMessage().content, [text("Let me run it."), text("Using the bridge."),
    { type: "tool_use", id: "toolu_good_1", name: "Bash", input: { value: "x" } }])) fail("REJECTED_CALL_CONTENT");
  const held = run.decoder.commitHandoff({ durableRevision: "rev-1", journaledToolUseIds: ["toolu_good_1"],
    verifiedPendingToolUseIds: ["toolu_good_1"] });
  if (!held.includes('"name":"Bash"') || (held.match(/event: message_stop/g) ?? []).length !== 1) fail("REJECTED_CALL_HELD");
  // only Claude Code's own unknown-tool answer for that call is merged
  if (failsWith([init, ...rejected, ...retry]) !== "BOX_TOOL_CLI_ERROR_MISSING") fail("REJECTED_CALL_NO_CLI_ERROR");
  if (failsWith([init, ...rejected, cliError("toolu_bad_1", "ran fine")]) !== "BOX_TOOL_CLI_ERROR_INVALID") {
    fail("REJECTED_CALL_FREE_TEXT");
  }
  if (failsWith([init, ...rejected, cliError("toolu_other")]) !== "BOX_TOOL_CLI_ERROR_INVALID") fail("REJECTED_CALL_OTHER_ID");
  if (failsWith([init, start("msg_a"), ...call("msg_a", 0, "toolu_good", boxName),
    ...call("msg_a", 1, "toolu_bad_1", "Bash", [{ type: "tool_use", id: "toolu_good", name: boxName,
      input: { value: "x" } }])]) !== "BOX_TOOL_ID_OR_NAME_INVALID") fail("REJECTED_CALL_MIXED_MESSAGE");
  // the whole first round: launched once, the retry is handed off, nothing is left unknown
  const whole = boxHost(api, spoolOf([init, ...rejected, cliError("toolu_bad_1"), ...retry]));
  const handoff = await whole.round().catch((error: unknown) =>
    fail(`REJECTED_CALL_ROUND_FAILED_${String((error as { code?: unknown }).code ?? (error as Error).message)}`));
  if (handoff.kind !== "tool_handoff" || whole.count.launch !== 1) fail("REJECTED_CALL_ROUND_NO_HANDOFF");
  if ((whole.sse().match(/event: message_start/g) ?? []).length !== 1 || whole.sse().includes("toolu_bad_1")
    || !whole.sse().includes('"name":"Bash"') || !whole.sse().trimEnd().endsWith("}")
    || (whole.sse().match(/event: message_stop/g) ?? []).length !== 1) fail("REJECTED_CALL_ROUND_SSE");
  if (whole.sequence.some((step) => step.startsWith("unknown") || step === "retain-unknown")) {
    fail("REJECTED_CALL_ROUND_LEFT_UNKNOWN");
  }

  // the same collision in a later round of the turn
  const laterRound = boxContinuation(api, [publishedText("toolu_prior", "ok")],
    [echoOf("toolu_prior", "ok"), ...rejected, cliError("toolu_bad_1"), ...retry]);
  const laterHandoff = await laterRound.round().catch((error: unknown) =>
    fail(`REJECTED_CALL_CONTINUATION_FAILED_${String((error as { code?: unknown }).code)}`));
  if (laterHandoff.kind !== "tool_handoff" || !isDeepStrictEqual(laterRound.sequence, ["handoff"])
    || (laterRound.sse().match(/event: message_start/g) ?? []).length !== 1
    || laterRound.sse().includes("toolu_bad_1")) fail("REJECTED_CALL_CONTINUATION");

  // the next message while the previous turn still holds the slot
  const slotHeld = () => new Error("BOX_CAPACITY_HELD");
  const settling = boxHost(api, spoolOf([init, ...retry]), { admit: (n) => { if (n < 3) throw slotHeld(); } });
  const started = await settling.round().catch((error: unknown) =>
    fail(`CAPACITY_NOT_WAITED_${String((error as Error).message)}`));
  if (started.kind !== "tool_handoff" || settling.count.admit !== 3 || settling.count.launch !== 1) {
    fail("CAPACITY_WAIT_DID_NOT_START_TURN");
  }
  // bounded: a slot that stays held ends in the original rejection, nothing staged or launched
  const stuck = boxHost(api, spoolOf([init, ...retry]), { admit: () => { throw slotHeld(); }, capacityWaitMs: 900 });
  if (await codeOf(stuck.round) !== "BOX_CAPACITY_HELD") fail("CAPACITY_WAIT_REJECTION_CHANGED");
  if (stuck.count.admit < 2 || stuck.count.launch !== 0 || stuck.sequence.includes("stage") || !stuck.disposed) {
    fail("CAPACITY_WAIT_UNBOUNDED_OR_STAGED");
  }
  // the production window is 45s, with backoff, and returns the first rejection unchanged
  if (api.capacityWaitMs !== 45_000) fail("CAPACITY_WINDOW_NOT_45S");
  let clock = 0, attempts = 0;
  const first = slotHeld();
  const lasted = await api.waitCapacity(() => { attempts++; throw attempts === 1 ? first : slotHeld(); },
    new AbortController().signal, { now: () => clock, sleep: async (ms: number) => { clock += ms; } })
    .catch((error: unknown) => error);
  if (!(lasted instanceof Error) || lasted.message !== "BOX_CAPACITY_HELD") fail("CAPACITY_WINDOW_RESULT");
  if (clock > 45_000 || clock < 40_000 || attempts < 20) fail(`CAPACITY_WINDOW_${clock}_${attempts}`);
  let other = 0;
  await api.waitCapacity(() => { other++; throw new Error("BOX_JOURNAL_BASIS_INVALID"); },
    new AbortController().signal, { now: () => 0, sleep: async () => {} }).catch(() => {});
  if (other !== 1) fail("CAPACITY_WAIT_RETRIED_OTHER_FAILURE");
  // the caller leaves during the wait: no further admission attempt, no launch
  const leaving = new AbortController();
  const left = boxHost(api, spoolOf([init, ...retry]), { admit: () => { throw slotHeld(); }, signal: leaving.signal });
  const gone = codeOf(left.round);
  await tick(100);
  const attemptsAtAbort = left.count.admit;
  leaving.abort();
  if (await gone !== "BOX_TOOL_ABORTED" && await gone !== "BOX_CAPACITY_HELD") fail(`CAPACITY_ABORT_${await gone}`);
  await tick(700);
  if (left.count.admit !== attemptsAtAbort || left.count.launch !== 0) fail("CAPACITY_ADMITTED_AFTER_ABORT");
  // an admission still in flight when the caller left commits late: prestart-closed, never launched
  const lateAbort = new AbortController();
  let commit: () => void = () => {};
  const late = boxHost(api, spoolOf([init, ...retry]), { signal: lateAbort.signal,
    admit: () => new Promise<void>((resolve) => { commit = resolve; }) });
  const lateRound = codeOf(late.round);
  await tick(20);
  lateAbort.abort();
  if (await lateRound !== "BOX_TOOL_ABORTED") fail("CAPACITY_LATE_NOT_ABORTED");
  commit();
  await tick(20);
  if (!late.sequence.includes("prestart-stopped") || late.count.launch !== 0) fail("CAPACITY_LATE_ADMISSION_HELD");

  // the text lane: the session's previous turn frees its lease while the new message waits
  const waited = boxTextHost(api, 5_000);
  const previous = waited.registry.open({ uid: 3n, sessionId: "session-proof", accountId: 20n });
  setTimeout(() => waited.registry.confirmRemoteStopped(previous), 300);
  const response = await waited.fetch().catch((error: unknown) =>
    fail(`CAPACITY_TEXT_NOT_WAITED_${String((error as { code?: unknown }).code)}`));
  if (response.status !== 200 || !(await response.text()).includes("answer")) fail("CAPACITY_TEXT_NO_ANSWER");
  const busy = boxTextHost(api, 0);
  const holder = busy.registry.open({ uid: 3n, sessionId: "session-proof", accountId: 20n });
  if (await codeOf(() => busy.fetch()) !== "BOX_CAPACITY_HELD" || busy.calls.length !== 0) fail("CAPACITY_TEXT_NO_WAIT_CHANGED");
  busy.registry.confirmRemoteStopped(holder);
  const textAbort = new AbortController();
  const lateText = boxTextHost(api, 5_000);
  let commitText: () => void = () => {};
  lateText.journal.admit = () => new Promise<void>((resolve) => { commitText = () => { lateText.calls.push("admit"); resolve(); }; });
  const lateFetch = codeOf(() => lateText.fetch(textAbort.signal));
  await tick(50);
  textAbort.abort();
  await lateFetch;
  commitText();
  await tick(50);
  if (!isDeepStrictEqual(lateText.calls, ["admit", "prestart-stopped"])) fail(`CAPACITY_TEXT_LATE_${lateText.calls.join(",")}`);
  return "[ocv5-301-cli-rejected-call] PASS — a call the CLI rejects is retried inside one visible turn";
}

// INC-20261001-BOX-SPOOL-READ-TRANSIENT, live #2ee979cd: about 25 tool rounds
// into a long turn one exec request that reads the Box stdout spool was dropped
// at the network layer, and that single failed read ended the whole turn. The
// poller must read the same offset again and deliver the line; errors that say
// something about the account or the run itself are never retried.
async function proveSpoolReadTransient(api: Api): Promise<string> {
  const line = Buffer.from('{"type":"assistant"}\n', "utf8");
  const chunk = (bytes: Buffer, offset: number) => ({ stdout: JSON.stringify({
    data: bytes.toString("base64"), offset: offset + bytes.length }), stderrBytes: 0, exitCode: 0 as const });
  const poll = (run: (offset: number, call: number) => unknown) => {
    const offsets: number[] = [];
    const exec = { run: async (request: { args: string[] }) => {
      const offset = Number(request.args[7]);
      offsets.push(offset);
      return run(offset, offsets.length);
    } };
    return { offsets, lines: api.pollSpool({ exec, access: api.spoolAccess(), startOffset: 7,
      deadlineMs: 5000, pollIntervalMs: 1, retryDelaysMs: [1, 1] }) };
  };
  const dropped = poll((offset, call) => {
    if (call === 1) throw api.transportError("BOX_EXEC_TRANSPORT_UNKNOWN");
    if (call === 2) throw api.transportError("BOX_EXEC_HTTP_502");
    return chunk(call === 3 ? line : Buffer.alloc(0), offset);
  });
  let first: IteratorResult<{ text: string; endOffset: number }>;
  try { first = await dropped.lines.next(); } catch (error) {
    fail(`SPOOL_DROPPED_READ_ENDED_TURN_${String((error as { code?: unknown }).code ?? "THREW")}`);
  }
  await dropped.lines.return(undefined);
  if (first.value?.text !== line.toString("utf8") || first.value.endOffset !== 7 + line.length) fail("SPOOL_LINE_LOST");
  if (!isDeepStrictEqual(dropped.offsets, [7, 7, 7])) fail("SPOOL_OFFSET_MOVED");
  const surfaces = async (code: string, expectCalls: number, label: string) => {
    const run = poll(() => { throw api.transportError(code); });
    const seen = await echoCode(async () => { await run.lines.next(); });
    if (seen !== code) fail(`${label}_${seen}`);
    if (run.offsets.length !== expectCalls) fail(`${label}_CALLS_${run.offsets.length}`);
  };
  await surfaces("BOX_EXEC_ACCOUNT_GUARD_FAILED", 1, "SPOOL_ACCOUNT_GUARD_RETRIED");
  await surfaces("BOX_EXEC_TRANSPORT_UNKNOWN", 3, "SPOOL_RETRY_UNBOUNDED");
  // the incident path: a later round of a long turn polls the spool and one read is dropped
  const drop = (call: number) => { if (call === 1) throw api.transportError("BOX_EXEC_TRANSPORT_UNKNOWN"); };
  const prior = publishedText("toolu_prior", "round 25");
  const closing = [echoOf("toolu_prior", "round 25"), ...FINAL_ANSWER];
  const cut = boxContinuation(api, [prior], closing, { spoolRead: drop });
  const ended = await cut.round().catch((error: unknown) =>
    fail(`SPOOL_CONTINUATION_ENDED_TURN_${String((error as { code?: unknown }).code)}`));
  if (!endedWithAnswer(ended, cut)) fail("SPOOL_CONTINUATION_NO_ANSWER");
  if (cut.offsets[0] !== 1234 || cut.offsets[1] !== 1234) fail("SPOOL_CONTINUATION_OFFSET_MOVED");
  // the terminal-proof read and the pending-call read of that round ride out the same drop
  const proofCut = boxContinuation(api, [prior], closing, { proofRead: drop });
  if (!endedWithAnswer(await must("SPOOL_PROOF_READ", proofCut.round()), proofCut) || proofCut.count.proofRead !== 2) fail("SPOOL_PROOF_READ");
  const pendingCut = boxContinuation(api, [prior], [echoOf("toolu_prior", "round 25"), ...BRIDGE_CALL],
    { pendingRead: drop });
  if ((await must("SPOOL_PENDING_READ", pendingCut.round())).kind !== "tool_handoff" || pendingCut.count.pendingRead !== 2
    || !isDeepStrictEqual(pendingCut.sequence, ["handoff"])) fail("SPOOL_PENDING_READ");
  // an error about the account itself still ends the round, unsettled
  const guarded = boxContinuation(api, [prior], closing,
    { spoolRead: () => { throw api.transportError("BOX_EXEC_ACCOUNT_GUARD_FAILED"); } });
  if (await codeOf(guarded.round) !== "BOX_EXEC_ACCOUNT_GUARD_FAILED" || guarded.count.spoolRead !== 1
    || guarded.sequence.includes("complete")) fail("SPOOL_ACCOUNT_GUARD_CONTINUED");
  // the first round of a turn reads through the same loops
  const firstHandoff = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]), { spoolRead: drop, pendingRead: drop });
  if ((await must("SPOOL_FIRST_ROUND_HANDOFF", firstHandoff.round())).kind !== "tool_handoff" || firstHandoff.count.pendingRead !== 2) fail("SPOOL_FIRST_ROUND_HANDOFF");
  const firstFinal = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { proofRead: drop });
  if ((await must("SPOOL_FIRST_ROUND_FINAL", firstFinal.round())).kind !== "final" || firstFinal.count.proofRead !== 2
    || !firstFinal.sequence.includes("complete")) fail("SPOOL_FIRST_ROUND_FINAL");
  // and so does a detached text round
  const textSpool = spoolOf(TEXT_ANSWER);
  let textProofReads = 0;
  const observed = await api.observeText({ access: api.spoolAccess(), expectedModel: TEXT_MODEL,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), deadlineMs: 30_000,
    target: { accountId: 20n, exec: { run: async (request: ExecRequest) => {
      if (request.args[5] === "--read") {
        const offset = Number(request.args[7]);
        return reply(JSON.stringify({ data: textSpool.subarray(offset).toString("base64"), offset: Math.max(offset, textSpool.length) }));
      }
      drop(++textProofReads);
      return reply(`${JSON.stringify({ runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), keeperPid: 101,
        cliPid: 102, reason: "worker_complete", revision: 1 })}\n`);
    } } } }).catch((error: unknown) => fail(`SPOOL_TEXT_ROUND_${String((error as { code?: unknown }).code)}`));
  if (observed.proof.reason !== "worker_complete" || textProofReads !== 2) fail("SPOOL_TEXT_PROOF_READ");
  return "[ocv5-306-spool-read-transient] PASS — a dropped spool read is read again at the same offset";
}

/** The explicit test DSN, checked before any product module is loaded: a
 * loopback *_test database that is not this process's DATABASE_URL. The
 * ambient database and Redis settings are then removed, so nothing imported
 * below can reach a persistent store by default. */
async function testDatabase(): Promise<unknown> {
  const gate = await import(pathToFileURL(join(CANDIDATE, "scripts/check-v5-box-success-recovery.ts")).href);
  const { config } = gate.parseTestDatabase(process.env.TEST_DATABASE_URL);
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE",
    "PGSERVICE", "PGOPTIONS", "REDIS_URL"]) delete process.env[key];
  return config;
}

/** One pinned session on the explicit loopback test database. The journal's
 * tables are session-local TEMP tables built from the product's own schema
 * mirror, so nothing here can reach or outlive into a persistent schema. */
async function withJournalDatabase<T>(config: unknown, run: (db: Db) => Promise<T>): Promise<T> {
  const pg = await import("pg");
  const pool = new (pg.default ?? pg).Pool({ ...(config as object), max: 1 });
  const client = await pool.connect();
  try {
    const ddl = readFileSync(join(CANDIDATE, "packages/commercial/src/billing/boxBillingRecoveryTempSchema.sql"), "utf8");
    for (const statement of ddl.split(/;\s*(?:\r?\n|$)/)) {
      const sql = statement.replace(/^\s*--.*$/gm, "").trim();
      if (sql) await client.query(sql);
    }
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,
      user_id bigint NOT NULL, status text NOT NULL)`);
    const shadow = await client.query(`SELECT n.nspname AS schema FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = ANY (ARRAY[to_regclass('request_finalize_journal'), to_regclass('usage_records'),
        to_regclass('users'), to_regclass('credit_ledger'), to_regclass('turn_dispatches')])`);
    if (shadow.rows.length !== 5 || shadow.rows.some((row: { schema: string }) => !/^pg_temp(?:_\d+)?$/.test(row.schema))) {
      fail("JOURNAL_TABLES_NOT_SESSION_LOCAL");
    }
    return await run(client as Db);
  } finally {
    client.release();
    await pool.end();
  }
}
const JOURNAL_PRICING = { v: 1, modelId: MODEL, displayName: "Opus", inputPerMtok: "1", outputPerMtok: "1",
  cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" };
/** What the proxy's precheck writes before a Box call is admitted. */
async function prechecked(api: Api, db: Db, row: { requestId: string; uid: bigint; containerId: bigint;
  sessionId: string; turnKey: string; dispatchId?: string }): Promise<void> {
  await db.query(`INSERT INTO request_finalize_journal
    (request_id,user_id,container_id,state,ctx,precheck_credits) VALUES ($1,$2,$3,'inflight',$4::jsonb,0)`,
  [row.requestId, row.uid.toString(), row.containerId.toString(), JSON.stringify({ model: MODEL,
    boxInvocationRecovery: "v1", billingPricing: JOURNAL_PRICING,
    boxBillingContext: api.billingContext({ sessionId: row.sessionId, turnKey: row.turnKey,
      ...(row.dispatchId ? { dispatchId: row.dispatchId, attemptNo: 1 } : {}) }) })]);
}
const journalRow = async (db: Db, requestId: string) => (await db.query(
  `SELECT state,failure_code,final_credits::text AS credits,ctx FROM request_finalize_journal WHERE request_id=$1`,
  [requestId])).rows[0] as { state: string; failure_code: string | null; credits: string | null;
    ctx: Record<string, unknown> } | undefined;
const money = async (db: Db, uid: bigint) => JSON.stringify((await db.query(`SELECT
  (SELECT COUNT(*)::text FROM usage_records) AS usage, (SELECT COUNT(*)::text FROM credit_ledger) AS ledger,
  (SELECT credits::text FROM users WHERE id=$1) AS wallet`, [uid.toString()])).rows);

// INC-20261001-BOX-REJECTED-STREAM-WEDGE: the model called a tool name outside
// this invocation's catalog, egress rejected the stream, the Box CLI answered
// the call itself and finished. The explicit stop then found nothing to stop
// (completed_unsettled) and the journal row stayed inflight/unknown for good:
// every next message of the session was refused ("消息未开始处理") and one
// account slot leaked. The row must settle unbilled from the keeper's proof,
// and production must expose the client's own tool names to the CLI.
async function proveRejectedStreamWedge(api: Api, db: Db): Promise<string> {
  const who = { uid: 900_000_300n, containerId: 300n, sessionId: "session-wedge" };
  const journal = api.journal(db);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'wedge@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const before = await money(db, who.uid);
  const turnKey = "3".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-wedge", turnKey });
  // one message with a valid call and a bare, unexposed name: rejected, never merged
  const mixed = [cliInit, start("msg_a"), ...call("msg_a", 0, "toolu_ok", BOX_BASH),
    ...call("msg_a", 1, "toolu_bad", "Bash", [{ type: "tool_use", id: "toolu_ok", name: BOX_BASH, input: { value: "x" } }])];
  let stops = 0;
  const host = boxHost(api, spoolOf(mixed), { real: { journal, ...who, requestId: "box-wedge", turnKey,
    // the CLI already exited by itself: its keeper proof says worker_complete
    proofReason: "worker_complete",
    stopRejectedRun: async (identity) => { stops++; return api.stopCoordinator(journal, host.target).requestStop(identity); } } });
  const rejected = await codeOf(host.round);
  if (rejected !== "BOX_TOOL_NAME_UNAVAILABLE") fail(`WEDGE_NOT_SETTLED_${rejected}`);
  if (stops !== 1 || host.count.launch !== 1) fail("WEDGE_STOP_OR_LAUNCH_COUNT");
  const row = await journalRow(db, "box-wedge");
  if (row?.state !== "aborted" || row.failure_code !== "STREAM_FAILED" || row.credits !== "0"
    || row.ctx.boxState !== "failed_stopped" || row.ctx.boxStopOutcome !== "rejected_stream"
    || (row.ctx.boxTerminalProof as { reason?: string } | undefined)?.reason !== "worker_complete") {
    fail(`WEDGE_ROW_${row?.state}_${String(row?.ctx.boxState)}_${String(row?.ctx.boxStopOutcome)}`);
  }
  if (await money(db, who.uid) !== before) fail("WEDGE_BILLED");
  const idle = await journal.readIdleProof({ ...who, turnKey });
  if (idle.status !== "failed" || !isDeepStrictEqual(idle.requestIds, ["box-wedge"])) fail(`WEDGE_IDLE_${idle.status}`);
  // the settled row keeps the keeper's worker_complete proof; cleanup must not take it for corrupt evidence
  const cleanup = await journal.listRemoteCleanupCandidates(10 as never) as Array<{ requestId: string }>;
  if (cleanup.some((item) => item.requestId === "box-wedge")
    || (await journalRow(db, "box-wedge"))?.ctx.boxRemoteCleanupQuarantine !== undefined) fail("WEDGE_QUARANTINED");
  // the user's next message in that session is admitted, launched and answered
  const nextKey = "4".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-wedge-next", turnKey: nextKey });
  const next = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, requestId: "box-wedge-next", turnKey: nextKey } });
  const answered = await must("WEDGE_NEXT_MESSAGE", next.round());
  if (answered.kind !== "final" || !next.sse().includes("done")) fail("WEDGE_NEXT_MESSAGE_NO_ANSWER");
  if ((await journalRow(db, "box-wedge-next"))?.ctx.boxState !== "terminal") fail("WEDGE_NEXT_MESSAGE_NOT_SETTLED");
  // the CLI is launched with the client's own names, so a native "Bash" resolves
  const allowed = next.launchArgs[next.launchArgs.indexOf("--allowedTools") + 1];
  if (allowed !== BOX_BASH) fail(`WEDGE_ALIAS_${allowed}`);
  if (!/new BoxToolFetch\(\{[^}]*?toolAliasMode: "natural"/s.test(api.egressSource)) fail("WEDGE_PRODUCTION_ALIAS_MODE");
  // a chain admitted before that release, on the opaque t0 binding, still continues
  const opaqueUse = [start("msg_o"), ...call("msg_o", 0, "toolu_opaque", "mcp__ocbridge__t0"), ...stop("tool_use", 4)];
  const opaque = boxContinuation(api, [publishedText("toolu_prior", "ok")],
    [echoOf("toolu_prior", "ok"), ...opaqueUse], {}, api.catalogHash(CLI_TOOLS, "opaque"));
  if ((await must("WEDGE_OPAQUE_CHAIN", opaque.round())).kind !== "tool_handoff"
    || !opaque.sse().includes('"name":"Bash"')) fail("WEDGE_OPAQUE_CHAIN_LOST");
  return "[ocv5-300-rejected-stream-wedge] PASS — a rejected stream whose CLI finished settles unbilled and the next message runs";
}

// INC-20261006-BOX-SYNTHETIC-TURN-HELD, live 2026-10-06 06:51Z (uid 4): Claude
// Code's context compaction asks for 20000 output tokens and forwards the
// user's `max` effort. The Box CLI spent the cap on thinking, wrote its own
// synthetic "Output token limit hit" user turn inside the message and the
// stream was rejected. The row stayed unknown, pinned the session, and every
// later message ended in BOX_CAPACITY_HELD ("消息未开始处理") until someone
// closed it by hand. A rejected stream of that kind settles unbilled and the
// next message runs.
async function proveSyntheticTurnHeld(api: Api, db: Db): Promise<string> {
  const who = { uid: 900_000_320n, containerId: 320n, sessionId: "session-synthetic-turn" };
  const journal = api.journal(db);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'synthetic-turn@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const before = await money(db, who.uid);
  const turnKey = "5".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-synthetic-turn", turnKey });
  const nudge = { type: "user", isSynthetic: true, parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text",
      text: "Output token limit hit. Resume directly — no apology, no recap of what you were doing." }] } };
  const spool = [cliInit, start("msg_a"), nudge, start("msg_b"), ...say("msg_b", 0, "summary"),
    ...stop("end_turn", 4)];
  let stops = 0;
  const host = boxHost(api, spoolOf(spool), { real: { journal, ...who, requestId: "box-synthetic-turn", turnKey,
    // the CLI finished by itself: its keeper proof says worker_complete
    proofReason: "worker_complete",
    stopRejectedRun: async (identity) => { stops++; return api.stopCoordinator(journal, host.target).requestStop(identity); } } });
  const rejected = await codeOf(host.round);
  if (!/^BOX_CLI_COMPACT_/.test(rejected)) fail(`SYNTHETIC_TURN_NOT_REJECTED_${rejected}`);
  if (stops !== 1 || host.count.launch !== 1) fail("SYNTHETIC_TURN_STOP_OR_LAUNCH_COUNT");
  const row = await journalRow(db, "box-synthetic-turn");
  if (row?.state !== "aborted" || row.failure_code !== "STREAM_FAILED" || row.credits !== "0"
    || row.ctx.boxState !== "failed_stopped" || row.ctx.boxStopOutcome !== "rejected_stream"
    || (row.ctx.boxTerminalProof as { reason?: string } | undefined)?.reason !== "worker_complete") {
    fail(`SYNTHETIC_TURN_ROW_${row?.state}_${String(row?.ctx.boxState)}_${String(row?.ctx.boxStopOutcome)}`);
  }
  if (await money(db, who.uid) !== before) fail("SYNTHETIC_TURN_BILLED");
  const idle = await journal.readIdleProof({ ...who, turnKey });
  if (idle.status !== "failed" || !isDeepStrictEqual(idle.requestIds, ["box-synthetic-turn"])) fail(`SYNTHETIC_TURN_IDLE_${idle.status}`);
  // the user's next message in that session is admitted, launched and answered
  const nextKey = "6".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-synthetic-turn-next", turnKey: nextKey });
  const next = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, requestId: "box-synthetic-turn-next", turnKey: nextKey } });
  const answered = await must("SYNTHETIC_TURN_NEXT_MESSAGE", next.round());
  if (answered.kind !== "final" || !next.sse().includes("done")) fail("SYNTHETIC_TURN_NEXT_MESSAGE_NO_ANSWER");
  if ((await journalRow(db, "box-synthetic-turn-next"))?.ctx.boxState !== "terminal") fail("SYNTHETIC_TURN_NEXT_MESSAGE_NOT_SETTLED");
  return "[inc-20261006-synthetic-turn-held] PASS — a stream with the CLI's own synthetic turn settles unbilled and the next message runs";
}

// INC-20261006-BOX-SYNTHETIC-TURN-HELD (cause of the canary's "snapshot without
// stream" rounds, found 2026-10-06 10:52Z): the Box account's five hour usage
// window was exhausted. The CLI runs without retries, so it streamed no model
// message and wrote its own synthetic assistant record ("You've hit your
// session limit") plus an error result. The decoder called that a snapshot
// violation; the row waited for the cleanup worker and the next message met
// BOX_CAPACITY_HELD. The refusal is one named code, settles unbilled at once
// and the next message is admitted. The spool is the capture from the Box.
async function proveUpstreamRefusal(api: Api, db: Db): Promise<string> {
  const who = { uid: 900_000_321n, containerId: 321n, sessionId: "session-upstream-refusal" };
  const journal = api.journal(db);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'upstream-refusal@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const before = await money(db, who.uid);
  const turnKey = "7".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-upstream-refusal", turnKey });
  const captured = readFileSync(fileURLToPath(new URL(
    "../packages/commercial/src/http/proxy/__fixtures__/box-cli-upstream-refusal/real-session-limit.jsonl",
    import.meta.url)), "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
  let stops = 0;
  const host = boxHost(api, spoolOf([cliInit, ...captured]), { real: { journal, ...who,
    requestId: "box-upstream-refusal", turnKey,
    // the CLI finished by itself: its keeper proof says worker_complete
    proofReason: "worker_complete",
    stopRejectedRun: async (identity) => { stops++; return api.stopCoordinator(journal, host.target).requestStop(identity); } } });
  const rejected = await codeOf(host.round);
  if (rejected !== "BOX_CLI_UPSTREAM_RATE_LIMITED") fail(`UPSTREAM_REFUSAL_NOT_NAMED_${rejected}`);
  if (stops !== 1 || host.count.launch !== 1) fail("UPSTREAM_REFUSAL_STOP_OR_LAUNCH_COUNT");
  const row = await journalRow(db, "box-upstream-refusal");
  if (row?.state !== "aborted" || row.failure_code !== "STREAM_FAILED" || row.credits !== "0"
    || row.ctx.boxState !== "failed_stopped" || row.ctx.boxStopOutcome !== "rejected_stream") {
    fail(`UPSTREAM_REFUSAL_ROW_${row?.state}_${String(row?.ctx.boxState)}_${String(row?.ctx.boxStopOutcome)}`);
  }
  if (await money(db, who.uid) !== before) fail("UPSTREAM_REFUSAL_BILLED");
  const idle = await journal.readIdleProof({ ...who, turnKey });
  if (idle.status !== "failed" || !isDeepStrictEqual(idle.requestIds, ["box-upstream-refusal"])) fail(`UPSTREAM_REFUSAL_IDLE_${idle.status}`);
  const nextKey = "8".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-upstream-refusal-next", turnKey: nextKey });
  const next = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, requestId: "box-upstream-refusal-next", turnKey: nextKey } });
  const answered = await must("UPSTREAM_REFUSAL_NEXT_MESSAGE", next.round());
  if (answered.kind !== "final" || !next.sse().includes("done")) fail("UPSTREAM_REFUSAL_NEXT_MESSAGE_NO_ANSWER");
  if ((await journalRow(db, "box-upstream-refusal-next"))?.ctx.boxState !== "terminal") fail("UPSTREAM_REFUSAL_NEXT_MESSAGE_NOT_SETTLED");
  return "[inc-20261006-upstream-refusal] PASS — a CLI usage-limit refusal settles unbilled at once and the next message runs";
}

/** A Box tool turn as egress serves it: the product's BoxToolFetch on the real
 * journal, with one Box account behind it. `first` is the round that hands the
 * tool call to the client; `next` sends the client's tool result back. */
function boxTurn(api: Api, db: Db, journal: Journal, who: { uid: bigint; containerId: bigint; sessionId: string },
  name: string, turnKey: string, writeMessage?: unknown,
  options: { dispatchId?: string; nextSpool?: Buffer; stopIgnored?: boolean;
    /** The CLI stays alive waiting: no terminal proof exists until its keeper is told to stop. */
    parked?: "until-stopped" | "unreadable";
    /** The Box account cannot be reached for a continuation publish. */
    unreachable?: { active: boolean } } = {}) {
  const cut = { active: false };
  const { parked, unreachable, ...hostOptions } = options;
  const host: ReturnType<typeof boxHost> = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]), {
    ...(parked ? { proofRead: () => { if (parked === "unreadable" || host.count.stop === 0) throw api.transportError("BOX_EXEC_REMOTE_EXIT"); } } : {}),
    // the exec stream of a continuation is cut in a way a re-read cannot repair
    spoolRead: () => { if (cut.active) throw api.transportError("BOX_EXEC_HTTP_500"); },
    real: { journal, ...who, accountId: who.containerId, requestId: `${name}-1`, turnKey, ...hostOptions } });
  const service = api.toolFetch({ ...host.deps, ...(writeMessage ? { writeMessage } : {}),
    ...(unreachable ? { resolveTarget: async () => {
      if (unreachable.active) throw Object.assign(new Error("BOX_TARGET_UNAVAILABLE"), { code: "BOX_TARGET_UNAVAILABLE" });
      return host.target;
    } } : {}),
    stopOrphanRun: (identity: unknown) => api.stopCoordinator(journal, host.target).requestStop(identity) });
  const exchange = [{ role: "user", content: "run it" },
    { role: "assistant", content: [text("Using the bridge."),
      { type: "tool_use", id: "toolu_good_1", name: "Bash", input: { value: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_good_1", content: "ok" }] }];
  /** The request that carries the tool result, under this or another turn key. */
  const answer = (requestId: string, key = turnKey) => {
    const body = { ...JSON.parse(host.call.init.body) as Body, messages: exchange,
      metadata: { user_id: JSON.stringify({ session_id: who.sessionId, oc_turn_key: key }) } };
    return { ...host.call, requestId, canonicalBody: { ...body, model: MODEL },
      init: { method: "POST", body: JSON.stringify(body) } };
  };
  return { host, service, cut, answer,
    first: async () => {
      await prechecked(api, db, { ...who, requestId: `${name}-1`, turnKey,
        ...(options.dispatchId ? { dispatchId: options.dispatchId } : {}) });
      const sse = await must(`${name}_FIRST_ROUND`, service.fetch(host.call).then((response) => response.text()));
      if (!sse.includes("toolu_good_1") || host.count.launch !== 1) fail(`${name}_FIRST_ROUND`);
    },
    next: async (requestId: string, key = turnKey, dispatchId?: string) => {
      await prechecked(api, db, { ...who, requestId, turnKey: key, ...(dispatchId ? { dispatchId } : {}) });
      return service.fetch(answer(requestId, key));
    } };
}

// INC-20261002-BOX-REPLAY-PENDING-AFTER-CUT, live #2ee979cd: right after the
// turn's tools succeeded the continuation's Box exec stream was cut. The CLI on
// the Box kept going and finished, but CCB's same-request non-streaming retry
// one second later found the call still resolving and got 409
// BOX_REPLAY_PENDING ("任务执行失败"). The retry must keep looking, read-only,
// until the real result is ready. A cut continuation whose CLI ran on to a
// tool call nobody received must not pin the session either.
async function proveReplayPendingAfterCut(api: Api, db: Db): Promise<string> {
  const journal = api.journal(db);
  const root = mkdtempSync(join(tmpdir(), "ocv5-308-replay-"));
  try {
    const store = api.replayStore(join(root, "state"));
    const who = { uid: 900_000_306n, containerId: 306n, sessionId: "session-cut" };
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'cut@test.invalid','unused',10000)",
      [who.uid.toString()]);
    const turn = boxTurn(api, db, journal, who, "box-cut", "6".repeat(64), store.write);
    await turn.first();
    turn.cut.active = true;
    const cutResponse = await turn.next("box-cut-2");
    if (await codeOf(() => cutResponse.text()) !== "BOX_EXEC_HTTP_500") fail("REPLAY_CONTINUATION_NOT_CUT");
    turn.cut.active = false;
    if ((await journalRow(db, "box-cut-2"))?.ctx.boxState !== "unknown") fail("REPLAY_LEAF_NOT_UNKNOWN");
    // the CLI is still working: it has echoed the tool result and the model has not answered yet
    turn.host.write([echoOf("toolu_good_1", "ok")]);
    // CCB's fallback: the same request without the stream key. The lookup is egress's own
    // composition (find, re-observe an unknown detached call read-only, find again).
    const retry = { uid: who.uid, canonicalModel: MODEL, upstreamModel: CLI_MODEL,
      canonicalBody: { ...turn.answer("box-cut-2").canonicalBody, stream: false } };
    const deps = { journal, readMessage: store.read };
    let lookups = 0;
    const lookup = async (): Promise<ReplayLookup> => {
      lookups++;
      const found = await api.findReplay(retry, deps);
      if (found.kind !== "pending" || found.identity?.state !== "unknown" || !found.identity.rootLaunchPermit) return found;
      await api.observeUnknown({ identity: found.identity, canonicalBody: retry.canonicalBody, upstreamModel: CLI_MODEL },
        { journal, writeMessage: store.write, resolveTarget: async () => turn.host.target, budgetMs: 1000 });
      return api.findReplay(retry, deps);
    };
    const first = await lookup();
    if (first.kind !== "pending") fail(`REPLAY_FIRST_LOOKUP_${first.kind}`);
    setTimeout(() => turn.host.write(FINAL_ANSWER), 30);
    const replayed = await api.waitReplay(first, lookup, { budgetMs: 20_000, intervalMs: 100,
      signal: new AbortController().signal });
    if (replayed.kind !== "ready" || !replayed.response) fail(`REPLAY_STILL_${replayed.kind}`);
    const message = await replayed.response.json() as { content?: Array<{ text?: string }> };
    if (message.content?.[0]?.text !== "done") fail("REPLAY_NOT_THE_REAL_RESULT");
    if (turn.host.count.launch !== 1) fail("REPLAY_RELAUNCHED");
    if ((await journalRow(db, "box-cut-2"))?.ctx.boxState !== "terminal") fail("REPLAY_LEAF_NOT_SETTLED");
    // production waits 240s in 3s steps, inside CCB's 300s fallback timeout, and the handler uses it
    const wait = /pendingWait: \{ budgetMs: ([0-9_]+), intervalMs: ([0-9_]+) \}/.exec(api.egressSource);
    const budgetMs = Number(wait?.[1]?.replaceAll("_", "")), intervalMs = Number(wait?.[2]?.replaceAll("_", ""));
    if (!(budgetMs >= 120_000 && budgetMs < 300_000 && intervalMs >= 1000 && intervalMs <= 10_000)) fail("REPLAY_PRODUCTION_WAIT");
    if (!/replay\.kind === "pending" && pendingWait\)[\s\S]{0,400}waitForBoxReplay\(replay, lookupReplay,\s*\{ \.\.\.pendingWait/
      .test(api.proxySource)) fail("REPLAY_HANDLER_NOT_WAITING");
    let clock = 0, polls = 0;
    const still = await api.waitReplay({ kind: "pending" }, async () => { polls++; return { kind: "pending" }; },
      { budgetMs, intervalMs, signal: new AbortController().signal, now: () => clock,
        sleep: async (ms) => { clock += ms; } });
    if (still.kind !== "pending" || clock > budgetMs || polls !== Math.floor(budgetMs / intervalMs)) fail("REPLAY_WAIT_UNBOUNDED");
    const gone = new AbortController();
    gone.abort();
    await api.waitReplay({ kind: "pending" }, async () => { polls = -1; return { kind: "ready" }; },
      { budgetMs, intervalMs, signal: gone.signal, now: () => 0, sleep: async () => {} });
    if (polls === -1) fail("REPLAY_WAITED_FOR_GONE_CLIENT");

    // a cut continuation whose CLI ran on to another tool call and exited: nobody can receive that
    // call, so the unknown leaf is closed unbilled and the session is released
    const stuck = { uid: 900_000_307n, containerId: 307n, sessionId: "session-cut-unseen" };
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'unseen@test.invalid','unused',10000)",
      [stuck.uid.toString()]);
    const before = await money(db, stuck.uid);
    const unseen = boxTurn(api, db, journal, stuck, "box-unseen", "7".repeat(64), store.write);
    await unseen.first();
    unseen.cut.active = true;
    await codeOf(async () => (await unseen.next("box-unseen-2")).text());
    unseen.cut.active = false;
    unseen.host.write([echoOf("toolu_good_1", "ok"), start("msg_c", 30, 5),
      ...call("msg_c", 0, "toolu_unseen", BOX_BASH), ...stop("tool_use", 9, 30)]);
    const sweeper = api.cleanupWorker({ journal, writeRecoveryMessage: store.write,
      resolver: { resolve: async () => unseen.host.target } });
    const swept = await sweeper.reconcileStoppedFailures();
    const leaf = await journalRow(db, "box-unseen-2"), parent = await journalRow(db, "box-unseen-1");
    if (swept.recovered !== 1 || leaf?.state !== "aborted" || leaf.credits !== "0"
      || leaf.ctx.boxState !== "failed_stopped" || leaf.ctx.boxStopOutcome !== "rejected_stream"
      || parent?.ctx.boxState !== "failed_stopped") {
      fail(`REPLAY_UNSEEN_LEAF_${swept.recovered}_${leaf?.state}_${String(leaf?.ctx.boxState)}_${String(parent?.ctx.boxState)}`);
    }
    if (await money(db, stuck.uid) !== before) fail("REPLAY_UNSEEN_BILLED");
    const idle = await journal.readIdleProof({ ...stuck, turnKey: "7".repeat(64) });
    if (idle.status !== "failed") fail(`REPLAY_UNSEEN_IDLE_${idle.status}`);
    await prechecked(api, db, { ...stuck, requestId: "box-unseen-next", turnKey: "8".repeat(64) });
    const nextMessage = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
      real: { journal, ...stuck, accountId: stuck.containerId, requestId: "box-unseen-next", turnKey: "8".repeat(64) } });
    if ((await must("REPLAY_UNSEEN_NEXT_MESSAGE", nextMessage.round())).kind !== "final") fail("REPLAY_UNSEEN_NEXT_MESSAGE");
    // a first round left unknown with a handoff in its spool is a different shape and stays held
    const held = { uid: 900_000_308n, containerId: 308n, sessionId: "session-first-held" };
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'held@test.invalid','unused',10000)",
      [held.uid.toString()]);
    await prechecked(api, db, { ...held, requestId: "box-held-1", turnKey: "9".repeat(64) });
    const firstHeld = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]), {
      pendingRead: () => { throw api.transportError("BOX_EXEC_HTTP_500"); },
      real: { journal, ...held, accountId: held.containerId, requestId: "box-held-1", turnKey: "9".repeat(64) } });
    if (await codeOf(firstHeld.round) !== "BOX_EXEC_HTTP_500") fail("REPLAY_FIRST_ROUND_NOT_CUT");
    const again = await api.cleanupWorker({ journal, writeRecoveryMessage: store.write,
      resolver: { resolve: async () => firstHeld.target } }).reconcileStoppedFailures();
    if ((await journalRow(db, "box-held-1"))?.ctx.boxState !== "unknown" || again.recovered !== 0) {
      fail("REPLAY_FIRST_ROUND_HANDOFF_RELEASED");
    }
    return "[ocv5-306-replay-pending-after-cut] PASS — a retry waits for the still-finishing Box call and replays its real result";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// INC-20261001-BOX-RECOVERED-TOOL-EXCHANGE, live #aacd65f7: a Box turn failed
// after it had handed tool calls to the client. The server's recovery turns
// ("从断点继续 / 重新尝试") resent the same tool results under a new turn key; a
// continuation can only bind to its own dispatch, so each one was 409
// BOX_TOOL_OWNER_UNKNOWN ("任务执行失败"), while the first dispatch's CLI kept
// waiting and held the session's slot. The recovery must stop that orphan the
// way a user Stop does and continue the exchange as one fresh invocation.
async function proveRecoveredToolExchange(api: Api, db: Db): Promise<string> {
  const journal = api.journal(db);
  // each user has one dispatch that has ended and one that is still running
  const endedOf = (uid: bigint) => `11111111-1111-4111-8111-${uid.toString().padStart(12, "0")}`;
  const runningOf = (uid: bigint) => `22222222-2222-4222-8222-${uid.toString().padStart(12, "0")}`;
  const user = async (uid: bigint, label: string) => {
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,$2,'unused',10000)",
      [uid.toString(), `${label}@test.invalid`]);
    await db.query(`INSERT INTO turn_dispatches VALUES ($1,$3,'terminal'),($2,$3,'running')`,
      [endedOf(uid), runningOf(uid), uid.toString()]);
  };
  const who = { uid: 900_000_304n, containerId: 304n, sessionId: "session-recover" };
  await user(who.uid, "recover");
  // the turn whose dispatch has ended; its CLI is parked waiting for the tool result
  const turn = boxTurn(api, db, journal, who, "box-rec", "a".repeat(64), undefined,
    { dispatchId: endedOf(who.uid), nextSpool: spoolOf([cliInit, ...FINAL_ANSWER]) });
  await turn.first();
  // the recovery turn: the same tool result, another turn key
  const recovered = await must("RECOVERED_EXCHANGE_REJECTED", turn.next("box-rec-2", "b".repeat(64), runningOf(who.uid)));
  const sse = await must("RECOVERED_EXCHANGE_STREAM", recovered.text());
  if (recovered.status !== 200 || !sse.includes("done")) fail("RECOVERED_EXCHANGE_NO_ANSWER");
  if (turn.host.count.stop !== 1 || turn.host.count.launch !== 2) {
    fail(`RECOVERED_EXCHANGE_STOP_${turn.host.count.stop}_LAUNCH_${turn.host.count.launch}`);
  }
  const orphan = await journalRow(db, "box-rec-1"), fresh = await journalRow(db, "box-rec-2");
  if (orphan?.ctx.boxState !== "failed_stopped" || orphan.ctx.boxRecoveredBy !== "box-rec-2"
    || (orphan.ctx.boxTerminalProof as { reason?: string } | undefined)?.reason !== "keeper_stopped") {
    fail(`RECOVERED_ORPHAN_${String(orphan?.ctx.boxState)}_${String(orphan?.ctx.boxRecoveredBy)}`);
  }
  if (fresh?.ctx.boxState !== "terminal" || fresh.ctx.boxRunNonce === orphan.ctx.boxRunNonce) fail("RECOVERED_NOT_A_FRESH_RUN");
  // the fresh CLI gets the whole exchange as history and Claude Code's own resume sentence as its prompt
  const run = `/tmp/ocv5-289-run-${String(fresh.ctx.boxRunNonce)}`;
  const stdin = turn.host.files.get(`${run}/stdin.jsonl`)?.toString("utf8") ?? "";
  const history = [...turn.host.files].filter(([path]) => path.endsWith(".jsonl") && !path.startsWith(run))
    .map(([, raw]) => raw.toString("utf8")).join("\n");
  if (!stdin.includes("Continue from where you left off.") || stdin.includes("toolu_good_1")) fail("RECOVERED_PROMPT");
  if (!history.includes('"tool_use"') || !history.includes('"tool_result"')
    || (history.match(/toolu_good_1/g) ?? []).length !== 2) fail("RECOVERED_HISTORY");
  // a second recovery of the same exchange never starts another paid run
  const again = await codeOf(async () => (await turn.next("box-rec-3", "c".repeat(64), runningOf(who.uid))).text());
  if (again !== "BOX_RESUME_IN_PROGRESS" || turn.host.count.launch !== 2) fail(`RECOVERED_TWICE_${again}`);

  // an exchange whose dispatch is still running belongs to its live owner
  const liveUser = { uid: 900_000_305n, containerId: 305n, sessionId: "session-live-owner" };
  await user(liveUser.uid, "live-owner");
  const live = boxTurn(api, db, journal, liveUser, "box-live", "a".repeat(64), undefined, { dispatchId: runningOf(liveUser.uid) });
  await live.first();
  const refused = await codeOf(async () => (await live.next("box-live-2", "b".repeat(64), runningOf(liveUser.uid))).text());
  if (refused !== "BOX_TOOL_OWNER_UNKNOWN" || live.host.count.stop !== 0 || live.host.count.launch !== 1
    || (await journalRow(db, "box-live-1"))?.ctx.boxState !== "handoff") fail(`RECOVERED_LIVE_OWNER_${refused}`);
  // a stop that cannot be proven keeps the rejection and gives the exchange back
  const unproven = { uid: 900_000_309n, containerId: 309n, sessionId: "session-unproven-stop" };
  await user(unproven.uid, "unproven");
  const parked = boxTurn(api, db, journal, unproven, "box-park", "a".repeat(64), undefined,
    { dispatchId: endedOf(unproven.uid), stopIgnored: true });
  await parked.first();
  const kept = await codeOf(async () => (await parked.next("box-park-2", "b".repeat(64), runningOf(unproven.uid))).text());
  const parkedRow = await journalRow(db, "box-park-1");
  if (kept !== "BOX_TOOL_OWNER_UNKNOWN" || parked.host.count.launch !== 1 || parkedRow?.ctx.boxRecoveredBy !== undefined) {
    fail(`RECOVERED_UNPROVEN_STOP_${kept}_${String(parkedRow?.ctx.boxRecoveredBy)}`);
  }
  // a recovery that claimed the exchange and ended before it was ever admitted does not keep it
  const stale = { uid: 900_000_311n, containerId: 311n, sessionId: "session-stale-claim" };
  await user(stale.uid, "stale-claim");
  const abandoned = boxTurn(api, db, journal, stale, "box-stale", "a".repeat(64), undefined,
    { dispatchId: endedOf(stale.uid), nextSpool: spoolOf([cliInit, ...FINAL_ANSWER]) });
  await abandoned.first();
  await prechecked(api, db, { ...stale, requestId: "box-stale-2", turnKey: "b".repeat(64), dispatchId: runningOf(stale.uid) });
  if (await journal.claimOrphanRecovery({ requestId: "box-stale-1", uid: stale.uid, by: "box-stale-2" } as never) !== true) {
    fail("RECOVERED_STALE_SETUP");
  }
  await db.query("UPDATE request_finalize_journal SET state='aborted' WHERE request_id='box-stale-2'");
  const takeover = await must("RECOVERED_STALE_CLAIM_KEPT", abandoned.next("box-stale-3", "c".repeat(64), runningOf(stale.uid)));
  if (!(await must("RECOVERED_STALE_CLAIM_STREAM", takeover.text())).includes("done")
    || (await journalRow(db, "box-stale-1"))?.ctx.boxRecoveredBy !== "box-stale-3") fail("RECOVERED_STALE_CLAIM_NOT_TAKEN");
  // an exchange the user is stopping is the user's: the recovery neither claims nor continues it
  const stopping = { uid: 900_000_310n, containerId: 310n, sessionId: "session-user-stop" };
  await user(stopping.uid, "user-stop");
  const pressed = boxTurn(api, db, journal, stopping, "box-stop", "a".repeat(64), undefined, { dispatchId: endedOf(stopping.uid) });
  await pressed.first();
  await journal.recordUserCancelIntent({ requestId: "box-stop-1", uid: stopping.uid, accountId: stopping.containerId,
    runNonce: pressed.host.runNonce, leaseEpoch: pressed.host.leaseEpoch } as never);
  const yielded = await codeOf(async () => (await pressed.next("box-stop-2", "b".repeat(64), runningOf(stopping.uid))).text());
  if (yielded !== "BOX_TOOL_OWNER_UNKNOWN" || pressed.host.count.stop !== 0 || pressed.host.count.launch !== 1
    || (await journalRow(db, "box-stop-1"))?.ctx.boxRecoveredBy !== undefined) fail(`RECOVERED_USER_STOP_${yielded}`);
  return "[ocv5-304-recovered-tool-exchange] PASS — a recovery turn stops the orphaned run and continues its tool exchange once";
}

/** Egress's two container-authenticated internal routes, served on loopback
 * by the product's own handlers over the real journal, and the environment a
 * user container has for reaching them. The gateway code under test calls
 * them with its own clients. */
async function egressInternalRoutes(api: Api, journal: Journal, who: { uid: bigint; containerId: bigint },
  target: unknown, readCapsule?: unknown) {
  const identity = { resolve: async () => ({ uid: who.uid, containerId: who.containerId, apiKey: null }) };
  const routes: Record<string, RouteHandler> = {
    "/internal/box/stop": api.stopHandler({ identity, journal, coordinator: api.stopCoordinator(journal, target) }),
    "/internal/box/idle-proof": api.idleProofHandler({ identity, journal, ...(readCapsule ? { readCapsule } : {}) }) };
  const calls: string[] = [];
  let idle: Promise<void> = Promise.resolve();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    calls.push(path);
    // one journal session: requests are served one after another
    idle = idle.then(() => routes[path]
      ? routes[path]!(req, res, { hostUuid: "proof-host", boundIp: "127.0.0.1" })
      : void res.writeHead(404).end()).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") fail("EGRESS_ROUTES_NO_PORT");
  const keys = ["ANTHROPIC_BASE_URL", "OPENCLAUDE_V3_MASTER_BASE_URL", "OPENCLAUDE_V3_CONTAINER_TOKEN",
    "OC_BOX_IDLE_PROOF_WAIT_MS"] as const;
  const before = keys.map((key) => process.env[key]);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${address.port}/`;
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = "oc-v3.proof-token";
  process.env.OC_BOX_IDLE_PROOF_WAIT_MS = "0";
  return { calls,
    /** Every request received so far has been answered. */
    settled: async () => { await tick(50); await idle; },
    close: async () => {
      keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } };
}

/** A live session of the gateway's SessionManager on the Box native model. The
 * runner stands in for the CCB subprocess: an idle turn, when one is
 * dispatched, ends normally with no summary. */
function gatewaySession(api: Api, sessionKey: string, counters: { submits: number; shutdowns: number },
  shutdown: () => Promise<void> = async () => {}) {
  return { sessionKey, agentId: "main", channel: "webchat", peerId: sessionKey, title: "proof", startedAt: Date.now(),
    model: api.boxNative.model, _boxContextOwner: api.boxNative.owner, lock: Promise.resolve(), lastUsedAt: 0,
    totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0,
    turns: 0, _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(), executionTarget: { kind: "local" }, providerTag: "ccb",
    runner: Object.assign(new EventEmitter(), { model: api.boxNative.model, engineId: "ccb", capabilities: {},
      submitTurn: () => { counters.submits++; return { submitted: Promise.resolve(), end: () => {}, summary: Promise.resolve({}) }; },
      shutdown: () => { counters.shutdowns++; return shutdown(); } }) };
}
const PAST_IDLE_GATE = "PROOF_PAST_IDLE_GATE";
/** A message arrives for the session: the product's SessionManager.submit().
 * submit() drives the session's durable idle work and refuses the message
 * with IDLE_HISTORY_PENDING ("消息未开始处理") while its history is pending.
 * The first thing it does with an admitted message is read the turn's model
 * authority descriptor; this call ends there, before any runner is touched. */
async function submitMessage(api: Api, session: unknown): Promise<"admitted" | "IDLE_HISTORY_PENDING"> {
  const executionDescriptor = Object.defineProperty({}, "contextOwner",
    { get: () => { throw new Error(PAST_IDLE_GATE); } });
  const outcome = await codeOf(() => api.sessionManager.submit(session, "next message", () => {}, undefined,
    api.boxNative.model, undefined, undefined, undefined, { modelAuthority: { executionDescriptor } }));
  if (outcome === PAST_IDLE_GATE) return "admitted";
  if (outcome.includes("IDLE_HISTORY_PENDING")) return "IDLE_HISTORY_PENDING";
  return fail(`SUBMIT_ENDED_${outcome}`);
}

// INC-20261003-BOX-REJECT-BLOCKS-NEXT-MESSAGE, live #72191544: egress refused a
// continuation with a deterministic 409 before any Box call. Claude Code ended
// the turn on it, but the Box CLI that had handed off the tool calls stayed
// parked waiting for their results. Its idle proof stayed pending, so every
// next message of the session was refused ("消息未开始处理") until the CLI timed
// out hours later. The gateway must settle that turn like a browser Stop.
async function proveRejectBlocksNextMessage(api: Api, db: Db): Promise<string> {
  const journal = api.journal(db);
  const who = { uid: 900_000_315n, containerId: 315n, sessionId: "session-reject" };
  const turnKey = "5".repeat(64);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'reject@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const turn = boxTurn(api, db, journal, who, "box-rej", turnKey);
  await turn.first();
  // the continuation the client sent: the tool result plus text egress cannot attribute to it
  const answer = turn.answer("box-rej-2").canonicalBody as Body;
  const refused = { ...answer, messages: [...(answer.messages as unknown[]).slice(0, 2), { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_good_1", content: "ok" }, text("and now deploy it") ] }] };
  // egress refuses it while this turn's CLI still waits for that result (since OCV5-322 the shape alone is a
  // new prompt over an answered exchange; the refusal is made at admission, against the journal)
  await prechecked(api, db, { ...who, requestId: "box-rej-2", turnKey });
  const sent = turn.answer("box-rej-2");
  const code = await codeOf(async () => (await turn.service.fetch({ ...sent, canonicalBody: refused, init: { method: "POST",
    body: JSON.stringify({ ...JSON.parse(sent.init.body) as Body, messages: refused.messages }) } })).text());
  if (!/^BOX_[A-Z0-9_]+$/.test(code) || turn.host.count.launch !== 1) fail(`REJECT_NOT_REFUSED_${code}`);
  // egress answers it with these bytes; Claude Code ends the turn with them as its error result
  let wire = "";
  api.jsonError({ headersSent: false, writeHead: () => {}, setHeader: () => {}, end: (body: string) => { wire = body; } },
    409, code, "continuation rejected", "dc1551b789864b0500d6bd581ffd538b");
  if (!wire.includes(code)) fail("REJECT_WIRE_BODY");
  const routes = await egressInternalRoutes(api, journal, who, turn.host.target);
  const dir = api.home;
  const counters = { submits: 0, shutdowns: 0 };
  const session = gatewaySession(api, "reject-session", counters);
  // the turn's own submit left the session's idle candidate, as for every Box native turn
  api.idle.writeIdleCandidate(dir, { v: 1, sessionKey: session.sessionKey, sessionId: who.sessionId, turnKey });
  try {
    if ((await api.fetchIdleProof({ sessionId: who.sessionId, turnKey })).status !== "pending") fail("REJECT_NOT_PARKED");
    // while the Box turn is parked, a message to this session is refused: the incident
    if (await submitMessage(api, session) !== "IDLE_HISTORY_PENDING") fail("REJECT_PARKED_TURN_DID_NOT_BLOCK");
    const runner = Object.assign(new EventEmitter(), { model: MODEL, sessionId: who.sessionId,
      setConsultTurn: () => {}, submit: async () => {}, interrupt: () => true });
    const adapter = api.ccbAdapter(runner);
    const ccbTurn = adapter.submitTurn({ input: "run it", turnKey, onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() });
    await ccbTurn.submitted;
    runner.emit("message", { type: "result", subtype: "success", is_error: true, result: `API Error: 409 ${wire}` });
    if ((await ccbTurn.summary)?.isError !== true) fail("REJECT_TURN_NOT_ENDED");
    await routes.settled();
    if (routes.calls.filter((path) => path === "/internal/box/stop").length !== 1) {
      fail(`REJECT_PARKED_TURN_NOT_STOPPED_${routes.calls.join(",")}`);
    }
    const parked = await journalRow(db, "box-rej-1");
    if (parked?.ctx.boxState !== "failed_stopped" || turn.host.count.stop !== 1) fail(`REJECT_ROW_${String(parked?.ctx.boxState)}`);
    // what the session's idle candidate waits for, read the way the gateway reads it
    const idle = await api.fetchIdleProof({ sessionId: who.sessionId, turnKey });
    if (idle.status !== "failed") fail(`REJECT_IDLE_${idle.status}`);
    // the next message is admitted by submit(): the candidate is cleared, nothing is compacted
    if (await submitMessage(api, session) !== "admitted") fail("REJECT_NEXT_MESSAGE_STILL_BLOCKED");
    if (api.idle.readIdleCandidate(dir, session.sessionKey) !== undefined || counters.submits !== 0) fail("REJECT_CANDIDATE_KEPT");
    if (await submitMessage(api, session) !== "admitted") fail("REJECT_NEXT_MESSAGE_BLOCKED_AGAIN");
    // a transient Box answer of the same shape is not a continuation reject and stops nothing
    const other = api.ccbAdapter(runner);
    const otherTurn = other.submitTurn({ input: "run it", turnKey: "e".repeat(64), onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() });
    await otherTurn.submitted;
    runner.emit("message", { type: "result", subtype: "success", is_error: true, result:
      'API Error: 409 {"error":{"code":"BOX_REPLAY_PENDING","message":"previous Box call still resolving"},"request_id":"x"}' });
    await otherTurn.summary;
    await routes.settled();
    if (routes.calls.filter((path) => path === "/internal/box/stop").length !== 1) fail("REJECT_TRANSIENT_STOPPED");
  } finally {
    await routes.close();
  }
  // and egress admits, launches and answers it
  await prechecked(api, db, { ...who, requestId: "box-rej-next", turnKey: "d".repeat(64) });
  const next = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, accountId: who.containerId, requestId: "box-rej-next", turnKey: "d".repeat(64) } });
  if ((await must("REJECT_NEXT_MESSAGE", next.round())).kind !== "final" || !next.sse().includes("done")) {
    fail("REJECT_NEXT_MESSAGE_NO_ANSWER");
  }
  return "[ocv5-315-reject-blocks-next-message] PASS — a rejected continuation stops the parked Box turn and the next message passes submit";
}

// INC-20261003-BOX-IDLE-NO-SUMMARY-STRANDS-SESSION: a session's idle compaction
// was dispatched; CCB's compact fallback request carried `temperature: 1`,
// egress refused it (BOX_PARAMETER_UNMAPPED) and CCB ended the idle turn
// normally with no summary. The runner was never shut down, the idle op had no
// shutdown evidence, its not_found proof could never settle it, and every
// message of the session was refused ("消息未开始处理") until an operator reset;
// recreating the container did not help.
async function proveIdleNoSummary(api: Api, db: Db): Promise<string> {
  const journal = api.journal(db);
  const root = mkdtempSync(join(tmpdir(), "ocv5-308-idle-"));
  const who = { uid: 900_000_319n, containerId: 319n, sessionId: "session-idle" };
  const sourceTurn = "1".repeat(64);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'idle@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const store = api.replayStore(join(root, "state"));
  // the source turn: a finished Box turn whose context is large enough to need compaction
  const large = [start("msg_big", 400_000), ...say("msg_big", 0, "done"), ...stop("end_turn", 4, 400_000),
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 400_000, output_tokens: 4 } }];
  await prechecked(api, db, { ...who, requestId: "box-idle-src", turnKey: sourceTurn });
  const source = boxHost(api, spoolOf([cliInit, ...large]),
    { real: { journal, ...who, accountId: who.containerId, requestId: "box-idle-src", turnKey: sourceTurn } });
  if ((await must("IDLE_SOURCE_TURN", api.firstRound({ ...source.call, emit: () => {} },
    { ...source.deps, writeMessage: store.write }))).kind !== "final") fail("IDLE_SOURCE_TURN");
  // the proxy's billing finalizer commits a settled row
  await db.query("UPDATE request_finalize_journal SET state='committed' WHERE request_id='box-idle-src'");
  // the compact fallback request is refused before admission, so egress never has a row for the idle turn
  if (api.gate({ model: MODEL, stream: true, max_tokens: 64, temperature: 1,
    messages: [{ role: "user", content: "summarize the conversation" }] }, true) !== "BOX_PARAMETER_UNMAPPED") {
    fail("IDLE_COMPACT_FALLBACK_ADMITTED");
  }
  const routes = await egressInternalRoutes(api, journal, who, source.target, store.read);
  const dir = api.home;
  const counters = { submits: 0, shutdowns: 0 };
  /** A message arrives for the session. */
  const submit = (sessionKey: string, shutdown?: () => Promise<void>) =>
    submitMessage(api, gatewaySession(api, sessionKey, counters, shutdown));
  try {
    const proof = await api.fetchIdleProof({ sessionId: who.sessionId, turnKey: sourceTurn }) as {
      status: string; revision?: string; compactRequired?: boolean };
    if (proof.status !== "terminal" || proof.compactRequired !== true || !proof.revision) fail(`IDLE_SOURCE_PROOF_${proof.status}`);
    const revision = proof.revision;
    const key = "idle-no-summary";
    api.idle.writeIdleCandidate(dir, { v: 1, sessionKey: key, sessionId: who.sessionId, turnKey: sourceTurn });
    const before = Date.now();
    // the idle turn is dispatched and ends without a summary; inside the grace window the session waits
    if (await submit(key) !== "IDLE_HISTORY_PENDING") fail("IDLE_ADMITTED_INSIDE_GRACE");
    const recorded = api.idle.readIdleOp(dir, key, revision);
    if (counters.submits !== 1) fail(`IDLE_TURN_DISPATCHES_${counters.submits}`);
    if (counters.shutdowns !== 1 || !((recorded?.runnerKilledAt ?? 0) >= before)) fail("IDLE_NO_SHUTDOWN_EVIDENCE");
    if (recorded?.disposition !== undefined || !api.idle.readPendingIdle(dir, key)) fail("IDLE_SETTLED_INSIDE_GRACE");
    // after the grace window egress still has no row for the idle turn: the op settles and stops blocking submit
    api.idle.writeIdleOp(dir, { ...recorded!, runnerKilledAt: Date.now() - api.idle.IDLE_STOPPED_GRACE_MS - 1 });
    if (await submit(key) !== "admitted") fail("IDLE_SESSION_STILL_BLOCKED");
    const settled = api.idle.readIdleOp(dir, key, revision);
    if (settled?.abandonReason !== "idle_turn_never_sent" || api.idle.readPendingIdle(dir, key) !== undefined
      || api.idle.readIdleCandidate(dir, key) !== undefined) fail(`IDLE_SESSION_STILL_BLOCKED_${String(settled?.abandonReason)}`);
    if (counters.submits !== 1) fail("IDLE_TURN_REDISPATCHED");
    // a shutdown that fails is no evidence: nothing is recorded and nothing settles on the clock alone
    api.idle.writeIdleCandidate(dir, { v: 1, sessionKey: "idle-stuck", sessionId: who.sessionId, turnKey: sourceTurn });
    const stuck = await submit("idle-stuck", async () => { throw new Error("busy"); });
    if (stuck !== "IDLE_HISTORY_PENDING" || api.idle.readIdleOp(dir, "idle-stuck", revision)?.runnerKilledAt !== undefined
      || !api.idle.readPendingIdle(dir, "idle-stuck")) fail("IDLE_SETTLED_WITHOUT_EVIDENCE");
    // an op stranded by older code in a container that no longer exists: written before this
    // runtime started, so that start is its shutdown evidence and the next submit settles it
    const stranded = "idle-stranded";
    const idleTurn = createHash("sha256").update(`${stranded}:${revision}`).digest("hex");
    api.idle.startIdleOp({ dir, sessionKey: stranded, sourceSessionId: who.sessionId, sourceTurnKey: sourceTurn,
      revision, idleTurnKey: idleTurn, frozenTail: [], attachments: [] });
    api.idle.writeIdleNative(dir, { v: 1, opId: idleTurn, revision, sessionId: who.sessionId, modelCalls: 0,
      modelStarted: true, frozenTail: [], attachments: [] });
    const long = new Date(Date.UTC(2001, 0, 1));
    utimesSync(join(dir, "idle-ops", encodeURIComponent(stranded), `${revision}.json`), long, long);
    const submits = counters.submits;
    if (await submit(stranded) !== "admitted") fail("IDLE_STRANDED_OP_BLOCKS");
    const released = api.idle.readIdleOp(dir, stranded, revision);
    if (released?.disposition !== "abandoned" || released.abandonReason !== "idle_turn_never_sent"
      || api.idle.readPendingIdle(dir, stranded) !== undefined || counters.submits !== submits) {
      fail(`IDLE_STRANDED_OP_${String(released?.disposition)}`);
    }
    // the incident's own shape: after the slot switch egress knows neither the source nor the idle turn
    const lost = "idle-lost-source", lostSource = "2".repeat(64);
    const lostTurn = createHash("sha256").update(`${lost}:${revision}`).digest("hex");
    api.idle.startIdleOp({ dir, sessionKey: lost, sourceSessionId: who.sessionId, sourceTurnKey: lostSource,
      revision, idleTurnKey: lostTurn, frozenTail: [], attachments: [] });
    api.idle.writeIdleNative(dir, { v: 1, opId: lostTurn, revision, sessionId: who.sessionId, modelCalls: 0,
      modelStarted: true, frozenTail: [], attachments: [] });
    utimesSync(join(dir, "idle-ops", encodeURIComponent(lost), `${revision}.json`), long, long);
    if (await submit(lost) !== "admitted") fail("IDLE_LOST_SOURCE_OP_BLOCKS");
    if (api.idle.readIdleOp(dir, lost, revision)?.abandonReason !== "idle_turn_never_sent"
      || api.idle.readPendingIdle(dir, lost) !== undefined || counters.submits !== submits) fail("IDLE_LOST_SOURCE_OP");
    return "[ocv5-319-idle-no-summary] PASS — an idle turn that ends without a summary leaves evidence and the session is released";
  } finally {
    await routes.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The sessions backend on its own schema of the test database, built from the
 * product's migrations the way its integration suite builds it. The schema has
 * a random name and is dropped again; nothing else in the database is touched. */
async function withSessionsBackend<T>(api: Api, config: unknown,
  run: (backend: SessionsBackend, db: Db) => Promise<T>): Promise<T> {
  const pg = await import("pg");
  const Pool = (pg.default ?? pg).Pool;
  const schema = `oc_incident_proof_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ ...(config as object), max: 1 });
  const pool = new Pool({ ...(config as object), max: 6, options: `-c search_path=${schema}`,
    application_name: schema });
  /** Dropping the schema is part of the result: a schema left behind fails the gate. It does not
   * wait for the backend's pool: its sessions are ended from the admin connection first, so a
   * stuck query cannot keep the schema alive. Runs once however many paths ask for it. */
  let dropping: Promise<void> | undefined;
  const drop = (): Promise<void> => dropping ??= (async () => {
    void pool.end().catch(() => {});
    try {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name=$1 AND pid <> pg_backend_pid()`, [schema]);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const left = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
      if (left.rows.length !== 0) fail("SESSIONS_SCHEMA_LEFT_BEHIND");
    } finally {
      void admin.end().catch(() => {});
    }
  })();
  // the pool's sessions are ended on purpose during cleanup
  pool.on("error", () => {});
  cleanups.add(drop);
  await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    const migrate = async (...names: string[]) => {
      for (const name of names) {
        await pool.query(readFileSync(join(CANDIDATE, "packages/commercial/src/db/migrations", name), "utf8"));
      }
    };
    await migrate("0066_wechat_pointer_outbox_audit.sql", "0078_wechat_outbox_backoff_hol.sql",
      "0134_sessions_master_pg.sql", "0147_lossless_turn_tapes.sql", "0159_goal_state.sql",
      "0157_lossless_runtime_batches.sql");
    // 0170 alters three billing/observability tables this schema does not otherwise need
    await pool.query(`CREATE TABLE request_finalize_journal (request_id TEXT PRIMARY KEY);
      CREATE TABLE usage_records (id BIGSERIAL PRIMARY KEY, user_id BIGINT, turn_key TEXT, status TEXT,
        output_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE turn_traces (trace_id TEXT PRIMARY KEY)`);
    await migrate("0170_durable_turn_dispatch.sql", "0173_client_session_model.sql",
      "0175_client_session_history_revision.sql", "0176_direct_turn_timeline.sql", "0177_unified_client_timeline.sql");
    await pool.query("CREATE TABLE users (id BIGINT PRIMARY KEY)");
    await migrate("0181_turn_tape_recovery_links.sql", "0196_client_session_workspace_mode.sql",
      "0201_durable_live_turn_frames.sql", "0202_turn_recovery_control.sql", "0228_turn_visible_finalize.sql",
      "0229_turn_finalize_integrity.sql", "0230_chat_projects.sql", "0231_turn_tape_materialization_resilience.sql",
      "0233_client_session_list_archived_at.sql", "0239_turn_dispatch_shutdown_ctx.sql",
      "0240_client_session_last_read_at.sql", "0241_raise_last_read_watermark.sql", "0243_live_unit_checkpoints.sql",
      "0246_chat_project_board_bind.sql");
    // columns and tables the backend's SQL reads that belong to migration chains outside this slice
    await pool.query(`CREATE TABLE agent_containers (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
        state TEXT NOT NULL, runtime_kind TEXT NOT NULL DEFAULT 'docker');
      CREATE TABLE admin_audit (id BIGSERIAL PRIMARY KEY, admin_id BIGINT NOT NULL, action TEXT NOT NULL, target TEXT,
        before JSONB, after JSONB, ip INET, user_agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      ALTER TABLE turn_dispatches ADD COLUMN IF NOT EXISTS agent_container_id BIGINT REFERENCES agent_containers(id);
      ALTER TABLE turn_dispatches ADD COLUMN IF NOT EXISTS runtime_kind TEXT;
      ALTER TABLE chat_projects ADD COLUMN IF NOT EXISTS is_research_default BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE client_session_turn_tapes ADD COLUMN waive_reason TEXT;
      CREATE TABLE turn_waivers (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, turn_key TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', refunded_credits BIGINT NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0, inbox_message_id BIGINT, applied_at TIMESTAMPTZ,
        UNIQUE (user_id, turn_key))`);
    await pool.query(`INSERT INTO sessions_store_migration_state
      (singleton, authority, generation, cutover_id, source_digest, completed_at)
      VALUES (true, 'pg_authoritative', 1, 'proof-cutover', 'proof-digest', $1)`, [Date.now()]);
    return await run(api.sessionsBackend(pool), pool as Db);
  } finally {
    cleanups.delete(drop);
    await drop();
  }
}

// INC-20261003-BOX-SETTLED-TOOLS-MANUAL-RESUME, live #b6df9aee: a Box Claude
// turn ran Bash and Skill to completion, then the next model call failed with
// ENGINE_ERROR. The master declined automatic recovery as checkpoint_unsafe,
// because Bash never has a gateway effect proof, and the user had to click
// 「从断点继续」. Finalizing such a turn must schedule the automatic checkpoint
// continuation itself, with a short budget, and only when nothing is open.
async function proveFinalizedTurnRecovery(api: Api, database: unknown): Promise<string[]> {
  return withSessionsBackend(api, database, async (backend, db) => {
    const uid = 9n, sessionUser = "c:9";
    const settled = [
      { blockId: "toolu_317_bash", toolName: "Bash", inputJson: { command: "git status --short" }, output: "M a.ts", completed: true },
      { blockId: "toolu_317_skill", toolName: "Skill", inputJson: { skill: "v5-selfhost-shared-worktree-deploy-discipline" },
        output: "Launching skill: v5-selfhost-shared-worktree-deploy-discipline", completed: true }];
    let turns = 0;
    /** One user turn admitted by the master and its finalized tape, as the gateway uploads it. */
    const finalized = async (name: string, shape: { tools: unknown[]; errorCode: string; status?: string;
      recoveryAttempt?: number; text?: string; runtimeEvents?: unknown[]; outputTokens?: number;
      /** Frames still in the live stream of this message when the tape is finalized. */
      liveFrames?: unknown[][] }) => {
      const sessionId = `s-ocv5-317-${name}`, clientMessageId = `cm-ocv5-317-${name}`;
      const turnKey = createHash("sha256").update(`ocv5-317:${name}:${++turns}`).digest("hex");
      const admitted = await backend.admitUserTurn({ uid, sessionUserId: sessionUser, sessionId, clientMessageId,
        agentId: "main", model: MODEL, requestHash: "h".repeat(64), billingRequestId: `brq-${clientMessageId}`,
        dispatchId: randomUUID(), ownerId: "conn-A",
        message: { id: clientMessageId, role: "user", text: "refactor the sidebar", ts: 1,
          _routing: { model: MODEL, effortLevel: null, teamMode: false },
          ...(shape.recoveryAttempt ? { _automaticRecovery: true, _automaticRecoveryAttempt: shape.recoveryAttempt,
            _automaticRecoveryRootClientMessageId: `cm-ocv5-317-root-${name}` } : {}) } });
      if (admitted.kind !== "admitted") fail(`SETTLED_${name}_NOT_ADMITTED`);
      const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
      if (shape.liveFrames) {
        const sessionKey = `agent:main:webchat:dm:${sessionId}`, streamKey = `legacy:621:${sessionKey}`;
        await db.query(`INSERT INTO client_session_live_streams
          (stream_key,session_id,user_id,client_message_id,source,projection_source,terminal_status)
          VALUES ($1,$2,$3,$4,'gateway','live','interrupted')`, [streamKey, sessionId, sessionUser, clientMessageId]);
        for (const [index, blocks] of shape.liveFrames.entries()) {
          const payload = Buffer.from(JSON.stringify({ type: "outbound.message", clientMessageId, blocks }));
          await db.query(`INSERT INTO client_session_live_frames
            (stream_key,source,agent_container_id,session_key,frame_seq,payload,payload_sha256)
            VALUES ($1,'gateway',621,$2,$3,$4,$5)`, [streamKey, sessionKey, index + 1, payload, hash(payload)]);
        }
      }
      const canonical = Buffer.from(JSON.stringify({ sessionId, agentId: "main", turnIndex: 1,
        status: shape.status ?? "completed", turnKey, clientMessageId, text: shape.text ?? "API Error: 409",
        tools: shape.tools, errorCode: shape.errorCode, createdAt: 1_783_950_150_000,
        usage: shape.outputTokens === undefined ? { inputTokens: 6, outputTokens: 872 }
          : { inputTokens: 0, outputTokens: shape.outputTokens },
        ...(shape.runtimeEvents ? { runtimeEvents: shape.runtimeEvents } : {}) }), "utf8");
      const partCount = Math.ceil(canonical.length / api.tape.partBytes);
      const base = { protocolVersion: api.tape.version, sessionId, agentId: "main", turnIndex: 1,
        status: shape.status ?? "completed", turnKey, tapeId: hash(`proof-tape\0${turnKey}`), tapeSha256: hash(canonical),
        totalBytes: canonical.length, partCount, createdAt: 1_783_950_150_000 };
      for (let partIndex = 0; partIndex < partCount; partIndex++) {
        const bytes = canonical.subarray(partIndex * api.tape.partBytes, (partIndex + 1) * api.tape.partBytes);
        await backend.stageLosslessTurnTapePart(sessionUser, { ...base, action: "part", partIndex,
          partSha256: hash(bytes), data: bytes.toString("base64") }, bytes);
      }
      if ((await backend.finalizeLosslessTurnTape(sessionUser, { ...base, action: "finalize" })).applied !== "finalized") {
        fail(`SETTLED_${name}_NOT_FINALIZED`);
      }
      const jobs = (await db.query(`SELECT recovery_mode AS mode, semantic_recovery_attempt AS attempt
        FROM turn_recovery_jobs WHERE user_id=$1 AND session_id=$2`, [uid.toString(), sessionId])).rows;
      const messages = (await backend.getClientSession(sessionId, sessionUser))?.messages ?? [];
      return { jobs: jobs.map((job) => `${String(job.mode)}#${String(job.attempt)}`),
        gaveUp: messages.some((message) => String(message.id).startsWith("m-recovery-giveup-")) };
    };
    // the live tape: Bash and Skill finished, then the model call failed
    const live = await finalized("live", { tools: settled, errorCode: "ENGINE_ERROR" });
    if (!isDeepStrictEqual(live.jobs, ["checkpoint#1"]) || live.gaveUp) fail(`SETTLED_LEFT_ON_MANUAL_CARD_${live.jobs.join(",")}`);
    for (const errorCode of ["UPSTREAM_TIMEOUT", "RATE_LIMITED"]) {
      const other = await finalized(errorCode.toLowerCase().replace("_", "-"), { tools: settled, errorCode });
      if (!isDeepStrictEqual(other.jobs, ["checkpoint#1"])) fail(`SETTLED_${errorCode}_${other.jobs.join(",")}`);
    }
    // a tool that never finished keeps the turn on the manual path
    const open = await finalized("open-tool", { errorCode: "ENGINE_ERROR", status: "interrupted",
      tools: [settled[0], { ...settled[1], output: "", completed: false }] });
    if (open.jobs.length !== 0) fail(`SETTLED_OPEN_TOOL_RESUMED_${open.jobs.join(",")}`);
    // losing the runner is not a model-plane failure, and a turn with no tools has nothing to resume over
    const runner = await finalized("runner-lost", { tools: settled, errorCode: "RUNNER_CRASHED" });
    const bare = await finalized("no-tools", { tools: [], errorCode: "ENGINE_ERROR" });
    if (runner.jobs.length !== 0 || bare.jobs.length !== 0) fail("SETTLED_WIDENED_TO_OTHER_FAILURES");
    // the automatic budget is three: the third failure of a lineage shows the card instead of ten bubbles
    const second = await finalized("second-retry", { tools: settled, errorCode: "ENGINE_ERROR", recoveryAttempt: 2 });
    const third = await finalized("third-retry", { tools: settled, errorCode: "ENGINE_ERROR", recoveryAttempt: 3 });
    if (!isDeepStrictEqual(second.jobs, ["checkpoint#3"]) || second.gaveUp) fail(`SETTLED_BUDGET_SECOND_${second.jobs.join(",")}`);
    if (third.jobs.length !== 0 || !third.gaveUp) fail(`SETTLED_BUDGET_THIRD_${third.jobs.join(",")}_${third.gaveUp}`);

    // INC-20261003-BOX-LEFTOVER-TOOL-FRAMES, live #611729fb: the same settled tape, but when the master decided,
    // the live stream of the message still held its tool_use and tool_result frames. Each leftover tool_use was
    // read as an open tool with no id, the turn was declared checkpoint_unsafe and the user got the red card with
    // a manual 「从断点继续」. Leftover frames must pair by id; a block that cannot be paired still blocks.
    const read = { blockId: "toolu_321_read", toolName: "Read", inputJson: { file_path: "a.ts" }, output: "x", completed: true };
    const bash = { blockId: "toolu_321_bash", toolName: "Bash", inputJson: { command: "ls" }, output: "a.ts", completed: true };
    const use = (tool: typeof read, extra: Record<string, unknown> = {}) =>
      ({ kind: "tool_use", blockId: tool.blockId, toolName: tool.toolName, inputJson: tool.inputJson, ...extra });
    const result = (tool: typeof read) => ({ kind: "tool_result", blockId: `${tool.blockId}:result`,
      toolUseBlockId: tool.blockId, toolName: tool.toolName, isError: false, output: tool.output });
    const leftover = await finalized("leftover-frames", { tools: [read, bash], errorCode: "ENGINE_ERROR", liveFrames: [
      [{ kind: "tool_use", blockId: read.blockId, toolName: "Read", partial: true }], [use(read)], [result(read)],
      [{ kind: "text", text: "Quick update: both changes are written." }, use(bash)], [result(bash)]] });
    if (!isDeepStrictEqual(leftover.jobs, ["checkpoint#1"]) || leftover.gaveUp) {
      fail(`LEFTOVER_FRAMES_LEFT_ON_MANUAL_CARD_${leftover.jobs.join(",")}`);
    }
    // a leftover call whose result never arrived is an open tool: no automatic continuation over it
    const unanswered = await finalized("leftover-open", { tools: [read, bash], errorCode: "ENGINE_ERROR", liveFrames: [
      [use(read)], [result(read)], [use(bash)]] });
    if (unanswered.jobs.length !== 0) fail(`LEFTOVER_OPEN_TOOL_RESUMED_${unanswered.jobs.join(",")}`);

    // INC-20261003-BOX-ANSWERED-EXCHANGE-PROMPT, second half: each automatic 「从断点继续」 failed within a second
    // with the same Box 409 and recorded nothing but Claude Code's own API Error row; the master took every one
    // for a new chance and sent ten in twenty seconds. Such an empty repeat has the short budget of three.
    const empty = (attempt: number) => finalized(`empty-recovery-${attempt}`, { tools: [], errorCode: "ENGINE_ERROR",
      recoveryAttempt: attempt, outputTokens: 0, text: 'API Error: 409 {"error":{"code":"BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION"}}',
      runtimeEvents: [{ ordinal: 1, observedAt: 1_783_950_170_100, source: "ccb",
        payload: { type: "result", is_error: true, num_turns: 1 } }] });
    const retried = await empty(2), stopped = await empty(3);
    if (!isDeepStrictEqual(retried.jobs.map((job) => job.split("#")[1]), ["3"]) || stopped.jobs.length !== 0) {
      fail(`ANSWERED_EMPTY_RECOVERY_BUDGET_${retried.jobs.join(",")}_${stopped.jobs.join(",")}`);
    }
    return ["[ocv5-317-settled-tools-auto-resume] PASS — a model failure after settled tools schedules the automatic checkpoint continuation",
      "[ocv5-321-leftover-tool-frames] PASS — settled tools whose live frames are still present pair by id and the checkpoint continuation is scheduled"];
  });
}

/** A Box for the resident CLI lane: an exec endpoint that really runs what the bridge sends (the product's
 * launch, write and stop scripts) around a stand-in for the Claude binary. `refuse.writes` makes the Box
 * answer a stdin write with exit 1 without running it. */
async function boxCliBox(tag: string, claudeScript: string) {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-box-`));
  cleanups.add(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  writeFileSync(claude, claudeScript, { mode: 0o755 });
  const fifoBase = `/tmp/oc-box-cc-${randomBytes(8).toString("hex")}`;
  const readers = (): number[] => readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
    try { return readlinkSync(`/proc/${pid}/fd/0`).startsWith(`${fifoBase}.`); } catch { return false; }
  }).map(Number);
  const execs = new Set<ChildProcess>();
  const refuse = { writes: false };
  cleanups.add(() => {
    for (const run of execs) run.kill("SIGKILL");
    for (const pid of readers()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    for (const name of readdirSync("/tmp")) if (`/tmp/${name}`.startsWith(`${fifoBase}.`)) rmSync(`/tmp/${name}`, { force: true });
  });
  const execFrame = (body: unknown): Buffer => {
    const payload = Buffer.from(JSON.stringify(body));
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const box = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).subarray(5).toString("utf8")) as { command: string;
        args: string[]; environment: Record<string, string> };
      res.writeHead(200, { "content-type": "application/connect+json" });
      if (refuse.writes && body.environment.OC_BOX_CC_SEQ !== undefined) {
        res.end(execFrame({ exitEvent: { exitCode: 1 } }));
        return;
      }
      const run = spawn(body.command, body.args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"],
        env: { ...body.environment, PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      execs.add(run);
      res.flushHeaders();
      // a pipe chunk can end inside a multi-byte character
      const utf8 = new StringDecoder("utf8");
      run.stdout!.on("data", (chunk: Buffer) => res.write(execFrame({ stdoutEvent: { data: utf8.write(chunk) } })));
      run.on("close", (code) => { execs.delete(run); res.end(execFrame({ exitEvent: code ? { exitCode: code } : {} })); });
    });
  });
  await new Promise<void>((resolve) => box.listen(0, "127.0.0.1", () => resolve()));
  cleanups.add(() => { box.closeAllConnections(); box.close(); });
  const address = box.address();
  if (!address || typeof address === "string") fail("BOX_CLI_ENDPOINT");
  return { readers, refuse, control: { execUrl: `http://127.0.0.1:${address.port}/agent.v1.ControlService/Exec`,
    execToken: "exec", networkToken: "network", remoteClaude: claude, fifo: `${fifoBase}.fifo`, cwd: dir } };
}

/** The stop script has killed the box Claude; on a loaded host its /proc entry can outlive the kill by a moment. */
async function gone(readers: () => number[]): Promise<boolean> {
  for (let i = 0; i < 80 && readers().length !== 0; i++) await tick(25);
  return readers().length === 0;
}

/** INC-20261005-BOX-CC-FOLLOWUP-TURN. Production rel-97e6472b5: on box-claude-* the second turn of a session
 * ended as "服务正在更新，本轮已中断" (子进程被信号 SIGKILL 终止). The runner took the box CLI for the
 * engine=ccb proxy lane and recycled it before every turn; the bridge ignored its closed stdin, was SIGKILLed,
 * and the box Claude stayed alive on the session. The Box here is an exec endpoint that really runs what the
 * bridge sends (the product's launch, write and stop scripts) around a stand-in for the Claude binary. */
async function proveBoxCliFollowUpTurn(api: Api): Promise<string> {
  const descriptor = { canonicalModel: "box-claude-opus-5-5", contextWindow: 200_000, capabilityZero: true,
    supportsThinking: true, supportsVision: true, supportedEfforts: [] };
  const turn = (lease: string) => ({ authorityEnvelope: `authority-${lease}`, leaseEnvelope: lease,
    executionDescriptor: descriptor });
  // A wrong recycle SIGKILLs the child's process group: give it a real one of its own.
  const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  cleanups.add(() => { try { process.kill(-sleeper.pid!, "SIGKILL"); } catch { /* already gone */ } });
  const written: string[] = [];
  let stdinEnded = false;
  const child = Object.assign(new EventEmitter(), { pid: sleeper.pid, exitCode: null, signalCode: null,
    stdin: Object.assign(new EventEmitter(), { writable: true, end: () => { stdinEnded = true; },
      write: (line: string, done?: (error?: Error | null) => void) => { written.push(line); done?.(null); return true; } }),
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const runner = api.boxCli.runner({ sessionKey: "agent:main:webchat:dm:ocv5-315", agentId: "main",
    agentBaseDir: api.home, model: "box-claude-opus-5-5", config: {}, harness: "official-cc", boxResidentCc: true });
  Object.assign(runner, { proc: child, closed: false, spawnedExecutionDescriptor: descriptor });
  await runner.submit("first", undefined, turn("lease-1"), "turn-1");
  await runner.updateTurnLease("lease-1-renewed");
  await runner.submit("second", undefined, turn("lease-2"), "turn-2");
  if ((runner as unknown as { proc: unknown }).proc !== child || stdinEnded || written.length !== 2) {
    fail(`FOLLOWUP_TURN_RECYCLED_BOX_PROCESS_${written.length}_${stdinEnded}`);
  }

  const box = await boxCliBox("ocv5-315",
    "#!/bin/sh\nwhile IFS= read -r line; do printf '%s\\n' \"$line\"; done\n");
  const readers = box.readers;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let answered = "";
  stdout.on("data", (chunk: Buffer) => { answered += chunk.toString("utf8"); });
  const bridge = api.boxCli.bridge({ control: box.control,
    args: ["--model", "box-claude-opus-5-5"], stdin, stdout, stderr: new PassThrough() });
  const answer = async (marker: string): Promise<void> => {
    stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: marker } })}\n`);
    for (let i = 0; i < 200 && !answered.includes(marker); i++) await tick(25);
    if (!answered.includes(marker)) fail(`FOLLOWUP_TURN_NOT_ANSWERED_${marker}`);
  };
  await answer("turn-one");
  const serving = readers();
  await answer("turn-two");
  if (serving.length === 0 || !isDeepStrictEqual(readers(), serving)) fail("FOLLOWUP_TURN_CHANGED_BOX_CLAUDE");
  // the gateway retires the process: shutdown, model switch, idle recycle
  stdin.end();
  const code = await Promise.race([bridge, tick(5_000).then(() => "still-running" as const)]);
  if (code !== 0) fail(`FOLLOWUP_STDIN_CLOSE_${code}`);
  if (!await gone(readers)) fail("FOLLOWUP_BOX_CLAUDE_LEFT_RUNNING");
  return "[ocv5-315-box-cli-follow-up-turn] PASS — a follow-up turn reaches the same box Claude and closing stdin ends it";
}

/** INC-20261005-BOX-CC-LARGE-LINE. Production rel-e4d81bfac: a session switched to box-claude-opus-5-5 with
 * 496 history messages; twice the turn was silent for about 303 s and ended as runner_crashed. The bridge put
 * each stdin line into one environment variable of the write exec; above 128 KiB the kernel does not start
 * that process, and the bridge never looked at the exit code. A line of any size must reach the box Claude
 * whole, once and in order, and a write the Box did not complete must end the turn at once. */
async function proveBoxCliLargeLine(api: Api): Promise<string> {
  const line = (content: string) => `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
  const large = line("历史🙂 context ".repeat(45_000));
  if (Buffer.byteLength(large) < 800_000) fail("LARGE_LINE_FIXTURE");
  // the recorded shape: the kernel refuses to start a process with this line as one environment string
  const before = spawnSync("python3", ["-c", "pass"],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OC_BOX_CC_LINE: large } });
  if ((before.error as NodeJS.ErrnoException | undefined)?.code !== "E2BIG") fail("LARGE_LINE_SHAPE_STARTED_A_PROCESS");

  const box = await boxCliBox("ocv5-317", "#!/bin/sh\nexec cat\n");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => received.push(chunk));
  const bridge = api.boxCli.bridge({ control: box.control, args: ["--model", "box-claude-opus-5-5"], stdin, stdout,
    stderr: new PassThrough() });
  const expected = Buffer.from(`${line("before")}${large}${line("after")}`);
  stdin.write(line("before"));
  stdin.write(large);
  stdin.write(line("after"));
  const size = () => received.reduce((sum, chunk) => sum + chunk.length, 0);
  for (let i = 0; i < 800 && size() < expected.length; i++) await tick(25);
  await tick(200);
  if (!Buffer.concat(received).equals(expected)) fail(`LARGE_LINE_NOT_WHOLE_${size()}_OF_${expected.length}`);
  stdin.end();
  const code = await Promise.race([bridge, tick(5_000).then(() => "still-running" as const)]);
  if (code !== 0 || !await gone(box.readers)) fail(`LARGE_LINE_CLOSE_${code}`);

  // the Box does not complete a write: the bridge reports it and ends, instead of waiting for an answer
  const failing = await boxCliBox("ocv5-317-refused", "#!/bin/sh\nexec cat\n");
  failing.refuse.writes = true;
  const input = new PassThrough();
  const errors = new PassThrough();
  let reported = "";
  errors.on("data", (chunk: Buffer) => { reported += chunk.toString("utf8"); });
  const refused = api.boxCli.bridge({ control: failing.control, args: [], stdin: input, stdout: new PassThrough(),
    stderr: errors });
  input.write(line("never delivered"));
  const outcome = await Promise.race([refused.then((exit) => `exit-${exit}`, () => "failed"),
    tick(5_000).then(() => "still-waiting")]);
  if (outcome !== "failed" || !reported.includes("BOX_CC_WRITE_FAILED")) fail(`LARGE_LINE_WRITE_FAILURE_${outcome}`);
  return "[ocv5-317-box-cli-large-line] PASS — a 900 KB stdin line reaches the box Claude whole and a failed write ends the turn at once";
}

/** INC-20261004-BOX-CLI-VERSION-UNREADABLE. Production v5-0ee3b3710: the version gate asked the exec transport
 * for a 64-byte response; the transport's floor is 1024, so the read was refused before it left and every Box
 * read as unreadable: no new Box turn could start. The read here goes through the real transport to a Box that
 * answers in the exec stream format. The gate of INC-20261004-BOX-UNKNOWN-NEVER-CLOSED is checked beside it:
 * an unlisted build still refuses a new launch and never a run that already exists. */
async function proveCliVersionRead(api: Api): Promise<string> {
  const frame = (flag: number, body: unknown): Buffer => {
    const payload = Buffer.from(JSON.stringify(body));
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const boxRunning = (version: string, accountId = 25n) => {
    const state = { sent: 0, disposed: 0 };
    const exec = api.cliVersion.transport(async (_url, init) => {
      state.sent++;
      const request = JSON.parse(Buffer.from(init.body).subarray(5).toString("utf8")) as { command?: string };
      if (request.command !== "/usr/bin/python3") fail("CLI_VERSION_READ_REQUEST");
      return new Response(new Uint8Array(Buffer.concat([frame(0, { stdoutEvent: { data: `${version}\n` } }),
        frame(0, { exitEvent: {} }), frame(2, {})])));
    });
    return { state, target: { accountId, exec, dispose: async () => { state.disposed++; } } };
  };
  const current = boxRunning("2.1.288");
  const version = await must("CLI_VERSION_READ", api.cliVersion.gate().read(current.target));
  if (version !== "2.1.288" || current.state.sent !== 1) fail(`CLI_VERSION_READ_${version}_${current.state.sent}`);
  // a new launch on that Box is admitted with its version; an unlisted build is refused before admission
  const resolve = api.cliVersion.launchResolver(async (args) => (args.box as ReturnType<typeof boxRunning>).target,
    api.cliVersion.gate());
  const admitted = await must("CLI_VERSION_LAUNCH", resolve({ box: boxRunning("2.1.288") }));
  if (admitted.cliVersion !== "2.1.288") fail("CLI_VERSION_LAUNCH_NOT_ANNOTATED");
  // (the gate trusts a supported result per account for a while, so the other Box is another account)
  const unlisted = boxRunning("2.1.999", 26n);
  const refusal = await codeOf(() => resolve({ box: unlisted }));
  if (refusal !== "BOX_CLI_VERSION_UNSUPPORTED" || unlisted.state.sent !== 1 || unlisted.state.disposed !== 1) {
    fail(`CLI_VERSION_UNLISTED_${refusal}_${unlisted.state.disposed}`);
  }
  // a run that exists (continuation publish, stop, cleanup) is never refused by the gate
  const pinned = await must("CLI_VERSION_PINNED", resolve({ box: boxRunning("2.1.999", 27n), requiredAccountId: 27n }));
  if (pinned.cliVersion !== undefined) fail("CLI_VERSION_PINNED_ANNOTATED");
  return "[ocv5-313-cli-version-read] PASS — the Box CLI version read leaves through the real exec transport and a supported Box is admitted";
}

/** INC-20261004-BOX-FRESH-PROJECTS-DIR. Selfhost v5-5ef67b4d8: a newly added account's Box had ~/.claude but no
 * ~/.claude/projects (its Claude had never persisted a session). Every turn with history stages the session
 * snapshot under that directory, so prelaunch INIT failed with BOX_EXEC_REMOTE_EXIT before Claude started.
 * The product's own bootstrap, INIT, stage and cleanup requests run here against such a home directory. */
function proveFreshProjectsDir(api: Api): string {
  const execute = (request: BoxRequest) => {
    if (request.args.some((arg) => Buffer.byteLength(arg) >= 70_000)) fail("FRESH_PROJECTS_ARG_TOO_LARGE");
    return spawnSync(request.command, request.args, { cwd: request.cwd, env: request.environment, encoding: "utf8",
      timeout: 7_000, maxBuffer: 128 * 1024 });
  };
  const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
  /** A Box home that exists only under /tmp: the requests are sent with their paths moved there. */
  const boxHome = () => {
    const home = `/tmp/ocv5-310-box-home-${randomBytes(8).toString("hex")}`;
    const projects = `${home}/.claude/projects`;
    const at = (suffix: string) => `('tmp','${home.slice("/tmp/".length)}','.claude'${suffix})`;
    const relocate = (request: BoxRequest): BoxRequest => ({ ...request,
      args: request.args.map((arg) => arg.replaceAll("/home/box/.claude/projects", projects)
        .replaceAll("('home','box','.claude','projects')", at(",'projects'"))
        .replaceAll("('home','box','.claude')", at(""))) });
    cleanups.add(() => rmSync(home, { recursive: true, force: true }));
    return { home, projects, relocate };
  };
  const identity = (): PrelaunchIdentity => {
    const runNonce = randomBytes(12).toString("hex");
    for (const kind of ["stage", "run"]) {
      cleanups.add(() => rmSync(`/tmp/ocv5-289-${kind}-${runNonce}`, { recursive: true, force: true }));
    }
    return { runNonce, leaseEpoch: randomBytes(16).toString("hex"), controlId: randomBytes(16).toString("hex"),
      accountId: "25" };
  };
  const sid = "12345678-1234-4123-8123-123456789abc";
  const snapshot = Buffer.from("synthetic-history\n");

  // the guarded launch path: bootstrap, INIT, staged history, cleanup
  const fresh = boxHome();
  mkdirSync(`${fresh.home}/.claude`, { recursive: true, mode: 0o755 });
  const who = identity();
  const cwd = `/tmp/ocv5-289-run-${who.runNonce}`;
  const project = `/home/box/.claude/projects/-tmp-ocv5-289-run-${who.runNonce}`;
  const staged = `${fresh.projects}/-tmp-ocv5-289-run-${who.runNonce}`;
  const boot = execute(fresh.relocate(api.prelaunch.bootstrap(who)));
  if (boot.status !== 0) fail(`FRESH_PROJECTS_BOOTSTRAP_${boot.status}`);
  const receipt = api.prelaunch.parse(boot.stdout, who);
  if (!existsSync(fresh.projects) || (statSync(fresh.projects).mode & 0o777) !== 0o700) fail("FRESH_PROJECTS_DIR_NOT_CREATED");
  const init = execute(fresh.relocate(api.prelaunch.init(receipt, project)));
  if (init.status !== 0 || init.stdout.trim() !== "ready") fail(`FRESH_PROJECTS_INIT_${init.status}`);
  const plan = api.stageFiles({ cwd, project, files: [{ path: `${project}/${sid}.jsonl`, raw: snapshot,
    hash: sha(snapshot) }] });
  for (const step of plan.requests.slice(1)) {
    const result = execute(fresh.relocate(api.prelaunch.guard(fresh.relocate(step), receipt)));
    if (result.status !== 0) fail(`FRESH_PROJECTS_STAGE_${result.status}`);
  }
  if (!readFileSync(`${staged}/${sid}.jsonl`).equals(snapshot)) fail("FRESH_PROJECTS_HISTORY_NOT_STAGED");
  const clean = execute(fresh.relocate(api.prelaunch.cleanup(receipt)));
  if (clean.status !== 0 || clean.stdout.trim() !== `cleaned:${receipt.identityHash}` || existsSync(staged)
    || !existsSync(fresh.projects)) fail(`FRESH_PROJECTS_CLEANUP_${clean.status}`);

  // the text path: its stage INIT creates the same one parent directory
  const text = boxHome();
  mkdirSync(`${text.home}/.claude`, { recursive: true, mode: 0o755 });
  const textRun = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  cleanups.add(() => rmSync(textRun, { recursive: true, force: true }));
  const textProject = `/home/box/.claude/projects/${textRun.replaceAll("/", "-")}`;
  const textPlan = api.stageFiles({ cwd: textRun, project: textProject, files: [{ path: `${textProject}/${sid}.jsonl`,
    raw: snapshot, hash: sha(snapshot) }] });
  for (const step of textPlan.requests) {
    const result = execute(text.relocate(step));
    if (result.status !== 0) fail(`FRESH_PROJECTS_TEXT_STAGE_${result.status}`);
  }
  if (!existsSync(text.projects) || (statSync(text.projects).mode & 0o777) !== 0o700
    || !readFileSync(`${text.projects}/${textRun.replaceAll("/", "-")}/${sid}.jsonl`).equals(snapshot)) {
    fail("FRESH_PROJECTS_TEXT_HISTORY_NOT_STAGED");
  }

  // what must stay refused: a missing ~/.claude is never created, a symlinked one is never followed
  const bare = boxHome();
  const elsewhere = `${bare.home}-elsewhere`;
  cleanups.add(() => rmSync(elsewhere, { recursive: true, force: true }));
  mkdirSync(bare.home, { mode: 0o700 });
  mkdirSync(elsewhere, { mode: 0o700 });
  const bootstrap = () => {
    const next = identity();
    const run = execute(bare.relocate(api.prelaunch.bootstrap(next)));
    if (run.status !== 0) fail(`FRESH_PROJECTS_BARE_BOOTSTRAP_${run.status}`);
    return api.prelaunch.parse(run.stdout, next);
  };
  bootstrap();
  if (existsSync(`${bare.home}/.claude`)) fail("FRESH_PROJECTS_CREATED_CLAUDE_HOME");
  symlinkSync(elsewhere, `${bare.home}/.claude`);
  const linked = bootstrap();
  const refused = execute(bare.relocate(api.prelaunch.init(linked,
    `/home/box/.claude/projects/-tmp-ocv5-289-run-${linked.runNonce}`)));
  if (existsSync(`${elsewhere}/projects`) || refused.status === 0) fail("FRESH_PROJECTS_FOLLOWED_SYMLINK");
  return "[ocv5-310-fresh-projects-dir] PASS — history stages on a Box whose Claude has no projects directory yet";
}

/** INC-20261005-SAND-INSTALL-RESEND. Selfhost: the relay installer failed inside the Box of account 25 every
 * time (the Box host layout is newer than the installer). The Box accepted the prompt, no capability appeared
 * within 15 minutes, and the coordinator sent the same installer again under a new nonce, more than a hundred
 * times; the user saw the same error in the Box app over and over. The real coordinator runs here against a
 * Box gateway that accepts the prompt and never gains the capability. */
async function proveSandInstallNotResent(api: Api): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-314-sand-"));
  cleanups.add(() => rmSync(dir, { recursive: true, force: true }));
  const token = `x.${Buffer.from(JSON.stringify({ type: "session", sub: "ocv5-314-principal",
    exp: 2_000_000_000 })).toString("base64url")}.y`;
  const moduleHash = "d".repeat(64);
  const box = { creates: 0, sends: 0, pid: 321, installed: false };
  const agents: unknown[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      const answer = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path.endsWith("GetSandBoxRunState")) return answer({ state: "SAND_BOX_RUN_STATE_RUNNING" });
      if (path.endsWith("EnsureSandBox")) return answer({ gatewayUrl: `${base}/box`, gatewayToken: "GATE", networkToken: "NET" });
      if (path.endsWith("/health")) return answer({ ok: true, pid: box.pid, isBusy: false });
      if (path.endsWith("InferenceService/Stream")) {
        return box.installed ? answer({ protocol: "oc-sand-relay-v2", moduleSha256: moduleHash,
          nonce: req.headers["x-oc-sand-box-probe-nonce"], active: 0, maxConcurrent: 4 }) : answer({}, 404);
      }
      if (path.endsWith("/listAgents")) return answer(agents);
      if (path.endsWith("/createAgent")) {
        box.creates++;
        agents.push({ id: "owned-maintenance-bot", isRunning: false,
          description: (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { description?: string }).description });
        return answer({ agent: { id: "owned-maintenance-bot" }, transcript: [] });
      }
      // the Box takes the prompt; the installer then fails inside it, which the coordinator cannot see
      if (path.endsWith("/sendPrompt")) { box.sends++; return answer({ accepted: true }); }
      return answer({}, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.add(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === "string") fail("SAND_BOX_ENDPOINT");
  base = `http://127.0.0.1:${address.port}`;
  let now = Date.now();
  const row = { id: 1n, provider: "cursor", status: "active", cursor_sand_enabled: true, runtime_channel: "v5" };
  const coordinator = api.sand.coordinator({ authDir: dir, moduleHash, listAccounts: async () => [row],
    getAccount: async () => row,
    getTokenSnapshot: async () => ({ id: 1n, token: Buffer.from(token), refresh: null, credential_kind: "session",
      machine_id: "a".repeat(32), expires_at: null }),
    clientFor: async () => ({ client: api.sand.client({ fetchImpl: fetch, apiBase: base, allowTestLoopback: true }) }),
    installerPrompt: () => "synthetic deterministic installer", onChange: () => {}, now: () => now });
  cleanups.add(() => coordinator.stop());
  const operation = () => Object.values(api.sand.state(dir).operations)[0];
  const seen = () => `${box.creates}/${box.sends}/${operation()?.phase}/${operation()?.errorCode ?? ""}`;
  await coordinator.tick();
  if (seen() !== "1/1/submitted/" || operation()?.hostPid !== 321) fail(`SAND_INSTALL_FIRST_${seen()}`);
  // four more stale windows on the same Box host process: the incident sent the installer in each of them
  for (let i = 0; i < 4; i++) { now += 15 * 60_000 + 1; await coordinator.tick(); }
  if (seen() !== "1/1/error/INSTALL_UNCONFIRMED") fail(`SAND_INSTALL_RESENT_${seen()}`);
  const account = api.sand.state(dir).accounts["1"];
  if (account?.phase !== "error" || account.errorCode !== "INSTALL_UNCONFIRMED") fail("SAND_INSTALL_ACCOUNT_STATE");
  // a restarted Box host has not seen the installer: it gets one attempt, and again only one
  box.pid = 322; now += 60_001; await coordinator.tick();
  if (seen() !== "1/2/submitted/" || operation()?.hostPid !== 322) fail(`SAND_INSTALL_AFTER_RESTART_${seen()}`);
  for (let i = 0; i < 3; i++) { now += 15 * 60_000 + 1; await coordinator.tick(); }
  if (box.sends !== 2 || operation()?.phase !== "error") fail(`SAND_INSTALL_RESENT_AFTER_RESTART_${seen()}`);
  // the capability probe still decides readiness after the error
  box.installed = true; now += 60_001; await coordinator.tick();
  if (api.sand.state(dir).accounts["1"]?.phase !== "ready" || box.sends !== 2 || box.creates !== 1) {
    fail(`SAND_INSTALL_READY_${seen()}`);
  }
  await coordinator.stop();
  return "[ocv5-314-sand-install-resend] PASS — an installer the Box accepted is not sent again to the same Box host process";
}

/** INC-20261003-BOX-ANSWERED-EXCHANGE-PROMPT, live #7da201bd/#2a81a2fe: a Box turn's tool results had been
 * sent when the turn failed. Claude Code drops its own API Error rows, so every later message of the session,
 * the automatic 「从断点继续」 included, was merged into that tool-result message (tool_result + text + text…).
 * Egress answered each with 409 BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION and each failure added one more text
 * block: the session could never continue. Such a request must run as a new invocation with the answered
 * exchange as history, unless a CLI of this turn is still waiting for exactly those results. */
async function proveAnsweredExchangePrompt(api: Api, db: Db): Promise<string> {
  const journal = api.journal(db);
  const prompts = ["上一条消息因上游瞬时错误中断，请继续完成该任务。", "继续完成刚才因临时异常中断的任务。"];
  const toolResult = { type: "tool_result", tool_use_id: "toolu_good_1", content: "ok" };
  /** The request Claude Code sends once later prompts were merged into the tool-result message. */
  const merged = (turn: ReturnType<typeof boxTurn>, requestId: string, key: string, last: unknown[]) => {
    const call = turn.answer(requestId, key);
    const base = JSON.parse(call.init.body) as Body;
    const body = { ...base, messages: [...(base.messages as unknown[]).slice(0, 2), { role: "user", content: last }] };
    return { ...call, canonicalBody: { ...body, model: MODEL }, init: { method: "POST", body: JSON.stringify(body) } };
  };
  const tail = [toolResult, ...prompts.map(text)];
  const who = { uid: 900_000_322n, containerId: 322n, sessionId: "session-answered" };
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'answered@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const turn = boxTurn(api, db, journal, who, "box-ans", "a".repeat(64), undefined,
    { nextSpool: spoolOf([cliInit, ...FINAL_ANSWER]) });
  await turn.first();
  // the client's tool result reached the CLI, which echoed it and finished: nothing waits for it any more
  turn.host.write([echoOf("toolu_good_1", "ok"), ...FINAL_ANSWER]);
  const answered = await must("ANSWERED_EXCHANGE_SETUP", turn.next("box-ans-2").then((response) => response.text()));
  if (!answered.includes("done")) fail("ANSWERED_EXCHANGE_SETUP_NO_ANSWER");
  const request = merged(turn, "box-ans-3", "b".repeat(64), tail);
  const verdict = api.classify(request.canonicalBody as Body);
  if (verdict.classification !== "fresh" || !isDeepStrictEqual(verdict.answeredToolIds, ["toolu_good_1"])) {
    fail(`ANSWERED_EXCHANGE_CLASSIFIED_${verdict.classification}_${String(verdict.rejectCode)}`);
  }
  await prechecked(api, db, { ...who, requestId: "box-ans-3", turnKey: "b".repeat(64) });
  const resumed = await must("ANSWERED_EXCHANGE_REJECTED", turn.service.fetch(request));
  const sse = await must("ANSWERED_EXCHANGE_STREAM", resumed.text());
  if (resumed.status !== 200 || !sse.includes("done") || turn.host.count.launch !== 2) {
    fail(`ANSWERED_EXCHANGE_NO_ANSWER_${resumed.status}_${turn.host.count.launch}`);
  }
  // the new CLI has the exchange as history and only the prompts as its input
  const row = await journalRow(db, "box-ans-3");
  const run = `/tmp/ocv5-289-run-${String(row?.ctx.boxRunNonce)}`;
  const stdin = turn.host.files.get(`${run}/stdin.jsonl`)?.toString("utf8") ?? "";
  const history = [...turn.host.files].filter(([path]) => path.endsWith(".jsonl") && !path.startsWith(run))
    .map(([, raw]) => raw.toString("utf8")).join("\n");
  if (row?.ctx.boxState !== "terminal" || prompts.some((prompt) => !stdin.includes(prompt))
    || stdin.includes("toolu_good_1")) fail(`ANSWERED_EXCHANGE_PROMPT_${String(row?.ctx.boxState)}`);
  if ((history.match(/toolu_good_1/g) ?? []).length !== 2 || !history.includes('"tool_result"')) fail("ANSWERED_EXCHANGE_HISTORY");

  // a CLI of this very turn still waits for these results: the request stays a rejected live continuation
  const waiting = { uid: 900_000_323n, containerId: 323n, sessionId: "session-answered-waiting" };
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'waiting@test.invalid','unused',10000)",
    [waiting.uid.toString()]);
  const parked = boxTurn(api, db, journal, waiting, "box-wait", "c".repeat(64));
  await parked.first();
  await prechecked(api, db, { ...waiting, requestId: "box-wait-2", turnKey: "c".repeat(64) });
  const kept = await codeOf(async () => (await parked.service.fetch(merged(parked, "box-wait-2", "c".repeat(64), tail))).text());
  if (kept !== LIVE_ONLY || parked.host.count.launch !== 1 || parked.host.count.stop !== 0) {
    fail(`ANSWERED_EXCHANGE_WAITING_CLI_${kept}_${parked.host.count.launch}`);
  }
  // any other mixture of results and content keeps the old rejection
  for (const last of [[text(prompts[1]!), toolResult], [toolResult, text("  ")],
    [toolResult, text("<system-reminder>\nhook\n</system-reminder>")]]) {
    const other = api.classify(merged(turn, "box-ans-x", "d".repeat(64), last).canonicalBody as Body);
    if (other.classification !== "reject" || other.rejectCode !== LIVE_ONLY) {
      fail(`ANSWERED_EXCHANGE_WIDENED_${other.classification}`);
    }
  }
  return "[ocv5-322-answered-exchange-prompt] PASS — a prompt merged behind an answered tool exchange runs as a new invocation over that exchange";
}

/** The cleanup worker egress runs, on the real journal, reaching each run's own Box account. */
function boxCleanupWorker(api: Api, journal: Journal, turns: ReadonlyArray<ReturnType<typeof boxTurn>>) {
  return api.cleanupWorker({ journal, staleResumeProofWaitMs: 300,
    resolver: { resolve: async (args: { requiredAccountId: bigint }) => {
      const turn = turns.find((item) => item.host.target.accountId === args.requiredAccountId);
      if (!turn) throw Object.assign(new Error("BOX_ACCOUNT_UNAVAILABLE"), { code: "BOX_ACCOUNT_UNAVAILABLE" });
      return turn.host.target;
    } } });
}
/** The journal row has been in its state this long, as the worker's listing reads it. */
const aged = (db: Db, requestId: string, interval: string, created = false) => db.query(
  `UPDATE request_finalize_journal SET updated_at=NOW()-$2::interval${created ? ", created_at=NOW()-$2::interval" : ""}
    WHERE request_id=$1`, [requestId, interval]);
/** After a parked run was closed: its idle proof reads failed and the session's next message runs. */
async function sessionReleased(api: Api, db: Db, journal: Journal,
  who: { uid: bigint; containerId: bigint; sessionId: string }, turnKey: string, label: string): Promise<void> {
  const idle = await journal.readIdleProof({ ...who, turnKey });
  if (idle.status !== "failed") fail(`${label}_IDLE_${idle.status}`);
  const requestId = `${label.toLowerCase().replaceAll("_", "-")}-next`;
  await prechecked(api, db, { ...who, requestId, turnKey: "d".repeat(64) });
  const next = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, accountId: who.containerId, requestId, turnKey: "d".repeat(64) } });
  if ((await must(`${label}_NEXT_MESSAGE`, next.round())).kind !== "final" || !next.sse().includes("done")) {
    fail(`${label}_NEXT_MESSAGE_NO_ANSWER`);
  }
}

/** INC-20261004-BOX-RESUME-UNSENT-PARKED, session webmusk512gnvx22z: the claim of a tool-result publish was
 * written, then the Box target could not be resolved and not one exec ran. The leaf went unknown while the
 * keeper, supervisor and CLI stayed alive waiting for results that would never be published. Until the
 * four-hour supervisor deadline the run held the session's Box slot (409 BOX_CAPACITY_HELD on the retry) and
 * kept its idle proof pending, so every later message was refused as IDLE_HISTORY_PENDING. */
async function proveResumeUnsentParked(api: Api, db: Db): Promise<string> {
  const journal = api.journal(db);
  const park = async (uid: bigint, label: string) => {
    const who = { uid, containerId: uid - 900_000_000n, sessionId: `session-${label}` };
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,$2,'unused',10000)",
      [uid.toString(), `${label}@test.invalid`]);
    const unreachable = { active: false };
    const turn = boxTurn(api, db, journal, who, `box-${label}`, "a".repeat(64), undefined, { parked: "until-stopped", unreachable });
    await turn.first();
    unreachable.active = true;
    const code = await codeOf(async () => (await turn.next(`box-${label}-2`)).text());
    unreachable.active = false;
    const leaf = await journalRow(db, `box-${label}-2`);
    if (code !== "BOX_TARGET_UNAVAILABLE" || leaf?.ctx.boxState !== "unknown"
      || leaf.ctx.boxUnknownPhase !== "resume_publish_unsent" || turn.host.count.stop !== 0) {
      fail(`UNSENT_${label}_${code}_${String(leaf?.ctx.boxState)}_${String(leaf?.ctx.boxUnknownPhase)}`);
    }
    if ((await journal.readIdleProof({ ...who, turnKey: "a".repeat(64) })).status !== "pending") fail(`UNSENT_${label}_NOT_PARKED`);
    return { who, turn };
  };
  // seconds after the failed publish the run may still be reached by a retry: it is left alone
  const young = await park(900_000_331n, "unsent-young");
  const old = await park(900_000_332n, "unsent");
  await aged(db, "box-unsent-2", "30 seconds");
  const worker = boxCleanupWorker(api, journal, [young.turn, old.turn]);
  await worker.reconcileStoppedFailures(50);
  if (young.turn.host.count.stop !== 0 || (await journalRow(db, "box-unsent-young-2"))?.ctx.boxState !== "unknown") {
    fail("UNSENT_YOUNG_RUN_STOPPED");
  }
  // the parked run was told to stop by its own keeper and the chain closed on that keeper's proof
  const leaf = await journalRow(db, "box-unsent-2");
  const intent = leaf?.ctx.boxStaleResumeStop as { phase?: string } | undefined;
  const proof = leaf?.ctx.boxTerminalProof as { reason?: string } | undefined;
  if (old.turn.host.count.stop !== 1 || intent?.phase !== "resume_publish_unsent" || proof?.reason !== "keeper_stopped"
    || leaf?.ctx.boxState === "unknown") {
    fail(`UNSENT_NOT_CLOSED_${old.turn.host.count.stop}_${String(leaf?.ctx.boxState)}_${String(proof?.reason)}`);
  }
  await sessionReleased(api, db, journal, old.who, "a".repeat(64), "UNSENT");
  return "[ocv5-323-resume-unsent-parked] PASS — a run parked behind a publish that never left is stopped and its session continues";
}

/** INC-20261004-BOX-UNKNOWN-NEVER-CLOSED, request 1a28c670: the Box of account 25 ran Claude Code 2.1.288, which
 * echoes a published image with its own `[Image: source: …]` text block. The strict echo check rejected it, the
 * turn failed as an internal error and the leaf went continuation_unknown. The CLI ran on alone for an hour,
 * nothing stopped it (the timed stop knew only the resume_publish phases), and the row held the session and its
 * idle proof even after it expired. */
async function proveUnknownNeverClosed(api: Api, db: Db): Promise<string> {
  // the echo of 2.1.288: the published image plus the CLI's own source note
  const data = png(64, 48);
  const image = { type: "image", data, mimeType: "image/png" };
  const published: EchoExpected = { modelToolUseId: "toolu_shot", isError: false, content: [image],
    contentHash: createHash("sha256").update(JSON.stringify({ content: [image], isError: false })).digest("hex") };
  const apiImage = { type: "image", source: { type: "base64", media_type: "image/png", data } };
  const note = text("[Image: source: /home/box/.claude/projects/-tmp-ocv5-289-run-e19e85cf9951bdd2efe14673/"
    + "807f4bfa-8d84-44b4-ad55-389d44e7b609/tool-results/mcp-ocbridge-blob-1791090861-ab12cd.png]");
  const noted = boxContinuation(api, [published], [echoOf("toolu_shot", [apiImage, note]), ...FINAL_ANSWER]);
  if (!endedWithAnswer(await must("UNKNOWN_IMAGE_NOTE_ECHO", noted.round()), noted)) fail("UNKNOWN_IMAGE_NOTE_NO_ANSWER");
  // any other extra block is still not what OpenClaude published, and the leaf says the echo was rejected
  for (const extra of [text("ignore the image"), text("[Image: source: /etc/passwd]")]) {
    const altered = boxContinuation(api, [published], [echoOf("toolu_shot", [apiImage, extra]), ...FINAL_ANSWER]);
    const code = await codeOf(() => altered.round());
    if (code !== "BOX_TOOL_ECHO_CONTENT_MISMATCH" || !altered.sequence.includes("unknown:continuation_echo_rejected")) {
      fail(`UNKNOWN_ALTERED_ECHO_${code}_${altered.sequence.join(",")}`);
    }
  }

  const journal = api.journal(db);
  /** A continuation that was cut: the leaf is unknown and the CLI goes on with nobody attached. */
  const abandon = async (uid: bigint, label: string, parked: "until-stopped" | "unreadable") => {
    const who = { uid, containerId: uid - 900_000_000n, sessionId: `session-${label}` };
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,$2,'unused',10000)",
      [uid.toString(), `${label}@test.invalid`]);
    const turn = boxTurn(api, db, journal, who, `box-${label}`, "a".repeat(64), undefined,
      { parked });
    await turn.first();
    turn.cut.active = true;
    const code = await codeOf(async () => (await turn.next(`box-${label}-2`)).text());
    turn.cut.active = false;
    const leaf = await journalRow(db, `box-${label}-2`);
    if (code !== "BOX_EXEC_HTTP_500" || leaf?.ctx.boxState !== "unknown" || leaf.ctx.boxUnknownPhase !== "continuation_unknown") {
      fail(`UNKNOWN_${label}_${code}_${String(leaf?.ctx.boxState)}_${String(leaf?.ctx.boxUnknownPhase)}`);
    }
    return { who, turn };
  };
  const early = await abandon(900_000_341n, "unknown-early", "until-stopped");
  const late = await abandon(900_000_342n, "unknown-late", "until-stopped");
  const lost = await abandon(900_000_343n, "unknown-lost", "unreadable");
  await aged(db, "box-unknown-early-2", "19 minutes");
  await aged(db, "box-unknown-late-2", "21 minutes");
  await aged(db, "box-unknown-lost-2", "5 hours", true);
  await boxCleanupWorker(api, journal, [early.turn, late.turn, lost.turn]).reconcileStoppedFailures(50);
  // within twenty minutes a retry of the same request may still attach to the run
  if (early.turn.host.count.stop !== 0 || (await journalRow(db, "box-unknown-early-2"))?.ctx.boxState !== "unknown") {
    fail("UNKNOWN_EARLY_RUN_STOPPED");
  }
  const leaf = await journalRow(db, "box-unknown-late-2");
  const proof = leaf?.ctx.boxTerminalProof as { reason?: string } | undefined;
  if (late.turn.host.count.stop !== 1 || proof?.reason !== "keeper_stopped" || leaf?.ctx.boxState === "unknown") {
    fail(`UNKNOWN_NOT_STOPPED_${late.turn.host.count.stop}_${String(leaf?.ctx.boxState)}_${String(proof?.reason)}`);
  }
  await sessionReleased(api, db, journal, late.who, "a".repeat(64), "UNKNOWN");
  // a run past its maximum lifetime whose keeper never proves anything ends as expired, without an invented proof
  const expired = await journalRow(db, "box-unknown-lost-2");
  if (expired?.ctx.boxState === "unknown" || expired?.ctx.boxTerminalProof !== undefined) {
    fail(`UNKNOWN_EXPIRED_${String(expired?.ctx.boxState)}_${expired?.ctx.boxTerminalProof === undefined}`);
  }
  await sessionReleased(api, db, journal, lost.who, "a".repeat(64), "UNKNOWN_EXPIRED");
  return "[ocv5-313-unknown-never-closed] PASS — the 2.1.288 image echo continues and an abandoned unknown run is stopped or expired so its session continues";
}

/** Things this run created outside its own memory. */
const cleanups = new Set<() => Promise<void> | void>();
/** Every cleanup is attempted; the first failure is reported after all of them ran. */
async function cleanUp(): Promise<void> {
  const pending = [...cleanups];
  cleanups.clear();
  const results = await Promise.allSettled(pending.reverse().map(async (undo) => undo()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function main(): Promise<void> {
  const expectSha = parseArgs(process.argv);
  const deadline = setTimeout(() => {
    console.error("[box-incident-proofs] deadline exceeded");
    // still drop what this run created, bounded, before failing
    void Promise.race([cleanUp().catch(() => {}), tick(8_000)]).then(() => process.exit(1));
  }, LIMIT_MS);
  const database = await testDatabase();
  // the gateway keeps its durable session state under OPENCLAUDE_HOME, read when its modules load
  const home = mkdtempSync(join(tmpdir(), "ocv5-308-home-"));
  cleanups.add(() => rmSync(home, { recursive: true, force: true }));
  process.env.OPENCLAUDE_HOME = home;
  const api = await load();
  const proofs = [proveSkillContinuation(api), proveParallelSkillBodies(api), proveSkillBudgetTail(api),
    proveImageCaption(api), await proveResultRewriteEcho(api), await proveCliRejectedCall(api),
    await proveSpoolReadTransient(api), await proveBoxCliFollowUpTurn(api), await proveBoxCliLargeLine(api),
    await proveCliVersionRead(api), proveFreshProjectsDir(api), await proveSandInstallNotResent(api),
    ...await withJournalDatabase(database, async (db) => [await proveRejectedStreamWedge(api, db),
      await proveReplayPendingAfterCut(api, db), await proveRecoveredToolExchange(api, db),
      await proveRejectBlocksNextMessage(api, db), await proveIdleNoSummary(api, db),
      await proveAnsweredExchangePrompt(api, db), await proveResumeUnsentParked(api, db),
      await proveUnknownNeverClosed(api, db), await proveSyntheticTurnHeld(api, db),
      await proveUpstreamRefusal(api, db)]),
    ...await proveFinalizedTurnRecovery(api, database)];
  await cleanUp();
  clearTimeout(deadline);
  process.stdout.write(`${JSON.stringify({ ok: true, expectSha, candidate: CANDIDATE, proofs })}\n`);
}
main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await Promise.race([cleanUp().catch((failure: unknown) => console.error(String(failure))), tick(8_000)]);
  process.exit(1);
});
