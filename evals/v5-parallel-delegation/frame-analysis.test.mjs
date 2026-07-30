import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeFrames } from "./frame-analysis.mjs";

const peer = "eval-peer";
const frame = (at, blocks) => ({
  at,
  direction: "received",
  payload: { type: "outbound.message", peer: { id: peer, kind: "dm" }, blocks },
});

describe("v5 parallel delegation frame evidence", () => {
  it("reads canonical inputJson, successful result, and overlapping delegate progress", () => {
    const frames = [
      frame(1, [{
        kind: "tool_use",
        blockId: "batch-1",
        toolName: "mcp__openclaude_memory__delegate_tasks",
        inputJson: { tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }] },
        partial: false,
      }]),
      frame(2, [{ kind: "delegate_progress", runId: "a", agentId: "one", phase: "start" }]),
      frame(3, [{ kind: "delegate_progress", runId: "b", agentId: "two", phase: "start" }]),
      frame(4, [{ kind: "delegate_progress", runId: "a", agentId: "one", phase: "done" }]),
      frame(5, [{ kind: "delegate_progress", runId: "b", agentId: "two", phase: "done" }]),
      frame(6, [{
        kind: "tool_result",
        blockId: "batch-1:result",
        toolUseBlockId: "batch-1",
        toolName: "mcp__openclaude_memory__delegate_tasks",
        isError: false,
      }]),
    ];
    const result = analyzeFrames(frames, peer);
    assert.deepEqual(result.behavior, {
      delegate_tasks_calls: 1,
      delegate_task_calls: 0,
      delegate_tasks_errors: 0,
      max_shards: 3,
      max_concurrent_delegates: 2,
      delegate_runs_started: 2,
      delegate_runs_queued: 0,
      delegate_runs_completed: 2,
      delegate_runs_errors: 0,
      delegate_runs_incomplete: 0,
      nested_delegate_calls: 0,
      background_bash_fanout: 0,
      native_agent_calls: 0,
    });
  });

  it("detects nested delegation and inputJson Bash fan-out but ignores another peer", () => {
    const frames = [
      frame(1, [{
        kind: "delegate_progress",
        runId: "child",
        agentId: "one",
        phase: "tool",
        block: {
          kind: "tool_use",
          blockId: "nested",
          toolName: "delegate_tasks",
          inputJson: { tasks: [{ goal: "a" }, { goal: "b" }] },
          partial: false,
        },
      }]),
      frame(2, [{
        kind: "tool_use",
        blockId: "bash",
        toolName: "Bash",
        inputJson: { command: "work-a & work-b & wait" },
        partial: false,
      }]),
      {
        at: 3,
        direction: "received",
        payload: {
          type: "outbound.message",
          peer: { id: "other", kind: "dm" },
          blocks: [{
            kind: "tool_use",
            blockId: "foreign",
            toolName: "spawn_agent",
            inputJson: {},
            partial: false,
          }],
        },
      },
    ];
    const result = analyzeFrames(frames, peer);
    assert.equal(result.behavior.nested_delegate_calls, 1);
    assert.equal(result.behavior.background_bash_fanout, 1);
    assert.equal(result.behavior.native_agent_calls, 0);
  });

  it("does not confuse shell && with background Bash fan-out", () => {
    const frames = [
      frame(1, [{
        kind: "tool_use",
        blockId: "bash",
        toolName: "Bash",
        inputJson: {
          command: "node -e \"if (value && other) console.log(value)\" && echo verified",
        },
        partial: false,
      }]),
    ];
    assert.equal(analyzeFrames(frames, peer).behavior.background_bash_fanout, 0);
  });

  it("unwraps Codex mcpToolCall arguments and rejects Codex native multi-agent", () => {
    const frames = [
      frame(1, [{
        kind: "tool_use",
        blockId: "codex-batch",
        toolName: "codex:mcpToolCall",
        inputJson: {
          server: "openclaude_memory",
          tool: "delegate_tasks",
          arguments: JSON.stringify({ tasks: [{ goal: "a" }, { goal: "b" }] }),
        },
        partial: false,
      }]),
      frame(2, [{
        kind: "tool_result",
        blockId: "codex-batch:result",
        toolUseBlockId: "codex-batch",
        isError: false,
      }]),
      frame(3, [{
        kind: "tool_use",
        blockId: "native",
        toolName: "Codex:multiAgent",
        inputJson: {},
        partial: false,
      }]),
    ];
    const result = analyzeFrames(frames, peer);
    assert.equal(result.behavior.delegate_tasks_calls, 1);
    assert.equal(result.behavior.max_shards, 2);
    assert.equal(result.behavior.delegate_tasks_errors, 0);
    assert.equal(result.behavior.native_agent_calls, 1);
  });

  it("unwraps CCB deferred ExecuteExtraTool delegate_tasks input", () => {
    const frames = [
      frame(1, [{
        kind: "tool_use",
        blockId: "ccb-batch",
        toolName: "ExecuteExtraTool",
        inputJson: {
          tool_name: "mcp__openclaude-memory__delegate_tasks",
          params: { tasks: [{ goal: "a" }, { goal: "b" }] },
        },
        partial: false,
      }]),
      frame(2, [{
        kind: "tool_result",
        blockId: "ccb-batch:result",
        toolUseBlockId: "ccb-batch",
        toolName: "ExecuteExtraTool",
        isError: false,
      }]),
    ];
    const result = analyzeFrames(frames, peer);
    assert.equal(result.behavior.delegate_tasks_calls, 1);
    assert.equal(result.behavior.max_shards, 2);
    assert.equal(result.behavior.delegate_tasks_errors, 0);
    assert.equal(result.retries, 0);
  });

  it("counts a malformed root ExecuteExtraTool as an abnormal retry", () => {
    const frames = [
      frame(1, [{
        kind: "tool_use",
        blockId: "ccb-malformed",
        toolName: "ExecuteExtraTool",
        inputJson: {},
        partial: false,
      }]),
      frame(2, [{
        kind: "tool_result",
        blockId: "ccb-malformed:result",
        toolUseBlockId: "ccb-malformed",
        toolName: "ExecuteExtraTool",
        isError: true,
      }]),
    ];
    const result = analyzeFrames(frames, peer);
    assert.equal(result.behavior.delegate_tasks_calls, 0);
    assert.equal(result.behavior.delegate_tasks_errors, 0);
    assert.equal(result.retries, 1);
  });

  it("sums root tokens with one terminal snapshot per child usageRunId", () => {
    const frames = [
      {
        at: 1,
        direction: "received",
        payload: {
          type: "outbound.turn_usage",
          peer: { id: peer, kind: "dm" },
          usage: { totalTokens: 100 },
        },
      },
      frame(2, [{
        kind: "delegate_progress",
        runId: "visible-a",
        usageRunId: "child-a",
        agentId: "one",
        phase: "usage",
        usage: { totalTokens: 40 },
      }]),
      frame(3, [{
        kind: "delegate_progress",
        runId: "visible-a",
        usageRunId: "child-a",
        agentId: "one",
        phase: "usage",
        usage: { totalTokens: 55 },
      }]),
      frame(4, [{
        kind: "delegate_progress",
        runId: "visible-b",
        usageRunId: "child-b",
        agentId: "two",
        phase: "usage",
        usage: { totalTokens: 35 },
      }]),
    ];
    const result = analyzeFrames(frames, peer);
    assert.equal(result.rootTokens, 100);
    assert.deepEqual(result.childTokens, { "child-a": 55, "child-b": 35 });
    assert.equal(result.tokens, 190);
  });

  it("reconstructs the exact canonical answer from streamed text blocks", () => {
    const frames = [
      frame(1, [{ kind: "text", text: "{\"answer\":" }]),
      frame(2, [{ kind: "text", text: "703}" }]),
    ];
    assert.equal(analyzeFrames(frames, peer).answerText, '{"answer":703}');
  });

  it("does not count a queued start as active delegate concurrency", () => {
    const frames = [
      frame(1, [{ kind: "delegate_progress", runId: "a", phase: "start", text: "资源紧张，排队中" }]),
      frame(2, [{ kind: "delegate_progress", runId: "b", phase: "start", text: "开始委派给 B" }]),
      frame(3, [{ kind: "delegate_progress", runId: "b", phase: "done" }]),
      frame(4, [{ kind: "delegate_progress", runId: "a", phase: "start", text: "开始委派给 A" }]),
      frame(5, [{ kind: "delegate_progress", runId: "a", phase: "done" }]),
    ];
    const result = analyzeFrames(frames, peer);
    assert.equal(result.behavior.delegate_runs_queued, 1);
    assert.equal(result.behavior.delegate_runs_started, 2);
    assert.equal(result.behavior.max_concurrent_delegates, 1);
  });
});
