/**
 * CcbAdapter turn 汇总 parity 测试(M0)。
 *
 * 用注入 fake runner 逐条喂 CCB SdkMessage,断言:
 *   - EngineEvent 序列(text/thinking/tool_use/tool_result + detected 事件)顺序
 *     与旧 parser 直连路径一致;
 *   - TurnSummary 各字段(text/thinking/tools/segments/stopReason/numTurns/
 *     staleResumeId/errorKind/phantomSignals)与 TurnResult 语义逐项对齐;
 *   - 成本 delta 基线(sessionTotals ref mutate)逐字节不变;
 *   - getPartialSnapshot 中途快照(crash/interrupt 持久化主风险面);
 *   - turn 终态后 bash_output_tail 继续经旧 parser 路由(bg bash 语义),
 *     新 submitTurn 替换路由。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbAdapterTurnParity.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { CcbAdapter } from "../engine/ccbAdapter.js";
import type { EngineEvent } from "../engine/engineEvents.js";
import type { TurnParams } from "../engine/engineAdapter.js";
import type { SubprocessRunner } from "../subprocessRunner.js";
import type { EngineCreateOpts } from "../engine/registry.js";

class FakeCcbRunner extends EventEmitter {
  lastActivityAt = Date.now();
  submitted: Array<{ input: unknown; requestId?: string }> = [];

  async submit(
    input: string | Array<{ type: string; [key: string]: unknown }>,
    requestId?: string,
  ): Promise<void> {
    this.submitted.push({ input, requestId });
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
}

function makeAdapter(): { adapter: CcbAdapter; runner: FakeCcbRunner } {
  const runner = new FakeCcbRunner();
  const adapter = new CcbAdapter(
    {} as EngineCreateOpts,
    runner as unknown as SubprocessRunner,
  );
  return { adapter, runner };
}

function makeTotals(seed = 0) {
  return { totalCostUSD: seed, turns: 0, _lastCcbCumulativeCost: seed };
}

function beginTurn(
  adapter: CcbAdapter,
  events: EngineEvent[],
  overrides: Partial<TurnParams> = {},
) {
  return adapter.submitTurn({
    input: "hello",
    onEvent: (e) => events.push(e),
    sessionTotals: makeTotals(),
    toolUseIdToName: new Map(),
    ...overrides,
  });
}

// ── 标准消息构造 ──────────────────────────────────────────────────────────

function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function thinkingDelta(thinking: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
  };
}

function toolUseStart(id: string, name: string, index = 0) {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name } },
  };
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(id: string, content: string, isError = false) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  };
}

function resultRow(over: Record<string, unknown> = {}) {
  return {
    type: "result",
    total_cost_usd: 0.08,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
    stop_reason: "end_turn",
    num_turns: 2,
    is_error: false,
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("CcbAdapter turn parity", () => {
  test("完整 turn:事件序列 + TurnSummary 字段 + 成本 delta 基线", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const totals = { totalCostUSD: 0.05, turns: 3, _lastCcbCumulativeCost: 0.05 };
    const turn = adapter.submitTurn({
      input: "hello",
      requestId: "req-1",
      assistantMessageId: "srv-p-main-t4",
      thinkingMessageId: "srv-p-main-t4-thinking",
      toolMessageIdFactory: (blockId) => `srv-p-main-t4-tool-${blockId}`,
      onEvent: (e) => events.push(e),
      sessionTotals: totals,
      toolUseIdToName: new Map(),
    });
    await turn.submitted;
    assert.equal(runner.submitted.length, 1);
    assert.equal(runner.submitted[0].requestId, "req-1");

    runner.msg(thinkingDelta("mull "));
    runner.msg(textDelta("Hello "));
    runner.msg(toolUseStart("tu1", "Bash"));
    runner.msg(assistantToolUse("tu1", "Bash", { command: "ls" }));
    assert.equal(turn.pendingToolCalls, 1, "tool_use 后 pendingToolCalls=1");
    assert.equal(adapter.pendingToolCalls, 1, "adapter 级 getter 同源");
    runner.msg(toolResult("tu1", "file-a\nfile-b"));
    assert.equal(turn.pendingToolCalls, 0);
    runner.msg(textDelta("world"));
    runner.msg(resultRow());

    const summary = await turn.summary;
    assert.ok(summary, "正常终态必须带 summary");

    // —— 事件序列(与旧 parser 直连一致 + detected 事件按回调时序插入)——
    const kinds = events.map((e) =>
      e.kind === "block" ? `block:${(e.block as { kind: string }).kind}` : e.kind,
    );
    assert.deepEqual(kinds, [
      "block:thinking",
      "block:text",
      "block:tool_use", // content_block_start partial
      "tool_use_detected", // onToolUse 在 finalized snapshot block 之前
      "block:tool_use", // assistant snapshot (partial:false)
      "block:tool_result",
      "tool_result_detected", // onToolResult 在 tool_result block 之后
      "block:text",
      "usage",
      "final",
    ]);

    // canonical id 打点(v7/v7.1)
    const textBlocks = events.filter(
      (e): e is Extract<EngineEvent, { kind: "block" }> =>
        e.kind === "block" && (e.block as { kind: string }).kind === "text",
    );
    assert.equal((textBlocks[0].block as { messageId?: string }).messageId, "srv-p-main-t4-s0");
    const toolBlocks = events.filter(
      (e): e is Extract<EngineEvent, { kind: "block" }> =>
        e.kind === "block" && (e.block as { kind: string }).kind === "tool_use",
    );
    assert.equal(
      (toolBlocks[0].block as { messageId?: string }).messageId,
      "srv-p-main-t4-tool-tu1",
    );

    // —— TurnSummary 字段 parity ——
    assert.equal(summary.assistantText, "Hello world");
    assert.equal(summary.thinkingText, "mull ");
    assert.equal(summary.stopReason, "end_turn");
    assert.equal(summary.numTurns, 2);
    assert.equal(summary.isError, false);
    assert.equal(summary.errorKind, undefined);
    assert.equal(summary.staleResumeId, false);
    assert.equal(summary.tools.length, 1);
    assert.equal(summary.tools[0].toolName, "Bash");
    assert.equal(summary.tools[0].output, "file-a\nfile-b");
    // text → tool → text:pending bump 只在两段都有内容时分段
    assert.deepEqual(
      summary.assistantSegments.map((s) => ({ index: s.index, text: s.text })),
      [
        { index: 0, text: "Hello " },
        { index: 1, text: "world" },
      ],
    );
    assert.equal(summary.thinkingSegments.length, 1);
    // usage(cost = cumulative 0.08 - baseline 0.05)
    assert.deepEqual(summary.usage, {
      cost: 0.08 - 0.05,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      totalTokens: 18,
    });
    // 成本 delta 基线:totals ref 被 parser 直接 mutate(逐字节不变语义)
    assert.equal(totals._lastCcbCumulativeCost, 0.08);
    assert.equal(totals.totalCostUSD, 0.05 + (0.08 - 0.05));
    assert.equal(totals.turns, 4);
    // 无 telemetry → phantomSignals unknown
    assert.equal(summary.phantomSignals.apiState, "unknown");
    assert.equal(turn.finalized, true);
  });

  test("telemetry willCallApi/skipped → phantomSignals + diagnostics", async () => {
    {
      const { adapter, runner } = makeAdapter();
      const events: EngineEvent[] = [];
      const turn = beginTurn(adapter, events);
      runner.telemetry("turn.willCallApi");
      runner.telemetry("turn.apiResponse", { stopReason: "end_turn" });
      runner.telemetry("tool.preUse", { toolName: "Bash" });
      runner.msg(resultRow());
      const summary = await turn.summary;
      assert.equal(summary?.phantomSignals.apiState, "called");
      assert.deepEqual(summary?.diagnostics, {
        hadApiResponse: true,
        apiRespStopReason: "end_turn",
        lastToolPreUse: "Bash",
        toolErrorCount: 0,
      });
    }
    {
      const { adapter, runner } = makeAdapter();
      const events: EngineEvent[] = [];
      const turn = beginTurn(adapter, events);
      runner.telemetry("turn.skipped", { reason: "slash_command" });
      runner.msg(resultRow({ total_cost_usd: 0, usage: {} }));
      const summary = await turn.summary;
      assert.equal(summary?.phantomSignals.apiState, "skipped");
      assert.equal(summary?.phantomSignals.skipReason, "slash_command");
      // 句柄级读取与 summary 同源(异常终态 summary=null 时 sessionManager 靠它)
      assert.equal(turn.getPhantomSignals().apiState, "skipped");
    }
  });

  test("auth 错误分类下沉:isError+关键字 / 精确前缀 → errorKind='auth'", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const turn = beginTurn(adapter, events);
    // CCB synthetic API-error assistant(error 字段触发 text 收集)
    runner.msg({
      type: "assistant",
      error: "auth",
      message: {
        content: [{ type: "text", text: "OAuth token revoked · Please run /login" }],
      },
    });
    runner.msg(resultRow({ is_error: true, total_cost_usd: 0, usage: {} }));
    const summary = await turn.summary;
    assert.equal(summary?.isError, true);
    assert.equal(summary?.errorKind, "auth");
  });

  test("MODEL_AUTHORITY_INVALID 先于泛 403/auth 分类，且不泄露原始 JSON", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const turn = beginTurn(adapter, events);
    const raw = '{"error":{"code":"MODEL_AUTHORITY_INVALID","status":403,"message":"forbidden"}}';
    runner.msg({ type: "assistant_error", error: raw });
    runner.msg(resultRow({
      is_error: true,
      subtype: "error_during_execution",
      result: raw,
      errors: [raw],
      total_cost_usd: 0,
      usage: {},
    }));

    const summary = await turn.summary;
    assert.equal(summary?.errorKind, "model_authority");
    assert.equal(summary?.assistantText, "");
    assert.deepEqual(summary?.assistantSegments, []);
    assert.equal(summary?.errorDetail, "MODEL_AUTHORITY_EXPIRED");
    assert.equal(events.some((event) => event.kind === "error"), false);
    assert.doesNotMatch(JSON.stringify(summary?.runtimeEvents), /MODEL_AUTHORITY_INVALID|forbidden/);
    assert.match(JSON.stringify(summary?.runtimeEvents), /MODEL_AUTHORITY_EXPIRED/);
  });

  test("非 auth 的 isError → errorKind='other'", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const turn = beginTurn(adapter, events);
    runner.msg({
      type: "assistant",
      error: "boom",
      message: { content: [{ type: "text", text: "upstream exploded" }] },
    });
    runner.msg(resultRow({ is_error: true }));
    const summary = await turn.summary;
    assert.equal(summary?.errorKind, "other");
  });

  test("stale --resume 检测透传:errors 数组 → staleResumeId=true", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const turn = beginTurn(adapter, events);
    runner.msg(
      resultRow({
        is_error: true,
        errors: ["No conversation found with session ID: dead-beef"],
      }),
    );
    const summary = await turn.summary;
    assert.equal(summary?.staleResumeId, true);
  });

  test("getPartialSnapshot:中途快照 = crash/interrupt 持久化数据源", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const turn = beginTurn(adapter, events);
    runner.msg(thinkingDelta("deep thought"));
    runner.msg(textDelta("partial answ"));
    runner.msg(toolUseStart("tu9", "Read"));
    runner.msg(assistantToolUse("tu9", "Read", { file_path: "/etc/hosts" }));
    runner.msg(toolResult("tu9", "127.0.0.1 localhost"));

    const snap = turn.getPartialSnapshot();
    assert.equal(snap.assistantText, "partial answ");
    assert.equal(snap.thinkingText, "deep thought");
    assert.equal(snap.completedTools.length, 1);
    assert.equal(snap.completedTools[0].toolName, "Read");
    assert.equal(snap.completedTools[0].output, "127.0.0.1 localhost");
    assert.equal(snap.assistantSegments.length, 1);
    assert.equal(snap.assistantSegments[0].text, "partial answ");
    assert.equal(snap.thinkingSegments[0].text, "deep thought");
    // 快照是拷贝:mutate 快照不影响后续快照
    snap.completedTools.pop();
    assert.equal(turn.getPartialSnapshot().completedTools.length, 1);
    assert.equal(turn.finalized, false);

    // end()(异常路径强制收尾)→ summary=null,幂等
    turn.end();
    turn.end();
    assert.equal(turn.finalized, true);
    assert.equal(await turn.summary, null);
  });

  test("turn 终态后 bash_output_tail 继续路由;新 submitTurn 替换路由", async () => {
    const { adapter, runner } = makeAdapter();
    const eventsA: EngineEvent[] = [];
    const turnA = beginTurn(adapter, eventsA);
    // F3:tail 归属靠 Bash tool_use_id 登记 —— 先发起 bg Bash 工具 tu1(否则 fail-closed
    // 会把归属不明的 tail 丢弃)。
    runner.msg(assistantToolUse("tu1", "Bash", { command: "sleep 5 &" }));
    runner.msg(textDelta("A"));
    runner.msg(resultRow());
    await turnA.summary;

    // finalized 后 tail 仍放行 → 旧 turn 的 onEvent 继续收 tool_output_tail
    runner.msg({
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "tu1",
      tail: "bg line",
      total_bytes: 7,
    });
    const tail = eventsA.find(
      (e) => e.kind === "block" && (e.block as { kind: string }).kind === "tool_output_tail",
    );
    assert.ok(tail, "终态后 tail 应继续流经旧 parser 路由");

    // 新 turn 替换路由:后续消息只进 B
    const eventsB: EngineEvent[] = [];
    const lenA = eventsA.length;
    const turnB = beginTurn(adapter, eventsB);
    runner.msg(textDelta("B"));
    runner.msg(resultRow({ total_cost_usd: 0.09 }));
    await turnB.summary;
    assert.equal(eventsA.length, lenA, "旧 turn 不再收到新消息");
    assert.ok(
      eventsB.some((e) => e.kind === "block" && (e.block as { text?: string }).text === "B"),
    );
  });

  test("A0 owner 路由:turn1 的 bg bash tail 在 turn2 期间归位 turn1(不污染 turn2 parser)", async () => {
    const { adapter, runner } = makeAdapter();

    // turn1:发起一个 bg Bash 工具(assistant snapshot 触发 onToolUse → 登记归属)。
    const eventsA: EngineEvent[] = [];
    const postTerminalA: Array<{ block: { kind: string; tail?: string } }> = [];
    const turnA = beginTurn(adapter, eventsA, {
      onPostTerminalRuntimeEvent: (_event, block) =>
        postTerminalA.push({ block: block as { kind: string; tail?: string } }),
    });
    runner.msg(toolUseStart("tu1", "Bash"));
    runner.msg(assistantToolUse("tu1", "Bash", { command: "sleep 100 &" }));
    runner.msg(resultRow()); // turn1 终态,bg bash 仍在后台跑
    await turnA.summary;

    // turn2 激活:_routeTurn 切到 turn2。
    const eventsB: EngineEvent[] = [];
    const postTerminalB: unknown[] = [];
    const turnB = beginTurn(adapter, eventsB, {
      onPostTerminalRuntimeEvent: (event) => postTerminalB.push(event),
    });
    runner.msg(textDelta("B answering"));

    // turn1 的 bg bash 在 turn2 期间继续 emit tail(tool_use_id = tu1)。
    runner.msg({
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "tu1",
      tail: "still running",
      total_bytes: 13,
    });

    // 断言:tail 经 turn1 的 onPostTerminalRuntimeEvent(finalized parser 的
    // onPostFinalRuntimeEvent),而非灌进 turn2。
    assert.equal(postTerminalA.length, 1, "turn1 收到其 bg bash 的 post-terminal tail");
    assert.equal(postTerminalA[0].block.kind, "tool_output_tail");
    assert.equal(postTerminalA[0].block.tail, "still running");
    assert.equal(postTerminalB.length, 0, "turn2 不该收到 turn1 的 tail");

    // turn2 的 parser 未被污染:snapshot.runtimeEvents 与事件流均无该 tail。
    const snapB = turnB.getPartialSnapshot();
    assert.equal(
      snapB.runtimeEvents.some(
        (e) => (e.payload as { subtype?: string })?.subtype === "bash_output_tail",
      ),
      false,
      "turn2 parser runtimeEvents 不含 turn1 tail",
    );
    assert.equal(
      eventsB.some(
        (e) => e.kind === "block" && (e.block as { kind: string }).kind === "tool_output_tail",
      ),
      false,
      "turn2 事件流不含 turn1 tail 的 tool_output_tail block",
    );

    // 收尾 turn2。
    runner.msg(resultRow({ total_cost_usd: 0.09 }));
    await turnB.summary;
  });

  test("F3 fail-closed:origin map 逐出后,归属不明 tail 丢弃(不回落当前 turn)", async () => {
    const { adapter, runner } = makeAdapter();
    // turn1 登记 258 个 Bash 工具 → 全局 origin map 上限 256,tu0/tu1 被逐出。
    const eventsA: EngineEvent[] = [];
    const postTerminalA: Array<{ block: { kind: string; tail?: string } }> = [];
    const turnA = beginTurn(adapter, eventsA, {
      onPostTerminalRuntimeEvent: (_e, block) =>
        postTerminalA.push({ block: block as { kind: string; tail?: string } }),
    });
    const N = 258;
    for (let i = 0; i < N; i++) {
      runner.msg(assistantToolUse(`tu${i}`, "Bash", { command: `sleep 1 &` }));
    }
    runner.msg(resultRow());
    await turnA.summary;

    // turn2 激活(不拥有任何 turn1 的 Bash id)。
    const eventsB: EngineEvent[] = [];
    const turnB = beginTurn(adapter, eventsB);
    runner.msg(textDelta("B"));

    // tu0 已被 LRU 逐出 origin map + turn2 不拥有它 → fail-closed 丢弃。
    runner.msg({ type: "system", subtype: "bash_output_tail", tool_use_id: "tu0", tail: "evicted", total_bytes: 7 });
    // tu257(最近登记,仍在册)→ 命中 → 归位 turn1。
    runner.msg({ type: "system", subtype: "bash_output_tail", tool_use_id: "tu257", tail: "retained", total_bytes: 8 });

    assert.equal(postTerminalA.length, 1, "只有仍在册的 tu257 归位 turn1;被逐出的 tu0 丢弃");
    assert.equal(postTerminalA[0].block.tail, "retained");
    // turn2 未被污染。
    assert.equal(
      turnB.getPartialSnapshot().runtimeEvents.some(
        (e) => (e.payload as { subtype?: string })?.subtype === "bash_output_tail",
      ),
      false,
      "被丢弃的 tail 绝不灌进 turn2",
    );

    runner.msg(resultRow({ total_cost_usd: 0.02 }));
    await turnB.summary;
  });

  test("F3⑤ shutdown:drain 期间的尾帧仍按 origin 归位,之后才清 map", async () => {
    class DrainRunner extends FakeCcbRunner {
      async shutdown(): Promise<void> {
        // 模拟 SIGTERM drain 期间 bg bash 迟到的一帧 tail(map 此刻应仍在)。
        this.msg({ type: "system", subtype: "bash_output_tail", tool_use_id: "tu1", tail: "drain-tail", total_bytes: 9 });
      }
    }
    const runner = new DrainRunner();
    const adapter = new CcbAdapter({} as EngineCreateOpts, runner as unknown as SubprocessRunner);
    const events: EngineEvent[] = [];
    const postTerminal: Array<{ block: { kind: string; tail?: string } }> = [];
    const turn = adapter.submitTurn({
      input: "hi",
      onEvent: (e) => events.push(e),
      sessionTotals: makeTotals(),
      toolUseIdToName: new Map(),
      onPostTerminalRuntimeEvent: (_e, block) =>
        postTerminal.push({ block: block as { kind: string; tail?: string } }),
    });
    runner.msg(assistantToolUse("tu1", "Bash", { command: "x &" }));
    runner.msg(resultRow());
    await turn.summary;

    await adapter.shutdown(); // 内部 await runner.shutdown()(emit tail)后才清 map

    assert.equal(postTerminal.length, 1, "drain 期尾帧按 origin 归位(清 map 在 await 之后)");
    assert.equal(postTerminal[0].block.tail, "drain-tail");
  });

  test("F5 活跃态:子 agent bg bash tail 正常路由进当前 turn(不被 fail-closed 误丢)", async () => {
    const { adapter, runner } = makeAdapter();
    const events: EngineEvent[] = [];
    const turn = beginTurn(adapter, events);
    // 子 agent(parent_tool_use_id 置位)发起 Bash 工具 → onBashToolObserved 登记归属
    // (onToolUse 主 agent-only 不会触发,故不能靠它登记)。
    runner.msg({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: { content: [{ type: "tool_use", id: "sub-bash", name: "Bash", input: { command: "x &" } }] },
    });
    // 活跃 turn 内子 agent 的 bash tail(带 parent)→ 路由进当前 turn,发 tool_output_tail。
    runner.msg({
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "sub-bash",
      parent_tool_use_id: "agent-1",
      tail: "sub output",
      total_bytes: 10,
    });
    const tail = events.find(
      (e): e is Extract<EngineEvent, { kind: "block" }> =>
        e.kind === "block" && (e.block as { kind: string }).kind === "tool_output_tail",
    );
    assert.ok(tail, "活跃态子 agent bash tail 必须路由进当前 turn(非丢弃)");
    assert.equal(
      (tail!.block as { parentToolUseId?: string }).parentToolUseId,
      "agent-1",
      "带 parent → 前端归入 Agent 卡",
    );
    assert.equal((tail!.block as { tail?: string }).tail, "sub output");
    runner.msg(resultRow());
    await turn.summary;
  });

  test("F5 post-terminal:子 agent bg bash tail 在后续 turn 期间归位 origin turn", async () => {
    const { adapter, runner } = makeAdapter();
    const eventsA: EngineEvent[] = [];
    const postTerminalA: Array<{ block: { tail?: string; parentToolUseId?: string } }> = [];
    const turnA = beginTurn(adapter, eventsA, {
      onPostTerminalRuntimeEvent: (_e, block) =>
        postTerminalA.push({ block: block as { tail?: string; parentToolUseId?: string } }),
    });
    runner.msg({
      type: "assistant",
      parent_tool_use_id: "agent-1",
      message: { content: [{ type: "tool_use", id: "sub-bash", name: "Bash", input: {} }] },
    });
    runner.msg(resultRow());
    await turnA.summary;

    const eventsB: EngineEvent[] = [];
    const turnB = beginTurn(adapter, eventsB);
    runner.msg(textDelta("B"));

    runner.msg({
      type: "system",
      subtype: "bash_output_tail",
      tool_use_id: "sub-bash",
      parent_tool_use_id: "agent-1",
      tail: "late sub",
      total_bytes: 8,
    });
    assert.equal(postTerminalA.length, 1, "子 agent post-terminal tail 归位 turn1");
    assert.equal(postTerminalA[0].block.tail, "late sub");
    assert.equal(postTerminalA[0].block.parentToolUseId, "agent-1");

    runner.msg(resultRow({ total_cost_usd: 0.01 }));
    await turnB.summary;
  });

  test("activity 事件:每条原始消息 emit 一次(30-min timer refresh 信号源)", async () => {
    const { adapter, runner } = makeAdapter();
    let activity = 0;
    adapter.on("activity", () => activity++);
    const events: EngineEvent[] = [];
    beginTurn(adapter, events);
    runner.msg(textDelta("x"));
    runner.msg({ type: "system", subtype: "init" }); // parser 忽略的消息同样计活
    runner.msg(resultRow());
    assert.equal(activity, 3);
  });
});
