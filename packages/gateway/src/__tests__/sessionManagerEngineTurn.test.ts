/**
 * SessionManager × EngineAdapter turn 编排回归测试(M0)。
 *
 * 覆盖 spec M0 验收的两块主风险面:
 *   1. phantom 三态判定(skipped / called / unknown→legacy 9-AND)在 TurnSummary/
 *      PhantomSignals 消费改造后语义不变,含 totals 回滚;auth / stale-resume
 *      回滚 + reject 分类同样锁死。
 *   2. crash/interrupt partial persistence:子进程崩溃/被信号终止时,经
 *      turn.getPartialSnapshot() 把部分 assistant/thinking/tools/segments 落
 *      v3 sink(150ms drain 语义、status 'crashed'/'interrupted' 区分)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerEngineTurn.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { SessionManager, type AgentSession } from "../sessionManager.js";
import { CcbAdapter } from "../engine/ccbAdapter.js";
import type { SessionStreamEvent, DurableRuntimeEvent } from "../engine/engineEvents.js";
import type { EngineCreateOpts } from "../engine/registry.js";
import type { SubprocessRunner } from "../subprocessRunner.js";
import {
  setV3MasterSinkSingleton,
  type V3MasterSink,
  type V3MasterSinkPayload,
} from "../v3MasterSink.js";
import type { OpenClaudeConfig } from "@openclaude/storage";
import type { ToolCalledEvent } from "@openclaude/protocol";
import { eventBus } from "../eventBus.js";

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
  } as unknown as OpenClaudeConfig;
}

type FakeExitInfo = { code: number | null; signal: string | null; crashed: boolean };

class FakeCcbRunner extends EventEmitter {
  lastActivityAt = Date.now();

  constructor(private readonly onSubmit: (runner: FakeCcbRunner) => void) {
    super();
  }

  interrupt(): boolean {
    return false;
  }

  async shutdown(): Promise<void> {}

  async waitForOutputDrain(): Promise<void> {}

  async submit(): Promise<void> {
    this.onSubmit(this);
  }

  msg(m: Record<string, unknown>): void {
    this.emit("message", m);
  }

  telemetry(event: string, data: Record<string, unknown> = {}): void {
    this.emit("telemetry", {
      type: "_oc_telemetry",
      schemaVersion: 1,
      event,
      session_id: "sess-1",
      data,
      ts: Date.now(),
    });
  }

  emitExit(info: FakeExitInfo): void {
    this.emit("exit", info);
  }

  text(text: string): void {
    this.msg({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
  }

  thinking(thinking: string): void {
    this.msg({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
    });
  }

  plan(plan: Record<string, unknown>): void {
    this.msg({ type: "openclaude_plan", plan });
  }

  goal(goal: Record<string, unknown>): void {
    this.msg({ type: "openclaude_goal", goal });
  }

  toolPair(id: string, name: string, output: string): void {
    this.msg({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { k: 1 } }] } });
    this.msg({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: false }] },
    });
  }

  result(over: Record<string, unknown> = {}): void {
    this.msg({
      type: "result",
      total_cost_usd: 0,
      usage: {},
      is_error: false,
      ...over,
    });
  }
}

function makeSession(
  runner: FakeCcbRunner,
  over: Partial<AgentSession> = {},
): AgentSession {
  const adapter = new CcbAdapter({} as EngineCreateOpts, runner as unknown as SubprocessRunner);
  return {
    sessionKey: "agent:main:webchat:dm:engine-peer",
    agentId: "main",
    channel: "unit",
    peerId: "engine-peer",
    title: "Engine Unit",
    startedAt: Date.now(),
    runner: adapter,
    ccbSessionId: "ccb-sess-1",
    lock: Promise.resolve(),
    lastUsedAt: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    _lastCcbCumulativeCost: 0,
    toolUseIdToName: new Map(),
    executionTarget: { kind: "local" },
    providerTag: "ccb",
    agentProvider: undefined,
    ...over,
  } as unknown as AgentSession;
}

async function runOneTurn(
  sm: SessionManager,
  session: AgentSession,
  events: SessionStreamEvent[],
  input = "hello",
): Promise<void> {
  await (sm as unknown as {
    _runOneTurn: (
      session: AgentSession,
      input: string,
      onEvent: (e: SessionStreamEvent) => void,
      requestId?: string,
    ) => Promise<void>;
  })._runOneTurn(session, input, (e) => events.push(e), "req-unit");
}

function submitWithReplayLifecycle(
  sm: SessionManager,
  session: AgentSession,
  input: string,
  clientMessageId: string,
  hooks: {
    onStart: () => void;
    onBeforeRelease: (error: unknown | undefined) => void;
    onEnd: () => void;
  },
): Promise<void> {
  return sm.submit(
    session,
    input,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { replayLifecycle: { clientMessageId, ...hooks } },
  );
}

describe("tool.called structured metadata", () => {
  test("parser result metadata reaches the observability event unchanged", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const observed: ToolCalledEvent[] = [];
    const listener = (event: ToolCalledEvent) => observed.push(event);
    eventBus.on("tool.called", listener);
    try {
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.msg({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "failed-tool", name: "codex:mcpToolCall", input: {} }],
            },
          });
          r.msg({
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "failed-tool",
                  content: "bounded failure",
                  is_error: true,
                  termination_reason: "tool_error",
                },
              ],
            },
          });
          r.result();
        });
      });
      const session = makeSession(runner);
      await runOneTurn(sm, session, events);
    } finally {
      eventBus.off("tool.called", listener);
    }

    assert.equal(observed.length, 1);
    assert.equal(observed[0].toolName, "codex:mcpToolCall");
    assert.equal(observed[0].isError, true);
    assert.equal(observed[0].terminationReason, "tool_error");
  });
});

// ── phantom 三态 ──────────────────────────────────────────────────────────

describe("phantom three-state judgment", () => {
  test("unknown(无 telemetry)+ 全零 → PHANTOM_TURN reject + totals 回滚", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => r.result()); // 全零、无 blocks、无 telemetry
    });
    const session = makeSession(runner);

    await assert.rejects(runOneTurn(sm, session, events), /PHANTOM_TURN/);
    // parser 已 turns+=1,回滚后归 0
    assert.equal(session.turns, 0);
    assert.equal(session.totalCostUSD, 0);
    assert.equal(session._lastCcbCumulativeCost, 0);
    assert.equal(
      events.some((e) => e.kind === "final"),
      false,
      "phantom 不放行缓冲的 final",
    );
  });

  test("skipped(CCB 明示未调 API)+ 全零 → 正常完成,不判 phantom", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => {
        r.telemetry("turn.skipped", { reason: "slash_command" });
        r.result();
      });
    });
    const session = makeSession(runner);

    await runOneTurn(sm, session, events, "/help");
    assert.ok(events.some((e) => e.kind === "final"), "final 应放行");
    assert.equal(events.some((e) => e.kind === "error"), false);
    assert.equal(session.turns, 1, "skipped 是正常完成,不回滚");
  });

  test("called(willCallApi 已发)+ 全零 → 不判 phantom(诊断仅告警)", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => {
        r.telemetry("turn.willCallApi");
        r.result(); // 无 stop_reason、零 blocks → incomplete 诊断路径
      });
    });
    const session = makeSession(runner);

    await runOneTurn(sm, session, events);
    assert.ok(events.some((e) => e.kind === "final"));
    assert.equal(session.turns, 1);
  });

  test("unknown + 有输出(blocks>0)→ 不判 phantom", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => {
        r.text("real answer");
        r.result({ total_cost_usd: 0.02, usage: { input_tokens: 3, output_tokens: 2 } });
      });
    });
    const session = makeSession(runner);

    await runOneTurn(sm, session, events);
    assert.ok(events.some((e) => e.kind === "final"));
    assert.equal(session.totalCostUSD, 0.02);
    assert.equal(session.totalInputTokens, 3);
    assert.equal(session.totalOutputTokens, 2);
  });
});

// ── auth / stale-resume 分类 + 回滚 ──────────────────────────────────────

describe("auth / stale-resume classification", () => {
  test("auth 错误(errorKind='auth')→ AUTH_ERROR reject + totals 回滚", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => {
        r.msg({
          type: "assistant",
          error: "auth",
          message: { content: [{ type: "text", text: "Failed to authenticate. run /login" }] },
        });
        r.result({ is_error: true, total_cost_usd: 0.3 });
      });
    });
    const session = makeSession(runner);

    await assert.rejects(runOneTurn(sm, session, events), /AUTH_ERROR/);
    assert.equal(session.turns, 0);
    assert.equal(session.totalCostUSD, 0);
    assert.equal(session._lastCcbCumulativeCost, 0);
    assert.equal(events.some((e) => e.kind === "final"), false, "auth 门拦下缓冲 final");
  });

  test("stale --resume → STALE_RESUME_ID reject + _pendingStaleResumeClear 置位", async () => {
    const sm = new SessionManager(makeConfigStub());
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() =>
        r.result({
          is_error: true,
          errors: ["No conversation found with session ID: dead-beef"],
        }),
      );
    });
    const session = makeSession(runner);

    await assert.rejects(runOneTurn(sm, session, events), /STALE_RESUME_ID/);
    assert.equal(session._pendingStaleResumeClear, true);
    assert.equal(session.turns, 0, "stale 路径同样回滚 totals");
  });
});

// ── crash/interrupt partial persistence(getPartialSnapshot 主风险面)─────

interface CapturedSink {
  sink: V3MasterSink;
  payloads: V3MasterSinkPayload[];
}

type CapturedSinkOutcome = Awaited<ReturnType<V3MasterSink["persistOrQueue"]>>;

function makeCapturingSink(outcome: CapturedSinkOutcome = { ok: true }): CapturedSink {
  const payloads: V3MasterSinkPayload[] = [];
  const sink = {
    persistOrQueue: async (payload: V3MasterSinkPayload) => {
      payloads.push(payload);
      return outcome;
    },
    attemptOnce: async () => {
      throw new Error("not used in this test");
    },
  } as unknown as V3MasterSink;
  return { sink, payloads };
}

/** F6 — 延迟落定的 sink:拉宽"读 count → 落定 count++"之间的窗口,若 owner 预算不是
 *  跨 session 串行临界区,共享 owner 的两 session 会同读旧 count 双双过 cap → 超发。 */
