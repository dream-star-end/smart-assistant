/**
 * bridgeSeedAuthority.test.ts —— bridge 生命周期重排:seed 权威按**容器实际 bundle rev** 推导
 * (docs/V5_MODEL_AUTHORITY_PLAN.md §5 阶段 B;设计审 R2-B3 / R1-B3)。
 *
 * 跑法:npx tsx --test src/__tests__/bridgeSeedAuthority.test.ts
 *
 * 被守护的不变量(**这就是这批改动的全部意义**):
 *   `loadAgentModelResolver` 必须在 `resolveContainerEndpoint`(= ensureRunning)**之后**调用,
 *   并接收容器 label 上的 `bundleRev`。反过来(旧顺序)master 只能用自己的 current 常量/声明
 *   给一个**可能还在跑旧 seed 的容器**计费 —— 滚动窗口(新 bundle 已发、老容器未回收)里
 *   master 按新模型计费、容器按旧模型执行,就是「计费分叉」本身。
 *
 * 覆盖:
 *   ① flag 未开 → 旧行为(不要求 bundleRev,seed = master 常量,零变化);
 *   ② flag 开 + 容器带 rev → seed 三元组来自**该 rev 的声明**(而非 master 常量);
 *   ③ flag 开 + label 缺失 → fail-closed 拒连接(close 1011,不放行、不回落常量);
 *   ④ flag 开 + bundle 被篡改(digest 不符)→ 同样 fail-closed;
 *   ⑤ 生命周期顺序:resolver load 严格晚于 endpoint 解析;
 *   ⑥ 周期/补触发 refresh 复用**同一** rev(容器在连接存续期内不换 rev)。
 *
 * 观测口径:注入 `loadAllowedModelChecker` 记录 bridge 实际判定的 `effectiveModel` ——
 * 帧带 `agentId:'main'` 且无 `model` 时,bridge 走 agentAuthority 分支(见 userChatBridge
 * 的选用顺序),故 checker 看到的 modelId **就是** seed 权威推导出来的模型。断言的是
 * 「bridge 真的按声明计费」,不是「loader 返回了什么」。
 *
 * resolver 实现用**生产组合**(seedAgentModels + buildAgentModelSnapshot,与
 * loadAgentModelResolverForUser 同构,只去掉 DB 那两次 marketplace 查询),因此 bundle 完整性
 * 校验(resolvePlatformBundleMount)是真跑的 —— 篡改用例不是 mock 出来的。
 *
 * bundle 夹具复用 seedDeclarationLoader.test.ts 的合规树写法;assertBaselineLeaf 要求 uid=0,
 * 故用到真 bundle 的两个用例在非 root 下 skip。
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import { signAccess } from "../auth/jwt.js";
import { bootHashOf, manifestDigestOf, type ManifestFileEntry } from "../agent-sandbox/platformBundle.js";
import { PLATFORM_DEFAULT_MODEL } from "../platformDefaults.js";
import {
  SEED_AUTHORITY_BY_REV_ENV,
  buildAgentModelSnapshot,
  seedAuthorityByRevEnabled,
} from "../ws/agentModelAuthority.js";
import {
  __resetSeedDeclarationCacheForTests,
  seedAgentModels,
} from "../ws/seedDeclarationLoader.js";
import {
  BRIDGE_WS_PATH,
  CLOSE_BRIDGE,
  createUserChatBridge,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";

const JWT_SECRET = "s".repeat(32);
const UID = 4242;
const CONTAINER_ID = 11;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** 声明里的 main 模型**故意不等于** master 常量 —— 相等就证明不了"权威来自声明"。 */
const DECLARED_MAIN_MODEL = "glm-5.1";

// ─────────────────────────────────────────────────────────────────────────────
// bundle 夹具(合规树 + 自洽 MANIFEST;目录名 = 内容 digest)
// ─────────────────────────────────────────────────────────────────────────────

