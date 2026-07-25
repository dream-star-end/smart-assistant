/**
 * bridge grants checker 的 **epoch 联动 fence**(代码审 R1 BLOCKER-1)。
 *
 * 跑法:npx tsx --test src/__tests__/bridgeGrantsEpochFence.test.ts
 *
 * 被修的洞:连接级 grants checker 只有 30s 周期刷新,且**刷新失败永久保留旧 checker**。
 * 撤销授权后 —— CCB 还有 egress 的每请求授权兜底,**codex 完全不经 /v1/messages egress** ——
 * 旧连接照样签票、照样执行。0144 让任何 grant 写都 bump security epoch,bridge 在每个 turn
 * 的 catalog fence 之后比对 checker 的 epoch 戳:漂移 → 同步重载 + 重新判定;重载失败 →
 * **拒帧**(禁止 keep-LKG 放行)。
 *
 * 覆盖:
 *   ① 稳态(epoch 未变)→ 不重载、正常转发(零额外开销)
 *   ② epoch 漂移 + 撤权   → 重载 → UNAUTHORIZED_MODEL 拒帧,容器**收不到**该帧
 *   ③ epoch 漂移 + 重载失败 → MODEL_AUTHORITY_UNAVAILABLE 拒帧(**不放行**)
 *   ④ epoch 漂移 + 仍授权   → 重载成功 → 正常转发
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { MODEL_AUTHORITY_CAPABILITY, MODEL_AUTHORITY_FIELD } from "@openclaude/protocol";
import { DEFAULT_SECONDARY_UTILITY_MODEL } from "@openclaude/gateway";

import { signAccess } from "../auth/jwt.js";
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import {
  createUserChatBridge,
  BRIDGE_WS_PATH,
  CONTAINER_ATTEST_FRAME_TYPE,
  type BridgeModelAuthorityDeps,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";

const JWT_SECRET = "x".repeat(32);
const UID = 4242;
const CONTAINER_ID = 11;
const MODEL = "glm-5.2";

// ─────────────────────────────────────────────────────────────────────────────
// catalog 夹具
// ─────────────────────────────────────────────────────────────────────────────

function entry(over: Partial<ModelCatalogEntry> & { entryId: number; modelId: string }): ModelCatalogEntry {
  return {
    engine: "ccb",
    providerId: "ark",
    upstreamModelId: null,
    contextWindow: 200_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: ["high", "max"], codexModelDefault: null },
      ccb: { capabilityZero: false, supportsThinking: true },
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
    visibility: "hidden", // 只能靠 grant 拿到 —— 撤权即不可用
    sortOrder: 1,
    defaultEffort: null,
  };
}

function snapshotAt(epoch: bigint): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: [
      entry({ entryId: 1, modelId: MODEL }),
      entry({ entryId: 2, modelId: DEFAULT_SECONDARY_UTILITY_MODEL, providerId: "deepseek" }),
    ],
    aliases: new Map(),
    pricing: new Map([
      [MODEL, price(MODEL)],
      [DEFAULT_SECONDARY_UTILITY_MODEL, price(DEFAULT_SECONDARY_UTILITY_MODEL)],
    ]),
    securityEpoch: epoch,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// rig
// ─────────────────────────────────────────────────────────────────────────────

interface Rig {
  gateway: http.Server;
  bridge: UserChatBridgeHandler;
  port: number;
  containerWss: WebSocketServer;
  /** 容器实际收到的帧(权威的"有没有放行")。 */
  containerSeen: string[];
  /** grants checker 被加载的次数(初始 1)。 */
  loads: () => number;
  /** 模拟 admin 撤权 + DB epoch bump(catalog 与 grants 同时前进)。 */
  revoke: (nextEpoch: bigint) => void;
  /** 模拟 epoch bump 但 grants 仍授权。 */
  bumpOnly: (nextEpoch: bigint) => void;
  /** 让后续的 grants 重载全部失败(DB 抖动)。 */
  breakLoader: () => void;
}

