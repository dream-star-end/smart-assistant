import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import {
  DISPATCH_AUTHORITY_FIELD,
  MODEL_AUTHORITY_FIELD,
  computeDispatchRequestHash,
  verifyAuthority,
  verifyDispatchAuthority,
} from "@openclaude/protocol";
import {
  DEFAULT_CCB_SUBAGENT_MODEL,
  DEFAULT_SECONDARY_UTILITY_MODEL,
  ModelAuthorityConsumer,
  buildContainerAttestFrame,
} from "@openclaude/gateway";
import { DispatchAuthorityConsumer, durableTurnDispatchCapabilities } from "../../../../gateway/src/turnDispatchInbox.js";
import { signAccess } from "../../auth/jwt.js";
import { ModelCatalogSnapshot, type ModelCatalogCache, type ModelCatalogEntry, type ModelCatalogPricing } from "../../billing/modelCatalog.js";
import { InMemoryPreCheckRedis } from "../../billing/preCheck.js";
import { PricingCache } from "../../billing/pricing.js";
import { resetPool, setPoolOverride } from "../../db/index.js";
import { resetLiveUnitCheckpointScheduler } from "../../db/liveUnitCheckpoints.js";
import { persistGatewayLiveFrame } from "../../db/liveTurnFrames.js";
import { createPgSessionsBackend } from "../../db/pgSessionsBackend.js";
import { buildSessionSnapshot } from "../../db/sessionSnapshot.js";
import { createLogger } from "../../logging/logger.js";
import { _clearMaintenanceCache } from "../../middleware/maintenanceMode.js";
import { AuthoritySigner } from "../../ws/authoritySigner.js";
import { resolveContainerLinkEndpoint } from "../../ws/containerLinkEndpoint.js";
import { BRIDGE_WS_PATH, createUserChatBridge, type CronOriginInjectInput, type UserChatBridgeDeps } from "../../ws/userChatBridge.js";
import type { AgentModelResolver } from "../../ws/agentModelAuthority.js";
import { getTestDatabaseUrlForTempTables } from "./db.js";

export const ORIGIN_UID = 42n;
export const ORIGIN_CARRIER = 7;
export const ORIGIN_BUNDLE_REV = "aabbccddeeff";
const JWT_SECRET = "origin-link-fixture-secret-32-bytes";

