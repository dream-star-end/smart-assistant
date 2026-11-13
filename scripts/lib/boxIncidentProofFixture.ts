/** Test-only shared fixture for the pinned Box incident proof gate.
 * Candidate root and failure behavior are explicit; the factory is instantiated
 * once by the main gate after its top-level constants, before main() starts. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export type Body = Record<string, unknown>;
export type Expected = { id: string; boxName: string; clientName: string; input: Record<string, unknown> };
export type Api = {
  localCatalogOwner: (legacyWire: Body) => Promise<Record<string, unknown>>;
  gate: (body: Body, toolBridgeEnabled: boolean) => string | null;
  classify: (body: Body) => { classification: string; rejectCode: string | null; toolIds?: readonly string[];
    answeredToolIds?: readonly string[] };
  match: (body: Body, expected: readonly Expected[]) => ReadonlyArray<Matched>;
  compile: (body: Body) => { snapshotJsonl: string; stdinJsonl: string };
  fitForCli: (results: readonly Matched[]) => Promise<readonly Matched[]>;
  echo: (expected: readonly EchoExpected[]) => { accept: (raw: unknown) => void;
    verifyDeferred: () => Promise<void>; assertComplete: () => void };
  decoder: (model: string, tools: unknown[]) => Decoder;
  pollSpool: (input: { exec: unknown; access: unknown; startOffset: number; deadlineMs: number;
    pollIntervalMs: number; retryDelaysMs?: readonly number[] }) => AsyncGenerator<{ text: string; endOffset: number }>;
  spoolAccess: () => unknown;
  transportError: (code: string) => Error;
  isSpoolTerminalError: (error: unknown) => boolean;
  /** OCV5-509: whether a failed replay re-read is the run's own deterministic refusal. */
  replayRejection: (error: unknown) => boolean;
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
  /** OCV5-488: the product's Box billing recovery for one row: it settles a handoff's completed calls. */
  settleBoxBilling: (db: Db, requestId: string, uid: bigint) => Promise<string>;
  /** OCV5-488: the journal writes that release a Box run held by nothing. */
  holds: (db: Db) => unknown;
  /** OCV5-488: the ops.box_hold_stuck alert's own query and row mapping. */
  boxHoldStuck: { sql: string; rows: (rows: unknown[]) => Array<{ requestId: string; absent: boolean }> };
  jsonError: (res: unknown, status: number, code: string, message: string, requestId: string) => void;
  /** egress' model authority gate reject, as /v1/messages serializes it. */
  gateReject: (kind: string, detail: string) => { status: number; code: string; clientMessage: string };
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
  /** OCV5-509: the reconciler sweep that closes a recovery chain paused before it ran. */
  closeRefusedRecoveryChains: (pool: unknown) => Promise<number>;
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
export type BoxRequest = { command: string; args: string[]; cwd: string; environment: Record<string, string> };
export type PrelaunchIdentity = { runNonce: string; leaseEpoch: string; controlId: string; accountId: string };
export type PrelaunchReceipt = PrelaunchIdentity & { identityHash: string };
export type SessionsBackend = { admitUserTurn: (input: unknown) => Promise<{ kind: string }>;
  stageLosslessTurnTapePart: (userId: string, request: unknown, bytes: Buffer) => Promise<unknown>;
  finalizeLosslessTurnTape: (userId: string, request: unknown) => Promise<{ applied: string }>;
  getClientSession: (sessionId: string, userId: string) => Promise<{ messages: Array<{ id?: string }> } | null>;
  appendServerAuthoredMessage: (sessionId: string, userId: string, message: Record<string, unknown> & { id: string; role: string }) =>
    Promise<{ applied: boolean }> };
