import { describe, expect, test, vi } from "vitest";
import type { LiveUnit } from "@openclaude/protocol/browser";
import { fetchSwarmResyncUnits, liveUnitToMessage } from "./liveUnitsHydrate";

function toolUnit(overrides: Partial<LiveUnit> & { inputPreview?: string }): LiveUnit {
  return {
    id: "u1",
    kind: "tool",
    seqFirst: 1,
    seqLast: 1,
    recordIdFirst: "r1",
    recordIdLast: "r1",
    open: true,
    clientMessageId: "m-1",
    toolName: "Bash",
    ...overrides,
  } as LiveUnit;
}

describe("liveUnitToMessage tool 行", () => {
  test("text 留空，不把 toolName 写成正文", () => {
    const msg = liveUnitToMessage(
      toolUnit({
        text: '{"command":"oc-memory delegate --goal x"}',
        inputJson: { command: "oc-memory delegate --goal x" },
      }),
    );
    expect(msg.role).toBe("tool");
    expect(msg.toolName).toBe("Bash");
    expect(msg.text).toBe("");
    expect(msg.text).not.toBe("Bash");
  });

  test("从 fold 的 unit.text 补拷 inputPreview", () => {
    const preview = '{"command":"oc-memory delegate --goal x"}';
    const msg = liveUnitToMessage(
      toolUnit({
        text: preview,
        inputJson: { command: "oc-memory delegate --goal x" },
      }),
    );
    expect(msg.inputPreview).toBe(preview);
    expect(msg.inputJson).toEqual({ command: "oc-memory delegate --goal x" });
  });

  test("显式 inputPreview 优先于 fold text", () => {
    const msg = liveUnitToMessage(
      toolUnit({
        text: '{"command":"stale"}',
        inputPreview: '{"command":"ls -la"}',
        inputJson: { command: "ls -la" },
      }),
    );
    expect(msg.inputPreview).toBe('{"command":"ls -la"}');
    expect(msg.text).toBe("");
  });

  test("plan 行不把 engine blockId 写成 ChatMessage.blockId", () => {
    const msg = liveUnitToMessage({
      id: "plan:1:x",
      kind: "plan",
      seqFirst: 1,
      seqLast: 1,
      recordIdFirst: "r1",
      recordIdLast: "r1",
      open: false,
      clientMessageId: "m-1",
      text: "plan",
      blockId: "must-not-copy",
      timelineProcessKey: "plan-block",
    });
    expect(msg.role).toBe("plan");
    expect(msg.blockId).toBeUndefined();
    expect(msg._timelineProcessKey).toBe("plan-block");
  });

  test("streamGeneration 进入 epoch 与 _timelineStreamGen", () => {
    const msg = liveUnitToMessage(
      toolUnit({ seqLast: 1, clientMessageId: "m-1", timelineProcessKey: "b1" }),
      { streamGeneration: 2 },
    );
    expect(msg._timelineStreamGen).toBe(2);
    expect(typeof msg._lifecycleEpoch).toBe("number");
    expect(msg._lifecycle).toBe("live_open");
  });
});

describe("fetchSwarmResyncUnits (OCV5-867)", () => {
  const swarmSnap = {
    swarmId: "86700002-1111-1111-1111-111111111111",
    title: "测试蜂群",
    phase: "running" as const,
    startedAt: 1000,
    updatedAt: 2000,
    revision: 3,
    members: [{ name: "coordinator", role: "coordinator" as const, status: "working" as const }],
    channels: [{ name: "main", memberCount: 1, postCount: 1 }],
    posts: [{ seq: 1, agent: "coordinator", channel: "main", text: "hi", mentions: [] }],
    totalPosts: 1,
    postsMode: "full" as const,
  };
  const swarmUnit = (clientMessageId = "m-active"): LiveUnit => ({
    id: "tool:3:agy-swarm-86700002",
    kind: "tool",
    seqFirst: 1,
    seqLast: 3,
    recordIdFirst: "1",
    recordIdLast: "3",
    open: true,
    clientMessageId,
    blockId: "agy-swarm-86700002",
    toolName: "SwarmBoard",
    inputJson: { swarmId: swarmSnap.swarmId, title: swarmSnap.title, phase: "running", snapshot: swarmSnap },
  });
  const basePage = (overrides: Record<string, unknown> = {}) => ({
    view: "units" as const,
    units: [swarmUnit("m-active")],
    n: 1,
    hasMoreBefore: false,
    beforeCursor: null,
    streamClientMessageIds: ["m-active"],
    openDispatch: true,
    hasTapeProjection: false,
    tapeProjectionVersion: 0,
    reducerEpoch: "4",
    degraded: false as const,
    ...overrides,
  });

  test("接受匹配活跃轮的 openDispatch SwarmBoard unit", async () => {
    const readLiveUnits = vi.fn(async () => basePage());
    const res = await fetchSwarmResyncUnits(readLiveUnits, "s1", "m-active");
    expect(res).toHaveLength(1);
    expect(res[0]?.blockId).toBe("agy-swarm-86700002");
    expect(res[0]?.snapshot.revision).toBe(3);
  });

  test("拒绝 degraded=fallback、openDispatch=false、跨轮包和异常", async () => {
    expect(await fetchSwarmResyncUnits(async () => basePage({ degraded: "fallback" }), "s1", "m-active")).toEqual([]);
    expect(await fetchSwarmResyncUnits(async () => basePage({ openDispatch: false }), "s1", "m-active")).toEqual([]);
    expect(
      await fetchSwarmResyncUnits(
        async () => basePage({ streamClientMessageIds: ["m-other"], units: [swarmUnit("m-other")] }),
        "s1",
        "m-active",
      ),
    ).toEqual([]);
    expect(
      await fetchSwarmResyncUnits(async () => {
        throw new Error("network down");
      }, "s1", "m-active"),
    ).toEqual([]);
  });
});