export async function originEventually(check: () => boolean | Promise<boolean>, detail: () => string = () => ""): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`origin link condition timed out: ${detail()}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function catalog(): ModelCatalogCache {
  const models = [...new Set(["glm-5.2", DEFAULT_CCB_SUBAGENT_MODEL, DEFAULT_SECONDARY_UTILITY_MODEL])];
  const entries: ModelCatalogEntry[] = models.map((modelId, index) => ({
    entryId: index + 1, modelId, engine: "ccb", providerId: "zhipu", upstreamModelId: null,
    contextWindow: 200_000, capabilityProfile: { supportsVision: false,
      reasoning: { supported: ["low", "medium", "high"], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: true } },
    capabilitySchemaVersion: 1, state: "active", lockVersion: 1,
  }));
  const pricing = new Map<string, ModelCatalogPricing>(models.map(modelId => [modelId, {
    modelId, displayName: modelId, inputPerMtok: 1n, outputPerMtok: 2n,
    cacheReadPerMtok: 1n, cacheWritePerMtok: 1n, multiplier: "1.000", visibility: "public",
    sortOrder: 0, defaultEffort: null,
  }]));
  const snapshot = new ModelCatalogSnapshot({ entries, pricing, aliases: new Map(), securityEpoch: 12n });
  return { peek: () => snapshot, current: () => snapshot, assertFresh: async () => snapshot } as unknown as ModelCatalogCache;
}

// Private schema, actual admission/receipt/frame SQL, and separate transaction
// connections. A shared Client would hide the concurrent admission row lock.
const SCHEMA_SQL = `
  CREATE TABLE users(id bigint PRIMARY KEY,role text,credits bigint,status text NOT NULL DEFAULT 'active');
  INSERT INTO users(id,role,credits) VALUES(42,'user',1000000);
  CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb NOT NULL,description text,
    updated_at timestamptz DEFAULT now(),updated_by bigint);
  CREATE TABLE user_subscriptions(user_id bigint,status text,period_end timestamptz,period_credits bigint);
  CREATE TABLE org_memberships(user_id bigint,org_id bigint,status text,billing_enabled boolean);
  CREATE TABLE orgs(id bigint,credits bigint,status text);
  CREATE TABLE org_subscriptions(org_id bigint,status text,period_end timestamptz,period_credits bigint);
  CREATE TABLE client_sessions(id text PRIMARY KEY,user_id text,agent_id text DEFAULT 'main',title text,
    created_at bigint DEFAULT 1,last_at bigint DEFAULT 1,updated_at bigint DEFAULT 1,deleted_at bigint,
    messages text DEFAULT '[]',message_count int DEFAULT 0,next_seq int DEFAULT 1,
    archived_through_seq int DEFAULT 0,archived_count int DEFAULT 0,workspace_mode text DEFAULT 'legacy',
    history_revision bigint DEFAULT 0,model_id text DEFAULT 'glm-5.2');
  CREATE TABLE client_session_archived_ids(session_id text,msg_id text,PRIMARY KEY(session_id,msg_id));
  CREATE TABLE compute_hosts(id uuid,name text);
  CREATE TABLE agent_containers(id bigint PRIMARY KEY,user_id bigint,state text,runtime_channel text,
    runtime_kind text,bound_ip inet,port int,host_uuid uuid,container_internal_id text,bundle_rev text);
  CREATE TABLE turn_dispatches(dispatch_id uuid PRIMARY KEY,user_id bigint,session_id text,client_message_id text,
    agent_id text,model text,request_hash text,billing_request_id text UNIQUE,attempt_no int,status text,outcome text,
    failure_code text,conflict_reason text,resolution text,resolved_at timestamptz,client_notified boolean DEFAULT false,
    owner_id text,lease_epoch bigint,lease_until timestamptz,anchor_seq bigint,admitted_at timestamptz DEFAULT now(),
    accepted_at timestamptz,terminal_at timestamptz,last_attempt_at timestamptz,visible_head jsonb,visible_at bigint,
    producer_fenced_at timestamptz,shutdown_ctx jsonb,agent_container_id bigint,runtime_kind text,trace_id text,
    UNIQUE(user_id,session_id,client_message_id));
  CREATE TABLE authority_turn_dispatches(authority_turn_id text PRIMARY KEY,user_id bigint,dispatch_model text,
    canonical_model text,session_id text,dispatch_id uuid,attempt_no int,UNIQUE(dispatch_id,attempt_no));
  CREATE TABLE client_session_live_streams(stream_key text PRIMARY KEY,user_id text,session_id text,
    client_message_id text,dispatch_id uuid,attempt_no int,agent_container_id bigint,source text,
    projection_source text DEFAULT 'live',provenance jsonb DEFAULT '{}',terminal_status text,tape_id text,
    tape_sha256 text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
  CREATE TABLE client_session_live_frames(record_id bigserial PRIMARY KEY,stream_key text,source text,
    agent_container_id bigint,session_key text,frame_seq bigint,payload bytea,payload_sha256 text,
    created_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX origin_frame_identity ON client_session_live_frames(agent_container_id,session_key,frame_seq)
    WHERE source='gateway';
  CREATE TABLE client_session_turn_tapes(session_id text,user_id text,tape_id text,turn_key text,client_message_id text,
    dispatch_id uuid,attempt_no int,status text,tape_sha256 text,finalized_at bigint,visible_at bigint,visible_head jsonb);
  CREATE TABLE usage_records(user_id bigint,dispatch_id uuid,attempt_no int,created_at timestamptz,turn_key text,parent_turn_key text);
  CREATE TABLE turn_tape_cost_components(session_id text,user_id text,tape_id text,request_id text,cost_credits numeric);
  CREATE TABLE pending_usage_patches(user_id text,turn_key text,parent_turn_key text,request_id text,cost_credits text);
  CREATE TABLE turn_permission_requests(user_id bigint,session_id text,request_id text,client_message_id text,
    tool_use_id text,tool_name text,input_sha256 text,input_json jsonb,ask_payload_json jsonb,expires_at timestamptz,
    status text DEFAULT 'pending',response_control_id text,response_json jsonb,
    created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,request_id));
  CREATE TABLE turn_control_requests(control_id text PRIMARY KEY,user_id bigint,session_id text,
    root_client_message_id text,kind text,request_id text,payload_json jsonb,status text DEFAULT 'pending',
    lease_owner text,lease_epoch bigint DEFAULT 0,lease_until timestamptz,delivery_attempt int DEFAULT 0,
    next_attempt_at timestamptz DEFAULT now(),error_code text,created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),applied_at timestamptz,terminal_at timestamptz);
  CREATE TABLE turn_recovery_jobs(job_id uuid PRIMARY KEY,user_id bigint,session_id text,
    root_client_message_id text,source_client_message_id text,source_turn_key text,error_code text,
    recovery_mode text,semantic_recovery_attempt int,transport_wait_attempt int DEFAULT 0,request_json jsonb,
    tape_sha256 text,status text DEFAULT 'queued',lease_owner text,lease_epoch bigint DEFAULT 0,
    lease_until timestamptz,next_attempt_at timestamptz DEFAULT now(),pause_reason text,dispatch_id uuid,
    dispatch_attempt_no int,terminal_outcome text,container_receipt_at timestamptz,
    created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
`;

type Frame = Record<string, any>;
export async function originLinkRig() {
  const url = getTestDatabaseUrlForTempTables();
  assert.match(new URL(url).pathname, /_test$/);
  const schema = `origin_link_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1500 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6, connectionTimeoutMillis: 1500 });
  const sockets: WebSocket[] = [];
  const browsers: WebSocket[] = [];
  const messages: Frame[] = [];
  const hellos: Frame[] = [];
  const produced = new Map<string, Frame[]>();
  const errors: Error[] = [];
  const events: string[] = [];
  const checkerLoads: Array<{ uid: bigint; epoch: bigint | undefined }> = [];
  const resolverLoads: Array<{ uid: bigint; bundleRev: string | null | undefined }> = [];
  const authorization = { allowed: true, epoch: 12n, ready: true };
  let activity = 0;
  let provisioning = 0;
  const signer = AuthoritySigner.createEphemeral();
  const container = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => container.once("listening", resolve));
  const port = (container.address() as { port: number }).port;
  await pool.query(SCHEMA_SQL);
  await pool.query(`INSERT INTO agent_containers VALUES(7,42,'active','v5','docker','127.0.0.1',$1,NULL,'origin-fixture',$2)`, [port, ORIGIN_BUNDLE_REV]);
  setPoolOverride(pool);
  _clearMaintenanceCache();

  container.on("connection", socket => {
    sockets.push(socket);
    const consumer = new ModelAuthorityConsumer({ keyring: signer.publicKeyring(), containerId: ORIGIN_CARRIER, uid: Number(ORIGIN_UID), required: true });
    const dispatchConsumer = new DispatchAuthorityConsumer({ keyring: signer.publicKeyring(),
      containerId: String(ORIGIN_CARRIER), uid: String(ORIGIN_UID) });
    const connection = consumer.newConnection();
    const attest = buildContainerAttestFrame(consumer, connection, ORIGIN_CARRIER);
    // Match wsConnection's combined model/durable-dispatch readiness broadcast.
    attest.capabilities.push(...durableTurnDispatchCapabilities(dispatchConsumer.enabled, true));
    socket.send(JSON.stringify(attest));
    socket.on("message", data => {
      try {
        const frame = JSON.parse(String(data)) as Frame;
        if (frame.type === "inbound.hello") {
          hellos.push(frame);
          for (const peer of frame.peers ?? []) {
            for (const output of produced.get(peer.peerId) ?? []) {
              if (output.frameSeq > peer.lastFrameSeq) socket.send(JSON.stringify(output));
            }
          }
          return;
        }
        if (frame.type !== "inbound.message") return;
        const dispatch = verifyDispatchAuthority(frame[DISPATCH_AUTHORITY_FIELD], signer.publicKeyring(), Date.now());
        assert.equal(dispatch.uid, ORIGIN_UID.toString());
        assert.equal(dispatch.containerId, String(ORIGIN_CARRIER));
        assert.equal(dispatch.clientMessageId, frame.clientMessageId);
        assert.equal(dispatch.payloadHash, computeDispatchRequestHash(frame.content));
        assert.equal(dispatch.connectionChallenge, connection.challenge);
        const authority = verifyAuthority(frame[MODEL_AUTHORITY_FIELD].authority, signer.publicKeyring(), Date.now());
        assert.equal(authority.canonicalModel, "glm-5.2");
        assert.equal(authority.connectionChallenge, connection.challenge);
        dispatchConsumer.consume(frame, connection.challenge, frame.content,
          { modelAuthorityBillingRequestId: authority.billingRequestId });
        messages.push(frame);
        socket.send(JSON.stringify({ type: "outbound.control.turn_dispatch_receipt", ...{
          dispatchId: dispatch.dispatchId, attemptNo: dispatch.attemptNo, sessionId: dispatch.sessionId,
          clientMessageId: dispatch.clientMessageId, state: "queued", outcome: null,
        } }));
        const delegated = frame.clientMessageId.startsWith("dlgcb-");
        const outputs: Frame[] = (delegated ? ["start", "done"] : ["text"]).map((phase, index) => ({
          type: "outbound.message", channel: "webchat", peer: { id: dispatch.sessionId, kind: "dm" },
          sessionKey: `agent:main:webchat:dm:${dispatch.sessionId}`, frameSeq: index + 1,
          clientMessageId: dispatch.clientMessageId, isFinal: false,
          blocks: delegated ? [{ kind: "delegate_progress", runId: "delegate-run", agentId: "researcher",
            jobId: "dlgjob-offline", goal: "offline callback evidence", phase,
            ...(phase === "done" ? { text: "delegate completed" } : {}) }]
            : [{ kind: "text", text: "offline origin accepted" }],
        }));
        produced.set(dispatch.sessionId, outputs);
        for (const output of outputs) socket.send(JSON.stringify(output));
      } catch (error) { errors.push(error as Error); }
    });
  });

  const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
  const deps: UserChatBridgeDeps = {
    jwtSecret: JWT_SECRET, logger: createLogger({ out: line => events.push(line) }),
    containerLinkEnabled: true, containerLinkHeartbeatMs: 500,
    containerLinkRecovery: { spacingMs: 1, retryMs: 1, maxAttempts: 3 },
    containerConnectTimeoutMs: 3000, heartbeatIntervalMs: 0,
    resolveContainerEndpoint: async () => { provisioning++; return { host: "127.0.0.1", port, containerId: ORIGIN_CARRIER, bundleRev: ORIGIN_BUNDLE_REV }; },
    resolveContainerLinkEndpoint: (uid, cid) => resolveContainerLinkEndpoint(pool, "v5", uid, cid),
    readContainerLinkBundleRev: async () => ORIGIN_BUNDLE_REV,
    pgPool: pool, preCheckRedis: new InMemoryPreCheckRedis(), pricing: new PricingCache(),
    admitUserTurn: input => backend.admitUserTurn(input),
    persistOutboundFrame: input => persistGatewayLiveFrame(pool, input),
    markContainerActivity: () => { activity++; },
    loadAllowedModelChecker: async (uid, epoch) => { checkerLoads.push({ uid, epoch }); return () => authorization.allowed; },
    loadAgentModelResolver: async (uid, options) => {
      resolverLoads.push({ uid, bundleRev: options?.bundleRev });
      const resolver: AgentModelResolver = Object.assign((agentId: string) => agentId === "main" ? "glm-5.2" : null, {
        isRuntimeDenied: () => !authorization.ready,
        isIdentityRegistered: () => true,
        authorizeExecution: async (requestedId: string) => {
          if (!authorization.ready) throw new Error("fixture agent readiness revoked");
          return { identity: { requestedId, executionAgentId: requestedId, status: "registered-ready" as const,
            profile: { profileId: "origin-fixture", legacyAgentId: "legacy-main", canonicalAgentId: "main",
              localPersonaPath: "agents/main/SOUL.md", localSkillStorageId: "origin-fixture" } }, model: "glm-5.2" };
        },
      });
      return resolver;
    },
    modelAuthority: { signer, catalog: catalog(), readSecurityEpoch: async () => authorization.epoch },
  };
  let bridge = createUserChatBridge(deps);
  const gateway = createServer(async (request, response) => {
    if (request.url !== "/fixture-origin-inject") { response.writeHead(404).end(); return; }
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body);
      const result = await bridge.injectCronOriginTurn({ ...input, uid: ORIGIN_UID });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    } catch (error) { errors.push(error as Error); response.writeHead(500).end(); }
  });
  gateway.on("upgrade", (request, socket, head) => { if (!bridge.handleUpgrade(request, socket, head)) socket.destroy(); });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (gateway.address() as { port: number }).port;

  return {
    pool, messages, sockets, hellos, errors, events, checkerLoads, resolverLoads, authorization,
    get bridge() { return bridge; },
    activity: () => activity, provisioning: () => provisioning,
    cronInjectUrl: `http://127.0.0.1:${gatewayPort}/fixture-origin-inject`,
    input: (sessionId: string, clientMessageId: string): CronOriginInjectInput => ({ uid: ORIGIN_UID, sessionId, clientMessageId, agentId: "main", text: `origin work ${clientMessageId}` }),
    session: async (sessionId: string) => { await pool.query("INSERT INTO client_sessions(id,user_id) VALUES($1,'c:42')", [sessionId]); },
    snapshot: async (sessionId: string, clientMessageId?: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const snapshot = await buildSessionSnapshot(client, "42", sessionId, { clientMessageId });
        await client.query("COMMIT");
        return snapshot;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    openBrowser: async (sessionId: string) => {
      const token = (await signAccess({ sub: "42", role: "user" }, JWT_SECRET)).token;
      const browser = new WebSocket(`ws://127.0.0.1:${gatewayPort}${BRIDGE_WS_PATH}`, ["bearer", token]);
      browsers.push(browser);
      const received: Frame[] = [];
      browser.on("message", data => { received.push(JSON.parse(String(data))); });
      await new Promise<void>((resolve, reject) => { browser.once("open", resolve); browser.once("error", reject); });
      browser.send(JSON.stringify({ type: "inbound.hello", channel: "webchat", peers: [{ peerId: sessionId, agentId: "main", lastFrameSeq: 0 }] }));
      return { browser, received };
    },
    restart: async () => {
      await bridge.shutdown();
      for (const socket of sockets) socket.terminate();
      bridge = createUserChatBridge(deps);
    },
    stop: async () => {
      await bridge.shutdown();
      for (const browser of browsers) browser.terminate();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await new Promise<void>(resolve => container.close(() => resolve()));
      resetLiveUnitCheckpointScheduler();
      _clearMaintenanceCache();
      await resetPool();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** Each call is a real new container scheduler process; only its model execution
 * is replaced by the origin callback crossing the local HTTP fixture boundary. */
export async function runOriginCronProcess(home: string, injectUrl: string, mode: "retry" | "inject"): Promise<string> {
  const script = `
    import { CronScheduler } from './packages/gateway/src/cron.ts';
    import { cronOriginClientMessageId, buildCronOriginResumeText } from './packages/gateway/src/cronOriginSession.ts';
    const scheduler = new CronScheduler({ defaults: { model: 'glm-5.2' } }, {
      getOrCreate: async () => { throw Error('origin cron must never create an isolated session'); },
      submit: async () => { throw Error('origin cron must never submit an isolated turn'); },
      destroySession: async () => {},
    }, async () => {}, async (job, delivery) => {
      const input = { sessionId: 'cron-restart', agentId: 'main',
        clientMessageId: cronOriginClientMessageId(delivery.deliveryId), text: buildCronOriginResumeText(job) };
      console.log('ORIGIN_CALLBACK ' + JSON.stringify({ ...input, deliveryId: delivery.deliveryId }));
      if (process.env.ORIGIN_FIXTURE_MODE === 'retry') return { kind: 'retryable_failure', code: 'NO_TRANSPORT' };
      const response = await fetch(process.env.ORIGIN_FIXTURE_URL, { method: 'POST', body: JSON.stringify(input) });
      if (!response.ok) throw Error('fixture HTTP ' + response.status);
      const result = await response.json();
      if (result.kind !== 'injected') throw Error('origin injection ' + JSON.stringify(result));
      return result;
    });
    await scheduler.tick(); scheduler.stop();
  `;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, OPENCLAUDE_HOME: home, OC_SEED_DEFAULT_CRON: "0",
        OC_DELEGATE_SM: "0", OC_DELEGATE_DURABLE: "0", OC_DELEGATE_NOTIFIER: "0",
        OPENCLAUDE_V3_MASTER_BASE_URL: "", OPENCLAUDE_V3_CONTAINER_TOKEN: "", OC_USER_ID: "",
        ORIGIN_FIXTURE_MODE: mode, ORIGIN_FIXTURE_URL: injectUrl }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += String(data); });
    child.stderr.on("data", data => { output += String(data); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`cron fixture process timed out: ${output}`)); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`cron fixture process exited ${code}: ${output}`));
    });
  });
}

export async function seedOriginCron(home: string): Promise<void> {
  await mkdir(join(home, "cron"), { recursive: true });
  await writeFile(join(home, "cron.yaml"), JSON.stringify({ jobs: [{ id: "origin-restart", schedule: "* * * * *", agent: "main",
    prompt: "continue after scheduler restart", enabled: true, oneshot: true, resume: "origin-session",
    sourceSessionKey: "agent:main:webchat:dm:cron-restart" }] }));
  await writeFile(join(home, "agents.yaml"), JSON.stringify({ agents: [{ id: "main", model: "glm-5.2" }], routes: [], default: "main" }));
}