async function startRig(): Promise<Rig> {
  const containerSeen: string[] = [];
  let snapshot = snapshotAt(10n);
  let allowed = true;
  let loaderBroken = false;
  let loads = 0;

  const containerWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => containerWss.once("listening", () => r()));
  const containerPort = (containerWss.address() as { port: number }).port;
  containerWss.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        type: CONTAINER_ATTEST_FRAME_TYPE,
        capabilities: [MODEL_AUTHORITY_CAPABILITY],
        connectionChallenge: "chal-" + Math.random().toString(16).slice(2),
        containerId: CONTAINER_ID,
        authorityTtlMs: 120_000,
      }),
    );
    ws.on("message", (data) => {
      containerSeen.push(typeof data === "string" ? data : String(data));
    });
  });

  // catalog fake:assertFresh 恒返回**当前** snapshot(= 已 fence 过的权威快照)。
  const catalog = {
    peek: () => snapshot,
    current: () => snapshot,
    assertFresh: async () => snapshot,
  } as unknown as ModelCatalogCache;

  const modelAuthority: BridgeModelAuthorityDeps = {
    signer: AuthoritySigner.createEphemeral(),
    catalog,
    // 签发边界的 epoch 直读:与快照同源(不制造 MAJOR-2 的那种漂移,本用例只测 grants fence)。
    readSecurityEpoch: async () => snapshot.securityEpoch,
    attestTimeoutMs: 5_000,
  };

  const bridge = createUserChatBridge({
    jwtSecret: JWT_SECRET,
    resolveContainerEndpoint: async () => ({
      host: "127.0.0.1",
      port: containerPort,
      containerId: CONTAINER_ID,
    }),
    containerConnectTimeoutMs: 1500,
    loadAllowedModelChecker: async () => {
      loads += 1;
      if (loaderBroken) throw new Error("grants db down");
      const snapAllowed = allowed;
      return (modelId: string) => snapAllowed || modelId === DEFAULT_SECONDARY_UTILITY_MODEL;
    },
    modelAuthority,
  });

  const gateway = http.createServer((_, res) => res.end());
  gateway.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  const port = (gateway.address() as { port: number }).port;

  return {
    gateway,
    bridge,
    port,
    containerWss,
    containerSeen,
    loads: () => loads,
    revoke: (nextEpoch) => {
      allowed = false;
      snapshot = snapshotAt(nextEpoch);
    },
    bumpOnly: (nextEpoch) => {
      snapshot = snapshotAt(nextEpoch);
    },
    breakLoader: () => {
      loaderBroken = true;
    },
  };
}

async function stopRig(rig: Rig): Promise<void> {
  await rig.bridge.shutdown();
  await new Promise<void>((r) => rig.containerWss.close(() => r()));
  await new Promise<void>((r) => rig.gateway.close(() => r()));
}

