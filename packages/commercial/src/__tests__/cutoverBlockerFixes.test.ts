import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { buildContainerAttestFrame, ModelAuthorityConsumer } from "@openclaude/gateway";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  DURABLE_TURN_DISPATCH_CAPABILITY,
  turnRecoveryAttemptIdentity,
} from "@openclaude/protocol";
import { hashSecret } from "../auth/containerIdentity.js";
import { signAccess } from "../auth/jwt.js";
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { PricingCache, type ModelPricing } from "../billing/pricing.js";
import { resetPool, setPoolOverride } from "../db/index.js";
import {
  CUTOVER_FENCING_ERROR_CODE,
  defaultCutoverInFlightTracker,
} from "../deploy/cutoverReadiness.js";
import { MuseBridgeHub } from "../muse/hub.js";
import { makeMuseInternalHandler } from "../muse/internalHttp.js";
import type { MuseJobFinish, MuseStore } from "../muse/store.js";
import { AuthorityKeyCensus } from "../ws/authorityKeyCensus.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";
import { ContainerLinkControls } from "../ws/containerLinkControls.js";
import { ContainerLinkRecovery } from "../ws/containerLinkRecovery.js";
import { BRIDGE_WS_PATH, CLOSE_BRIDGE, createUserChatBridge } from "../ws/userChatBridge.js";

const WEBP = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), Buffer.alloc(128, 7)]);

class MemMuseStore implements MuseStore {
  rows = new Map<string, { status: string; error: string | null; userId: string; kind: "image" | "video" }>();
  async insertJob(r: { id: string; userId: string; kind: "image" | "video" }) {
    this.rows.set(r.id, { status: "queued", error: null, userId: r.userId, kind: r.kind });
  }
  async markRunning(id: string) {
    const r = this.rows.get(id);
    if (r) r.status = "running";
  }
  async finishJob(id: string, fin: MuseJobFinish) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { status: fin.status, error: fin.errorCode });
  }
  async failOrphans() {
    return 0;
  }
  async countRecent() {
    return { hour: 0, day: 0 };
  }
  async countSiteToday() {
    return 0;
  }
  async findJob() {
    return null;
  }
  async openCredits() {
    return 0n;
  }
  async findCredential() {
    return null;
  }
  async touchCredential() {}
}