function makeDelayingSink(delayMs: number): CapturedSink {
  const payloads: V3MasterSinkPayload[] = [];
  const sink = {
    persistOrQueue: async (payload: V3MasterSinkPayload) => {
      await new Promise((r) => setTimeout(r, delayMs));
      payloads.push(payload);
      return { ok: true } as CapturedSinkOutcome;
    },
    attemptOnce: async () => {
      throw new Error("not used in this test");
    },
  } as unknown as V3MasterSink;
  return { sink, payloads };
}

describe("crash/interrupt partial persistence", () => {
  test("co-locates the exact engine billing frame with the immutable paid turn", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const requestId = "a".repeat(32);
      let emittedTurnKey: string | undefined;
      let session!: AgentSession;
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          const billing = {
            requestId,
            turnKey: session._currentTurnKey!,
            engineSessionId: `oceng-${"b".repeat(48)}`,
            status: "success" as const,
            durationMs: 321,
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              reasoning_output_tokens: 7,
            },
            rateLimits: { util5h: 17.5, reset5h: "2026-07-14T00:00:00.000Z" },
          };
          emittedTurnKey = billing.turnKey;
          session.runner.emit("billing", billing);
          r.text("answer with durable billing");
          r.result({ stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4 } });
        });
      });
      session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await sm.submit(session, "paid request", (event) => events.push(event), undefined, undefined, requestId);

      assert.equal(captured.payloads.length, 1);
      const persisted = captured.payloads[0]!;
      assert.equal(persisted.turnKey, emittedTurnKey);
      assert.deepEqual(persisted.engineBilling, {
        requestId,
        turnKey: persisted.turnKey,
        engineSessionId: `oceng-${"b".repeat(48)}`,
        status: "success",
        durationMs: 321,
        usage: { input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 7 },
        rateLimits: { util5h: 17.5, reset5h: "2026-07-14T00:00:00.000Z" },
      });
      assert.ok(events.some((event) => event.kind === "codex_billing"));
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("persists every visible retry notice as assistant text and as a raw gateway event", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      let submits = 0;
      const runner = new FakeCcbRunner((r) => {
        submits++;
        setImmediate(() => {
          if (submits === 1) {
            r.msg({
              type: "assistant",
              error: "auth",
              message: { content: [{ type: "text", text: "Failed to authenticate. run /login" }] },
            });
            r.result({ is_error: true, total_cost_usd: 0 });
          } else {
            r.text("retry succeeded exactly");
            r.result({ stop_reason: "end_turn", usage: { output_tokens: 2 } });
          }
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await sm.submit(
        session,
        "retry me",
        (event) => events.push(event),
        undefined,
        undefined,
        "c".repeat(32),
      );

      assert.equal(submits, 2);
      assert.equal(captured.payloads.length, 1);
      const payload = captured.payloads[0]!;
      const retryText = "\n\n🔄 认证已过期,正在刷新凭据并重试...\n";
      assert.equal(payload.text, retryText + "retry succeeded exactly");
      assert.deepEqual(payload.assistantSegments?.map((segment) => segment.text), [
        retryText,
        "retry succeeded exactly",
      ]);
      assert.ok(payload.runtimeEvents?.some((event) => {
        const raw = event.payload as { type?: unknown; code?: unknown };
        return raw.type === "retry_status" && raw.code === "AUTH_RETRY";
      }));
      assert.ok(events.some((event) =>
        event.kind === "block" && event.block.kind === "text" && event.block.text === retryText
      ));
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("writes post-terminal Bash tails as immutable continuations before live delivery", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const rawTail = {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "tool-bg",
        tail: "late complete stdout",
        total_bytes: 20,
        truncated_head: false,
        futureExactField: { keep: true },
      };
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.toolPair("tool-bg", "Bash", "initial output");
          r.text("the command continues in background");
          r.result({ stop_reason: "end_turn", usage: { output_tokens: 3 } });
          setTimeout(() => r.msg(rawTail), 10);
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await sm.submit(
        session,
        "start background command",
        (event) => events.push(event),
        undefined,
        undefined,
        "d".repeat(32),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      await sm.awaitPendingPersistence();

      assert.equal(captured.payloads.length, 2);
      const [main, continuation] = captured.payloads;
      assert.equal(continuation!.continuationOfTurnKey, main!.turnKey);
      assert.equal(continuation!.text, "");
      assert.equal(continuation!.status, "completed");
      assert.deepEqual(continuation!.runtimeEvents?.map((event) => event.payload), [rawTail]);
      assert.ok(events.some((event) =>
        event.kind === "block" &&
        event.block.kind === "tool_output_tail" &&
        event.block.tail === rawTail.tail
      ));
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("crash(code!=0)→ 部分 text/thinking/tools/segments 以 status='crashed' 落 sink", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      let session!: AgentSession;
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.thinking("half thought");
          r.text("partial ans");
          r.plan({
            blockId: "plan-live",
            text: "first plan",
            steps: [{ step: "inspect", status: "inProgress" }],
            partial: true,
          });
          r.plan({
            blockId: "plan-live",
            text: "updated plan",
            steps: [{ step: "inspect", status: "completed" }],
            partial: false,
          });
          r.goal({
            blockId: "goal-live",
            objective: "preserve everything",
            status: "in_progress",
            tokenBudget: null,
          });
          r.toolPair("tu1", "Bash", "tool output before crash");
          r.text("wer");
          session.runner.emit("billing", {
            requestId: "crash-usage-request",
            turnKey: session._currentTurnKey,
            engineSessionId: `oceng-${"c".repeat(48)}`,
            status: "error",
            durationMs: 123,
            usage: {
              input_tokens: 7,
              output_tokens: 3,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
          });
          r.emitExit({ code: 1, signal: null, crashed: true });
        });
      });
      session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);

      // 150ms flush 已在 resolve 前完成(settle 在 flush 内)
      assert.equal(captured.payloads.length, 1);
      const p = captured.payloads[0];
      assert.equal(p.status, "crashed");
      assert.equal(p.sessionId, "engine-peer");
      assert.equal(p.turnIndex, 1);
      assert.equal(session.turns, 1, "partial paid output must consume its logical turn index");
      assert.equal(p.text, "partial answer");
      assert.equal(p.thinkingText, "half thought");
      assert.equal(p.requestId, "req-unit");
      assert.equal(p.agentSessionId, "ccb-sess-1");
      assert.deepEqual(p.usage, {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
        turn: 1,
      });
      assert.equal(p.tools?.length, 1);
      assert.equal(p.tools?.[0].toolName, "Bash");
      assert.equal(p.tools?.[0].output, "tool output before crash");
      assert.equal(p.structuredBlocks?.length, 3);
      assert.deepEqual(
        p.structuredBlocks?.map((block) => ({
          kind: block.kind,
          blockId: block.blockId,
          text: block.text,
          objective: block.objective,
          status: block.status,
          partial: block.partial,
        })),
        [
          {
            kind: "plan",
            blockId: "plan-live",
            text: "first plan",
            objective: undefined,
            status: undefined,
            partial: true,
          },
          {
            kind: "plan",
            blockId: "plan-live",
            text: "updated plan",
            objective: undefined,
            status: undefined,
            partial: false,
          },
          {
            kind: "goal",
            blockId: "goal-live",
            text: undefined,
            objective: "preserve everything",
            status: "in_progress",
            partial: undefined,
          },
        ],
      );
      const structuredOrdinals = p.structuredBlocks?.map((block) => block._ocEventOrdinal as number) ?? [];
      assert.equal(structuredOrdinals.length, 3);
      assert.ok(structuredOrdinals.every((ordinal, index) =>
        Number.isSafeInteger(ordinal) && (index === 0 || ordinal > structuredOrdinals[index - 1]!)),
      );
      // Fix B per-segment:text → tool → text 分成 s0/s1
      assert.deepEqual(
        p.assistantSegments?.map((s) => ({ index: s.index, text: s.text })),
        [
          { index: 0, text: "partial ans" },
          { index: 1, text: "wer" },
        ],
      );
      assert.equal(p.thinkingSegments?.length, 1);
      assert.ok(
        p.runtimeEvents?.some((event) =>
          (event.payload as { type?: unknown }).type === "terminal_error" &&
          (event.payload as { code?: unknown }).code === "RUNNER_CRASHED"
        ),
        "crash reason itself must be part of the immutable tape",
      );

      // 用户可见错误帧 + turn 正常 resolve
      assert.ok(
        events.some((e) => e.kind === "error" && e.error.includes("code 1")),
        "crash 需产生可见错误帧",
      );
      // flush promise 已注册进 pending-persistence 并排空
      await sm.awaitPendingPersistence();
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("interrupt(signal)→ status='interrupted'", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.text("stopped midway");
          r.emitExit({ code: null, signal: "SIGTERM", crashed: true });
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);

      assert.equal(captured.payloads.length, 1);
      assert.equal(captured.payloads[0].status, "interrupted");
      assert.equal(captured.payloads[0].text, "stopped midway");
      assert.ok(events.some((e) => e.kind === "error" && e.error.includes("SIGTERM")));
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  for (const [status, exit, expectedReason] of [
    ["crashed", { code: 1, signal: null, crashed: true }, "code 1"],
    ["interrupted", { code: null, signal: "SIGTERM", crashed: true }, "SIGTERM"],
  ] as const) {
    test(`queued ${status} tape is not exposed as a terminal reply before master ACK`, async () => {
      const captured = makeCapturingSink({
        ok: false,
        queued: true,
        errorClass: "transient",
      });
      setV3MasterSinkSingleton(captured.sink);
      try {
        const sm = new SessionManager(makeConfigStub());
        const events: SessionStreamEvent[] = [];
        const runner = new FakeCcbRunner((r) => {
          setImmediate(() => {
            r.text(`partial ${status}`);
            r.emitExit(exit);
          });
        });
        const session = makeSession(runner, {
          channel: "webchat",
          userId: "user-queued",
        } as Partial<AgentSession>);

        await runOneTurn(sm, session, events);

        assert.equal(captured.payloads.length, 1);
        assert.equal(captured.payloads[0].status, status);
        assert.equal(captured.payloads[0].text, `partial ${status}`);
        assert.ok(captured.payloads[0].runtimeEvents?.some((event) =>
          (event.payload as { type?: unknown }).type === "terminal_error"));
        assert.equal(
          events.some((event) =>
            (event.kind === "error" && event.error.includes(expectedReason)) ||
            event.kind === "final"),
          false,
          "locally queued data is not an authoritative terminal ACK",
        );
        await sm.awaitPendingPersistence();
      } finally {
        setV3MasterSinkSingleton(null);
      }
    });
  }

  test("completed structured-only turn persists every plan/goal update", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.plan({ blockId: "plan-only", text: "draft", partial: true });
          r.plan({ blockId: "plan-only", text: "final", partial: false });
          r.goal({ blockId: "goal-only", objective: "done", status: "complete" });
          r.result({ stop_reason: "end_turn" });
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);

      assert.equal(captured.payloads.length, 1);
      assert.equal(captured.payloads[0].status, "completed");
      assert.equal(captured.payloads[0].text, "");
      assert.deepEqual(
        captured.payloads[0].structuredBlocks?.map((block) => block.kind),
        ["plan", "plan", "goal"],
      );
      assert.ok(events.some((event) => event.kind === "final"));
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("error-only paid result persists the complete error and raw runtime events", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const hugeDetail = `provider-detail:${"故障字段".repeat(30_000)}`;
      const resultPayload = {
        is_error: true,
        subtype: "error_during_execution",
        result: hugeDetail,
        errors: [hugeDetail, { future: { nested: [1, 2, 3] } }],
        stop_reason: "refusal",
      };
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.msg({
            type: "assistant_error",
            error: { code: "UPSTREAM_EXACT", detail: hugeDetail },
            futureField: { keep: true },
          });
          r.result(resultPayload);
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);

      assert.equal(captured.payloads.length, 1);
      const payload = captured.payloads[0]!;
      assert.equal(payload.status, "completed");
      assert.equal(payload.text, "");
      assert.equal(
        payload.errorDetail,
        JSON.stringify({
          subtype: resultPayload.subtype,
          result: hugeDetail,
          errors: resultPayload.errors,
        }),
      );
      assert.deepEqual(
        payload.runtimeEvents?.map((event) => event.payload),
        [
          {
            type: "assistant_error",
            error: { code: "UPSTREAM_EXACT", detail: hugeDetail },
            futureField: { keep: true },
          },
          {
            type: "result",
            total_cost_usd: 0,
            usage: {},
            ...resultPayload,
          },
        ],
      );
      assert.ok(
        events.some((event) => event.kind === "error" && event.error === payload.errorDetail),
        "error-only result must remain visible live and after refresh",
      );
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("runner error waits for drained late output instead of freezing an early partial", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.emit("error", new Error("pipe reported failure before close"));
          r.text("late bytes still in stdout");
          r.result({ stop_reason: "end_turn", usage: { output_tokens: 5 } });
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);
      await sm.awaitPendingPersistence();

      assert.equal(captured.payloads.length, 1);
      assert.equal(captured.payloads[0]!.status, "completed");
      assert.equal(captured.payloads[0]!.text, "late bytes still in stdout");
      assert.ok(
        captured.payloads[0]!.runtimeEvents?.some((event) =>
          (event.payload as { type?: unknown }).type === "terminal_error" &&
          (event.payload as { detail?: unknown }).detail === "pipe reported failure before close"
        ),
      );
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("crash partial 后下一次 submit 使用新 turnIndex/turnKey，不复用 immutable tape identity", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      let submits = 0;
      const sm = new SessionManager(makeConfigStub());
      const runner = new FakeCcbRunner((r) => {
        submits++;
        setImmediate(() => {
          if (submits === 1) {
            r.text("first partial");
            r.emitExit({ code: 1, signal: null, crashed: true });
          } else {
            r.text("second complete");
            r.result({ stop_reason: "end_turn" });
          }
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await sm.submit(session, "first", () => {}, undefined, undefined, "req-first");
      await sm.submit(session, "second", () => {}, undefined, undefined, "req-second");

      assert.equal(captured.payloads.length, 2);
      const turnIndices = captured.payloads.map((p) => p.turnIndex);
      assert.equal(turnIndices[1], turnIndices[0] + 1);
      assert.equal(session.turns, turnIndices[1]);
      assert.notEqual(captured.payloads[0].turnKey, captured.payloads[1].turnKey);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("stdout 已排空的 result+exit 边界只写 completed tape,不再竞态双写 partial", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.text("complete at drained exit");
          r.result({ stop_reason: "end_turn" });
          r.emitExit({ code: 1, signal: null, crashed: true });
        });
      });
      const session = makeSession(runner, {
        channel: "webchat",
        userId: "user-1",
      } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(captured.payloads.length, 1, "one logical turn has one terminal tape");
      assert.equal(captured.payloads[0].status, "completed");
      assert.equal(captured.payloads[0].text, "complete at drained exit");
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("非 sink 白名单 channel:crash 只发错误帧,不落 sink", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const events: SessionStreamEvent[] = [];
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.text("cron partial");
          r.emitExit({ code: 137, signal: null, crashed: true });
        });
      });
      const session = makeSession(runner, { channel: "cron" } as Partial<AgentSession>);

      await runOneTurn(sm, session, events);
      assert.equal(captured.payloads.length, 0);
      assert.ok(events.some((e) => e.kind === "error"));
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });
});

