/**
 * OCV5-482: a completed turn whose answer glues the ```ui prediction fence to the answer line is
 * stored (lossless tape to master, currentAssistantBuf) with the fence on its own line.
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerUiFenceNormalize.test.ts
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { SessionManager, type AgentSession } from "../sessionManager.js";
import type { EngineCapabilities, EngineTurnRun, TurnParams } from "../engine/engineAdapter.js";
import type { TurnSummary } from "../engine/engineEvents.js";
import type { OpenClaudeConfig } from "@openclaude/storage";
import { setV3MasterSinkSingleton, type V3MasterSink } from "../v3MasterSink.js";

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
    defaults: { model: "deepseek-v4-flash" },
  } as unknown as OpenClaudeConfig;
}

/** 最小 EngineAdapter fake:capabilities 可配,submitTurn 记录调用并立即正常终态。 */
class FakeEngineAdapter extends EventEmitter {
  answer = "";
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
      usage: {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
      },
      assistantText: this.answer,
      thinkingText: "",
      assistantSegments: this.answer ? [{ index: 0, text: this.answer, ts: Date.now() }] : [],
      thinkingSegments: [],
      tools: [],
      runtimeEvents: [],
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
        runtimeEvents: [],
      }),
      getPhantomSignals: () => ({ apiState: "skipped" as const, skipReason: "unit-test" }),
      finalized: true,
      pendingToolCalls: 0,
    };
  }
}

const CCB_CAPS: EngineCapabilities = {
  billingMode: "proxy",
  supportsEffort: true,
  resumeKind: "ccb-session",
  needsServerRequestId: false,
  historyMode: "native-resume",
  permissionModel: "native",
  emitsCallUsage: true,
  emitsToolInputDeltas: true,
  supportsNativeCompact: true,
  multimodalInput: "native",
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

const savedChannel = process.env.OC_RUNTIME_CHANNEL;
afterEach(() => {
  setV3MasterSinkSingleton(null);
  if (savedChannel === undefined) delete process.env.OC_RUNTIME_CHANNEL;
  else process.env.OC_RUNTIME_CHANNEL = savedChannel;
});

async function runTurn(answer: string): Promise<{ session: AgentSession; persisted: string[] }> {
  process.env.OC_RUNTIME_CHANNEL = "v5";
  const persisted: string[] = [];
  setV3MasterSinkSingleton({
    persistOrQueue: async (payload: unknown) => { persisted.push(JSON.stringify(payload)); return { ok: true }; },
    attemptOnce: async () => {},
  } as unknown as V3MasterSink);
  const runner = new FakeEngineAdapter("ccb", CCB_CAPS, "deepseek-v4-flash");
  runner.answer = answer;
  const session = makeSession(runner);
  (session as unknown as { channel: string }).channel = "webchat";
  await makeSm().submit(session, "请回答:1+1等于几?只回答数字。", () => {});
  await session.lock;
  assert.equal(runner.submitTurnCalls.length, 1);
  return { session, persisted };
}

describe("completed turn stores a glued ui fence on its own line", () => {
  test("the tape sent to master and currentAssistantBuf carry the normalized answer", async () => {
    const glued = '2```ui{"type":"next","text":"那2+2呢?"}\n```';
    const fixed = '2\n```ui\n{"type":"next","text":"那2+2呢?"}\n```';
    const { session, persisted } = await runTurn(glued);
    assert.equal((session as unknown as { currentAssistantBuf?: string }).currentAssistantBuf, fixed);
    const all = persisted.join("\n");
    assert.ok(all.includes(JSON.stringify(fixed).slice(1, -1)), "tape must carry the normalized text");
    assert.ok(!all.includes(JSON.stringify(glued).slice(1, -1)), "tape must not carry the glued text");
  });

  test("a plain answer is stored unchanged", async () => {
    const { session } = await runTurn("2");
    assert.equal((session as unknown as { currentAssistantBuf?: string }).currentAssistantBuf, "2");
  });
});