export type RouteHandler = (req: unknown, res: unknown, ctx: { hostUuid: string; boundIp: string }) => Promise<void>;
export type IdleOp = { runnerKilledAt?: number; disposition?: string; abandonReason?: string; [key: string]: unknown };
export type IdleFiles = { IDLE_STOPPED_GRACE_MS: number;
  readIdleCandidate: (dir: string, key: string) => unknown; readPendingIdle: (dir: string, key: string) => unknown;
  readIdleOp: (dir: string, key: string, revision: string) => IdleOp | undefined;
  writeIdleOp: (dir: string, op: IdleOp) => void; writeIdleCandidate: (dir: string, candidate: unknown) => void;
  startIdleOp: (input: unknown) => { op: IdleOp }; writeIdleNative: (dir: string, native: unknown) => void;
  idleHistoryStillBlocked: (input: { candidate: unknown; pending: unknown; recovered: unknown }) => boolean;
  setRuntimeIncarnationStartForTest: (ms: number | undefined) => void };
export type ReplayLookup = { kind: string; response?: Response;
  failure?: { code: string; diagnostic?: Record<string, unknown> };
  identity?: { state?: string; rootLaunchPermit?: boolean; invocationMode?: string } };
export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };
export type Journal = { readIdleProof: (input: { uid: bigint; containerId: bigint; sessionId: string; turnKey: string }) =>
  Promise<{ status: string; requestIds?: string[] }>; [method: string]: (...args: never[]) => Promise<unknown> };
export type Decoder = {
  push: (chunk: string) => { sse: string; candidate: { toolUses: ReadonlyArray<{ id: string; clientName: string }>;
    inputTokens: number; outputTokens: number; cacheReadTokens: number } | null; finalCandidate: unknown };
  completedMessage: () => { id?: unknown; content?: unknown };
  commitHandoff: (proof: { durableRevision: string; journaledToolUseIds: string[];
    verifiedPendingToolUseIds: string[] }) => string;
};
export type Matched = { modelToolUseId: string; isError: boolean; contentHash: string;
  content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }> };
export type EchoExpected = { modelToolUseId: string; isError: boolean; contentHash: string; content?: unknown };
export type ExecRequest = { args: string[]; environment?: Record<string, string> };
export type ExecReply = { stdout: string; stderrBytes: number; exitCode: 0 };

