/**
 * P0 计费旁路封堵 — gateway seam fail-closed guard 回归测试。
 *
 * 威胁模型:M1a 后任意 agent 的 agent.model='gpt-5.5' 都会落 codex 底座
 * (resolveEngine 按 model 判定),而 bridge 只对它分类出的 codex turn 注
 * server-owned requestId。绕过 bridge 分类的 codex turn(帧无 model + agent.model
 * 回落、cron、手改 agents.yaml 等)不带 requestId → CodexAdapter 不 emit billing
 * → 免费 codex。submit() 按 capabilities.needsServerRequestId 在 commercial
 * 运行时 fail-closed 拒绝该类 turn(明确 error 事件,不静默落 CCB / 不白跑)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerCodexBillingGuard.test.ts
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  SessionManager,
  isCommercialManagedRuntime,
  type AgentSession,
} from "../sessionManager.js";
import type { EngineCapabilities, EngineTurnRun, TurnParams } from "../engine/engineAdapter.js";
import type { SessionStreamEvent, TurnSummary } from "../engine/engineEvents.js";
import type { OpenClaudeConfig } from "@openclaude/storage";

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
    defaults: { model: "glm-5.2" },
  } as unknown as OpenClaudeConfig;
}

/** 最小 EngineAdapter fake:capabilities 可配,submitTurn 记录调用并立即正常终态。 */
class FakeEngineAdapter extends EventEmitter {
  readonly engineId: string;
  readonly capabilities: EngineCapabilities;
  submitTurnCalls: TurnParams[] = [];
  lastActivityAt = Date.now();
  effortLevel: string | undefined = undefined;
  model: string;

  constructor(engineId: string, capabilities: EngineCapabilities, model: string) {
    super();
    this.engineId = engineId;
    this.capabilities = capabilities;
    this.model = model;
  }

  setTraceId(): void {}
  setEffortLevel(): void {}
  setModel(): void {}
  interrupt(): boolean {
    return false;
  }
  async shutdown(): Promise<void> {}
  async start(): Promise<void> {}

