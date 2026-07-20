/**
 * bridge 侧模型执行权威 —— 签发注入 + per-connection attestation 门
 * (docs/V5_MODEL_AUTHORITY_PLAN.md §2 / §7 步 4 / §8)。
 *
 * 跑法:npx tsx --test src/__tests__/modelAuthorityBridge.test.ts
 *
 * 真起 bridge WS + mock 容器 WS(容器由测试决定 attest 与否),断言的是**转发到容器的
 * 真实字节**——签名能不能被容器验通过、model 有没有归一、客户端伪造字段有没有被剥掉。
 *
 * 覆盖:flag 关 = 零变化 / 签发注入 + 容器验签 / alias 归一 / 客户端伪造字段 strip /
 * attestation 缓冲与重放 / 不 attest 超时 → 拒 + recycle / codex 分类改用 catalog engine /
 * 模型不可路由 fail-closed。
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import {
  DURABLE_TURN_DISPATCH_CAPABILITY,
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_FIELD,
  verifyAuthority,
  verifyTurnLease,
  assertLeaseMatchesAuthority,
} from "@openclaude/protocol";

import {
  CONTAINER_ATTEST_FRAME_TYPE as GATEWAY_ATTEST_FRAME_TYPE,
  DEFAULT_SECONDARY_UTILITY_MODEL,
  GATEWAY_CAPABILITY_SCHEMA_VERSION,
  ModelAuthorityConsumer,
  buildContainerAttestFrame,
} from "@openclaude/gateway";

import { signAccess } from "../auth/jwt.js";
import { CAPABILITY_SCHEMA_VERSION } from "../billing/modelCatalog.js";
import {
  createUserChatBridge,
  CLOSE_BRIDGE,
  BRIDGE_WS_PATH,
  CONTAINER_ATTEST_FRAME_TYPE,
  _readDispatchDrainMs,
  type BridgeModelAuthorityDeps,
  type UserChatBridgeDeps,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";
import { AuthorityKeyCensus } from "../ws/authorityKeyCensus.js";
import type { AdmitUserTurnInput, AdmitUserTurnResult } from "../db/pgSessionsBackend.js";
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";

const JWT_SECRET = "x".repeat(32);
const UID = 9001;
const CONTAINER_ID = 7;

// ─────────────────────────────────────────────────────────────────────────────
// catalog 夹具(真 ModelCatalogSnapshot —— alias 归一 / resolve / isCodexModel 走真实实现)
// ─────────────────────────────────────────────────────────────────────────────

function entry(over: Partial<ModelCatalogEntry> & { entryId: number; modelId: string }): ModelCatalogEntry {
  return {
    engine: "ccb",
    providerId: "zhipu",
    upstreamModelId: null,
    contextWindow: 200_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: ["low", "medium", "high"], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: true },
    },
    capabilitySchemaVersion: 1,
    state: "active",
    lockVersion: 1,
    ...over,
  } as ModelCatalogEntry;
}

function price(modelId: string): ModelCatalogPricing {
  return {
    modelId,
    displayName: modelId,
    inputPerMtok: 1n,
    outputPerMtok: 2n,
    cacheReadPerMtok: 1n,
    cacheWritePerMtok: 1n,
    multiplier: "1.0",
    visibility: "public",
    sortOrder: 1,
    defaultEffort: null,
  };
}

/**
 * @param auxState 平台次级模型(= 容器 ANTHROPIC_SMALL_FAST_MODEL 的实际取值)在 catalog 里的状态。
 *   'active'   生产形态;'disabled'/'absent' 用来验签发期 fail-closed。
 */
function makeSnapshot(auxState: "active" | "disabled" | "absent" = "active"): ModelCatalogSnapshot {
  const entries: ModelCatalogEntry[] = [
    entry({ entryId: 1, modelId: "glm-5.2" }),
    entry({
      entryId: 2,
      modelId: "gpt-5.6-sol",
      engine: "codex",
      providerId: "codex",
      contextWindow: 400_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["medium", "xhigh"], codexModelDefault: "xhigh" },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
    }),
  ];
  // kimi-k3:角色分档窗口投影(modelRolePolicy)的靶模型 —— 机制窗口 1M,
  // 签发时 admin 原样 / user 收窄 500k(见「角色分档窗口投影」describe)。
  entries.push(
    entry({
      entryId: 9,
      modelId: "kimi-k3",
      providerId: "moonshot",
      contextWindow: 1_048_576,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: true, supportsThinking: true },
      },
    }),
  );
  const pricing = new Map([
    ["glm-5.2", price("glm-5.2")],
    ["gpt-5.6-sol", price("gpt-5.6-sol")],
    ["kimi-k3", price("kimi-k3")],
  ]);
  if (auxState !== "absent") {
    entries.push(
      entry({
        entryId: 3,
        modelId: DEFAULT_SECONDARY_UTILITY_MODEL,
        providerId: "deepseek",
        contextWindow: 1_000_000,
        ...(auxState === "disabled" ? { state: "disabled" as const } : {}),
      }),
    );
    pricing.set(DEFAULT_SECONDARY_UTILITY_MODEL, price(DEFAULT_SECONDARY_UTILITY_MODEL));
  }
  return new ModelCatalogSnapshot({
    entries,
    // alias:'gpt-latest' → entryId 2(gpt-5.6-sol)。签发必须归一到 canonical。
    aliases: new Map([["gpt-latest", 2]]),
    pricing,
    securityEpoch: 12n,
  });
}