function listenHttp(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("B06 + B04: Muse tracks claimed non-durable jobs with 0 HTTP, ignores idle bridge long-poll, and honors cutover fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-muse-b06-"));
  const store = new MemMuseStore();
  const hub = new MuseBridgeHub({
    store,
    stateRoot: dir,
    allowedUids: new Set(["3"]),
    rate: { imagePerHour: 30, imagePerDay: 200, videoPerHour: 10, videoPerDay: 40 },
    cliTimeoutSec: { image: 120, video: 300 },
  });
  await hub.start();
  defaultCutoverInFlightTracker.reset();
  defaultCutoverInFlightTracker.setMuseJobsGetter(() => hub.activeNonDurableJobCount());

  const secretHex = "a".repeat(64);
  const token = `oc-v3.77.${secretHex}`;
  const secretHash = hashSecret(secretHex);
  const identityRepo = {
    findActiveByHostAndBoundIp: async (hostUuid: string, boundIp: string) =>
      hostUuid === "self-host" && boundIp === "127.0.0.1"
        ? {
            id: 77,
            user_id: 3,
            bound_ip: "127.0.0.1",
            host_uuid: "self-host",
            secret_hash: secretHash,
          }
        : null,
  };
  const museHandler = makeMuseInternalHandler({ identityRepo: identityRepo as never, hub });
  const server = createServer((req, res) => {
    void museHandler(req, res, { hostUuid: "self-host", boundIp: "127.0.0.1" });
  });
  const port = await listenHttp(server);

  try {
    // ② Idle bridge continuously long-polling, 0 jobs -> activeMuse === 0
    const sessionId = hub.hello("cred-1", "0.5.0");
    const idlePollAbort = new AbortController();
    const idlePollP = hub.poll(sessionId, 1_500, idlePollAbort.signal);
    await new Promise((r) => setTimeout(r, 30));
    // Wait for async store.finishJob persistence (.finally deletes from hub.persisted)
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(hub.activeNonDurableJobCount(), 0);
    assert.equal(defaultCutoverInFlightTracker.snapshot().activeMuse, 0);
    idlePollAbort.abort();
    await idlePollP;

    // ① Claimed non-durable job, 0 open HTTP requests -> activeMuse === 1
    const submitRes = await postJson(
      port,
      "/internal/v3/muse-media/jobs",
      { kind: "image", prompt: "red fox" },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(submitRes.status, 202);
    const { job_id: jobId } = JSON.parse(submitRes.body) as { job_id: string };
    assert.ok(jobId);

    const polled = await hub.poll(sessionId, 50);
    assert.ok(polled && polled.id === jobId);
    hub.heartbeat(polled.id, polled.nonce);
    // Zero HTTP requests open now (between heartbeats)
    assert.equal(hub.activeNonDurableJobCount(), 1);
    assert.equal(defaultCutoverInFlightTracker.snapshot().activeMuse, 1);

    // ③ Enable cutover fence -> new non-durable submit rejected with 503 + Retry-After: 1
    defaultCutoverInFlightTracker.setFencing(true);
    const fencedRes = await postJson(
      port,
      "/internal/v3/muse-media/jobs",
      { kind: "image", prompt: "blocked during cutover" },
      { authorization: `Bearer ${token}` },
    );
    assert.equal(fencedRes.status, 503);
    assert.equal(fencedRes.headers["retry-after"], "1");
    assert.deepEqual(JSON.parse(fencedRes.body), {
      ok: false,
      error: CUTOVER_FENCING_ERROR_CODE,
    });

    // Existing claimed job still completes cleanly while fenced, and count drops to 0
    const shaWebp = createHash("sha256").update(WEBP).digest("hex");
    await hub.putChunk(polled.id, polled.nonce, 0, 0, WEBP, shaWebp);
    await hub.result(polled.id, polled.nonce, {
      ok: true,
      files: [
        {
          idx: 0,
          filename: "x.webp",
          mime: "image/webp",
          bytes: WEBP.length,
          sha256: shaWebp,
          chunks: 1,
        },
      ],
    });
    // Wait for async store.finishJob persistence (.finally deletes from hub.persisted)
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(hub.activeNonDurableJobCount(), 0);
    assert.equal(defaultCutoverInFlightTracker.snapshot().activeMuse, 0);
  } finally {
    defaultCutoverInFlightTracker.reset();
    await hub.stop();
    await closeHttp(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B07: step-down handoff on detached Grok turn emits linkShutdown and preserves Grok slot/route lease", async () => {
  const jwtSecret = "test-jwt-secret-b07-32-bytes-min!!";
  const routeToken = "a".repeat(64);
  const expiredTokens: string[] = [];
  const releasedLeases: Array<{ accountId: bigint; slotId: string }> = [];
  const containerReceived: Array<Record<string, unknown>> = [];

  // Mock container gateway WS server
  const containerWss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const containerPort = await new Promise<number>((resolve) => {
    containerWss.once("listening", () => {
      const addr = containerWss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  let containerSocketClosed = false;
  containerWss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        containerReceived.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
    ws.on("close", () => {
      containerSocketClosed = true;
    });
  });

  const grokPricing: ModelPricing = {
    model_id: "grok-build",
    display_name: "Grok Build",
    input_per_mtok: 1000n,
    output_per_mtok: 5000n,
    cache_read_per_mtok: 100n,
    cache_write_per_mtok: 500n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "admin",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  };
  const pricing = new PricingCache();
  pricing._setForTests([grokPricing]);

  const fakePg = {
    query: async (sqlOrCfg: unknown) => {
      const sql = (typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text).trim();
      if (sql.startsWith("SELECT u.credits::text AS wallet")) {
        return { rows: [{ wallet: "1000000", period: "0" }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO request_finalize_journal")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    }),
    end: async () => {},
  };
  setPoolOverride(fakePg as never);

  const bridge = createUserChatBridge({
    jwtSecret,
    pgPool: fakePg as never,
    containerLinkEnabled: true,
    deferBackgroundActivation: false,
    heartbeatIntervalMs: 0,
    pricing,
    preCheckRedis: new InMemoryPreCheckRedis(),
    resolveContainerEndpoint: async () => ({
      host: "127.0.0.1",
      port: containerPort,
      containerId: 901,
    }),
    createCodexRoute: async () => ({
      kind: "api_relay",
      engine: "grok",
      token: routeToken,
      baseUrl: `http://127.0.0.1:18789/internal/v5/grok-relay/route/${routeToken}/v1`,
      modelProvider: "grok",
      providerName: "xAI Grok",
      wireApi: "chat",
      preferredAuthMethod: "apikey",
      disableResponseStorage: true,
      groupId: "51",
      credentialId: "53",
      accountId: "53",
      slotId: "slot-grok-b07",
    }),
    expireCodexRoute: async (token) => {
      expiredTokens.push(token);
    },
    releaseGrokRouteLease: async (accountId, slotId) => {
      releasedLeases.push({ accountId, slotId });
    },
  });

  const gwServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  gwServer.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const gwPort = await listenHttp(gwServer);

  try {
    const { token } = await signAccess({ sub: "24", role: "user" }, jwtSecret);
    const browserWs = new WebSocket(`ws://127.0.0.1:${gwPort}${BRIDGE_WS_PATH}`, ["bearer", token]);
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", () => resolve());
      browserWs.once("error", reject);
    });
    // Wait briefly for ContainerLink relay_ready
    await new Promise((r) => setTimeout(r, 80));

    browserWs.send(
      JSON.stringify({
        type: "inbound.message",
        peer: { id: "grok-peer-b07", kind: "dm" },
        agentId: "grok",
        model: "grok-build",
        content: "long grok turn surviving master cutover",
      }),
    );

    const deadline = Date.now() + 3_000;
    while (
      !containerReceived.some((f) => f.type === "inbound.message") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      containerReceived.some((f) => f.type === "inbound.message"),
      "Grok turn must be forwarded to container",
    );

    // Browser disconnects (detaches handle) while Grok turn is still running on container
    const browserClosed = new Promise<void>((resolve) => browserWs.once("close", () => resolve()));
    browserWs.close();
    await browserClosed;
    await new Promise((r) => setTimeout(r, 40));

    // Master steps down: must handoff via linkShutdown without synthesizing container_close
    await bridge.setBackgroundRoleActive!(false);
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(
      releasedLeases.length,
      0,
      "step-down handoff must NOT revoke surviving Grok account slot lease",
    );
    assert.equal(
      expiredTokens.length,
      0,
      "step-down handoff must NOT expire surviving Grok route token",
    );
    assert.equal(
      containerReceived.some((f) => f.type === "inbound.control.stop"),
      false,
      "step-down must NOT send stop/abort to container",
    );
    assert.equal(containerSocketClosed, true, "detached standby link closes cleanly after handoff");
  } finally {
    await bridge.shutdown();
    await closeHttp(gwServer);
    await new Promise<void>((resolve) => containerWss.close(() => resolve()));
    await resetPool();
  }
});

test("B08: ContainerLinkRecovery step-down aborts paused old-epoch task, prevents attach, and awaits drain", async () => {
  let releaseDrainGate!: () => void;
  let drainEnteredResolve!: () => void;
  const drainEntered = new Promise<void>((r) => { drainEnteredResolve = r; });
  const drainGate = new Promise<void>((r) => { releaseDrainGate = r; });

  let attachCalls = 0;
  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes("scan_container_link_carriers") || sql.includes("turn_dispatches")) {
        return {
          rows: [
            {
              uid: "3",
              user_id: "3",
              container_id: 7337,
              agent_container_id: 7337,
              dispatch_id: "d-1",
              attempt_no: 1,
              session_id: "s-1",
              client_message_id: "m-1",
              agent_id: "main",
              lease_epoch: 1,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const recovery = new ContainerLinkRecovery({
    pool: fakePool as never,
    channel: "v5",
    spacingMs: 1,
    retryMs: 1,
    drain: async () => {
      drainEnteredResolve();
      await drainGate;
    },
    attach: async () => {
      attachCalls += 1;
      return "rebuilt";
    },
  });

  try {
    void recovery.start();
    await drainEntered;

    let stepDownResolved = false;
    const stepDownP = recovery.setActive(false).then(() => {
      stepDownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stepDownResolved, false, "setActive(false) must wait for paused old epoch to exit");

    // Release old epoch gate after step-down
    releaseDrainGate();
    await stepDownP;

    assert.equal(stepDownResolved, true);
    assert.equal(attachCalls, 0, "stale epoch must NOT call attach after step-down");
  } finally {
    recovery.stop();
  }
});

test("B08: ContainerLinkControls step-down waits for paused claim, releases claimed lease, and never sends", async () => {
  let claimEnteredResolve!: () => void;
  const claimEntered = new Promise<void>((r) => { claimEnteredResolve = r; });
  let releaseClaimGate!: () => void;
  const claimGate = new Promise<void>((r) => { releaseClaimGate = r; });

  let sendCalls = 0;
  let releaseRetryQueries = 0;

  const fakeSocket = {
    readyState: WebSocket.OPEN,
    send(_data: unknown, _opts: unknown, cb?: (err?: Error) => void) {
      sendCalls += 1;
      cb?.();
    },
  };

  const fakeLinks = {
    controlTransport: () => fakeSocket,
  };

  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT DISTINCT user_id FROM turn_control_requests")) {
        return { rows: [{ user_id: "3" }] };
      }
      if (sql.includes("FROM turn_control_requests") && sql.includes("agent_container_id")) {
        return { rows: [{ control_id: "ctrl-1", container_id: 7337 }] };
      }
      if (sql.includes("UPDATE turn_control_requests") && sql.includes("SET status='pending'")) {
        releaseRetryQueries += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE turn_control_requests") && sql.includes("SET status='leased'")) {
        // claimDueTurnControls SQL
        claimEnteredResolve();
        await claimGate;
        return {
          rows: [
            {
              control_id: "ctrl-1",
              user_id: "3",
              session_id: "s-1",
              kind: "permission",
              root_client_message_id: null,
              request_id: "req-1",
              payload_json: { type: "inbound.permission_response", requestId: "req-1" },
              lease_owner: "owner",
              lease_epoch: "1",
              delivery_attempt: 1,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const controls = new ContainerLinkControls({
    pool: fakePool as never,
    channel: "v5",
    links: fakeLinks as never,
    legacy: new Map(),
    paused: false,
  });

  try {
    void controls.scan();
    await claimEntered;

    let stepDownResolved = false;
    const stepDownP = controls.setActive(false).then(() => {
      stepDownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stepDownResolved, false, "setActive(false) must wait for paused claim to exit");

    // Release claim gate after step-down
    releaseClaimGate();
    await stepDownP;

    assert.equal(stepDownResolved, true);
    assert.equal(sendCalls, 0, "stale epoch must NOT send control frame after step-down");
    assert.equal(
      releaseRetryQueries,
      1,
      "stale epoch must immediately release claimed control lease back to pending",
    );
  } finally {
    await controls.stop();
  }
});

test("B08: ContainerLinkControls step-down during paused targets scan never calls wake or claim", async () => {
  let targetsEnteredResolve!: () => void;
  const targetsEntered = new Promise<void>((r) => { targetsEnteredResolve = r; });
  let releaseTargetsGate!: () => void;
  const targetsGate = new Promise<void>((r) => { releaseTargetsGate = r; });

  let wakeCalls = 0;
  let claimCalls = 0;

  const fakeLinks = {
    controlTransport: () => null,
  };

  const fakePool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT DISTINCT user_id FROM turn_control_requests")) {
        return { rows: [{ user_id: "3" }] };
      }
      if (sql.includes("FROM turn_control_requests") && sql.includes("agent_container_id")) {
        targetsEnteredResolve();
        await targetsGate;
        return { rows: [{ control_id: "ctrl-2", container_id: 7337 }] };
      }
      if (sql.includes("UPDATE turn_control_requests") && sql.includes("SET status='leased'")) {
        claimCalls += 1;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const controls = new ContainerLinkControls({
    pool: fakePool as never,
    channel: "v5",
    links: fakeLinks as never,
    legacy: new Map(),
    paused: false,
    wake: async () => {
      wakeCalls += 1;
    },
  });

  try {
    void controls.scan();
    await targetsEntered;

    let stepDownResolved = false;
    const stepDownP = controls.setActive(false).then(() => {
      stepDownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stepDownResolved, false, "setActive(false) must wait for paused targets scan");

    releaseTargetsGate();
    await stepDownP;

    assert.equal(stepDownResolved, true);
    assert.equal(wakeCalls, 0, "stale epoch must NOT call wake after step-down");
    assert.equal(claimCalls, 0, "stale epoch must NOT call claim after step-down");
  } finally {
    await controls.stop();
  }
});

function makeTestAuthorityCatalog(): ModelCatalogCache {
  const entries: ModelCatalogEntry[] = [
    {
      entryId: 1,
      modelId: "gpt-5.6-sol",
      engine: "codex",
      providerId: "codex",
      upstreamModelId: null,
      contextWindow: 400_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["medium", "xhigh"], codexModelDefault: "xhigh" },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: 1,
      state: "active",
      lockVersion: 1,
    } as unknown as ModelCatalogEntry,
  ];
  const pricing = new Map<string, ModelCatalogPricing>([
    [
      "gpt-5.6-sol",
      {
        modelId: "gpt-5.6-sol",
        displayName: "GPT 5.6",
        inputPerMtok: 1000n,
        outputPerMtok: 5000n,
        cacheReadPerMtok: 100n,
        cacheWritePerMtok: 500n,
        multiplier: "1.000",
        visibility: "public",
        sortOrder: 0,
        defaultEffort: null,
      },
    ],
  ]);
  const snapshot = new ModelCatalogSnapshot({
    entries,
    aliases: new Map(),
    pricing,
    securityEpoch: 1n,
  });
  return {
    peek: () => snapshot,
    current: () => snapshot,
    assertFresh: async () => snapshot,
  } as unknown as ModelCatalogCache;
}

test("B05: userChatBridge reports real containerLinkEnabled runtime capability (false vs true)", async () => {
  const jwtSecret = "test-jwt-secret-b05-32-bytes-min!!";
  const fakePg = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    end: async () => {},
  };
  const bridgeOff = createUserChatBridge({
    jwtSecret,
    pgPool: fakePg as never,
    preCheckRedis: new InMemoryPreCheckRedis(),
    pricing: new PricingCache(),
    containerLinkEnabled: false,
    heartbeatIntervalMs: 0,
    resolveContainerEndpoint: async () => ({ host: "127.0.0.1", port: 1, containerId: 1 }),
  });
  const bridgeOn = createUserChatBridge({
    jwtSecret,
    pgPool: fakePg as never,
    preCheckRedis: new InMemoryPreCheckRedis(),
    pricing: new PricingCache(),
    containerLinkEnabled: true,
    heartbeatIntervalMs: 0,
    resolveContainerEndpoint: async () => ({ host: "127.0.0.1", port: 1, containerId: 1 }),
  });
  try {
    assert.equal(bridgeOff.containerLinkEnabled, false);
    assert.equal(bridgeOn.containerLinkEnabled, true);
  } finally {
    await bridgeOff.shutdown();
    await bridgeOn.shutdown();
  }
});

test("B04: existing browser WS sending new inbound.message while cutover-fence=true is rejected without admitting", async () => {
  const jwtSecret = "test-jwt-secret-b04-ws-32-bytes!!";
  const signer = AuthoritySigner.createEphemeral();
  const containerReceived: Array<Record<string, unknown>> = [];
  let admitCalls = 0;

  const containerWss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const containerPort = await new Promise<number>((resolve) => {
    containerWss.once("listening", () => {
      const addr = containerWss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  containerWss.on("connection", (ws) => {
    const consumer = new ModelAuthorityConsumer({
      keyring: signer.publicKeyring(),
      containerId: 902,
      uid: 24,
      required: true,
    });
    const attest = buildContainerAttestFrame(consumer, consumer.newConnection(), 902);
    ws.send(JSON.stringify({ ...attest, capabilities: [...attest.capabilities, DURABLE_TURN_DISPATCH_CAPABILITY] }));
    ws.on("message", (data) => {
      try {
        containerReceived.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch { /* ignore */ }
    });
  });

  const fakePg = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    end: async () => {},
  };
  const ccbPricing: ModelPricing = {
    model_id: "gpt-5.6-sol",
    display_name: "GPT 5.6",
    input_per_mtok: 1000n,
    output_per_mtok: 5000n,
    cache_read_per_mtok: 100n,
    cache_write_per_mtok: 500n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  };
  const pricing = new PricingCache();
  pricing._setForTests([ccbPricing]);
  const bridge = createUserChatBridge({
    jwtSecret,
    pgPool: fakePg as never,
    preCheckRedis: new InMemoryPreCheckRedis(),
    pricing,
    containerLinkEnabled: true,
    heartbeatIntervalMs: 0,
    resolveContainerEndpoint: async () => ({ host: "127.0.0.1", port: containerPort, containerId: 902 }),
    modelAuthority: {
      signer,
      catalog: makeTestAuthorityCatalog(),
      census: new AuthorityKeyCensus(),
      readSecurityEpoch: async () => 1n,
    },
    admitUserTurn: async () => {
      admitCalls += 1;
      throw new Error("admitUserTurn must not be called while cutover-fence is active");
    },
  });
  const gwServer = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  gwServer.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const gwPort = await listenHttp(gwServer);
  defaultCutoverInFlightTracker.reset();

  try {
    const { token } = await signAccess({ sub: "24", role: "user" }, jwtSecret);
    const browserWs = new WebSocket(`ws://127.0.0.1:${gwPort}${BRIDGE_WS_PATH}`, ["bearer", token]);
    const receivedFrames: Array<Record<string, unknown>> = [];
    browserWs.on("message", (d) => {
      try { receivedFrames.push(JSON.parse(d.toString("utf8")) as Record<string, unknown>); } catch { /* */ }
    });
    const closedP = new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`browserWs close timeout; state=${browserWs.readyState} frames=${JSON.stringify(receivedFrames)}`)), 4_000);
      browserWs.once("close", (code) => { clearTimeout(t); resolve(code); });
    });
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", () => resolve());
      browserWs.once("error", reject);
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(browserWs.readyState, WebSocket.OPEN, `expected open before send; frames=${JSON.stringify(receivedFrames)}`);

    // Activate cutover fence on an already-open browser WS
    defaultCutoverInFlightTracker.setFencing(true);

    browserWs.send(
      JSON.stringify({
        type: "inbound.message",
        peer: { id: "peer-b04-fence", kind: "dm" },
        clientMessageId: "cmid-b04-fenced-1",
        agentId: "main",
        model: "gpt-5.6-sol",
        content: { text: "new chat during cutover fence" },
      }),
    );

    const closeCode = await closedP;
    assert.equal(closeCode, CLOSE_BRIDGE.SERVER_RESTART, "fenced browser WS must close with 4509 SERVER_RESTART");
    assert.equal(admitCalls, 0, "admitUserTurn must NOT be called when cutover-fence=true");
    assert.equal(
      containerReceived.some((f) => f.type === "inbound.message"),
      false,
      "fenced inbound.message must NOT be forwarded to container",
    );
    assert.ok(
      receivedFrames.some((f) => f.type === "error" && f.code === "SESSION_PERSIST_UNAVAILABLE"),
      `browser WS receives retryable transient error before 4509 close; got=${JSON.stringify(receivedFrames)}`,
    );
  } finally {
    defaultCutoverInFlightTracker.reset();
    await bridge.shutdown();
    await closeHttp(gwServer);
    await new Promise<void>((resolve) => containerWss.close(() => resolve()));
  }
});

test("B08: active-browser-handle recovery paused before physical send blocks onFence and executes 0 physical sends", async () => {
  const jwtSecret = "test-jwt-secret-b08-live-32bytes!";
  const signer = AuthoritySigner.createEphemeral();
  const containerReceived: Array<Record<string, unknown>> = [];
  let rootFenceEnteredResolve!: () => void;
  const rootFenceEntered = new Promise<void>((r) => { rootFenceEnteredResolve = r; });
  let releaseRootFenceGate!: () => void;
  const rootFenceGate = new Promise<void>((r) => { releaseRootFenceGate = r; });

  let claimCount = 0;
  let admitCount = 0;
  let sentStatusQueries = 0;
  let rollbackQueries = 0;
  let releasePreReceiptQueries = 0;
  const browserFrames: unknown[] = [];

  const containerWss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const containerPort = await new Promise<number>((resolve) => {
    containerWss.once("listening", () => {
      const addr = containerWss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  containerWss.on("connection", (ws) => {
    const consumer = new ModelAuthorityConsumer({
      keyring: signer.publicKeyring(),
      containerId: 903,
      uid: 24,
      required: true,
    });
    const attest = buildContainerAttestFrame(consumer, consumer.newConnection(), 903);
    ws.send(JSON.stringify({ ...attest, capabilities: [...attest.capabilities, DURABLE_TURN_DISPATCH_CAPABILITY] }));
    ws.on("message", (data) => {
      try {
        containerReceived.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch { /* ignore */ }
    });
  });

  const recIdentity = turnRecoveryAttemptIdentity("peer-b08-live", "cmid-b08-root-1", 1);
  const recoveryRequest = {
    type: "inbound.message",
    peer: { id: "peer-b08-live", kind: "dm" },
    clientMessageId: recIdentity.clientMessageId,
    idempotencyKey: recIdentity.idempotencyKey,
    agentId: "main",
    model: "gpt-5.6-sol",
    content: {
      text: "recovered prompt",
      recovery: {
        sourceClientMessageId: "cmid-b08-root-1",
        mode: "replay",
        automatic: true,
        rootClientMessageId: "cmid-b08-root-1",
        attempt: 1,
        max: AUTOMATIC_TURN_RETRY_MAX,
      },
    },
  };

  let lastAdmitted: {
    dispatchId: string;
    userId: string;
    sessionId: string;
    model: string | null;
    ownerId: string;
    attemptNo: number;
    leaseEpoch: number;
    leaseUntil: Date;
  } | null = null;
  let lastAuthorityBinding: Record<string, unknown> | null = null;

  const fakeClient = {
    query: async (sqlOrCfg: unknown, params?: unknown[]) => {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      if (sql.includes("FROM turn_dispatches") && sql.includes("WHERE dispatch_id=$1")) {
        if (!lastAdmitted) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              user_id: lastAdmitted.userId,
              session_id: lastAdmitted.sessionId,
              model: lastAdmitted.model,
              attempt_no: lastAdmitted.attemptNo,
              status: "admitted",
              owner_id: lastAdmitted.ownerId,
              lease_epoch: String(lastAdmitted.leaseEpoch),
              lease_until: lastAdmitted.leaseUntil,
              agent_container_id: "903",
              runtime_kind: "docker",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO authority_turn_dispatches") && params) {
        lastAuthorityBinding = {
          authority_turn_id: params[0],
          user_id: params[1],
          dispatch_model: params[2],
          canonical_model: params[3],
          session_id: params[4],
          dispatch_id: params[5],
          attempt_no: params[6],
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM authority_turn_dispatches")) {
        return lastAuthorityBinding ? { rows: [lastAuthorityBinding], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM turn_recovery_jobs j") && sql.includes("FOR UPDATE OF j,d")) {
        rootFenceEnteredResolve();
        await rootFenceGate;
        return { rows: [{ job_id: "job-b08-1" }], rowCount: 1 };
      }
      if (sql.includes("SET status='sent'")) {
        sentStatusQueries += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.trim() === "ROLLBACK") {
        rollbackQueries += 1;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE turn_recovery_jobs") && sql.includes("SET status='queued'")) {
        releasePreReceiptQueries += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE turn_dispatches")) {
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const fakePg = {
    query: async (sqlOrCfg: unknown) => {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : (sqlOrCfg as { text: string }).text;
      if (sql.includes("UPDATE turn_recovery_jobs j") && sql.includes("SET status='leased'")) {
        if (claimCount > 0) return { rows: [], rowCount: 0 };
        claimCount += 1;
        return {
          rows: [
            {
              job_id: "job-b08-1",
              user_id: "24",
              session_id: "peer-b08-live",
              root_client_message_id: "cmid-b08-root-1",
              source_client_message_id: "cmid-b08-root-1",
              source_turn_key: "turn-root-1",
              error_code: "INTERRUPTED",
              recovery_mode: "replay",
              semantic_recovery_attempt: 1,
              transport_wait_attempt: 0,
              request_json: recoveryRequest,
              lease_epoch: "1",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE turn_recovery_jobs") && sql.includes("SET status='queued'")) {
        releasePreReceiptQueries += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE turn_dispatches")) {
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => fakeClient,
    end: async () => {},
  };

  const ccbPricing: ModelPricing = {
    model_id: "gpt-5.6-sol",
    display_name: "GPT 5.6",
    input_per_mtok: 1000n,
    output_per_mtok: 5000n,
    cache_read_per_mtok: 100n,
    cache_write_per_mtok: 500n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  };
  const pricing = new PricingCache();
  pricing._setForTests([ccbPricing]);
  const bridge = createUserChatBridge({
    jwtSecret,
    pgPool: fakePg as never,
    preCheckRedis: new InMemoryPreCheckRedis(),
    pricing,
    containerLinkEnabled: true,
    deferBackgroundActivation: false,
    heartbeatIntervalMs: 0,
    resolveContainerEndpoint: async () => ({ host: "127.0.0.1", port: containerPort, containerId: 903 }),
    modelAuthority: {
      signer,
      catalog: makeTestAuthorityCatalog(),
      census: new AuthorityKeyCensus(),
      readSecurityEpoch: async () => 1n,
    },
    admitUserTurn: async (input) => {
      admitCount += 1;
      const leaseUntil = new Date(Date.now() + 60_000);
      lastAdmitted = {
        dispatchId: input.dispatchId,
        userId: input.uid.toString(),
        sessionId: input.sessionId,
        model: input.model,
        ownerId: input.ownerId,
        attemptNo: 1,
        leaseEpoch: 1,
        leaseUntil,
      };
      return {
      kind: "admitted",
      takeover: false,
      workspaceMode: "legacy",
      dispatch: {
        dispatchId: input.dispatchId,
        userId: input.uid,
        sessionId: input.sessionId,
        clientMessageId: input.clientMessageId,
        agentId: input.agentId,
        model: input.model,
        requestHash: input.requestHash,
        billingRequestId: input.billingRequestId,
        attemptNo: 1,
        status: "admitted",
        outcome: null,
        failureCode: null,
        conflictReason: null,
        resolution: null,
        resolvedAt: null,
        clientNotified: false,
        ownerId: input.ownerId,
        leaseEpoch: 1,
        leaseUntil: new Date(Date.now() + 60_000),
        anchorSeq: 1n,
        admittedAt: new Date(),
        acceptedAt: null,
        terminalAt: null,
        lastAttemptAt: new Date(),
        traceId: null,
      },
    };
    },
  });
  const gwServer = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  gwServer.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const gwPort = await listenHttp(gwServer);
  defaultCutoverInFlightTracker.reset();

  try {
    // Open an ACTIVE browser subscriber handle (so releaseInactiveLinks will NOT close it!)
    const { token } = await signAccess({ sub: "24", role: "user" }, jwtSecret);
    const browserWs = new WebSocket(`ws://127.0.0.1:${gwPort}${BRIDGE_WS_PATH}`, ["bearer", token]);
    browserWs.on("message", (d) => {
      try { browserFrames.push(JSON.parse(d.toString("utf8"))); } catch { /* */ }
    });
    await new Promise<void>((resolve, reject) => {
      browserWs.once("open", () => resolve());
      browserWs.once("error", reject);
    });

    // Attest triggers drainDurableRecoveryForUser -> claim -> admitUserTurn -> pauses in forwardRecoveryUnderRootFence!
    await Promise.race([
      rootFenceEntered,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`timeout waiting for forwardRecoveryUnderRootFence; claimCount=${claimCount} admitCount=${admitCount} frames=${JSON.stringify(browserFrames)} container=${JSON.stringify(containerReceived)}`)),
          4_000,
        ),
      ),
    ]);

    // Trigger step-down while the active browser handle's recovery job is paused right before physical send
    let stepDownResolved = false;
    const stepDownP = bridge.setBackgroundRoleActive!(false).then(() => {
      stepDownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      stepDownResolved,
      false,
      "setBackgroundRoleActive(false) / onFence MUST wait for in-flight recovery execution to exit",
    );

    // Release the root-fence SELECT gate after step-down
    releaseRootFenceGate();
    await stepDownP;

    assert.equal(stepDownResolved, true);
    assert.equal(
      containerReceived.some((f) => f.type === "inbound.message"),
      false,
      "stale epoch on active browser handle MUST execute 0 physical sends",
    );
    assert.equal(sentStatusQueries, 0, "stale epoch must NOT mark recovery job status='sent'");
    assert.ok(rollbackQueries >= 1, "root-fence transaction must ROLLBACK when epoch fenced");
    assert.ok(releasePreReceiptQueries >= 1, "stale recovery lease must be unwound back to queued");

    browserWs.close();
  } finally {
    defaultCutoverInFlightTracker.reset();
    await bridge.shutdown();
    await closeHttp(gwServer);
    await new Promise<void>((resolve) => containerWss.close(() => resolve()));
  }
});