  submitTurn(params: TurnParams): EngineTurnRun {
    this.submitTurnCalls.push(params);
    const summary: TurnSummary = {
      usage: { cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      assistantText: "",
      thinkingText: "",
      assistantSegments: [],
      thinkingSegments: [],
      tools: [],
      stopReason: "end_turn",
      numTurns: 1,
      isError: false,
      staleResumeId: false,
      // 'skipped' → phantom 判定明确非 phantom,turn 正常完成(测试只关心 guard
      // 是否放行到 submitTurn,turn 内容语义不在本测试范围)。
      phantomSignals: { apiState: "skipped", skipReason: "unit-test" },
    };
    return {
      submitted: Promise.resolve(),
      summary: Promise.resolve(summary),
      end: () => {},
      getPartialSnapshot: () => ({
        assistantText: "",
        thinkingText: "",
        completedTools: [],
        assistantSegments: [],
        thinkingSegments: [],
      }),
      getPhantomSignals: () => ({ apiState: "skipped" as const, skipReason: "unit-test" }),
      finalized: true,
      pendingToolCalls: 0,
    };
  }
}

const CODEX_CAPS: EngineCapabilities = {
  billingMode: "engine-reported",
  supportsEffort: true,
  resumeKind: "codex-thread",
  needsServerRequestId: true,
};

const CCB_CAPS: EngineCapabilities = {
  billingMode: "proxy",
  supportsEffort: true,
  resumeKind: "ccb-session",
  needsServerRequestId: false,
};

function makeSession(runner: FakeEngineAdapter): AgentSession {
  return {
    sessionKey: `agent:main:webchat:dm:guard-peer-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "main",
    channel: "unit",
    peerId: "guard-peer",
    title: "Guard Unit",
    startedAt: Date.now(),
    runner,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    // 非 0 → submit() 跳过 getMaxTurnIdx 的 FTS 查询(单测不依赖 storage)。
    turns: 3,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: "local" },
    providerTag: runner.engineId,
    agentProvider: undefined,
  } as unknown as AgentSession;
}

function makeSm(): SessionManager {
  const sm = new SessionManager(makeConfigStub());
  const ins = sm as unknown as { _saveResumeMap: () => void };
  ins._saveResumeMap = () => {};
  return sm;
}

const ENV_KEYS = [
  "OC_RUNTIME_CHANNEL",
  "OPENCLAUDE_V3_MASTER_BASE_URL",
  "OPENCLAUDE_V3_CONTAINER_TOKEN",
] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("isCommercialManagedRuntime(commercial 判定惯例)", () => {
  test("个人版 / 测试环境(两组信号全缺)→ false", () => {
    assert.equal(isCommercialManagedRuntime({}), false);
  });

  test("OC_RUNTIME_CHANNEL 存在(v3/v5 实例)→ true;纯空白 → false", () => {
    assert.equal(isCommercialManagedRuntime({ OC_RUNTIME_CHANNEL: "v5" }), true);
    assert.equal(isCommercialManagedRuntime({ OC_RUNTIME_CHANNEL: "v3" }), true);
    assert.equal(isCommercialManagedRuntime({ OC_RUNTIME_CHANNEL: "  " }), false);
  });

  test("v3supervisor 容器双 env 成对 → true;缺一 → false", () => {
    assert.equal(
      isCommercialManagedRuntime({
        OPENCLAUDE_V3_MASTER_BASE_URL: "http://172.30.0.1:18791",
        OPENCLAUDE_V3_CONTAINER_TOKEN: "oc-v3.1.secret",
      }),
      true,
    );
    assert.equal(
      isCommercialManagedRuntime({ OPENCLAUDE_V3_MASTER_BASE_URL: "http://172.30.0.1:18791" }),
      false,
    );
    assert.equal(
      isCommercialManagedRuntime({ OPENCLAUDE_V3_CONTAINER_TOKEN: "oc-v3.1.secret" }),
      false,
    );
  });
});

describe("submit() codex 计费 guard(fail-closed)", () => {
  test("commercial + needsServerRequestId + 无 requestId → 拒 turn(error 事件),不触 submitTurn", async () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    const runner = new FakeEngineAdapter("codex", CODEX_CAPS, "gpt-5.5");
    const session = makeSession(runner);
    const sm = makeSm();
    const events: SessionStreamEvent[] = [];

    await sm.submit(session, "hello", (e) => events.push(e));

    assert.equal(runner.submitTurnCalls.length, 0, "guard 必须在 submitTurn 之前拦截");
    const err = events.find((e) => e.kind === "error");
    assert.ok(err, "必须发出明确 error 事件(不静默吞 turn)");
    assert.match(
      (err as { error: string }).error,
      /CODEX_BILLING_GUARD/,
      "错误信息应可辨识为计费 guard 拒绝",
    );
    assert.equal(
      events.some((e) => e.kind === "final"),
      false,
      "拒绝的 turn 不应有 final(不白跑、不静默落 CCB)",
    );
  });

  test("commercial + needsServerRequestId + 畸形 requestId(空串/非 32hex)→ 同样拒 turn", async () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    const sm = makeSm();
    // seam 合同校验形状:bridge 生成的 server-owned requestId 恒为 32 hex;
    // 空串/短串/大写/非 hex 都意味着没走 bridge preCheck/journal → fail-closed。
    for (const bad of ["", "abc", "A".repeat(32), "g".repeat(32), "a".repeat(31), "a".repeat(33)]) {
      const runner = new FakeEngineAdapter("codex", CODEX_CAPS, "gpt-5.5");
      const session = makeSession(runner);
      const events: SessionStreamEvent[] = [];
      await sm.submit(session, "hello", (e) => events.push(e), undefined, undefined, bad);
      assert.equal(runner.submitTurnCalls.length, 0, `畸形 requestId '${bad.slice(0, 8)}…(len=${bad.length})' 应被拦截`);
      assert.ok(
        events.some((e) => e.kind === "error" && /CODEX_BILLING_GUARD/.test((e as { error: string }).error)),
        "畸形 requestId 应发 guard error 事件",
      );
    }
  });

  test("commercial + needsServerRequestId + 带 requestId → 放行,requestId 透传 submitTurn", async () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    const runner = new FakeEngineAdapter("codex", CODEX_CAPS, "gpt-5.5");
    const session = makeSession(runner);
    const sm = makeSm();
    const events: SessionStreamEvent[] = [];

    await sm.submit(
      session,
      "hello",
      (e) => events.push(e),
      undefined,
      undefined,
      "a".repeat(32),
    );

    assert.equal(runner.submitTurnCalls.length, 1, "带 requestId 的 codex turn 应正常提交");
    assert.equal(runner.submitTurnCalls[0]!.requestId, "a".repeat(32));
    assert.equal(
      events.some((e) => e.kind === "error" && /CODEX_BILLING_GUARD/.test((e as { error: string }).error)),
      false,
    );
  });

  test("commercial + CCB(needsServerRequestId=false)+ 无 requestId → 不受影响(CCB 路径零回归)", async () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    const runner = new FakeEngineAdapter("ccb", CCB_CAPS, "glm-5.2");
    const session = makeSession(runner);
    const sm = makeSm();
    const events: SessionStreamEvent[] = [];

    await sm.submit(session, "hello", (e) => events.push(e));

    assert.equal(runner.submitTurnCalls.length, 1, "CCB turn 不需要 requestId");
    assert.equal(
      events.some((e) => e.kind === "error" && /CODEX_BILLING_GUARD/.test((e as { error: string }).error)),
      false,
    );
  });

  test("非 commercial(个人版 env)+ codex + 无 requestId → 放行(无 bridge 场景保留)", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const runner = new FakeEngineAdapter("codex", CODEX_CAPS, "gpt-5.5");
    const session = makeSession(runner);
    const sm = makeSm();
    const events: SessionStreamEvent[] = [];

    await sm.submit(session, "hello", (e) => events.push(e));

    assert.equal(runner.submitTurnCalls.length, 1, "个人版 codex 无 requestId 照跑");
    assert.equal(
      events.some((e) => e.kind === "error" && /CODEX_BILLING_GUARD/.test((e as { error: string }).error)),
      false,
    );
  });
});
