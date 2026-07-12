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
  type BridgeModelAuthorityDeps,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";
import { AuthorityKeyCensus } from "../ws/authorityKeyCensus.js";
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
      },
    }),
  ];
  const pricing = new Map([
    ["glm-5.2", price("glm-5.2")],
    ["gpt-5.6-sol", price("gpt-5.6-sol")],
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

async function openClient(port: number): Promise<WebSocket> {
  const { token } = await signAccess({ sub: String(UID), role: "user" }, JWT_SECRET);
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
      const newKeyId = rig.signer.addKey({ activate: false });
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
