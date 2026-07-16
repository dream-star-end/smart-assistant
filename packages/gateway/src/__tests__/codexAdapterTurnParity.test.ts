/**
 * CodexAdapter turn parity 测试(M1a)。
 *
 * 深度对标 ccbAdapterTurnParity.test.ts:用 __setCodexAppServerSpawnForTests
 * 注入 fake `codex app-server` 子进程,走完整链路(adapter.submitTurn → 内核
 * drain/runTurn → JSON-RPC 握手 → thread/start|resume → 通知流 → turn/completed),
 * 在 **adapter 边界** 断言 canonical EngineEvent / TurnSummary / billing 事件 ——
 * fake-SDK RunnerMessage 形状不出现在断言里(内聚验证)。
 *
 * 覆盖(任务书 M1a 清单):JSON-RPC 握手 / thread start+resume /
 * agentMessage delta→text 块 / reasoning→thinking / commandExecution→Bash 卡 /
 * fileChange→Write|Edit / webSearch / mcpToolCall / plan / imageGeneration 落盘 /
 * turn completed→TurnSummary+billing 事件 / interrupt / approval auto-response /
 * appserver 崩溃→exit+partial snapshot / errorKind auth 分类。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexAdapterTurnParity.test.ts
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { paths } from "@openclaude/storage";

import { CodexAdapter, buildCodexBillingEvent, classifyCodexErrorKind } from "../engine/codexAdapter.js";
import { __setCodexAppServerSpawnForTests } from "../engine/codexAppServerRunner.js";
import { engineSessionId } from "../engine/engineSessionId.js";
import type { EngineBillingEvent, EngineEvent } from "../engine/engineEvents.js";
import type { EngineCreateOpts } from "../engine/registry.js";
import type { TurnParams } from "../engine/engineAdapter.js";

// ── fake `codex app-server` proc ─────────────────────────────────────────

type JsonRpcRequest = { jsonrpc: string; id: number | string; method: string; params?: unknown };

class FakeCodexProc extends EventEmitter {
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: JsonRpcRequest[] = [];
  /** auto-responder:内核每写一个 request 调用一次;返回 result 或抛错形状。 */
  onRequest: ((req: JsonRpcRequest) => void) | null = null;
  stdin = {
    write: (line: string) => {
      const req = JSON.parse(line) as JsonRpcRequest;
      this.written.push(req);
      this.onRequest?.(req);
      return true;
    },
  };
  kill(_sig?: string): void {
    this.killed = true;
  }
  /** 模拟子进程 stdout 一行 JSON-RPC。 */
  reply(obj: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
  }
  respondTo(id: number | string, result: unknown): void {
    this.reply({ jsonrpc: "2.0", id, result });
  }
  notify(method: string, params: unknown): void {
    this.reply({ jsonrpc: "2.0", method, params });
  }
}

interface Harness {
  adapter: CodexAdapter;
  events: EngineEvent[];
  billing: EngineBillingEvent[];
  sessionIds: string[];
  exits: Array<{ code: number | null; signal: string | null; crashed: boolean }>;
  spawnCalls: Array<{ cmd: string; args: string[] }>;
  proc: () => FakeCodexProc;
}

const SESSION_KEY = "agent:main:webchat:dm:codex-peer";

function makeHarness(opts: Partial<EngineCreateOpts> = {}): Harness {
  const procs: FakeCodexProc[] = [];
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  __setCodexAppServerSpawnForTests(((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const p = new FakeCodexProc();
    // 默认 auto-responder:握手/线程/turn 全自动应答。测试可换 p.onRequest。
    p.onRequest = (req) => {
      if (req.method === "initialize") p.respondTo(req.id, {});
      else if (req.method === "thread/start") p.respondTo(req.id, { thread: { id: "thr-new-1" } });
      else if (req.method === "thread/resume") p.respondTo(req.id, {});
      else if (req.method === "turn/start") p.respondTo(req.id, { turn: { id: "turn-1", status: "inProgress" } });
      else if (req.method === "turn/interrupt") p.respondTo(req.id, {});
    };
    procs.push(p);
    return p as unknown as ReturnType<typeof spawn>;
  }) as unknown as typeof spawn);

  const adapter = new CodexAdapter({
    sessionKey: SESSION_KEY,
    agentId: "main",
    agentBaseDir: tmpdir(),
    model: "gpt-5.6-sol",
    ...opts,
  } as EngineCreateOpts);
  const events: EngineEvent[] = [];
  const billing: EngineBillingEvent[] = [];
  const sessionIds: string[] = [];
  const exits: Array<{ code: number | null; signal: string | null; crashed: boolean }> = [];
  adapter.on("billing", (b: EngineBillingEvent) => billing.push(b));
  adapter.on("session_id", (id: string) => sessionIds.push(id));
  adapter.on("exit", (info) => exits.push(info));
  return {
    adapter,
    events,
    billing,
    sessionIds,
    exits,
    spawnCalls,
    proc: () => {
      assert.ok(procs.length > 0, "no codex proc spawned yet");
      return procs[procs.length - 1];
    },
  };
}