export function createBoxIncidentProofFixture(CANDIDATE: string, fail: (message: string) => never) {
  const PROXY = join(CANDIDATE, "packages/commercial/src/http/proxy");
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
  const holdStuck = await import(pathToFileURL(join(PROXY, "boxHoldStuck.ts")).href);
  const holdRelease = await import(pathToFileURL(join(PROXY, "boxHoldRelease.ts")).href);
  const boxBilling = await import(pathToFileURL(join(CANDIDATE,
    "packages/commercial/src/billing/boxBillingRecovery.ts")).href);
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
  const authorityGate = await import(pathToFileURL(join(PROXY, "modelAuthorityGate.ts")).href);
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
  const refusedCards = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/db/refusedRecoveryCards.ts")).href);
  const mapper = await import(pathToFileURL(join(PROXY, "boxMessagesMapper.ts")).href);
  const localCatalog = await import(pathToFileURL(join(GATEWAY, "modelCatalogClient.ts")).href);
  const spawnConfig = await import(pathToFileURL(join(GATEWAY, "subprocessSpawnConfig.ts")).href);
  const modelSnapshot = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/billing/modelCatalog.ts")).href);
  const catalogHttp = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/http/internalModelCatalog.ts")).href);
  const containerIdentity = await import(pathToFileURL(join(CANDIDATE, "packages/commercial/src/auth/containerIdentity.ts")).href);
  return {
    localCatalogOwner: async (legacyWire) => {
      const model = "box-api-claude-haiku-5-5";
      const snapshot = new modelSnapshot.ModelCatalogSnapshot({ entries: [{ entryId: 1, modelId: model,
        engine: "ccb", providerId: "box_cli", upstreamModelId: null, contextWindow: 200000,
        capabilityProfile: { supportsVision: false, reasoning: { supported: ["low"], codexModelDefault: null },
          ccb: { capabilityZero: true, supportsThinking: false, contextOwner: "box-native-v1" } },
        capabilitySchemaVersion: 1, state: "active", lockVersion: 0 }], aliases: new Map(),
        pricing: new Map([[model, { modelId: model, displayName: model, inputPerMtok: 100n, outputPerMtok: 500n,
          cacheReadPerMtok: 10n, cacheWritePerMtok: 100n, multiplier: "1.000", visibility: "public",
          sortOrder: 1, defaultEffort: "low" }]]), securityEpoch: 5n });
      const secret = "a".repeat(64), token = `oc-v3.7.${secret}`;
      const authz = { role: "admin" as const, grantedModelIds: new Set<string>() };
      const handler = catalogHttp.makeModelCatalogHandler({ identityRepo: {
        async findActiveByHostAndBoundIp() { return { id: 7, user_id: 3, bound_ip: "127.0.0.1",
          host_uuid: "fixture-518", secret_hash: containerIdentity.hashSecret(secret) }; },
      }, catalog: { async assertFresh() { return snapshot; } }, loadUserModelAuthz: async () => authz,
        readEpoch: async () => 5n, loadRoutingAvailability: async () => ({ unavailableProviderIds: new Set<string>(),
          revision: "fixture-availability" }), loadAgentCostOverrides: async () => ({}) });
      let fullFetches = 0, wireOwner: unknown;
      const env = { OC_MODEL_AUTHORITY: "1", OPENCLAUDE_V3_MASTER_BASE_URL: "http://fixture.invalid",
        OPENCLAUDE_V3_CONTAINER_TOKEN: token };
      const lkgPath = join(process.env.OPENCLAUDE_HOME!, "ocv5-518-legacy-lkg.json");
      writeFileSync(lkgPath, JSON.stringify(legacyWire));
      const fetcher = (async (url: string, init: { headers: Record<string, string> }) => {
        const path = new URL(url).pathname;
        let text = "";
        const res = { statusCode: 0, setHeader() {}, end(value?: string) { text = value ?? ""; } };
        await handler({ method: "GET", url: path, headers: init.headers } as never, res as never,
          { hostUuid: "fixture-518", boundIp: "127.0.0.1" });
        if (path === protocol.MODEL_CATALOG_PATH) {
          fullFetches += 1;
          wireOwner = JSON.parse(text).models?.find((row: { model_id: string }) => row.model_id === model)?.context_owner;
        }
        return { statusCode: res.statusCode, body: (async function* () { yield Buffer.from(text); })() };
      }) as never;
      const client = new localCatalog.ModelCatalogClient({ env, lkgPath, fetcher });
      localCatalog._setModelCatalogClientForTests(client);
      try {
        const runtime = await spawnConfig.resolveTurnRuntime(undefined, model, env, "ccb");
        const view = await client.getView();
        const cold = await new localCatalog.ModelCatalogClient({ env, lkgPath, fetcher }).getView();
        const localToken = runtime.headers!.localCatalog!;
        const gateDecision = await authorityGate.enforceModelAuthority({ catalog: { async assertFresh() { return snapshot; } },
          keyring: null, headers: { [localCatalog.LOCAL_CATALOG_HEADER]: localToken }, uid: 3n, containerId: 7n,
          model, loadUserModelAuthz: async () => authz });
        return { wireOwner, descriptorOwner: runtime.descriptor?.contextOwner,
          coldOwner: cold.resolve(model)?.contextOwner, projectionFormat: view.projectionFormat,
          projectionRevision: view.projectionRevision, fullFetches,
          token: JSON.parse(Buffer.from(localToken, "base64url").toString("utf8")), gateKind: gateDecision.authorityKind };
      } finally { localCatalog._setModelCatalogClientForTests(null); }
    },
    gate: gate.validateBoxRequest, classify: prepared.classifyBoxContinuation,
    compile: (body: Body) => mapper.compileBoxCliSyntheticTurn(body, { cwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`, cliVersion: "2.1.280" }),
    match: matcher.matchBoxToolResults, fitForCli: images.normalizeBoxResultImagesForCli,
    echo: (expected) => new echo.BoxToolResultEcho(expected),
    decoder: (model, tools) => new handoff.BoxCliToolHandoffDecoder(model,
      catalog.compileBoxToolCatalog(tools, "natural")),
    pollSpool: poller.pollBoxSpoolLines,
    spoolAccess: () => access.makeBoxDetachedRunAccess({ runNonce: "a".repeat(24), detachedRunnerHash: "b".repeat(64) }),
    transportError: (code) => new transport.BoxExecTransportError(code, false),
    isSpoolTerminalError: (error) => error instanceof poller.BoxSpoolTerminalError,
    replayRejection: observer.isBoxReplayRejection,
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
    boxHoldStuck: { sql: holdStuck.BOX_HOLD_STUCK_SQL, rows: holdStuck.boxHoldStuckRows },
    holds: (db) => new holdRelease.BoxHoldRelease({ query: db.query.bind(db) }),
    settleBoxBilling: (db, requestId, uid) => boxBilling.recoverBoxBillingRequest({ query: db.query.bind(db),
      connect: async () => ({ query: db.query.bind(db), release: () => {} }) }, requestId, uid),
    jsonError: shared.sendJsonError,
    gateReject: (kind: string, detail: string) => new authorityGate.ModelGateReject(kind, detail),
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
    closeRefusedRecoveryChains: (pool) => refusedCards.closeRefusedRecoveryChains(pool),
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



const reply = (stdout = ""): ExecReply => ({ stdout, stderrBytes: 0, exitCode: 0 });
const isRunner = (args: string[]) => args[0] === "-I" && args[1] === "-c"
  && args[2]?.includes("sys.argv=[p,*argv]") === true
  && args[3]?.startsWith("/tmp/ocv5-289-v2-detached-runner-") === true;
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** `work`, or "still-running" after `ms`; the timer is cleared either way (OCV5-557: these bounds are 20 s+). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "still-running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<"still-running">((resolve) => { timer = setTimeout(() => resolve("still-running"), ms); })]);
  } finally { clearTimeout(timer); }
}
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
  pendingArguments?: unknown; // OCV5-509: the arguments the CLI called the tool with (default: the model's)
  /** OCV5-488: what the read-only liveness probe finds of the run on the Box (default: alive). */
  liveness?: { state: string; boot: string };
  capacityWaitMs?: number;
  signal?: AbortSignal;
  /** The durable journal on real Postgres instead of the in-memory one. */
  real?: { journal: unknown; uid: bigint; requestId: string; sessionId: string; turnKey: string;
    messages?: unknown[]; resumeToolResults?: boolean; proofReason?: string;
    nextSpool?: Buffer; stopIgnored?: boolean; dispatchId?: string; workerExitCode?: number; cleanupSpool?: boolean;
    /** The Box account this session is pinned to (its capacity is per account). */
    accountId?: bigint;
    stopRejectedRun?: (identity: unknown) => Promise<string> } } = {}) {
  const sequence: string[] = [];
  const emitted: string[] = [];
  /** What each handoff recorded in the journal (the claim the next round is built from). */
  const handoffs: unknown[] = [];
  const count = { admit: 0, launch: 0, spoolRead: 0, pendingRead: 0, proofRead: 0, stop: 0, look: 0, cleanup: 0 };
  const spoolOffsets: number[] = [];
  // biome-ignore lint/style/useSingleVarDeclarator: moved verbatim from the commercial copy of this file (OCV5-488)
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
      spoolOffsets.push(offset);
      const bytes = spool.subarray(offset);
      return reply(JSON.stringify({ data: bytes.toString("base64"), offset: offset + bytes.length }));
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
      faults.pendingRead?.(++count.pendingRead);
      return reply(JSON.stringify({ version: 1, modelToolUseId: args[4], mcpRequestId: 7,
        name: "Bash", arguments: faults.pendingArguments ?? { value: "x" } }));
    }
    if (args.length === 5 && args[2]?.includes("signal.pidfd_send_signal")
      && /^[a-f0-9]{24}$/.test(args[3] ?? "") && /^[a-f0-9]{32}$/.test(args[4] ?? "")) {
      // Match the keeper script, not just its nonce/epoch shape: the liveness probe has the same five arguments.
      // A CLI still waiting for tool results stops; one that already exited does not.
      count.stop++;
      if (faults.real?.proofReason === undefined && !faults.real?.stopIgnored) stopped.add(args[3]!);
      return reply("stop-requested\n");
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("/proc/sys/kernel/random/boot_id")) {
      count.look++;
      return reply(`${faults.liveness?.state ?? "alive"} ${faults.liveness?.boot ?? PROOF_BOOT}\n`);
    }
    if (faults.real?.cleanupSpool && args[2]?.includes("nonce,keep=sys.argv[1:]")
      && args[2].includes("def clear_session(parent,name):")) {
      if (args[3] !== nonce || !["0", "1"].includes(args[4] ?? "")) fail("BOX_HOST_CLEANUP_IDENTITY");
      count.cleanup++;
      spool = Buffer.alloc(0);
      return reply("clean\n");
    }
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("terminal.json")) {
      faults.proofRead?.(++count.proofRead);
      const asked = args[3]?.slice(-24) ?? nonce;
      const reason = stopped.has(asked) ? "keeper_stopped" : faults.real?.proofReason ?? "worker_complete";
      return reply(`${JSON.stringify({ runNonce: asked, leaseEpoch: epochs.get(asked) ?? epoch, keeperPid: 101,
        cliPid: 102, reason, revision: reason === "worker_failed" ? 2 : 1,
        ...(reason === "worker_failed" ? { workerExitCode: faults.real?.workerExitCode ?? 1 } : {}) })}\n`);
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
      handoffs.push(arg.candidate);
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
  return { round, call, deps, target, sequence, count, staged, files, handoffs, spoolOffsets, sse: () => emitted.join(""),
    /** The CLI goes on and appends to its stdout spool. */
    write: (records: unknown[]) => { spool = Buffer.concat([spool, spoolOf(records)]); },
    clearSpool: () => { spool = Buffer.alloc(0); },
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
  proofRead?: (call: number) => void } = {}, catalogHash = api.catalogHash(CLI_TOOLS),
  /** Fields the previous round's handoff recorded on the claim (e.g. its hidden calls). */
  recorded: Record<string, unknown> = {}) {
  const sequence: string[] = [];
  const emitted: string[] = [];
  const count = { spoolRead: 0, pendingRead: 0, proofRead: 0 };
  const offsets: number[] = [];
  const claim = { ownerRequestId: "box-owner", accountId: 20n, runNonce: "a".repeat(24),
    leaseEpoch: "b".repeat(32), spoolOffset: 1234, roundNo: 2, detachedRunnerHash: "b".repeat(64),
    catalogHash, durableRevision: "rev-1", results,
    toolUses: results.map((result) => ({ id: result.modelToolUseId, boxName: BOX_BASH, clientName: "Bash",
      inputHash: "f".repeat(64) })), ...recorded };
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
  // biome-ignore lint/style/useSingleVarDeclarator: moved verbatim from the commercial copy of this file (OCV5-488)
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
    // ids of the settled rows, as the billing recovery integ test numbers them (OCV5-488)
    for (const table of ["usage", "ledger"]) await client.query(`CREATE TEMP SEQUENCE box_recovery_${table}_id_seq`);
    await client.query("ALTER TABLE pg_temp.usage_records ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_recovery_usage_id_seq'::regclass)");
    await client.query("ALTER TABLE pg_temp.credit_ledger ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_recovery_ledger_id_seq'::regclass)");
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,
      user_id bigint NOT NULL, status text NOT NULL)`);
    // OCV5-488: the cleanup worker asks whether a row's container is still the user's active one
    await client.query(`CREATE TEMP TABLE agent_containers (id bigint PRIMARY KEY,
      user_id bigint NOT NULL, state text NOT NULL)`);
    const shadow = await client.query(`SELECT n.nspname AS schema FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = ANY (ARRAY[to_regclass('request_finalize_journal'), to_regclass('usage_records'),
        to_regclass('users'), to_regclass('credit_ledger'), to_regclass('turn_dispatches'),
        to_regclass('agent_containers')])`);
    if (shadow.rows.length !== 6 || shadow.rows.some((row: { schema: string }) => !/^pg_temp(?:_\d+)?$/.test(row.schema))) {
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
  // the request came from this container, so it is the user's active one
  await db.query(`INSERT INTO agent_containers(id,user_id,state) VALUES ($1,$2,'active')
    ON CONFLICT (id) DO NOTHING`, [row.containerId.toString(), row.uid.toString()]);
}
const journalRow = async (db: Db, requestId: string) => (await db.query(
  // biome-ignore lint/style/noUnusedTemplateLiteral: moved verbatim from the commercial copy of this file (OCV5-488)
  `SELECT state,failure_code,final_credits::text AS credits,ctx FROM request_finalize_journal WHERE request_id=$1`,
  [requestId])).rows[0] as { state: string; failure_code: string | null; credits: string | null;
    ctx: Record<string, unknown> } | undefined;
const money = async (db: Db, uid: bigint) => JSON.stringify((await db.query(`SELECT
  (SELECT COUNT(*)::text FROM usage_records) AS usage, (SELECT COUNT(*)::text FROM credit_ledger) AS ledger,
  (SELECT credits::text FROM users WHERE id=$1) AS wallet`, [uid.toString()])).rows);

function boxTurn(api: Api, db: Db, journal: Journal, who: { uid: bigint; containerId: bigint; sessionId: string },
  name: string, turnKey: string, writeMessage?: unknown,
  options: { dispatchId?: string; nextSpool?: Buffer; stopIgnored?: boolean;
    /** The CLI stays alive waiting: no terminal proof exists until its keeper is told to stop. */
    parked?: "until-stopped" | "unreadable";
    /** The Box account cannot be reached for a continuation publish. */
    unreachable?: { active: boolean };
    /** OCV5-488: what a liveness look finds of this run on the Box. */
    liveness?: { state: string; boot: string };
    /** OCV5-762: a rejected round is stopped through the product's stop coordinator, as egress wires it. */
    stopRejected?: boolean } = {}) {
  const cut = { active: false, code: "BOX_EXEC_HTTP_500" };
  const { parked, unreachable, liveness, stopRejected, ...hostOptions } = options;
  const host: ReturnType<typeof boxHost> = boxHost(api, spoolOf([cliInit, ...BRIDGE_CALL]), {
    ...(parked ? { proofRead: () => { if (parked === "unreadable" || host.count.stop === 0) throw api.transportError("BOX_EXEC_REMOTE_EXIT"); } } : {}),
    ...(liveness ? { liveness } : {}),
    // the exec stream of a continuation is cut in a way a re-read cannot repair
    spoolRead: () => { if (cut.active) throw api.transportError(cut.code); },
    real: { journal, ...who, accountId: who.containerId, requestId: `${name}-1`, turnKey, ...hostOptions } });
  const service = api.toolFetch({ ...host.deps, ...(writeMessage ? { writeMessage } : {}),
    ...(unreachable ? { resolveTarget: async () => {
      if (unreachable.active) throw Object.assign(new Error("BOX_TARGET_UNAVAILABLE"), { code: "BOX_TARGET_UNAVAILABLE" });
      return host.target;
    } } : {}),
    stopOrphanRun: (identity: unknown) => api.stopCoordinator(journal, host.target).requestStop(identity),
    ...(stopRejected ? { stopRejectedRun: (identity: unknown) =>
      api.stopCoordinator(journal, host.target).requestStop(identity) } : {}) });
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

const PROOF_BOOT = "6c1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
  return {
    load, MODEL, text, CLI_MODEL, BOX_BASH, CLI_TOOLS,
    event, cliInit, start, say, call, stop,
    cliError, REJECTED_CALL, BRIDGE_CALL, spoolOf, reply, isRunner,
    tick, within, must, codeOf, boxHost, boxContinuation,
    FINAL_ANSWER, echoOf, publishedText, endedWithAnswer, TEXT_MODEL, TEXT_USAGE,
    TEXT_ANSWER, boxTextHost, testDatabase, withJournalDatabase, JOURNAL_PRICING, prechecked,
    journalRow, money, boxTurn, PROOF_BOOT,
  };
}