/** 只实现 bridge 用到的三个方法(peek / current / assertFresh)。 */
function fakeCatalog(snapshot: ModelCatalogSnapshot, opts: { fenceFails?: boolean } = {}) {
  return {
    peek: () => snapshot,
    current: () => snapshot,
    assertFresh: async () => {
      if (opts.fenceFails) throw new Error("epoch fence failed (db down)");
      return snapshot;
    },
  } as unknown as ModelCatalogCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// rig
// ─────────────────────────────────────────────────────────────────────────────

interface Rig {
  gateway: http.Server;
  bridge: UserChatBridgeHandler;
  port: number;
  containerWss: WebSocketServer;
  containerSeen: string[];
  recycled: Array<{ containerId: number; reason: string }>;
  signer: AuthoritySigner;
  census: AuthorityKeyCensus;
  /** 签发边界 epoch 直读的返回值(测试可中途改,模拟 admin 安全写)。 */
  epochAtSign: { value: bigint; fail?: boolean };
}

async function startRig(opts: {
  /** 容器是否 attest(false = 旧 release / 旧 env,不广播 capability)。 */
  attest: "yes" | "no-capability" | "silent";
  authorityOn?: boolean;
  attestTimeoutMs?: number;
  fenceFails?: boolean;
  /** 容器 attest 前的人为延迟(测缓冲与重放)。 */
  attestDelayMs?: number;
  /** 平台次级模型在 catalog 里的状态(默认 active = 生产形态)。 */
  auxState?: "active" | "disabled" | "absent";
  /**
   * 容器上报的 keyIds 形态:
   *   'real'     = 用**真的 gateway 代码**(ModelAuthorityConsumer + buildContainerAttestFrame)
   *                从注入的 keyring 里算 —— 生产形态,顺带锁死 attest 帧的跨包 parity;
   *   'legacy'   = 旧 release(帧里没有 keyIds 字段)→ census 记 keyIdsUnknown,不判死;
   *   'stale'    = ring 里没有 master 当前 activeKeyId(轮换步骤③ 早于 ①)→ 必须当场拒 + recycle。
   */
  keyIds?: "real" | "legacy" | "stale";
  /** B10:容器 attest 携带 durable-turn-dispatch-v1 → 走 dispatch 受理路径。 */
  durableDispatch?: boolean;
  admitUserTurn?: (input: AdmitUserTurnInput) => Promise<AdmitUserTurnResult>;
  loadMasterSessionMessages?: UserChatBridgeDeps["loadMasterSessionMessages"];
  hasCompletedClientTurn?: UserChatBridgeDeps["hasCompletedClientTurn"];
  loadGoalState?: (uid: bigint, sessionId: string) => Promise<unknown>;
  /** B3(R3):注入 mock pgPool 观察受理后 pre-forward 失败出口的 casToTerminal(需三件套齐)。 */
  pgPool?: unknown;
}): Promise<Rig> {
  const containerSeen: string[] = [];
  const recycled: Array<{ containerId: number; reason: string }> = [];
  const signer = AuthoritySigner.createEphemeral();
  const census = new AuthorityKeyCensus();
  const epochAtSign: { value: bigint; fail?: boolean } = { value: 12n };
  const keyIdsMode = opts.keyIds ?? "real";

  const containerWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => containerWss.once("listening", () => r()));
  const containerPort = (containerWss.address() as { port: number }).port;
  containerWss.on("connection", (ws) => {
    // 容器 gateway 的行为:连接建立即发 attest 帧(见 gateway handleWsConnection)。
    const sendAttest = () => {
      if (opts.attest === "silent") return;
      if (opts.durableDispatch && opts.attest === "yes") {
        // B10:手工 attest 帧携带 durable-turn-dispatch-v1 + model-authority 双 capability。
        // 省略 keyIds(keyIdsUnknown → 不判死),仅为驱动 dispatch 受理路径。
        ws.send(
          JSON.stringify({
            type: CONTAINER_ATTEST_FRAME_TYPE,
            capabilities: [MODEL_AUTHORITY_CAPABILITY, DURABLE_TURN_DISPATCH_CAPABILITY],
            connectionChallenge: "chal-" + Math.random().toString(16).slice(2),
            containerId: CONTAINER_ID,
            authorityTtlMs: 120_000,
          }),
        );
        return;
      }
      if (keyIdsMode === "real" && opts.attest === "yes") {
        // **真容器代码**:keyring 来自 master 注入的 env ring(这里直接用 signer 的公钥环),
        // keyIds/指纹由 gateway 侧算 —— census 与 attest 帧形状的跨包 parity 一并被锁死。
        const consumer = new ModelAuthorityConsumer({
          keyring: signer.publicKeyring(),
          containerId: CONTAINER_ID,
          uid: UID,
          required: true,
        });
        const conn = consumer.newConnection();
        ws.send(JSON.stringify(buildContainerAttestFrame(consumer, conn, CONTAINER_ID)));
        return;
      }
      ws.send(
        JSON.stringify({
          type: CONTAINER_ATTEST_FRAME_TYPE,
          capabilities: opts.attest === "yes" ? [MODEL_AUTHORITY_CAPABILITY] : [],
          connectionChallenge: "chal-" + Math.random().toString(16).slice(2),
          containerId: CONTAINER_ID,
          authorityTtlMs: 120_000,
          // legacy = 旧 release:整个字段缺席;stale = 有 ring 但不含 master 的 activeKeyId
          ...(keyIdsMode === "stale"
            ? { keyIds: ["mak1_0000000000000000"], keyringFingerprint: "deadbeefdeadbeef" }
            : {}),
        }),
      );
    };
    if (opts.attestDelayMs) setTimeout(sendAttest, opts.attestDelayMs);
    else sendAttest();
    ws.on("message", (data) => {
      containerSeen.push(
        typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "",
      );
    });
  });

  const modelAuthority: BridgeModelAuthorityDeps | undefined =
    opts.authorityOn === false
      ? undefined
      : {
          signer,
          catalog: fakeCatalog(makeSnapshot(opts.auxState ?? "active"), {
            fenceFails: opts.fenceFails,
          }),
          recycleContainer: (containerId, reason) => recycled.push({ containerId, reason }),
          attestTimeoutMs: opts.attestTimeoutMs ?? 10_000,
          // 签发边界的 epoch 直读(MAJOR-2)。默认与快照 epoch 同值 = 无安全写发生;
          // 用例可在 turn 途中改 epochAtSign.value 模拟 admin 的 disable/撤销/改价。
          readSecurityEpoch: async () => {
            if (epochAtSign.fail === true) throw new Error("db down");
            return epochAtSign.value;
          },
          census,
        };

  const bridge = createUserChatBridge({
    jwtSecret: JWT_SECRET,
    resolveContainerEndpoint: async () => ({
      host: "127.0.0.1",
      port: containerPort,
      containerId: CONTAINER_ID,
    }),
    containerConnectTimeoutMs: 1500,
    ...(modelAuthority ? { modelAuthority } : {}),
    ...(opts.admitUserTurn ? { admitUserTurn: opts.admitUserTurn } : {}),
    ...(opts.loadMasterSessionMessages
      ? { loadMasterSessionMessages: opts.loadMasterSessionMessages }
      : {}),
    ...(opts.hasCompletedClientTurn
      ? { hasCompletedClientTurn: opts.hasCompletedClientTurn }
      : {}),
    ...(opts.loadGoalState
      ? { loadGoalState: opts.loadGoalState as UserChatBridgeDeps["loadGoalState"] }
      : {}),
    // B3(R3):注入 pgPool 时必须补齐 codex 计费三件套(bridge fail-closed 校验);glm-5.2(CCB)
    // 在 goal 失败(转发前)短路,故 preCheckRedis/pricing 永不被调用,空桩即可满足类型。
    ...(opts.pgPool
      ? {
          pgPool: opts.pgPool as UserChatBridgeDeps["pgPool"],
          preCheckRedis: {
            atomicReserve: async () => ({ ok: true }),
            release: async () => {},
          } as unknown as UserChatBridgeDeps["preCheckRedis"],
          pricing: { get: () => undefined } as unknown as UserChatBridgeDeps["pricing"],
        }
      : {}),
  });

  const gateway = http.createServer((_, res) => res.end());
  gateway.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  const port = (gateway.address() as { port: number }).port;

  return { gateway, bridge, port, containerWss, containerSeen, recycled, signer, census, epochAtSign };
}

