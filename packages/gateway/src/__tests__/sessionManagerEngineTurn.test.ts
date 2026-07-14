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
import type { SessionStreamEvent } from "../engine/engineEvents.js";
import type { EngineCreateOpts } from "../engine/registry.js";
import type { SubprocessRunner } from "../subprocessRunner.js";
import {
  setV3MasterSinkSingleton,
  type V3MasterSink,
  type V3MasterSinkPayload,
} from "../v3MasterSink.js";
import type { OpenClaudeConfig } from "@openclaude/storage";

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
          r.emitExit({ code: 1, signal: null, crashed: true });
        });
      });
      const session = makeSession(runner, {
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