// ── A1 post-terminal bash_output_tail 折叠 ────────────────────────────────

describe("post-terminal tail folding (A1)", () => {
  const mkTail = (over: Record<string, unknown> = {}) => ({
    type: "system",
    subtype: "bash_output_tail",
    tool_use_id: "tool-bg",
    tail: "same output",
    total_bytes: 11,
    truncated_head: false,
    ...over,
  });

  /** 跑一个最小 turn:发起若干 bg Bash 工具(F3 tail 归属登记点)+ text + result,
   *  返回可继续注入这些工具 post-terminal tail 的句柄。 */
  async function runFoldTurn(
    sm: SessionManager,
    requestId: string,
    opts: { toolIds?: string[]; sessionOver?: Partial<AgentSession> } = {},
  ): Promise<{
    session: AgentSession;
    runner: FakeCcbRunner;
    events: SessionStreamEvent[];
  }> {
    const toolIds = opts.toolIds ?? ["tool-bg"];
    const events: SessionStreamEvent[] = [];
    const runner = new FakeCcbRunner((r) => {
      setImmediate(() => {
        // Bash tool_use → onToolUse 登记归属;bg bash 终态后继续 emit tail。
        for (const id of toolIds) r.toolPair(id, "Bash", `initial ${id}`);
        r.text("done");
        r.result({ stop_reason: "end_turn", usage: { output_tokens: 1 } });
      });
    });
    const session = makeSession(runner, {
      channel: "webchat",
      userId: "user-1",
      ...opts.sessionOver,
    });
    await sm.submit(session, "go", (e) => events.push(e), undefined, undefined, requestId);
    return { session, runner, events };
  }

  const flush = (sm: SessionManager, session: AgentSession): Promise<void> =>
    (sm as unknown as { _flushTailFolding: (s: AgentSession) => Promise<void> })._flushTailFolding(
      session,
    );

  const tailBlockCount = (events: SessionStreamEvent[]): number =>
    events.filter(
      (e) => e.kind === "block" && (e.block as { kind: string }).kind === "tool_output_tail",
    ).length;

  test("同 hash 连发 N 条:只落 1 条 continuation 且只转发 1 条 block", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const { session, runner, events } = await runFoldTurn(sm, "e".repeat(32));
      const baseline = captured.payloads.length; // main turn tape

      runner.msg(mkTail()); // 首条 → 立即持久化
      await sm.awaitPendingPersistence();
      // 同内容连发 → 稳态早退丢弃(不落、不转、不进 durable 收集器)
      for (let i = 0; i < 4; i++) runner.msg(mkTail());
      await sm.awaitPendingPersistence();

      const tails = captured.payloads.slice(baseline);
      assert.equal(tails.length, 1, "同 hash 只持久化 1 条");
      assert.equal(tails[0].continuationOfTurnKey, captured.payloads[0].turnKey);
      assert.equal(tailBlockCount(events), 1, "只转发 1 条 tool_output_tail block");

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("内容变化但 <interval:trailing flush 恰一次(合并到最新一条)", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      // 缩短限频窗口,用真定时器 + 短 sleep 精确观察 trailing flush。
      (sm as unknown as { _tailFoldMinIntervalMs: number })._tailFoldMinIntervalMs = 40;
      const { session, runner } = await runFoldTurn(sm, "f".repeat(32));
      const baseline = captured.payloads.length;

      runner.msg(mkTail({ tail: "line-1", total_bytes: 1 })); // 立即落,锚定限频窗口
      runner.msg(mkTail({ tail: "line-2", total_bytes: 2 })); // 窗口内变化 → pending
      runner.msg(mkTail({ tail: "line-3", total_bytes: 3 }));
      runner.msg(mkTail({ tail: "line-4", total_bytes: 4 }));
      await sm.awaitPendingPersistence();
      assert.equal(captured.payloads.length - baseline, 1, "限频窗口内只先落 tail(1)");

      await new Promise((r) => setTimeout(r, 90)); // 等定时器到点
      await sm.awaitPendingPersistence();

      const tails = captured.payloads.slice(baseline);
      assert.equal(tails.length, 2, "trailing flush 恰一次");
      assert.deepEqual(
        tails.map((p) => (p.runtimeEvents?.[0].payload as { tail?: string }).tail),
        ["line-1", "line-4"],
        "只落首条 + 合并后的最新一条",
      );

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("每流 cap:达上限后落 capped marker,之后既不落也不转", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const smAny = sm as unknown as {
        _tailFoldMinIntervalMs: number;
        _tailFoldStreamCap: number;
      };
      smAny._tailFoldMinIntervalMs = 0; // 关限频:每条不同内容都立即持久化
      smAny._tailFoldStreamCap = 3; // 缩小 cap 以精确断言
      const { session, runner, events } = await runFoldTurn(sm, "g".repeat(32));
      const baseline = captured.payloads.length;

      // 前 3 条真实落,第 4 条(达 cap)落 capped marker。
      for (let i = 1; i <= 4; i++) {
        runner.msg(mkTail({ tail: `l-${i}`, total_bytes: i }));
        await sm.awaitPendingPersistence();
      }
      // 封顶后:第 5、6 条丢弃。
      runner.msg(mkTail({ tail: "l-5", total_bytes: 5 }));
      runner.msg(mkTail({ tail: "l-6", total_bytes: 6 }));
      await sm.awaitPendingPersistence();

      const tails = captured.payloads.slice(baseline);
      assert.equal(tails.length, 4, "3 条真实 tail + 1 条 capped marker");
      assert.deepEqual(
        tails.map((p) => (p.runtimeEvents?.[0].payload as { subtype?: string }).subtype),
        [
          "bash_output_tail",
          "bash_output_tail",
          "bash_output_tail",
          "bash_output_tail_capped",
        ],
      );
      const marker = tails[3].runtimeEvents?.[0].payload as {
        suppressed_reason?: string;
        tool_use_id?: string;
      };
      assert.equal(marker.suppressed_reason, "cap");
      assert.equal(marker.tool_use_id, "tool-bg");
      assert.equal(tailBlockCount(events), 3, "只转发 3 条真实 tail(marker 与封顶后事件不转发)");

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("session destroy:flush pending(最终态豁免限频)", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const { session, runner } = await runFoldTurn(sm, "h".repeat(32));
      const baseline = captured.payloads.length;
      // 挂进 sessions 表,让 destroySession 能定位到它。
      (sm as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        session.sessionKey,
        session,
      );

      runner.msg(mkTail({ tail: "first", total_bytes: 1 })); // 立即落
      runner.msg(mkTail({ tail: "second", total_bytes: 2 })); // 默认 5s 窗口内 → pending
      await sm.awaitPendingPersistence();
      assert.equal(captured.payloads.length - baseline, 1, "pending 未到点,仅首条落");

      await sm.destroySession(session.sessionKey); // 应 flush pending,不等 5s 定时器

      const tails = captured.payloads.slice(baseline);
      assert.equal(tails.length, 2, "destroy 触发 pending 的 terminal flush");
      assert.equal(
        (tails[1].runtimeEvents?.[0].payload as { tail?: string }).tail,
        "second",
      );
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F1 三态:queued(已可靠排队)等同成功 —— 转发 + 更新 hash(同内容后续被抑制)", async () => {
    const captured = makeCapturingSink({ ok: false, queued: true, errorClass: "transient" });
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const { session, runner, events } = await runFoldTurn(sm, "q".repeat(32));
      const baseline = captured.payloads.length;

      runner.msg(mkTail()); // master 不可达 → queued(stage 已 fsync)
      await sm.awaitPendingPersistence();
      // queued 视作成功:已 stage(payload 落盘)+ 转发 + 更新 hash。
      assert.equal(captured.payloads.length - baseline, 1, "queued 帧已 stage");
      assert.equal(tailBlockCount(events), 1, "queued 帧照常转发(帧已可靠落盘)");

      // 同内容后续:hash 已更新 → 稳态早退抑制,不再重复 stage。
      runner.msg(mkTail());
      runner.msg(mkTail());
      await sm.awaitPendingPersistence();
      assert.equal(captured.payloads.length - baseline, 1, "同内容不因 queued 反复重 stage");

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F1 三态:dropped(永久丢弃)不算成功 —— 不转发、hash 不更新(下次重试)", async () => {
    const captured = makeCapturingSink({ ok: false, queued: false, droppedReason: "gone-410" });
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      (sm as unknown as { _tailFoldMinIntervalMs: number })._tailFoldMinIntervalMs = 0; // 关限频
      const { session, runner, events } = await runFoldTurn(sm, "r".repeat(32));
      const baseline = captured.payloads.length;

      runner.msg(mkTail());
      await sm.awaitPendingPersistence();
      runner.msg(mkTail()); // 同内容:因 dropped 未更新 hash → 不被抑制,重试
      await sm.awaitPendingPersistence();

      assert.equal(captured.payloads.length - baseline, 2, "dropped 不更新 hash → 同内容会重试(2 次 stage 尝试)");
      assert.equal(tailBlockCount(events), 0, "dropped 绝不转发(维持'转发的必已持久化')");

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F2 owner 多流 cap:跨流聚合达 owner 上限 → 落一条 owner marker,该 owner 全停", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const smAny = sm as unknown as {
        _tailFoldMinIntervalMs: number;
        _tailFoldStreamCap: number;
        _tailFoldOwnerCap: number;
      };
      smAny._tailFoldMinIntervalMs = 0;
      smAny._tailFoldStreamCap = 100; // 高到不触发 per-stream cap
      smAny._tailFoldOwnerCap = 3; // 跨流聚合上限
      const { session, runner, events } = await runFoldTurn(sm, "o".repeat(32), {
        toolIds: ["ta", "tb", "tc", "td"],
      });
      const baseline = captured.payloads.length;

      // 4 个不同流(同一 turn = 同一 ownerTurnKey)各发 1 条:前 3 落,第 4 触发 owner cap。
      for (const id of ["ta", "tb", "tc", "td"]) {
        runner.msg(mkTail({ tool_use_id: id, tail: `x-${id}` }));
        await sm.awaitPendingPersistence();
      }
      // owner 已封顶:任意流后续事件全丢。
      runner.msg(mkTail({ tool_use_id: "ta", tail: "after-cap" }));
      await sm.awaitPendingPersistence();

      const tails = captured.payloads.slice(baseline);
      assert.equal(tails.length, 4, "3 条真实 tail + 1 条 owner marker");
      assert.deepEqual(
        tails.map((p) => (p.runtimeEvents?.[0].payload as { subtype?: string }).subtype),
        [
          "bash_output_tail",
          "bash_output_tail",
          "bash_output_tail",
          "bash_output_tail_capped",
        ],
      );
      assert.equal(
        (tails[3].runtimeEvents?.[0].payload as { suppressed_reason?: string }).suppressed_reason,
        "owner_cap",
      );
      assert.equal(tailBlockCount(events), 3, "封顶后不再转发");

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F1b capped marker 冻结:dropped 时按同一 identity 重试,不生成多条不同 marker", async () => {
    const captured = makeCapturingSink({ ok: false, queued: false, droppedReason: "gone" });
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const smAny = sm as unknown as { _tailFoldMinIntervalMs: number; _tailFoldStreamCap: number };
      smAny._tailFoldMinIntervalMs = 0;
      smAny._tailFoldStreamCap = 2;
      const { session, runner } = await runFoldTurn(sm, "z".repeat(32));
      const baseline = captured.payloads.length;

      // dropped sink:真实 tail 不计入 persistedCount(dropped 不更新)→ cap 永不到。
      // 换 acked 让前 2 条落定后再切 dropped 不现实;改用 streamCap=0 直接触发 marker。
      smAny._tailFoldStreamCap = 0;
      runner.msg(mkTail({ tail: "a" }));
      await sm.awaitPendingPersistence();
      runner.msg(mkTail({ tail: "b" })); // 再触发一次 marker(仍 dropped)
      await sm.awaitPendingPersistence();

      const markers = captured.payloads
        .slice(baseline)
        .filter(
          (p) =>
            (p.runtimeEvents?.[0].payload as { subtype?: string }).subtype ===
            "bash_output_tail_capped",
        );
      assert.ok(markers.length >= 2, "dropped → marker 反复重试");
      // 冻结验证:所有 marker 的 event ordinal + observedAt 完全一致(同一冻结对象)。
      const first = markers[0].runtimeEvents?.[0];
      for (const m of markers) {
        const ev = m.runtimeEvents?.[0];
        assert.equal(ev?.ordinal, first?.ordinal, "marker ordinal 冻结");
        assert.equal(ev?.observedAt, first?.observedAt, "marker observedAt 冻结");
      }

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  // 收集器里只挑 bash_output_tail(隔离 turn 本身在 turn-end 推入的 runtimeEvents)。
  const tailsInCollector = (collector: unknown[]): string[] =>
    collector
      .map((e) => (e as { payload?: { subtype?: string; tail?: string } }).payload)
      .filter((p): p is { subtype: string; tail?: string } => p?.subtype === "bash_output_tail")
      .map((p) => p.tail ?? "");

  test("F4 delegate 收集器:acked/queued 才进 + flush 排空 pending(摘取前 await 链)", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const collector: DurableRuntimeEvent[] = [];
      const { session, runner } = await runFoldTurn(sm, "d".repeat(32), {
        sessionOver: { _durableDelegateRuntimeEvents: collector },
      });

      runner.msg(mkTail({ tail: "one", total_bytes: 1 })); // 立即落
      runner.msg(mkTail({ tail: "two", total_bytes: 2 })); // <5s → pending
      await sm.awaitPendingPersistence();
      assert.deepEqual(tailsInCollector(collector), ["one"], "落定的 tail 进收集器(pending 未 flush)");

      // flush 排空 pending → 收集器补齐(F4:handleDelegateTask 摘取前必须 await 该链)。
      await flush(sm, session);
      assert.deepEqual(tailsInCollector(collector), ["one", "two"], "flush 后 pending 也进收集器");
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F4 delegate 收集器失败路径:dropped tail 绝不进收集器", async () => {
    const captured = makeCapturingSink({ ok: false, queued: false, droppedReason: "gone" });
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const collector: DurableRuntimeEvent[] = [];
      const { session, runner } = await runFoldTurn(sm, "p".repeat(32), {
        sessionOver: { _durableDelegateRuntimeEvents: collector },
      });

      runner.msg(mkTail({ tail: "lost" }));
      await sm.awaitPendingPersistence();
      assert.deepEqual(tailsInCollector(collector), [], "dropped 的 tail 不进 delegate 收集器");

      await flush(sm, session);
      assert.deepEqual(tailsInCollector(collector), []);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F6 owner 预算跨 session 并发不超发:两 session 同 owner + 延迟 sink,总落定恰=cap", async () => {
    const captured = makeDelayingSink(25); // 拉宽落定窗口,暴露非串行会超发
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const smAny = sm as unknown as { _tailFoldMinIntervalMs: number; _tailFoldOwnerCap: number };
      smAny._tailFoldMinIntervalMs = 0;
      smAny._tailFoldOwnerCap = 1; // 硬:owner 只准落 1 条真实 tail
      const owner = {
        channel: "delegate",
        _billingParentTurnKey: "shared-owner",
        _usageAttribution: { mode: "delegate", parentSessionId: "shared-peer" },
      } as unknown as Partial<AgentSession>;
      const a = await runFoldTurn(sm, "a".repeat(32), { toolIds: ["a-bash"], sessionOver: owner });
      const b = await runFoldTurn(sm, "b".repeat(32), { toolIds: ["b-bash"], sessionOver: owner });
      const baseline = captured.payloads.length;

      // 两 session 同一 ownerTurnKey 的 tail **并发**注入(不 await 间隔)。
      a.runner.msg(mkTail({ tool_use_id: "a-bash", parent_tool_use_id: undefined, tail: "A1" }));
      b.runner.msg(mkTail({ tool_use_id: "b-bash", parent_tool_use_id: undefined, tail: "B1" }));
      await sm.awaitPendingPersistence();

      const tails = captured.payloads.slice(baseline);
      const real = tails.filter(
        (p) => (p.runtimeEvents?.[0].payload as { subtype?: string }).subtype === "bash_output_tail",
      );
      const markers = tails.filter(
        (p) =>
          (p.runtimeEvents?.[0].payload as { subtype?: string }).subtype ===
          "bash_output_tail_capped",
      );
      assert.equal(real.length, 1, "owner cap=1:跨 session 并发也只落 1 条真实 tail(无超发)");
      assert.equal(markers.length, 1, "第二条转为 owner marker");

      await flush(sm, a.session);
      await flush(sm, b.session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("F7 terminal flush 尊重 cap:owner capped 后 pending 不落盘(destroy 也不豁免)", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      (sm as unknown as { _tailFoldOwnerCap: number })._tailFoldOwnerCap = 2; // 默认 5s 限频保留
      const { session, runner } = await runFoldTurn(sm, "w".repeat(32), { toolIds: ["t1", "t2"] });
      (sm as unknown as { sessions: Map<string, AgentSession> }).sessions.set(session.sessionKey, session);
      const baseline = captured.payloads.length;

      runner.msg(mkTail({ tool_use_id: "t1", tail: "a" })); // 立即落,owner=1
      await sm.awaitPendingPersistence();
      runner.msg(mkTail({ tool_use_id: "t2", tail: "b" })); // 立即落,owner=2
      await sm.awaitPendingPersistence();
      // 各流第二条(<5s)→ pending;此刻 owner 未 capped(尚无 tail 超过 cap)。
      runner.msg(mkTail({ tool_use_id: "t1", tail: "a2" }));
      runner.msg(mkTail({ tool_use_id: "t2", tail: "c" }));

      await sm.destroySession(session.sessionKey); // terminal flush(runner 已停)

      const tails = captured.payloads.slice(baseline);
      const real = tails.filter(
        (p) => (p.runtimeEvents?.[0].payload as { subtype?: string }).subtype === "bash_output_tail",
      );
      // a2 触发 owner cap → 转 owner marker;c 落入 owner.capped → 丢弃。真实 tail 恒=cap。
      assert.equal(real.length, 2, "真实 tail 恰=owner cap(terminal flush 不豁免 cap)");
      assert.deepEqual(
        real.map((p) => (p.runtimeEvents?.[0].payload as { tail?: string }).tail).sort(),
        ["a", "b"],
        "a2/c 均未作为真实 tail 落盘",
      );
      assert.ok(
        tails.some(
          (p) =>
            (p.runtimeEvents?.[0].payload as { suppressed_reason?: string }).suppressed_reason ===
            "owner_cap",
        ),
        "落一条 owner marker",
      );
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });

  test("legacy 'skipped'(未落盘非失败):tail 仍转发 + 更新 hash 去重,但不计预算", async () => {
    setV3MasterSinkSingleton(null); // 无 sink → legacy 本地路径;post-terminal tail(空 text)→ skipped
    try {
      const sm = new SessionManager(makeConfigStub());
      const smAny = sm as unknown as { _tailFoldMinIntervalMs: number; _tailFoldStreamCap: number };
      smAny._tailFoldMinIntervalMs = 0;
      smAny._tailFoldStreamCap = 2; // 若 skipped 误计预算,3 条不同内容会触发 cap marker
      const { session, runner, events } = await runFoldTurn(sm, "s".repeat(32));

      // 4 条不同内容 → 全 skipped:全部转发,且因 hash 更新使重复被去重。
      for (const n of [1, 2, 3, 4]) {
        runner.msg(mkTail({ tail: `k-${n}`, total_bytes: n }));
        await sm.awaitPendingPersistence();
      }
      runner.msg(mkTail({ tail: "k-4", total_bytes: 4 })); // 与上条同内容 → 去重丢弃
      await sm.awaitPendingPersistence();

      assert.equal(tailBlockCount(events), 4, "skipped 仍转发(4 条不同内容各转发一次)");
      // 若 skipped 计预算,streamCap=2 会在第 3 条落 cap marker → 但 legacy 无 sink 不落盘,
      // 关键断言是"未触发 cap 提前静默":第 4 条仍被转发(未因 cap 停流)。
      const lastTail = events
        .filter(
          (e): e is Extract<SessionStreamEvent, { kind: "block" }> =>
            e.kind === "block" && (e.block as { kind: string }).kind === "tool_output_tail",
        )
        .pop();
      assert.equal((lastTail!.block as { tail?: string }).tail, "k-4", "第 4 条(cap 之外)仍转发 → skipped 不计预算");

      await flush(sm, session);
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });
});

describe("active-turn replay lock-owner lifecycle", () => {
  test("a queued submit cannot replace the marker until it actually owns session.lock", async () => {
    const sm = new SessionManager(makeConfigStub());
    let submitCount = 0;
    let finishFirst!: () => void;
    let firstEngineReady!: () => void;
    const firstEngineStarted = new Promise<void>((resolve) => { firstEngineReady = resolve; });
    const runner = new FakeCcbRunner((r) => {
      submitCount++;
      if (submitCount === 1) {
        finishFirst = () => {
          r.text("first complete");
          r.result({ stop_reason: "end_turn", usage: { output_tokens: 1 } });
        };
        firstEngineReady();
        return;
      }
      setImmediate(() => {
        r.text("second complete");
        r.result({ stop_reason: "end_turn", usage: { output_tokens: 1 } });
      });
    });
    const session = makeSession(runner);
    const lifecycle: string[] = [];
    const hooks = (id: string) => ({
      onStart: () => lifecycle.push(`start:${id}`),
      onBeforeRelease: (error: unknown | undefined) => {
        assert.equal(error, undefined);
        lifecycle.push(`before:${id}`);
      },
      onEnd: () => lifecycle.push(`end:${id}`),
    });

    const first = submitWithReplayLifecycle(sm, session, "first", "m-user-1", hooks("u1"));
    await firstEngineStarted;
    const second = submitWithReplayLifecycle(sm, session, "second", "m-user-2", hooks("u2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(lifecycle, ["start:u1"]);
    assert.equal(session._runningClientMessageId, "m-user-1");

    finishFirst();
    await first;
    await second;
    assert.deepEqual(lifecycle, [
      "start:u1", "before:u1", "end:u1",
      "start:u2", "before:u2", "end:u2",
    ]);
    assert.equal(session._runningClientMessageId, undefined);
    assert.equal(session._activeTurnCount, 0);
  });

  test("hook failures never mask the turn or strand the session lock", async () => {
    const sm = new SessionManager(makeConfigStub());
    let submitCount = 0;
    const runner = new FakeCcbRunner((r) => {
      submitCount++;
      setImmediate(() => {
        r.text(`answer-${submitCount}`);
        r.result({ stop_reason: "end_turn", usage: { output_tokens: 1 } });
      });
    });
    const session = makeSession(runner);
    await submitWithReplayLifecycle(sm, session, "first", "m-user-1", {
      onStart: () => { throw new Error("start hook"); },
      onBeforeRelease: () => { throw new Error("before hook"); },
      onEnd: () => { throw new Error("end hook"); },
    });
    await sm.submit(session, "second", () => {});
    assert.equal(submitCount, 2, "a second turn acquired the released lock");
    assert.equal(session._runningClientMessageId, undefined);
    assert.equal(session._activeTurnCount, 0);
  });

  test("the exact browser user-row id reaches the immutable terminal tape", async () => {
    const captured = makeCapturingSink();
    setV3MasterSinkSingleton(captured.sink);
    try {
      const sm = new SessionManager(makeConfigStub());
      const runner = new FakeCcbRunner((r) => {
        setImmediate(() => {
          r.text("durable exact answer");
          r.result({ stop_reason: "end_turn", usage: { output_tokens: 2 } });
        });
      });
      const session = makeSession(runner, { channel: "webchat", userId: "user-1" });
      await submitWithReplayLifecycle(sm, session, "question", "m-user-exact", {
        onStart: () => {},
        onBeforeRelease: () => {},
        onEnd: () => {},
      });
      assert.equal(captured.payloads.length, 1);
      assert.equal(captured.payloads[0]!.clientMessageId, "m-user-exact");
    } finally {
      setV3MasterSinkSingleton(null);
    }
  });
});