async function stopRig(rig: Rig): Promise<void> {
  await rig.bridge.shutdown();
  await new Promise<void>((r) => rig.containerWss.close(() => r()));
  await new Promise<void>((r) => rig.gateway.close(() => r()));
}

async function openClient(port: number, role: "user" | "admin" = "user"): Promise<WebSocket> {
  const { token } = await signAccess({ sub: String(UID), role }, JWT_SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_WS_PATH}`, ["bearer", token]);
  await new Promise<void>((r, j) => {
    ws.once("open", () => r());
    ws.once("error", j);
  });
  return ws;
}

/** 持久收帧器(避免背靠背双帧丢帧竞态;见 userChatBridge.test.ts 同款注释)。 */
function frameCollector(ws: WebSocket): { next: () => Promise<Record<string, unknown>> } {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(f: Record<string, unknown>) => void> = [];
  ws.on("message", (data) => {
    const s = typeof data === "string" ? data : (data as Buffer).toString("utf8");
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(s) as Record<string, unknown>; } catch { return; }
    // sys.* 是 bridge 的带外信号(cold_start / relay_ready / frontend_build),不是业务帧。
    if (typeof obj.type === "string" && obj.type.startsWith("sys.")) return;
    const w = waiters.shift();
    if (w) w(obj);
    else queue.push(obj);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const q = queue.shift();
        if (q) resolve(q);
        else waiters.push(resolve);
      }),
  };
}

function inboundFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "inbound.message",
    channel: "webchat",
    peer: { id: "p1", kind: "dm" },
    content: { text: "hi" },
    ts: Date.now(),
    model: "glm-5.2",
    ...over,
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

/** 取容器收到的第一条 inbound.message(过滤 hello 等)。 */
function firstInbound(seen: string[]): Record<string, unknown> {
  for (const s of seen) {
    try {
      const f = JSON.parse(s) as Record<string, unknown>;
      if (f.type === "inbound.message") return f;
    } catch { /* skip */ }
  }
  throw new Error(`no inbound.message forwarded; seen=${JSON.stringify(seen)}`);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("bridge ↔ gateway 跨包契约 parity(两包不互相 import 生产代码)", () => {
  test("attest 帧 type 双侧同值(改一侧 = bridge 永远等不到 attest → 全站拒连接)", () => {
    assert.equal(CONTAINER_ATTEST_FRAME_TYPE, GATEWAY_ATTEST_FRAME_TYPE);
  });

  test("capability schema version 双侧同值(master 签的 profile 容器必须认得)", () => {
    // 不等 = master 会签出容器 fail-closed 拒收的 descriptor(或反之默默漏校验)。
    // 新增 capability_profile 字段时**两处同 bump**,这条断言就是那个提醒。
    assert.equal(CAPABILITY_SCHEMA_VERSION, GATEWAY_CAPABILITY_SCHEMA_VERSION);
  });
});

describe("bridge 模型执行权威 — flag 关 = 零行为变化", () => {
  let rig: Rig;
  before(async () => { rig = await startRig({ attest: "silent", authorityOn: false }); });
  after(async () => { await stopRig(rig); });

  test("不注入 modelAuthority → 不签发、不注入、不要求 attestation", async () => {
    const ws = await openClient(rig.port);
    ws.send(inboundFrame());
    await waitFor(() => rig.containerSeen.some((s) => s.includes("inbound.message")));
    const f = firstInbound(rig.containerSeen);
    assert.equal(MODEL_AUTHORITY_FIELD in f, false, "flag 关不得注入 envelope");
    assert.equal(f.model, "glm-5.2");
    assert.ok(typeof f.traceId === "string", "既有 traceId 契约不受影响");
    assert.equal(ws.readyState, WebSocket.OPEN, "容器没 attest 也不该被拒");
    ws.close();
  });
});

describe("bridge 模型执行权威 — 签发注入(容器已 attest)", () => {
  let rig: Rig;
  before(async () => { rig = await startRig({ attest: "yes" }); });
  after(async () => { await stopRig(rig); });

  test("注入的 envelope 能被容器 keyring 验通过,且绑定本连接 challenge", async () => {
    const ws = await openClient(rig.port);
    ws.send(inboundFrame());
    await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
    const f = firstInbound(rig.containerSeen);

    const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string; lease: string };
    assert.ok(bundle?.authority && bundle?.lease, "authority + lease 两张票据都要有");

    const keyring = rig.signer.publicKeyring();
    const payload = verifyAuthority(bundle.authority, keyring, Date.now());
    const lease = verifyTurnLease(bundle.lease, keyring, Date.now());
    assertLeaseMatchesAuthority(lease, payload); // 不抛 = 绑定字段全一致

    assert.equal(payload.uid, UID);
    assert.equal(payload.containerId, CONTAINER_ID);
    assert.equal(payload.canonicalModel, "glm-5.2");
    assert.equal(payload.engine, "ccb");
    assert.equal(payload.securityEpoch, 12);
    assert.equal(payload.executionDescriptor.contextWindow, 200_000);
    assert.equal(payload.executionDescriptor.supportsVision, false);
    assert.deepEqual([...payload.executionDescriptor.supportedEfforts], ["low", "medium", "high"]);
    // challenge 必须来自容器 attest 帧(**真 gateway 代码**现铸的 128bit CSPRNG),
    // 而不是 bridge 自己编的 —— 否则「绑连接」这条防重放的腿是假的。
    assert.match(payload.connectionChallenge, /^[0-9a-f]{32}$/);
    // frame.model 必须已归一 —— 容器会断言 canonicalModel === frame.model。
    assert.equal(f.model, payload.canonicalModel);
    ws.close();
  });

  test("角色分档窗口投影:kimi-k3 user 签 512000,admin 签 1048576;glm-5.2 不受影响", async () => {
    // 结构 guard(勿删):这是**执行轴**(JWT 角色 → bridge 签发 descriptor.contextWindow)
    // 唯一的端到端证据。执行轴不进 projectionRevision 409 对账(那只覆盖 listForUser 的 DB
    // 角色列表轴),所以删掉本用例 = 拆掉执行轴唯一防线的另一半,漂移将无任何自动化拦截。
    // modelRolePolicy 的签发边界落点:descriptor.contextWindow 按连接角色收窄,
    // 驱动 CCB auto-compact —— 这是"admin 1M / 其他 500k"的实际执行面。
    const grab = async (role: "user" | "admin", model: string): Promise<number | null> => {
      rig.containerSeen.length = 0;
      const ws = await openClient(rig.port, role);
      ws.send(inboundFrame({ model }));
      await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
      const f = firstInbound(rig.containerSeen);
      const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string };
      const payload = verifyAuthority(bundle.authority, rig.signer.publicKeyring(), Date.now());
      ws.close();
      return payload.executionDescriptor.contextWindow;
    };
    assert.equal(await grab("user", "kimi-k3"), 512_000);
    assert.equal(await grab("admin", "kimi-k3"), 1_048_576);
    // 未登记模型不受策略影响(哪个角色都拿机制窗口)
    assert.equal(await grab("user", "glm-5.2"), 200_000);
  });

  test("ccb turn:auxModels = 平台次级模型集合(WebFetch/WebSearch 的隐藏调用能过 egress)", async () => {
    rig.containerSeen.length = 0;
    const ws = await openClient(rig.port);
    ws.send(inboundFrame()); // glm-5.2 = ccb
    await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
    const f = firstInbound(rig.containerSeen);
    const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string; lease: string };

    const keyring = rig.signer.publicKeyring();
    const payload = verifyAuthority(bundle.authority, keyring, Date.now());
    const lease = verifyTurnLease(bundle.lease, keyring, Date.now());
    // 权威源 = gateway DEFAULT_SECONDARY_UTILITY_MODEL(容器 ANTHROPIC_SMALL_FAST_MODEL 的实际取值)
    assert.deepEqual([...(payload.auxModels ?? [])], [DEFAULT_SECONDARY_UTILITY_MODEL]);
    // lease 必须同值:WebFetch 常发生在 turn 中段,那时只有 lease 在飞
    assert.deepEqual([...(lease.auxModels ?? [])], [DEFAULT_SECONDARY_UTILITY_MODEL]);
    assert.doesNotThrow(() => assertLeaseMatchesAuthority(lease, payload));
    ws.close();
  });

  test("codex turn:auxModels 为空(codex 不经 anthropic proxy → 最小权限)", async () => {
    rig.containerSeen.length = 0;
    const ws = await openClient(rig.port);
    ws.send(inboundFrame({ model: "gpt-latest" })); // → canonical gpt-5.6-sol(codex)
    await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
    const f = firstInbound(rig.containerSeen);
    const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string };
    const payload = verifyAuthority(bundle.authority, rig.signer.publicKeyring(), Date.now());
    assert.equal(payload.engine, "codex");
    assert.deepEqual([...(payload.auxModels ?? [])], []);
    ws.close();
  });

  test("alias 归一:frame.model=gpt-latest → 签发 + 改写为 canonical gpt-5.6-sol,engine=codex", async () => {
    rig.containerSeen.length = 0;
    const ws = await openClient(rig.port);
    // codex 系模型但本 rig 没注 codexBinding/createCodexRoute → 走非 codex 转发路径,
    // 签发链路仍必须按 catalog 判 engine='codex'(判定源 = catalog,不是 baked 前缀表)。
    ws.send(inboundFrame({ model: "gpt-latest" }));
    await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
    const f = firstInbound(rig.containerSeen);
    const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string };
    const payload = verifyAuthority(bundle.authority, rig.signer.publicKeyring(), Date.now());
    assert.equal(payload.canonicalModel, "gpt-5.6-sol");
    assert.equal(payload.engine, "codex");
    assert.equal(payload.executionDescriptor.codexDefaultEffort, "xhigh");
    assert.equal(f.model, "gpt-5.6-sol", "转发帧的 model 必须是 canonical");
    ws.close();
  });

  test("客户端伪造的 __oc_model_authority 被无条件 strip,替换为 master 签发", async () => {
    rig.containerSeen.length = 0;
    const ws = await openClient(rig.port);
    ws.send(
      inboundFrame({
        [MODEL_AUTHORITY_FIELD]: { authority: "FORGED", lease: "FORGED" },
      }),
    );
    await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
    const f = firstInbound(rig.containerSeen);
    const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string };
    assert.notEqual(bundle.authority, "FORGED");
    // 能验通过 = 这就是 master 的票,不是客户端塞的。
    const payload = verifyAuthority(bundle.authority, rig.signer.publicKeyring(), Date.now());
    assert.equal(payload.uid, UID);
    ws.close();
  });

  test("每条 inbound 现铸一枚 authorityTurnId(容器按单次消费拒重放)", async () => {
    rig.containerSeen.length = 0;
    const ws = await openClient(rig.port);
    ws.send(inboundFrame());
    await waitFor(() => rig.containerSeen.filter((s) => s.includes(MODEL_AUTHORITY_FIELD)).length >= 1);
    ws.send(inboundFrame());
    await waitFor(() => rig.containerSeen.filter((s) => s.includes(MODEL_AUTHORITY_FIELD)).length >= 2);

    const keyring = rig.signer.publicKeyring();
    const turnIds = rig.containerSeen
      .filter((s) => s.includes(MODEL_AUTHORITY_FIELD))
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .map((f) => (f[MODEL_AUTHORITY_FIELD] as { authority: string }).authority)
      .map((a) => verifyAuthority(a, keyring, Date.now()).authorityTurnId);
    assert.equal(new Set(turnIds).size, turnIds.length, "authorityTurnId 不得复用");
    ws.close();
  });
});

describe("bridge 模型执行权威 — attestation 门(方案 §7 步 4 三类竞态)", () => {
  test("attest 晚到:期间的用户帧被缓冲,attest 到达后原样重放(不丢、不早发)", async () => {
    const rig = await startRig({ attest: "yes", attestDelayMs: 250 });
    try {
      const ws = await openClient(rig.port);
      ws.send(inboundFrame());
      // attest 未到 → 帧不得到达容器。
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(
        rig.containerSeen.some((s) => s.includes("inbound.message")),
        false,
        "未 attest 前不得放行用户帧(否则容器按 baked 判定跑 = 双信任源)",
      );
      // attest 到达 → 缓冲帧重放并带上签名。
      await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)), 3000);
      const f = firstInbound(rig.containerSeen);
      const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string };
      verifyAuthority(bundle.authority, rig.signer.publicKeyring(), Date.now());
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("容器不广播 capability(旧 release / 旧 env)→ 拒连接 + 触发 stale recycle", async () => {
    const rig = await startRig({ attest: "no-capability" });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      ws.send(inboundFrame());

      const err = await frames.next();
      assert.equal(err.type, "error");
      assert.equal(err.code, "CONTAINER_OUTDATED");
      assert.equal(await closed, CLOSE_BRIDGE.ENV_RECYCLED);
      assert.deepEqual(rig.recycled, [
        { containerId: CONTAINER_ID, reason: "model_authority_capability_missing" },
      ]);
      assert.equal(
        rig.containerSeen.some((s) => s.includes("inbound.message")),
        false,
        "拒连接的容器不得收到任何用户帧",
      );
    } finally {
      await stopRig(rig);
    }
  });

  test("容器沉默不 attest → 超时后拒连接 + recycle(缓冲不是无限等待)", async () => {
    const rig = await startRig({ attest: "silent", attestTimeoutMs: 200 });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      ws.send(inboundFrame());

      const err = await frames.next();
      assert.equal(err.code, "CONTAINER_OUTDATED");
      assert.equal(await closed, CLOSE_BRIDGE.ENV_RECYCLED);
      assert.deepEqual(rig.recycled, [
        { containerId: CONTAINER_ID, reason: "attestation_timeout" },
      ]);
    } finally {
      await stopRig(rig);
    }
  });
});

describe("bridge 模型执行权威 — fail-closed(绝不降级为无 envelope 转发)", () => {
  test("模型不在 catalog(不可路由)→ MODEL_NOT_AVAILABLE,帧不转发", async () => {
    const rig = await startRig({ attest: "yes" });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      ws.send(inboundFrame({ model: "retired-model" }));
      const err = await frames.next();
      assert.equal(err.type, "error");
      assert.equal(err.code, "MODEL_NOT_AVAILABLE");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        rig.containerSeen.some((s) => s.includes("inbound.message")),
        false,
        "不可路由的模型不得被转发(降级转发 = 容器回落 baked 判定)",
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("平台次级模型不在 catalog active(disabled / 缺行)→ 签发期 fail-closed,帧不转发", async () => {
    // 签一张"aux 说了也用不了"的票 = 把故障推迟到 egress 的 403(现场丢失)。
    // 签发期直接拒:master 日志响亮 + 用户拿到明确错误码。
    for (const auxState of ["disabled", "absent"] as const) {
      const rig = await startRig({ attest: "yes", auxState });
      try {
        const ws = await openClient(rig.port);
        const frames = frameCollector(ws);
        ws.send(inboundFrame()); // glm-5.2(ccb)→ 需要 aux 集合
        const err = await frames.next();
        assert.equal(err.type, "error");
        assert.equal(err.code, "MODEL_AUTHORITY_UNAVAILABLE", `auxState=${auxState}`);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(
          rig.containerSeen.some((s) => s.includes("inbound.message")),
          false,
          `auxState=${auxState}:aux 不可用时不得降级为无 envelope / 空 aux 转发`,
        );
        ws.close();
      } finally {
        await stopRig(rig);
      }
    }
  });

  test("epoch fence 失败(DB 不可达)→ MODEL_AUTHORITY_UNAVAILABLE,帧不转发", async () => {
    const rig = await startRig({ attest: "yes", fenceFails: true });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      ws.send(inboundFrame());
      const err = await frames.next();
      assert.equal(err.code, "MODEL_AUTHORITY_UNAVAILABLE");
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        rig.containerSeen.some((s) => s.includes("inbound.message")),
        false,
        "fence 不过一律拒帧(零 stale window)",
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 代码审 R1 MAJOR-2:签发边界的 epoch 重读
// ─────────────────────────────────────────────────────────────────────────────

describe("bridge 模型执行权威 — 签发边界 epoch 重读(MAJOR-2)", () => {
  test("fence 通过后 epoch 变了(admin 禁用/撤销/改价)→ 签发前拒帧,不签、不转发", async () => {
    const rig = await startRig({ attest: "yes" });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      // 起手 fence 用的是快照 epoch=12;这里把 DB epoch 抬到 13 = turn 途中发生了安全写。
      // 只 fence 一次的旧实现会拿**过时快照**签出一张 lease TTL 50min 的票。
      rig.epochAtSign.value = 13n;
      ws.send(inboundFrame());
      const err = await frames.next();
      assert.equal(err.type, "error");
      assert.equal(err.code, "MODEL_CONFIG_CHANGED_RETRY_TURN");
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(
        rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)),
        false,
        "epoch 变了就不许签票",
      );
      assert.equal(
        rig.containerSeen.some((s) => s.includes("inbound.message")),
        false,
        "更不许降级为无 envelope 转发",
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("签发边界 epoch 读不到(DB 挂)→ fail-closed 拒帧(不当作『没变』)", async () => {
    const rig = await startRig({ attest: "yes" });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      rig.epochAtSign.fail = true;
      ws.send(inboundFrame());
      const err = await frames.next();
      assert.equal(err.code, "MODEL_AUTHORITY_UNAVAILABLE");
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(rig.containerSeen.some((s) => s.includes("inbound.message")), false);
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("epoch 没变 → 正常签发(重读只拦真正的变更,不误伤)", async () => {
    const rig = await startRig({ attest: "yes" });
    try {
      const ws = await openClient(rig.port);
      ws.send(inboundFrame());
      await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
      const f = firstInbound(rig.containerSeen);
      const bundle = f[MODEL_AUTHORITY_FIELD] as { authority: string; lease: string };
      const payload = verifyAuthority(bundle.authority, rig.signer.publicKeyring(), Date.now());
      assert.equal(payload.securityEpoch, 12);
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 代码审 R1 MAJOR-3 ④:attestation 上报 keyIds + master 侧 census(轮换步骤② 的 gate)
// ─────────────────────────────────────────────────────────────────────────────

describe("bridge 模型执行权威 — keyring census(轮换步骤② gate)", () => {
  test("容器 attest 上报 keyIds/指纹 → census 覆盖 = 全覆盖;连接关闭 → 出册", async () => {
    const rig = await startRig({ attest: "yes" });
    try {
      const ws = await openClient(rig.port);
      // attest 成功后才会登记(登记发生在 attest 帧到达时,不必等业务帧)
      await waitFor(() => rig.census.size === 1);
      const snap = rig.census.snapshot();
      assert.equal(snap.connections, 1);
      assert.equal(snap.unknown, 0, "真容器必须自报 keyIds");
      assert.equal(snap.byKeyId[rig.signer.activeKeyId], 1);
      assert.deepEqual(Object.keys(snap.byFingerprint), [rig.signer.fingerprint()]);

      const cov = rig.census.coverage(rig.signer.activeKeyId);
      assert.equal(cov.fullyCovered, true, "全部在跑连接都认得 active key → 可以切私钥");
      assert.deepEqual(cov.missing, []);

      // 轮换步骤①:master 加了新公钥但容器还没换 env → 步骤② 的 gate 必须为 false,
      // 否则运维会在容器认不得新钥的情况下切私钥 = 全站 UnknownKey。
      const newKeyId = rig.signer.addKey();
      assert.equal(rig.census.isFullyCovered(newKeyId), false);

      ws.close();
      await waitFor(() => rig.census.size === 0, 3000);
    } finally {
      await stopRig(rig);
    }
  });

  test("旧 release 容器(attest 无 keyIds 字段)→ 不判死,但 census 记 unknown = 永不算覆盖", async () => {
    const rig = await startRig({ attest: "yes", keyIds: "legacy" });
    try {
      const ws = await openClient(rig.port);
      await waitFor(() => rig.census.size === 1);
      assert.equal(rig.census.snapshot().unknown, 1);
      const cov = rig.census.coverage(rig.signer.activeKeyId);
      assert.equal(cov.fullyCovered, false, "不知道 ≠ 认得:轮换 gate 必须 fail-closed");
      assert.equal(cov.missing[0]?.keyIdsUnknown, true);
      // 但它仍然是可服务的(capability 有 + challenge 有)→ 帧照常签发转发
      ws.send(inboundFrame());
      await waitFor(() => rig.containerSeen.some((s) => s.includes(MODEL_AUTHORITY_FIELD)));
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("容器 ring 里没有 master 的 activeKeyId → 当场拒连接 + recycle(不让用户撞一轮 403)", async () => {
    const rig = await startRig({ attest: "yes", keyIds: "stale" });
    try {
      const ws = await openClient(rig.port);
      const frames = frameCollector(ws);
      const err = await frames.next();
      assert.equal(err.code, "CONTAINER_OUTDATED");
      await waitFor(() => rig.recycled.length === 1);
      assert.equal(rig.recycled[0].reason, "model_authority_active_key_missing");
      assert.equal(rig.census.size, 0, "判死的连接不进 census");
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B10 — dispatch 路径 legacy-completed dedup 在受理之前(不留孤儿 admitted dispatch)
// ─────────────────────────────────────────────────────────────────────────────

function fakeAdmittedDispatch(clientMessageId: string): AdmitUserTurnResult {
  const now = new Date();
  return {
    kind: "admitted",
    takeover: false,
    dispatch: {
      dispatchId: "11111111-1111-4111-8111-111111111111",
      userId: BigInt(UID),
      sessionId: "sess-b10",
      clientMessageId,
      agentId: "main",
      model: "glm-5.2",
      requestHash: "h".repeat(64),
      billingRequestId: "br-b10",
      attemptNo: 1,
      status: "admitted",
      outcome: null,
      failureCode: null,
      conflictReason: null,
      resolution: null,
      resolvedAt: null,
      clientNotified: false,
      ownerId: "conn-b10",
      leaseEpoch: 1,
      leaseUntil: new Date(now.getTime() + 90_000),
      anchorSeq: 5n,
      admittedAt: now,
      acceptedAt: null,
      terminalAt: null,
      lastAttemptAt: now,
    },
  };
}

describe("bridge B10 — dispatch 路径 legacy-completed dedup 先于受理", () => {
  test("已有 completed assistant 行 → dedup ack 且 admitUserTurn 从未被调用(无孤儿 dispatch)", async () => {
    let admitCalls = 0;
    const rig = await startRig({
      attest: "yes",
      durableDispatch: true,
      admitUserTurn: async (input) => {
        admitCalls++;
        return fakeAdmittedDispatch(input.clientMessageId);
      },
      loadMasterSessionMessages: async () => [
        { id: "cm-b10", role: "user", text: "do once", ts: 1 },
        {
          id: "srv-b10",
          role: "assistant",
          text: "already done",
          status: "completed",
          _clientMessageId: "cm-b10",
          ts: 2,
        },
      ],
      hasCompletedClientTurn: async (_uid, _sessionId, clientMessageId) =>
        clientMessageId === "cm-b10",
    });
    try {
      const ws = await openClient(rig.port);
      const fc = frameCollector(ws);
      ws.send(
        inboundFrame({
          clientMessageId: "cm-b10",
          idempotencyKey: "web:cm-b10:0",
          peer: { id: "sess-b10", kind: "dm" },
        }),
      );
      const ack = await fc.next();
      assert.equal(ack.type, "outbound.ack");
      assert.equal(ack.deduplicated, true);
      assert.equal(ack.clientMessageId, "cm-b10");
      // B10 核心:dedup 在受理之前 → admitUserTurn 从未被调用 → 无永续租的孤儿 dispatch。
      assert.equal(admitCalls, 0);
      // 未转发任何 inbound.message。
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(
        rig.containerSeen.some((s) => {
          try { return (JSON.parse(s) as { type?: string }).type === "inbound.message"; }
          catch { return false; }
        }),
        false,
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("无 completed 行 → 正常受理(admitUserTurn 被调用一次,不被 dedup 误伤)", async () => {
    let admitCalls = 0;
    let historyContext: Parameters<NonNullable<UserChatBridgeDeps["loadMasterSessionMessages"]>>[2] | null = null;
    const rig = await startRig({
      attest: "yes",
      durableDispatch: true,
      admitUserTurn: async (input) => {
        admitCalls++;
        return fakeAdmittedDispatch(input.clientMessageId);
      },
      loadMasterSessionMessages: async (_uid, _sessionId, context) => {
        historyContext = context;
        return [
          { id: "u-old", role: "user", text: "older", ts: 1 },
          { id: "a-old", role: "assistant", text: "older answer", status: "completed", _clientMessageId: "u-old", ts: 2 },
        ];
      },
      hasCompletedClientTurn: async () => false,
    });
    try {
      const ws = await openClient(rig.port);
      ws.send(
        inboundFrame({
          clientMessageId: "cm-fresh",
          idempotencyKey: "web:cm-fresh:0",
          peer: { id: "sess-b10", kind: "dm" },
        }),
      );
      // dedup 只在同 clientMessageId 已 completed 时短路;此轮是新 id → 受理照常进行。
      await waitFor(() => admitCalls === 1);
      assert.equal(admitCalls, 1);
      await waitFor(() => historyContext !== null);
      assert.deepEqual(historyContext, {
        contextWindow: 200_000,
        engine: "ccb",
        currentUserText: "hi",
        excludeClientMessageId: "cm-fresh",
      });
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B3(R3)— 受理成功后 pre-forward 失败出口必须终态化 dispatch(否则 admitted 永续租孤儿)
// ─────────────────────────────────────────────────────────────────────────────
describe("bridge B3 — 受理后 GoalState 失败 → dispatch CAS terminal(executed_error)+ 不转发", () => {
  test("goal 读失败(非 NOT_FOUND)→ 受理后终态化:casToTerminal(executed_error) + drop + 无转发", async () => {
    const DISPATCH_ID = "11111111-1111-4111-8111-111111111111"; // fakeAdmittedDispatch 固定值
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    // mock pgPool:捕获所有 query,统一回空;user 状态查空 → 不拦(fail-open)。
    const pgPool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    let admitCalls = 0;
    const rig = await startRig({
      attest: "yes",
      durableDispatch: true,
      pgPool,
      admitUserTurn: async (input) => {
        admitCalls++;
        return fakeAdmittedDispatch(input.clientMessageId);
      },
      // goal 读抛非 NOT_FOUND 错 → resolveTurnGoalState 判 unavailable → 受理后拒轮。
      loadGoalState: async () => {
        throw new Error("goal db down");
      },
    });
    try {
      const ws = await openClient(rig.port);
      const fc = frameCollector(ws);
      ws.send(
        inboundFrame({
          clientMessageId: "cm-goal-fail",
          idempotencyKey: "web:cm-goal-fail:0",
          peer: { id: "sess-b3", kind: "dm" },
        }),
      );
      // 1) 受理发生(admitUserTurn 被调用)。
      await waitFor(() => admitCalls === 1);
      // 2) 用户收到 GOAL_STATE_UNAVAILABLE 错误帧。
      let errFrame: Record<string, unknown> | null = null;
      for (let i = 0; i < 30 && errFrame === null; i++) {
        const f = await Promise.race([
          fc.next(),
          new Promise<Record<string, unknown>>((r) => setTimeout(() => r({ type: "__timeout" }), 200)),
        ]);
        if ((f.code === "GOAL_STATE_UNAVAILABLE") || (f.type === "error" && (f as { code?: string }).code === "GOAL_STATE_UNAVAILABLE")) {
          errFrame = f;
        } else if (f.type === "__timeout") {
          break;
        }
      }
      assert.ok(errFrame, "用户收到 GOAL_STATE_UNAVAILABLE 错误帧");
      // 3) B3 核心:受理后失败出口 → casToTerminal(executed_error) 落到 pgPool。
      await waitFor(() =>
        queries.some(
          (q) =>
            /UPDATE turn_dispatches/.test(q.sql) &&
            /status = 'terminal'/.test(q.sql) &&
            q.params[0] === DISPATCH_ID &&
            q.params[1] === "executed_error",
        ),
      );
      const casQ = queries.find(
        (q) => /status = 'terminal'/.test(q.sql) && q.params[0] === DISPATCH_ID && q.params[1] === "executed_error",
      )!;
      // failureCode 明确(goal 出口),clientNotified=false(durable「已通知」只由 reconciler 置真)。
      assert.equal(casQ.params[2], "goal_state_unavailable", "failure_code = goal_state_unavailable");
      assert.equal(casQ.params[3], false, "client_notified=false(不用瞬态 socket 态推断)");
      // 4) 绝不转发 inbound.message(拒轮先于转发)。
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(
        rig.containerSeen.some((s) => {
          try { return (JSON.parse(s) as { type?: string }).type === "inbound.message"; }
          catch { return false; }
        }),
        false,
        "goal 失败拒轮 → 无 inbound.message 转发",
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("R4-B1 受理 await 期间连接 cleanup → admitted 仍被接管终态化,无孤儿 lease、无转发", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pgPool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    const DISPATCH_ID = "11111111-1111-4111-8111-111111111111"; // fakeAdmittedDispatch 固定值
    let admitCalls = 0;
    let releaseAdmit: (() => void) | null = null;
    const admitGate = new Promise<void>((r) => { releaseAdmit = r; });
    const rig = await startRig({
      attest: "yes",
      durableDispatch: true,
      pgPool,
      admitUserTurn: async (input) => {
        admitCalls++;
        // 受控暂停:让 cleanup 发生在 admit await 期间(R4-B1 的精确竞态窗)。
        await admitGate;
        return fakeAdmittedDispatch(input.clientMessageId);
      },
    });
    try {
      const ws = await openClient(rig.port);
      ws.send(
        inboundFrame({
          clientMessageId: "cm-race-b1",
          idempotencyKey: "web:cm-race-b1:0",
          peer: { id: "sess-race", kind: "dm" },
        }),
      );
      await waitFor(() => admitCalls === 1);
      // admission 挂起中,客户端断连 → bridge cleanup(cleaned=true,双 map 皆空立即 final)。
      ws.close();
      await new Promise((r) => setTimeout(r, 80));
      // 现在才让 admission 提交成功返回 —— 修复前:early return 于登记前,孤儿 admitted;
      // 修复后:先接管(登记)再判 cleaned → 立即 failDispatchPreForward 终态化。
      releaseAdmit!();
      await waitFor(() =>
        queries.some(
          (q) =>
            /UPDATE turn_dispatches/.test(q.sql) &&
            /status = 'terminal'/.test(q.sql) &&
            q.params[0] === DISPATCH_ID &&
            q.params[1] === "executed_error" &&
            q.params[2] === "bridge_closed_during_admission",
        ),
      );
      const casQ = queries.find((q) => q.params[2] === "bridge_closed_during_admission")!;
      assert.equal(casQ.params[3], false, "client_notified=false(连接已死,durable 告知交 reconciler)");
      // 绝不转发:连接死于受理期,帧不得进容器。
      assert.equal(
        rig.containerSeen.some((s2) => {
          try { return (JSON.parse(s2) as { type?: string }).type === "inbound.message"; }
          catch { return false; }
        }),
        false,
        "cleanup 后受理成功 → 终态化而非转发",
      );
      // R5 note:cleaned 命中路径不得启动 heartbeat interval(finalCleanup 已过,无人清理 = 闭包泄漏)。
      // 行为断言:终态化后静置 >1 个心跳间隔窗口的缩影,pgPool 不再出现 lease heartbeat UPDATE。
      const qCountAfterTerminal = queries.length;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        queries.slice(qCountAfterTerminal).some((q) => /lease_until/.test(q.sql) && /UPDATE turn_dispatches/.test(q.sql) && !/status = 'terminal'/.test(q.sql)),
        false,
        "无 late heartbeat(interval 未被启动)",
      );
    } finally {
      await stopRig(rig);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M7(R3)— durable dispatch drain 窗口:有在飞 admitted dispatch 时 ≥60s(默认),
// drain 定时 = max(billing, dispatch)。
// ─────────────────────────────────────────────────────────────────────────────
describe("M7 readDispatchDrainMs — 默认 ≥60s / clamp ≤120s / env 覆盖", () => {
  const KEY = "OC_DISPATCH_DRAIN_MS";
  function withEnv(v: string | undefined, fn: () => void): void {
    const prev = process.env[KEY];
    if (v === undefined) delete process.env[KEY];
    else process.env[KEY] = v;
    try { fn(); } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }
  test("缺省 → 60_000(≥60s)", () => {
    withEnv(undefined, () => assert.equal(_readDispatchDrainMs(), 60_000));
  });
  test("env 覆盖 90s → 90_000", () => {
    withEnv("90000", () => assert.equal(_readDispatchDrainMs(), 90_000));
  });
  test("env 200s → clamp 到硬上限 120_000", () => {
    withEnv("200000", () => assert.equal(_readDispatchDrainMs(), 120_000));
  });
  test("env 非法/过小 → 回落 60_000", () => {
    withEnv("nope", () => assert.equal(_readDispatchDrainMs(), 60_000));
    withEnv("10", () => assert.equal(_readDispatchDrainMs(), 60_000));
  });
});

describe("M7 drain 窗口:有 admitted dispatch → max(billing, dispatch)（非 5s billing 窗口）", () => {
  test("admitted 未终态 + user close → drain 取 dispatch 窗口(远大于 billing)", async () => {
    const prevBilling = process.env.DRAIN_BILLING_MS;
    const prevDispatch = process.env.OC_DISPATCH_DRAIN_MS;
    // billing=100ms、dispatch=700ms:有 admitted → max=700ms;若误用 billing 窗口则 ~100ms。
    process.env.DRAIN_BILLING_MS = "100";
    process.env.OC_DISPATCH_DRAIN_MS = "700";
    const rig = await startRig({
      attest: "yes",
      durableDispatch: true,
      // admit 成功且不失败 goal → dispatch 保持 admitted(mock 容器不发 receipt/terminal,不掉出 map)。
      admitUserTurn: async (input) => fakeAdmittedDispatch(input.clientMessageId),
    });
    // 捕获 bridge→容器 socket 的 close 时刻(drain 结束时 finalCleanup 关它)。
    let containerCloseAt = 0;
    rig.containerWss.on("connection", (ws) => {
      ws.on("close", () => { if (containerCloseAt === 0) containerCloseAt = Date.now(); });
    });
    try {
      const ws = await openClient(rig.port);
      ws.send(
        inboundFrame({
          clientMessageId: "cm-m7",
          idempotencyKey: "web:cm-m7:0",
          peer: { id: "sess-m7", kind: "dm" },
        }),
      );
      // 等 dispatch 受理并转发(容器收到 inbound.message → dispatch 已 admitted 且在飞)。
      await waitFor(() =>
        rig.containerSeen.some((s) => {
          try { return (JSON.parse(s) as { type?: string }).type === "inbound.message"; }
          catch { return false; }
        }),
      );
      const closedAt = Date.now();
      ws.close(); // client_close → 有 admitted dispatch → 进 drain
      // 等 drain 结束(容器 socket 被 finalCleanup 关闭)。
      await waitFor(() => containerCloseAt > 0, 4000);
      const elapsed = containerCloseAt - closedAt;
      // 取 dispatch 窗口(700ms)而非 billing(100ms):留足抖动余量,断言明显 > billing 窗口。
      assert.ok(elapsed >= 500, `drain 应取 dispatch 窗口(~700ms),实测 ${elapsed}ms(billing=100ms 会 ~100ms)`);
    } finally {
      if (prevBilling === undefined) delete process.env.DRAIN_BILLING_MS;
      else process.env.DRAIN_BILLING_MS = prevBilling;
      if (prevDispatch === undefined) delete process.env.OC_DISPATCH_DRAIN_MS;
      else process.env.OC_DISPATCH_DRAIN_MS = prevDispatch;
      await stopRig(rig);
    }
  });
});