afterEach(() => {
  __setCodexAppServerSpawnForTests(null);
});

function makeTotals(seed = 0) {
  return { totalCostUSD: seed, turns: 0, _lastCcbCumulativeCost: seed };
}

function beginTurn(h: Harness, overrides: Partial<TurnParams> = {}) {
  return h.adapter.submitTurn({
    input: "hello codex",
    onEvent: (e) => h.events.push(e),
    sessionTotals: makeTotals(),
    toolUseIdToName: new Map(),
    ...overrides,
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** 等到 fake proc 已写出某个 method 的请求。 */
async function waitForRequest(h: Harness, method: string): Promise<JsonRpcRequest> {
  await waitFor(() => h.spawnCalls.length > 0 && h.proc().written.some((r) => r.method === method));
  return h.proc().written.find((r) => r.method === method)!;
}

function blockKinds(events: EngineEvent[]): string[] {
  return events.map((e) =>
    e.kind === "block" ? `block:${(e.block as { kind: string }).kind}` : e.kind,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("CodexAdapter — 握手 / thread lifecycle", () => {
  test("首 turn:spawn argv + initialize 握手 + thread/start → session_id 上报", async () => {
    const h = makeHarness();
    const turn = beginTurn(h, { requestId: "req-hs" });

    const init = await waitForRequest(h, "initialize");
    assert.deepEqual(h.spawnCalls[0].cmd, "codex");
    assert.equal(h.spawnCalls[0].args[0], "app-server");
    assert.ok(
      h.spawnCalls[0].args.includes('model_reasoning_effort="xhigh"'),
      `spawn argv should use GPT-5.6-Sol default effort xhigh: ${h.spawnCalls[0].args.join(" ")}`,
    );
    assert.deepEqual(h.spawnCalls[0].args.slice(-2), ["--listen", "stdio://"]);
    const initParams = init.params as { clientInfo?: { name?: string }; capabilities?: { experimentalApi?: boolean } };
    assert.equal(initParams.clientInfo?.name, "openclaude-gateway");
    assert.equal(initParams.capabilities?.experimentalApi, true);

    const threadStart = await waitForRequest(h, "thread/start");
    const tsParams = threadStart.params as Record<string, unknown>;
    assert.equal(tsParams.approvalPolicy, "never");
    assert.equal(tsParams.sandbox, "danger-full-access");
    assert.equal(tsParams.model, "gpt-5.6-sol");

    const turnStart = await waitForRequest(h, "turn/start");
    const turnParams = turnStart.params as { collaborationMode?: { settings?: { reasoning_effort?: unknown } } };
    assert.equal(turnParams.collaborationMode?.settings?.reasoning_effort, "xhigh");
    assert.deepEqual(h.sessionIds, ["thr-new-1"]);
    assert.equal(h.adapter.nativeSessionId, "thr-new-1");

    // 收尾:正常完成
    h.proc().notify("turn/completed", { threadId: "thr-new-1", turn: { id: "turn-1", status: "completed", durationMs: 3 } });
    const summary = await turn.summary;
    assert.ok(summary);
    assert.equal(summary.isError, false);
  });

  test("resumeSessionId → thread/resume(不新开线程);nativeSessionId 保持", async () => {
    const h = makeHarness({ resumeSessionId: "thr-old-9" } as Partial<EngineCreateOpts>);
    assert.equal(h.adapter.nativeSessionId, "thr-old-9");
    const turn = beginTurn(h);
    const resume = await waitForRequest(h, "thread/resume");
    assert.equal((resume.params as Record<string, unknown>).threadId, "thr-old-9");
    assert.equal(
      h.proc().written.some((r) => r.method === "thread/start"),
      false,
      "resume 路径不得走 thread/start",
    );
    await waitForRequest(h, "turn/start");
    h.proc().notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await turn.summary;
    assert.equal(h.adapter.nativeSessionId, "thr-old-9");
    // clearSessionId 双向清(adapter 视图 + 内核线程态)
    h.adapter.clearSessionId();
    assert.equal(h.adapter.nativeSessionId, null);
  });

  test("thread/goal/set 的同步通知在下一 turn parser 安装后保留平台 generation", async () => {
    const h = makeHarness();
    const first = beginTurn(h);
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    p.notify("turn/completed", {
      threadId: "thr-new-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await first.summary;
    h.events.length = 0;

    const fallback = p.onRequest;
    p.onRequest = (req) => {
      if (req.method !== "thread/goal/set") {
        fallback?.(req);
        return;
      }
      // Reproduce app-server stdout ordering:the notification is parsed in
      // the same chunk before the request Promise continuation resumes.
      p.notify("thread/goal/updated", {
        threadId: "thr-new-1",
        goal: {
          objective: "ship adapter goal",
          status: "paused",
          tokenBudget: 2_000,
          tokensUsed: 21,
          timeUsedSeconds: 8,
        },
      });
      p.respondTo(req.id, {});
    };
    await h.adapter.setGoalState({
      sessionId: "web-goal-adapter",
      goalId: "11111111-1111-4111-8111-111111111111",
      objective: "ship adapter goal",
      status: "paused",
      tokenBudget: 2_000,
      creditBudget: null,
      tokensUsed: 21,
      creditsUsed: "0",
      timeUsedSeconds: 8,
      stateRevision: 7,
      snapshotRevision: 9,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:01.000Z",
      statusChangedAt: "2026-07-16T00:00:01.000Z",
    });
    assert.equal(h.events.length, 0, "between-turn notification waits for a live parser");

    const second = beginTurn(h);
    const goalEvent = h.events.find(
      (event) => event.kind === "block" && (event.block as { kind?: string }).kind === "goal",
    );
    assert.ok(goalEvent && goalEvent.kind === "block");
    assert.deepEqual(goalEvent.block, {
      kind: "goal",
      blockId: "codex-goal-pending",
      objective: "ship adapter goal",
      status: "paused",
      tokenBudget: 2_000,
      tokensUsed: 21,
      timeUsedSeconds: 8,
      platformGoalId: "11111111-1111-4111-8111-111111111111",
      platformStateRevision: 7,
    });
    await waitFor(() => p.written.filter((request) => request.method === "turn/start").length === 2);
    p.notify("turn/completed", {
      threadId: "thr-new-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await second.summary;
  });
});

describe("CodexAdapter — 事件映射 parity(fake-SDK 不出边界)", () => {
  test("完整 turn:delta→text / reasoning→thinking / commandExecution→Bash / fileChange→Write / plan / tokenUsage→TurnSummary + billing", async () => {
    const h = makeHarness();
    const totals = makeTotals(0);
    const turn = beginTurn(h, { requestId: "req-full", sessionTotals: totals });
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    const tid = { threadId: "thr-new-1", turnId: "turn-1" };

    p.notify("item/reasoning/textDelta", { ...tid, itemId: "r1", delta: "pondering " });
    p.notify("item/agentMessage/delta", { ...tid, itemId: "m1", delta: "Hello " });
    // commandExecution → Bash 卡(剥 /bin/bash -lc 壳)
    p.notify("item/started", {
      ...tid,
      item: { id: "c1", type: "commandExecution", command: "/bin/bash -lc 'ls -la'" },
    });
    p.notify("item/completed", {
      ...tid,
      item: { id: "c1", type: "commandExecution", aggregatedOutput: "file-a\nfile-b", exitCode: 0 },
    });
    // fileChange(add)→ Write 卡
    p.notify("item/started", {
      ...tid,
      item: { id: "f1", type: "fileChange", changes: [{ path: "/tmp/x.ts", kind: { type: "add" } }] },
    });
    p.notify("item/completed", {
      ...tid,
      item: { id: "f1", type: "fileChange", changes: [{ path: "/tmp/x.ts", kind: { type: "add" } }] },
    });
    // plan(原生 plan 更新 → plan 块)
    p.notify("turn/plan/updated", {
      ...tid,
      explanation: "step plan",
      plan: [{ step: "调研", status: "completed" }, { step: "实现", status: "inProgress" }],
    });
    p.notify("item/agentMessage/delta", { ...tid, itemId: "m1", delta: "world" });
    // usage(anthropic shape 折算:input 是 cached+非 cached 总量,须减去 cached)
    p.notify("thread/tokenUsage/updated", {
      ...tid,
      tokenUsage: {
        last: { cachedInputTokens: 100, inputTokens: 300, outputTokens: 40, reasoningOutputTokens: 8, totalTokens: 340 },
        total: { cachedInputTokens: 100, inputTokens: 300, outputTokens: 40, reasoningOutputTokens: 8, totalTokens: 340 },
      },
    });
    p.notify("turn/completed", { threadId: "thr-new-1", turn: { id: "turn-1", status: "completed", durationMs: 42 } });

    const summary = await turn.summary;
    assert.ok(summary, "正常终态必须带 summary");

    // billing 事件:engine-reported 侧信道,先于 final(内容事件流里 final 是最后一个)
    assert.equal(h.billing.length, 1);
    const b = h.billing[0];
    assert.equal(b.requestId, "req-full");
    assert.equal(b.engineSessionId, engineSessionId(SESSION_KEY));
    assert.equal(b.status, "success");
    // durationMs 是内核 runTurn 的 wall-clock(Date.now - startedAt),非通知里的
    // turn.durationMs —— 只锁类型/非负,不锁具体值。
    assert.ok(typeof b.durationMs === "number" && b.durationMs >= 0);
    assert.deepEqual(b.usage, {
      input_tokens: 200, // 300 - 100 cached(双计费修正)
      output_tokens: 40,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 8,
    });

    // EngineEvent 序列(canonical;fake-SDK 形状不在断言面)
    const kinds = blockKinds(h.events);
    assert.deepEqual(kinds, [
      "block:thinking",
      "block:text",
      "tool_use_detected",
      "block:tool_use", // Bash
      "block:tool_result",
      "tool_result_detected",
      "tool_use_detected",
      "block:tool_use", // Write
      "block:tool_result",
      "tool_result_detected",
      "block:plan",
      "block:text",
      "final",
    ]);
    const toolBlocks = h.events.filter(
      (e): e is Extract<EngineEvent, { kind: "block" }> =>
        e.kind === "block" && (e.block as { kind: string }).kind === "tool_use",
    );
    assert.equal((toolBlocks[0].block as { toolName?: string }).toolName, "Bash");
    // shell 壳剥离(/bin/bash -lc '...' → 原始命令)进 inputJson(assistant 快照帧)
    assert.equal(
      ((toolBlocks[0].block as { inputJson?: { command?: string } }).inputJson)?.command,
      "ls -la",
    );
    assert.equal((toolBlocks[1].block as { toolName?: string }).toolName, "Write");
    const detectedBash = h.events.find(
      (event): event is Extract<EngineEvent, { kind: "tool_result_detected" }> =>
        event.kind === "tool_result_detected" && event.result.toolName === "Bash",
    );
    assert.equal(detectedBash?.result.exitCode, 0);
    assert.equal(detectedBash?.result.terminationReason, "exit_code");

    // TurnSummary parity
    assert.equal(summary.assistantText, "Hello world");
    assert.equal(summary.thinkingText, "pondering ");
    assert.equal(summary.isError, false);
    assert.equal(summary.errorKind, undefined);
    assert.equal(summary.staleResumeId, false);
    assert.equal(summary.tools.length, 2);
    assert.equal(summary.tools[0].toolName, "Bash");
    assert.equal(summary.tools[0].output, "file-a\nfile-b");
    // codex 无 telemetry → phantom 恒 unknown(上层 legacy 启发式兜底)
    assert.equal(summary.phantomSignals.apiState, "unknown");
    assert.equal(summary.phantomSignals.skipReason, null);
    assert.equal(turn.getPhantomSignals().apiState, "unknown");
    // 成本 delta 基线:codex result 帧 total_cost_usd 恒 0 → cost 0,turns +1
    assert.equal(summary.usage.cost, 0);
    assert.equal(totals.totalCostUSD, 0);
    assert.equal(totals.turns, 1);
    // usage 进 summary(anthropic shape)
    assert.equal(summary.usage.inputTokens, 200);
    assert.equal(summary.usage.outputTokens, 40);
    assert.equal(summary.usage.cacheReadTokens, 100);
  });

  test("webSearch / mcpToolCall item → codex:<type> 工具卡(前端通用降级契约)", async () => {
    const h = makeHarness();
    const turn = beginTurn(h);
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    const tid = { threadId: "thr-new-1", turnId: "turn-1" };
    p.notify("item/started", { ...tid, item: { id: "w1", type: "webSearch", query: "openclaude" } });
    p.notify("item/completed", { ...tid, item: { id: "w1", type: "webSearch", results: 3 } });
    p.notify("item/started", { ...tid, item: { id: "mc1", type: "mcpToolCall", server: "openclaude_memory", tool: "memory" } });
    p.notify("item/completed", { ...tid, item: { id: "mc1", type: "mcpToolCall", status: "completed" } });
    p.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    const summary = await turn.summary;
    assert.ok(summary);
    assert.deepEqual(
      summary.tools.map((t) => t.toolName),
      ["codex:webSearch", "codex:mcpToolCall"],
    );
    const toolUseBlocks = h.events.filter(
      (e): e is Extract<EngineEvent, { kind: "block" }> =>
        e.kind === "block" && (e.block as { kind: string }).kind === "tool_use",
    );
    assert.deepEqual(
      toolUseBlocks.map((e) => (e.block as { toolName?: string }).toolName),
      ["codex:webSearch", "codex:mcpToolCall"],
    );
  });

  test("structured item failures survive runner → parser with exact reasons", async () => {
    const h = makeHarness();
    const turn = beginTurn(h);
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    const tid = { threadId: "thr-new-1", turnId: "turn-1" };
    p.notify("item/started", {
      ...tid,
      item: { id: "mc-failed", type: "mcpToolCall", server: "example", tool: "lookup" },
    });
    p.notify("item/completed", {
      ...tid,
      item: {
        id: "mc-failed",
        type: "mcpToolCall",
        status: "failed",
        error: { message: "remote rejected request" },
      },
    });
    p.notify("item/started", {
      ...tid,
      item: { id: "web-cancelled", type: "webSearch", query: "cancel me" },
    });
    p.notify("item/completed", {
      ...tid,
      item: { id: "web-cancelled", type: "webSearch", status: "cancelled" },
    });
    p.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await turn.summary;

    const results = h.events
      .filter(
        (event): event is Extract<EngineEvent, { kind: "tool_result_detected" }> =>
          event.kind === "tool_result_detected",
      )
      .map((event) => event.result);
    assert.deepEqual(
      results.map((result) => [
        result.toolName,
        result.isError,
        result.terminationReason,
      ]),
      [
        ["codex:mcpToolCall", true, "tool_error"],
        ["codex:webSearch", true, "cancelled"],
      ],
    );
  });

  test("imageGeneration savedPath → 落盘 public dir + 附件口径 text 块 + tool_result", async () => {
    const srcDir = await mkdtemp(join(tmpdir(), "codex-adapter-img-"));
    try {
      const saved = join(srcDir, "ig_beef.png");
      await writeFile(saved, Buffer.from("89504e470d0a1a0a", "hex"));
      const h = makeHarness();
      const turn = beginTurn(h);
      await waitForRequest(h, "turn/start");
      const p = h.proc();
      const tid = { threadId: "thr-new-1", turnId: "turn-1" };
      p.notify("item/started", { ...tid, item: { id: "ig1", type: "imageGeneration", status: "in_progress" } });
      p.notify("item/completed", { ...tid, item: { id: "ig1", type: "imageGeneration", savedPath: saved } });
      p.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      const summary = await turn.summary;
      assert.ok(summary);
      const expectedPublic = join(paths.generatedDir, "codex-thr-new-1-ig_beef.png");
      assert.ok(existsSync(expectedPublic), "image must be copied into public generated dir");
      // 附件识别口径:绝对路径独行出现在 assistantText(前端 media 识别契约)
      assert.ok(summary.assistantText.includes(`\n${expectedPublic}\n`), summary.assistantText);
      const trBlock = h.events.find(
        (e) => e.kind === "block" && (e.block as { kind: string }).kind === "tool_result",
      );
      assert.ok(trBlock, "imageGeneration 卡需要 tool_result 收尾");
      await rm(expectedPublic, { force: true });
    } finally {
      await rm(srcDir, { recursive: true, force: true });
    }
  });
});

describe("CodexAdapter — interrupt / approval / 崩溃", () => {
  test("interrupt:活跃 turn → turn/interrupt 请求;interrupted 终态仍带 usage billing", async () => {
    const h = makeHarness();
    const turn = beginTurn(h, { requestId: "req-int" });
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    const tid = { threadId: "thr-new-1", turnId: "turn-1" };
    p.notify("item/agentMessage/delta", { ...tid, itemId: "m1", delta: "partial before stop" });
    p.notify("thread/tokenUsage/updated", {
      ...tid,
      tokenUsage: {
        last: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 14 },
        total: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 14 },
      },
    });

    assert.equal(h.adapter.interrupt(), true);
    await waitForRequest(h, "turn/interrupt");
    const ir = h.proc().written.find((r) => r.method === "turn/interrupt")!;
    assert.deepEqual(ir.params, { threadId: "thr-new-1", turnId: "turn-1" });

    p.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted", durationMs: 7 } });
    const summary = await turn.summary;
    assert.ok(summary);
    assert.equal(summary.isError, true);
    // 中断计费部分工作量(codex 已扣的 token 要上报)
    assert.equal(h.billing.length, 1);
    assert.equal(h.billing[0].status, "error");
    assert.equal(h.billing[0].terminalCode, "USER_CANCELLED");
    assert.equal(h.billing[0].usage?.output_tokens, 4);
    assert.equal(Object.prototype.hasOwnProperty.call(h.billing[0], "errorReason"), false);
  });

  test("无活跃 turn / 无进程 → interrupt() = false", () => {
    const h = makeHarness();
    assert.equal(h.adapter.interrupt(), false);
  });

  test("approval 反向请求 → 受控 auto-approve;未知 server method → -32601 fail-fast", async () => {
    const h = makeHarness();
    const turn = beginTurn(h);
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    const before = p.written.length;
    p.reply({ jsonrpc: "2.0", id: "srv-1", method: "item/commandExecution/requestApproval", params: {} });
    p.reply({ jsonrpc: "2.0", id: "srv-2", method: "execCommandApproval", params: {} });
    p.reply({ jsonrpc: "2.0", id: "srv-3", method: "totally/unknown", params: {} });
    await waitFor(() => p.written.length >= before + 3);
    const responses = p.written.slice(before) as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(responses[0], { jsonrpc: "2.0", id: "srv-1", result: { decision: "acceptForSession" } });
    assert.deepEqual(responses[1], { jsonrpc: "2.0", id: "srv-2", result: { decision: "approved_for_session" } });
    assert.equal((responses[2].error as { code: number }).code, -32601);
    // 浏览器 permission 卡不参与 codex 审批(容器即沙箱)
    assert.equal(h.adapter.sendPermissionResponse("whatever", {}), false);
    assert.equal(h.events.some((e) => e.kind === "permission_request"), false);
    p.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await turn.summary;
  });

  test("app-server 崩溃:partial snapshot 保留 + 'exit' crashed + summary isError", async () => {
    const h = makeHarness();
    const turn = beginTurn(h, { requestId: "req-crash" });
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    const tid = { threadId: "thr-new-1", turnId: "turn-1" };
    p.notify("item/reasoning/textDelta", { ...tid, itemId: "r1", delta: "half thought" });
    p.notify("item/agentMessage/delta", { ...tid, itemId: "m1", delta: "partial ans" });
    p.notify("item/started", { ...tid, item: { id: "c9", type: "commandExecution", command: "sleep 999" } });
    p.notify("item/completed", { ...tid, item: { id: "c9", type: "commandExecution", aggregatedOutput: "done-before-crash", exitCode: 0 } });

    // 崩溃前:turn-scoped partial snapshot(crash-flush 数据源)
    const snap = turn.getPartialSnapshot();
    assert.equal(snap.assistantText, "partial ans");
    assert.equal(snap.thinkingText, "half thought");
    assert.equal(snap.completedTools.length, 1);
    assert.equal(snap.completedTools[0].output, "done-before-crash");
    assert.equal(h.adapter.pendingToolCalls, 0);

    p.emit("close", 137, null);
    await waitFor(() => h.exits.length > 0);
    assert.deepEqual(h.exits[0], { code: 137, signal: null, crashed: true });

    // 内核 catch 路径 → 错误终态 summary(partial 文本仍在)+ billing error(无 usage)
    const summary = await turn.summary;
    assert.ok(summary);
    assert.equal(summary.isError, true);
    assert.ok(summary.assistantText.startsWith("partial ans"));
    assert.equal(h.billing.length, 1);
    assert.equal(h.billing[0].status, "error");
    assert.equal(h.billing[0].usage, undefined);
  });

  test("errorKind='auth':codex 401/token 失效错误形状 → auth 分类", async () => {
    const h = makeHarness();
    const turn = beginTurn(h);
    await waitForRequest(h, "turn/start");
    h.proc().notify("turn/completed", {
      turn: { id: "turn-1", status: "failed", error: { message: "HTTP 401 Unauthorized: token is expired" } },
    });
    const summary = await turn.summary;
    assert.ok(summary);
    assert.equal(summary.isError, true);
    assert.equal(summary.errorKind, "auth");
  });

  test("errorKind='other':非 auth 失败", async () => {
    const h = makeHarness();
    const turn = beginTurn(h);
    await waitForRequest(h, "turn/start");
    h.proc().notify("turn/completed", {
      turn: { id: "turn-1", status: "failed", error: { message: "context window exceeded" } },
    });
    const summary = await turn.summary;
    assert.equal(summary?.errorKind, "other");
  });
});

describe("CodexAdapter — billing 侧信道边界", () => {
  test("requestId 缺省 → 不 emit billing(信任 master 只在 codex 路径下发)", async () => {
    const h = makeHarness();
    const turn = beginTurn(h); // no requestId
    await waitForRequest(h, "turn/start");
    h.proc().notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await turn.summary;
    assert.equal(h.billing.length, 0);
  });

  test("rateLimits 快照 piggy-back 到 billing 帧(NaN 拒收)", async () => {
    const h = makeHarness();
    const turnKey = "ab".repeat(32);
    const turn = beginTurn(h, { requestId: "req-rl", turnKey });
    await waitForRequest(h, "turn/start");
    const p = h.proc();
    p.notify("account/rateLimits/updated", {
      rateLimits: {
        primary: { usedPercent: 37, resetsAt: 1_800_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 12, windowDurationMins: 10080 },
      },
    });
    p.notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await turn.summary;
    assert.equal(h.billing.length, 1);
    assert.equal(h.billing[0].rateLimits?.util5h, 37);
    assert.equal(h.billing[0].rateLimits?.util7d, 12);
    assert.ok(h.billing[0].rateLimits?.reset5h?.startsWith("2027-"));
    assert.equal(h.billing[0].turnKey, turnKey);
  });

  test("buildCodexBillingEvent 纯函数:usage typeof 防御 + stable terminalCode", () => {
    const ev = buildCodexBillingEvent(
      {
        type: "result",
        is_error: true,
        result: "codex turn failed",
        duration_ms: 5,
        usage: { input_tokens: 3, output_tokens: "oops", reasoning_output_tokens: 2 },
        rateLimits: { util5h: Number.NaN, reset5h: "2026-01-01T00:00:00Z" },
      },
      "req-x",
      "oceng-abc",
      "cd".repeat(32),
      {
        mode: "delegate",
        parentTurnKey: "ef".repeat(32),
        parentSessionId: "web-parent-1",
        delegateAgentId: "researcher",
      },
    );
    assert.equal(ev.status, "error");
    assert.equal(ev.terminalCode, "CODEX_ERROR");
    assert.equal(Object.prototype.hasOwnProperty.call(ev, "errorReason"), false);
    assert.deepEqual(ev.usage, { input_tokens: 3, reasoning_output_tokens: 2 });
    assert.deepEqual(ev.rateLimits, { reset5h: "2026-01-01T00:00:00Z" }, "NaN util 必须拒收");
    assert.equal(ev.engineSessionId, "oceng-abc");
    assert.equal(ev.turnKey, "cd".repeat(32));
    assert.equal(ev.parentTurnKey, "ef".repeat(32));
    assert.equal(ev.parentSessionId, "web-parent-1");
    assert.equal(ev.delegateAgentId, "researcher");
  });

  test("classifyCodexErrorKind:lastErrorText(catch 路径无 delta)也参与分类", () => {
    assert.equal(
      classifyCodexErrorKind({ isError: true, assistantText: "" }, "codex app-server: thread/resume -> 401: unauthorized"),
      "auth",
    );
    assert.equal(classifyCodexErrorKind({ isError: true, assistantText: "" }, "boom"), "other");
    assert.equal(classifyCodexErrorKind({ isError: false, assistantText: "" }, null), undefined);
  });
});
