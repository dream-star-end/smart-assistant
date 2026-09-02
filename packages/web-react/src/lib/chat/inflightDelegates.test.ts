import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../authSession";
import type { ChatMessage } from "./model";
import {
  fetchInflightDelegates,
  isTerminalDelegateState,
  mergeInflightWithTimeline,
  normalizeInflightDelegateItem,
  type InflightDelegateItem,
} from "./inflightDelegates";

afterEach(() => {
  vi.unstubAllGlobals();
});

function item(over: Partial<InflightDelegateItem> = {}): InflightDelegateItem {
  return {
    jobId: "dlgjob-1",
    runId: "dlg-1",
    agentId: "coding-assistant",
    goal: "修 inflight HUD",
    state: "running",
    liveHint: "Read src.ts",
    updatedAt: 1000,
    parentSessionKey: "agent:main:webchat:dm:web-1",
    ...over,
  };
}

function group(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-g1",
    role: "agent-group",
    text: "修 inflight HUD",
    ts: 2000,
    _delegateRunId: "dlg-1",
    _delegateJobId: "dlgjob-1",
    ...over,
  } as ChatMessage;
}

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe("isTerminalDelegateState", () => {
  test("终态 completed/failed/cancelled/killed_by_cutover", () => {
    expect(isTerminalDelegateState("completed")).toBe(true);
    expect(isTerminalDelegateState("failed")).toBe(true);
    expect(isTerminalDelegateState("cancelled")).toBe(true);
    expect(isTerminalDelegateState("killed_by_cutover")).toBe(true);
  });

  test("非终态 queued/running/paused_for_cutover", () => {
    expect(isTerminalDelegateState("queued")).toBe(false);
    expect(isTerminalDelegateState("running")).toBe(false);
    expect(isTerminalDelegateState("paused_for_cutover")).toBe(false);
  });
});

describe("normalizeInflightDelegateItem", () => {
  test("从 protocol surface 取出 HUD 字段，resultSummary 来自 foldedGroup", () => {
    const got = normalizeInflightDelegateItem({
      jobId: "dlgjob-abc",
      runId: "dlg-abc",
      agentId: "coding-assistant",
      goal: "do it",
      state: "completed",
      liveHint: "",
      updatedAt: 42,
      parentSessionKey: "agent:main:webchat:dm:web-1",
      foldedGroup: {
        runId: "dlg-abc",
        agentId: "coding-assistant",
        goal: "do it",
        status: "ok",
        completedAt: 42,
        resultSummary: "已修好",
      },
    });
    expect(got).toMatchObject({
      jobId: "dlgjob-abc",
      runId: "dlg-abc",
      state: "completed",
      resultSummary: "已修好",
    });
  });

  test("缺 jobId / 非法 state → null", () => {
    expect(
      normalizeInflightDelegateItem({ runId: "dlg-1", agentId: "a", goal: "", state: "running" }),
    ).toBeNull();
    expect(
      normalizeInflightDelegateItem({
        jobId: "j",
        runId: "r",
        agentId: "a",
        goal: "",
        state: "nope",
        updatedAt: 1,
      }),
    ).toBeNull();
  });
});

describe("mergeInflightWithTimeline", () => {
  test("HTTP running 且时间线没有对应组卡 → 仍显示 running", () => {
    const merged = mergeInflightWithTimeline([item()], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.state).toBe("running");
    expect(merged[0]?.liveHint).toBe("Read src.ts");
  });

  test("时间线组卡已终态 → 以时间线为准（即使 HTTP 仍 running）", () => {
    const merged = mergeInflightWithTimeline(
      [item({ state: "running" })],
      [
        group({
          _completed: true,
          _delegateStatus: "ok",
          _resultPreview: "done",
          completedAt: 9000,
        }),
      ],
    );
    expect(merged[0]?.state).toBe("completed");
    expect(merged[0]?.resultSummary).toBe("done");
    expect(merged[0]?.updatedAt).toBe(9000);
  });

  test("时间线失败终态覆盖 HTTP running", () => {
    const merged = mergeInflightWithTimeline(
      [item()],
      [group({ _completed: true, _isError: true, _delegateStatus: "failed" })],
    );
    expect(merged[0]?.state).toBe("failed");
  });

  test("时间线组卡未终态 → 保留 HTTP 快照（含 liveHint）", () => {
    const merged = mergeInflightWithTimeline(
      [item({ liveHint: "Grep HUD" })],
      [group({ _completed: false, text: "过程树" })],
    );
    expect(merged[0]?.state).toBe("running");
    expect(merged[0]?.liveHint).toBe("Grep HUD");
  });

  test("按 runId 对齐；jobId 作为缺 runId 绑定的兜底", () => {
    const merged = mergeInflightWithTimeline(
      [item({ runId: "other-run" })],
      [
        group({
          _delegateRunId: undefined,
          runId: undefined,
          _completed: true,
          _delegateStatus: "ok",
        }),
      ],
    );
    expect(merged[0]?.state).toBe("completed");
  });
});

describe("fetchInflightDelegates", () => {
  test("200 返回 items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes(200, {
          enabled: true,
          items: [item()],
          nextCursor: null,
          truncated: false,
        }),
      ),
    );
    const auth = createMemoryAuthSession(() => {}, "tok");
    const got = await fetchInflightDelegates("web-1", auth);
    expect(got).toHaveLength(1);
    expect(got?.[0]?.jobId).toBe("dlgjob-1");
  });

  test("404 / 非 200 / 网络错 → null", async () => {
    const auth = createMemoryAuthSession(() => {}, "tok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(404, { error: "not found" })),
    );
    expect(await fetchInflightDelegates("web-1", auth)).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(500, { error: "boom" })),
    );
    expect(await fetchInflightDelegates("web-1", auth)).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await fetchInflightDelegates("web-1", auth)).toBeNull();
  });
});