async function connect(rig: Rig): Promise<WebSocket> {
  const { token } = await signAccess({ sub: String(UID), role: "user" }, JWT_SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${rig.port}${BRIDGE_WS_PATH}`, ["bearer", token]);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

/** 发一帧 inbound.message,收集这之后 300ms 内用户侧收到的**业务**帧(sys.* 是带外信号)。 */
async function send(ws: WebSocket, peerId: string): Promise<Record<string, unknown>[]> {
  const got: Record<string, unknown>[] = [];
  const onMsg = (d: unknown): void => {
    const s = typeof d === "string" ? d : String(d);
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      if (typeof obj.type === "string" && obj.type.startsWith("sys.")) return;
      got.push(obj);
    } catch {
      /* 非 JSON 帧忽略 */
    }
  };
  ws.on("message", onMsg);
  ws.send(
    JSON.stringify({
      type: "inbound.message",
      channel: "webchat",
      peer: { id: peerId, kind: "dm" },
      content: { text: "hi" },
      ts: Date.now(),
      model: MODEL,
      clientMessageId: `cm_${peerId}`,
    }),
  );
  await new Promise((r) => setTimeout(r, 300));
  ws.off("message", onMsg);
  return got;
}

function errorCodes(frames: Record<string, unknown>[]): string[] {
  const codes: string[] = [];
  for (const p of frames) {
    const err = p.error as { code?: string } | undefined;
    const code = (p.code as string | undefined) ?? err?.code;
    if (typeof p.type === "string" && p.type.includes("error") && typeof code === "string") {
      codes.push(code);
    }
  }
  return codes;
}

function forwardedInbound(seen: string[]): unknown[] {
  return seen
    .map((s) => {
      try {
        return JSON.parse(s) as { type?: string };
      } catch {
        return null;
      }
    })
    .filter((f): f is { type?: string } => f !== null && f.type === "inbound.message");
}

// ─────────────────────────────────────────────────────────────────────────────

describe("bridge grants checker · epoch fence(R1 BLOCKER-1)", () => {
  const rigs: Rig[] = [];
  after(async () => {
    for (const r of rigs) await stopRig(r);
  });

  test("稳态:epoch 未漂移 → 不重载 grants,帧照常带 envelope 转发", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const ws = await connect(rig);
    await new Promise((r) => setTimeout(r, 100)); // 等 attest

    const loadsAfterConnect = rig.loads();
    const frames = await send(ws, "s-steady");

    assert.deepEqual(errorCodes(frames), [], "稳态不该拒帧");
    assert.equal(rig.loads(), loadsAfterConnect, "epoch 没变 → 不该触发重载(稳态零开销)");
    const fwd = forwardedInbound(rig.containerSeen);
    assert.equal(fwd.length, 1, "帧应转发到容器");
    assert.ok(
      MODEL_AUTHORITY_FIELD in (fwd[0] as Record<string, unknown>),
      "转发帧必须带签名 envelope",
    );
    ws.close();
  });

  test("撤权:epoch 漂移 → 同步重载 → UNAUTHORIZED_MODEL 拒帧,容器收不到帧", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const ws = await connect(rig);
    await new Promise((r) => setTimeout(r, 100));

    // 第一帧正常(证明连接是通的、模型本来是被授权的)
    await send(ws, "s-1");
    const forwardedBefore = forwardedInbound(rig.containerSeen).length;
    assert.equal(forwardedBefore, 1);

    // admin 撤权 → 0144 的 trigger bump epoch(catalog 快照随之前进)
    rig.revoke(11n);

    const frames = await send(ws, "s-2");
    assert.deepEqual(
      errorCodes(frames),
      ["UNAUTHORIZED_MODEL"],
      "撤权后必须在**同一个连接**上立刻拒帧(不等 30s 周期刷新)",
    );
    assert.equal(ws.readyState, WebSocket.OPEN, "turn 级撤权拒绝不能关闭整条用户 WS");
    assert.equal(
      forwardedInbound(rig.containerSeen).length,
      forwardedBefore,
      "被拒的帧绝不能到达容器(到了就是撤权后仍能签票执行)",
    );
    assert.ok(rig.loads() >= 2, "epoch 漂移必须触发一次同步重载");
    ws.close();
  });

  test("重载失败:epoch 漂移 + grants DB 抖动 → MODEL_AUTHORITY_UNAVAILABLE 拒帧(**禁止 keep-LKG 放行**)", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const ws = await connect(rig);
    await new Promise((r) => setTimeout(r, 100));

    await send(ws, "s-1");
    const forwardedBefore = forwardedInbound(rig.containerSeen).length;

    // epoch 变了(可能就是撤权),但 grants 读不出来 → 不知道自己还有没有授权 → 只能拒
    rig.bumpOnly(12n);
    rig.breakLoader();

    const frames = await send(ws, "s-2");
    assert.deepEqual(
      errorCodes(frames),
      ["MODEL_AUTHORITY_UNAVAILABLE"],
      "重载失败必须 fail-closed(旧实现是 keep-LKG 放行)",
    );
    assert.equal(
      forwardedInbound(rig.containerSeen).length,
      forwardedBefore,
      "重载失败时绝不放行",
    );
    ws.close();
  });

  test("放宽:epoch 漂移但授权仍在 → 重载成功 → 帧照常转发", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const ws = await connect(rig);
    await new Promise((r) => setTimeout(r, 100));

    await send(ws, "s-1");
    const forwardedBefore = forwardedInbound(rig.containerSeen).length;

    rig.bumpOnly(13n); // 别的模型改了价 → epoch 前进,本用户授权没动
    const frames = await send(ws, "s-2");

    assert.deepEqual(errorCodes(frames), [], "授权仍在 → 不该拒帧");
    assert.equal(
      forwardedInbound(rig.containerSeen).length,
      forwardedBefore + 1,
      "重载后应正常转发",
    );
    assert.ok(rig.loads() >= 2, "epoch 漂移应触发重载");
    ws.close();
  });
});