const SEED_YAML_V2 = [
  "schemaVersion: 2",
  "agents:",
  "  - id: main",
  `    model: ${DECLARED_MAIN_MODEL}`,
  "    provider: ark",
  "  - id: codex",
  "    model: gpt-5.6-sol",
  "    provider: codex-native",
  "    runnerKind: app-server",
  "",
].join("\n");

function bundleContents(seedYaml: string): Record<string, string> {
  return {
    "bin/oc-web-context": "#!/bin/sh\nexec echo web-context\n",
    "entrypoint/entrypoint.ts": "export const boot = 1;\n",
    "entrypoint/platformBundle.ts": "export const bundle = 1;\n",
    "seed/platform-seed.yaml": seedYaml,
    "prompts/platform-capabilities.md": "# Platform capabilities\n",
    "prompts/memory-instructions.md": "# Memory\n",
    "prompts/codex-preamble.md": "# preamble\n",
    "etc-codex/managed_config.toml": "check_for_update_on_startup = false\n",
  };
}

interface BuiltBundle {
  platformRoot: string;
  bundleDir: string;
  rev: string;
}

function buildBundle(seedYaml: string): BuiltBundle {
  const root = mkdtempSync(join(tmpdir(), "oc-bridgeseed-"));
  chmodSync(root, 0o755);
  const bundlesDir = join(root, "bundles");
  mkdirSync(bundlesDir, { recursive: true });
  chmodSync(bundlesDir, 0o755);
  const staging = join(bundlesDir, ".staging");
  rmSync(staging, { recursive: true, force: true });
  for (const d of ["bin", "entrypoint", "seed", "prompts", "etc-codex"]) {
    mkdirSync(join(staging, d), { recursive: true });
    chmodSync(join(staging, d), 0o755);
  }
  const contents = bundleContents(seedYaml);
  for (const [rel, body] of Object.entries(contents)) {
    const abs = join(staging, rel);
    writeFileSync(abs, body);
    chmodSync(abs, rel.startsWith("bin/") ? 0o755 : 0o644);
  }
  const files: ManifestFileEntry[] = Object.keys(contents)
    .sort()
    .map((rel) => {
      const abs = join(staging, rel);
      const st = statSync(abs);
      return {
        path: rel,
        sha256: createHash("sha256").update(Buffer.from(contents[rel]!)).digest("hex"),
        size: st.size,
        mode: (st.mode & 0o777).toString(8),
      };
    });
  const digest = manifestDigestOf(files);
  const bundleDir = join(bundlesDir, digest);
  rmSync(bundleDir, { recursive: true, force: true });
  renameSync(staging, bundleDir);
  const manifest = {
    schemaVersion: 1,
    digest,
    bootHash: bootHashOf(files),
    sourceCommit: "deadbeefcafe",
    files,
  };
  const manifestPath = join(bundleDir, "MANIFEST.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  chmodSync(manifestPath, 0o644);
  return { platformRoot: root, bundleDir, rev: digest };
}

// ─────────────────────────────────────────────────────────────────────────────
// rig
// ─────────────────────────────────────────────────────────────────────────────

interface Rig {
  gateway: http.Server;
  bridge: UserChatBridgeHandler;
  port: number;
  containerWss: WebSocketServer;
  /** 生命周期事件流(顺序断言的唯一依据)。 */
  order: string[];
  /** 每次 loadAgentModelResolver 收到的 opts(refresh 复用同一 rev 的依据)。 */
  resolverOpts: Array<{ bundleRev?: string }>;
  /** bridge 实际拿去判定/计费的 effectiveModel(经 loadAllowedModelChecker 观测)。 */
  checkedModels: string[];
  /** 容器收到的帧(未 forward = 拒帧生效)。 */
  containerSeen: string[];
}

/**
 * 生产 resolver 的组合等价物:seed 层按 flag 走「声明」或「master 常量」,
 * marketplace 两层留空(DB 不进单测;那两层与本批次无关)。
 * 与 loadAgentModelResolverForUser 同构 —— seed 加载**先于** DB,失败即抛。
 */
function makeResolverLoader(
  env: NodeJS.ProcessEnv,
  platformRoot: string | undefined,
  rig: { order: string[]; resolverOpts: Array<{ bundleRev?: string }> },
) {
  return async (_uid: bigint, opts: { bundleRev?: string }) => {
    rig.order.push("resolver");
    rig.resolverOpts.push(opts);
    const seedExecutions = seedAuthorityByRevEnabled(env)
      ? await seedAgentModels(opts.bundleRev, platformRoot)
      : undefined;
    const snapshot = buildAgentModelSnapshot([], [], seedExecutions);
    return (agentId: string) => snapshot.get(agentId) ?? null;
  };
}

async function startRig(opts: {
  /** 容器 label 上的 bundle rev(undefined = label 缺失 / bundle 轴未启用)。 */
  bundleRev?: string;
  platformRoot?: string;
  /** OC_SEED_AUTHORITY_BY_REV 的值(不传 = 未设 = 旧路径)。 */
  flag?: string;
}): Promise<Rig> {
  const order: string[] = [];
  const resolverOpts: Array<{ bundleRev?: string }> = [];
  const checkedModels: string[] = [];
  const containerSeen: string[] = [];

  const containerWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => containerWss.once("listening", () => r()));
  const containerPort = (containerWss.address() as { port: number }).port;
  containerWss.on("connection", (ws) => {
    ws.on("message", (data) => {
      containerSeen.push(typeof data === "string" ? data : (data as Buffer).toString("utf8"));
    });
  });

  const env: NodeJS.ProcessEnv = opts.flag !== undefined ? { [SEED_AUTHORITY_BY_REV_ENV]: opts.flag } : {};

  const bridge = createUserChatBridge({
    jwtSecret: JWT_SECRET,
    resolveContainerEndpoint: async () => {
      order.push("endpoint");
      return {
        host: "127.0.0.1",
        port: containerPort,
        containerId: CONTAINER_ID,
        ...(opts.bundleRev !== undefined ? { bundleRev: opts.bundleRev } : {}),
      };
    },
    // 观测口径:bridge 判定的 effectiveModel 会流经这里(全部放行,只记录)。
    loadAllowedModelChecker: async () => {
      order.push("checker");
      return (modelId: string) => {
        checkedModels.push(modelId);
        return true;
      };
    },
    loadAgentModelResolver: makeResolverLoader(env, opts.platformRoot, { order, resolverOpts }),
    containerConnectTimeoutMs: 1500,
    heartbeatIntervalMs: 0,
  });

  const gateway = http.createServer((_, res) => res.end());
  gateway.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  const port = (gateway.address() as { port: number }).port;

  return { gateway, bridge, port, containerWss, order, resolverOpts, checkedModels, containerSeen };
}

async function stopRig(rig: Rig): Promise<void> {
  await rig.bridge.shutdown();
  await new Promise<void>((r) => rig.containerWss.close(() => r()));
  await new Promise<void>((r) => rig.gateway.close(() => r()));
}

interface Client {
  ws: WebSocket;
  /** close code —— 监听器在 open 时就挂上,避免"close 早于 await"的丢事件竞态。 */
  closed: Promise<number>;
}

async function openClient(port: number): Promise<Client> {
  const { token } = await signAccess({ sub: String(UID), role: "user" }, JWT_SECRET);
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_WS_PATH}`, ["bearer", token]);
  await new Promise<void>((r, j) => {
    ws.once("open", () => r());
    ws.once("error", j);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return { ws, closed };
}

/** agentId 帧(**不带 model** → bridge 必须走 agent 权威推导)。 */
function agentFrame(agentId: string): string {
  return JSON.stringify({
    type: "inbound.message",
    channel: "webchat",
    peer: { id: "p1", kind: "dm" },
    content: { text: "hi" },
    ts: Date.now(),
    agentId,
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

// ─────────────────────────────────────────────────────────────────────────────

describe("bridge seed 权威 — 生命周期顺序(resolver 必须晚于 ensureRunning)", () => {
  test("⑤ loadAgentModelResolver 在 resolveContainerEndpoint 之后,且收到容器 label 的 bundleRev", async () => {
    const rig = await startRig({ bundleRev: "abc123456def" });
    try {
      const { ws } = await openClient(rig.port);
      await waitFor(() => rig.resolverOpts.length > 0);

      const endpointAt = rig.order.indexOf("endpoint");
      const resolverAt = rig.order.indexOf("resolver");
      assert.ok(endpointAt >= 0 && resolverAt >= 0, `order=${JSON.stringify(rig.order)}`);
      assert.ok(
        endpointAt < resolverAt,
        "resolver 必须在 endpoint 解析(ensureRunning)之后 —— 否则拿不到容器实际 rev," +
          `master 会用 current 声明给旧容器计费(滚动窗口分叉)。order=${JSON.stringify(rig.order)}`,
      );
      assert.equal(rig.resolverOpts[0]?.bundleRev, "abc123456def", "rev 必须原样透传给 resolver");
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

describe("bridge seed 权威 — ① flag 未开 = 旧路径零变化", () => {
  test("不要求 bundleRev:endpoint 无 rev 也能建连,seed = master 常量", async () => {
    const rig = await startRig({}); // flag 未设 + endpoint 不带 rev
    try {
      const { ws } = await openClient(rig.port);
      await waitFor(() => rig.resolverOpts.length > 0);
      assert.equal(rig.resolverOpts[0]?.bundleRev, undefined, "旧路径 opts 里没有 rev(也不需要)");

      // 帧带 agentId:'main' 无 model → bridge 走 agentAuthority 推导 → 常量 PLATFORM_DEFAULT_MODEL。
      ws.send(agentFrame("main"));
      await waitFor(() => rig.checkedModels.length > 0);
      assert.equal(rig.checkedModels[0], PLATFORM_DEFAULT_MODEL, "flag 未开 → seed 仍是 master 常量");
      await waitFor(() => rig.containerSeen.some((s) => s.includes("inbound.message")));
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("flag 未开时即使 endpoint 带 rev 也不去读 bundle(不存在的 root 也不炸)", async () => {
    const rig = await startRig({ bundleRev: "0123456789ab", platformRoot: "/nonexistent-root" });
    try {
      const { ws } = await openClient(rig.port);
      ws.send(agentFrame("main"));
      await waitFor(() => rig.checkedModels.length > 0);
      assert.equal(rig.checkedModels[0], PLATFORM_DEFAULT_MODEL);
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

describe("bridge seed 权威 — ③④ flag 开 + rev 不可用 = fail-closed", () => {
  test("③ label 缺失 → close(1011),帧绝不进容器(不回落 master 常量)", async () => {
    const rig = await startRig({ flag: "1" }); // 容器无 bundle_rev label
    try {
      const { closed } = await openClient(rig.port);
      assert.equal(await closed, CLOSE_BRIDGE.INTERNAL, "rev 缺失必须 close 1011,不得放行");
      assert.equal(rig.containerSeen.length, 0, "拒连接 → 一个字节都不该到容器");
      assert.equal(rig.checkedModels.length, 0, "没有任何模型被判定 → 不可能按常量计费");
    } finally {
      await stopRig(rig);
    }
  });

  test("④ rev 合法但 bundle 不存在 → close(1011)", async () => {
    __resetSeedDeclarationCacheForTests();
    const rig = await startRig({
      flag: "1",
      bundleRev: "0123456789ab",
      platformRoot: "/nonexistent-platform-root",
    });
    try {
      const { closed } = await openClient(rig.port);
      assert.equal(await closed, CLOSE_BRIDGE.INTERNAL);
      assert.equal(rig.containerSeen.length, 0);
    } finally {
      await stopRig(rig);
    }
  });
});

describe(
  "bridge seed 权威 — ②⑥ flag 开 + 真 bundle(按 rev 的声明计费)",
  { skip: !IS_ROOT ? "requires root (uid=0;bundle 校验器断言 root-owned)" : false },
  () => {
    let bundle: BuiltBundle;

    before(() => {
      __resetSeedDeclarationCacheForTests();
      bundle = buildBundle(SEED_YAML_V2);
    });
    after(() => {
      rmSync(bundle.platformRoot, { recursive: true, force: true });
      __resetSeedDeclarationCacheForTests();
    });

    test("② seed 三元组来自**该 rev 的声明**,而非 master 常量", async () => {
      const rig = await startRig({ flag: "1", bundleRev: bundle.rev, platformRoot: bundle.platformRoot });
      try {
        const { ws } = await openClient(rig.port);
        ws.send(agentFrame("main"));
        await waitFor(() => rig.checkedModels.length > 0);
        assert.equal(
          rig.checkedModels[0],
          DECLARED_MAIN_MODEL,
          "bridge 必须按容器那个 rev 的声明计费(声明 glm-5.1),而不是 master 常量 " +
            PLATFORM_DEFAULT_MODEL,
        );
        assert.notEqual(DECLARED_MAIN_MODEL, PLATFORM_DEFAULT_MODEL, "夹具前提:声明值必须≠常量");
        await waitFor(() => rig.containerSeen.some((s) => s.includes("inbound.message")));
        ws.close();
      } finally {
        await stopRig(rig);
      }
    });

    test("⑥ refresh 复用同一 rev(容器在连接存续期内不换 rev)", async () => {
      const rig = await startRig({ flag: "1", bundleRev: bundle.rev, platformRoot: bundle.platformRoot });
      try {
        const { ws, closed } = await openClient(rig.port);
        await waitFor(() => rig.resolverOpts.length === 1);
        // 未知 agentId + 无 model → resolve miss → bridge 补触发一次 refresh,再拒帧。
        ws.send(agentFrame("ghost-agent"));
        await waitFor(() => rig.resolverOpts.length >= 2);
        assert.equal(rig.resolverOpts[1]?.bundleRev, bundle.rev, "refresh 必须用同一 rev");
        assert.equal(
          rig.resolverOpts[0],
          rig.resolverOpts[1],
          "refresh 复用初次 load 的同一 opts 闭包(不重新取 label / 不换 rev)",
        );
        // 推导不出 → fail-closed 拒帧(既有语义,顺带守住)。
        assert.equal(await closed, CLOSE_BRIDGE.PRODUCT_POLICY);
      } finally {
        await stopRig(rig);
      }
    });

    test("④' bundle 内容被篡改(digest 不再等于目录名)→ close(1011),不按被改过的声明计费", async () => {
      __resetSeedDeclarationCacheForTests();
      const tampered = buildBundle(SEED_YAML_V2);
      try {
        // 攻击面:改 seed 里的 model = 改计费。目录名(digest)不变 → 全量校验器必须拒。
        writeFileSync(
          join(tampered.bundleDir, "seed", "platform-seed.yaml"),
          SEED_YAML_V2.replace(DECLARED_MAIN_MODEL, "gpt-5.6-sol"),
        );
        const rig = await startRig({
          flag: "1",
          bundleRev: tampered.rev,
          platformRoot: tampered.platformRoot,
        });
        try {
          const { closed } = await openClient(rig.port);
          assert.equal(await closed, CLOSE_BRIDGE.INTERNAL);
          assert.equal(rig.containerSeen.length, 0, "篡改的 bundle 一个帧都不许放行");
          assert.equal(rig.checkedModels.length, 0);
        } finally {
          await stopRig(rig);
        }
      } finally {
        rmSync(tampered.platformRoot, { recursive: true, force: true });
        __resetSeedDeclarationCacheForTests();
      }
    });
  },
);
