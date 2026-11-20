import { SWARM_BOARD_TOOL_NAME, reduceLiveFrames, type SwarmSnapshot } from "@openclaude/protocol/browser";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSwarmBoard } from "../../hooks/useSwarmUi";
import { liveUnitToMessage, restoreLiveUnitStreamingState } from "../../lib/chat/liveUnitsHydrate";
import { createSession, type ChatMessage } from "../../lib/chat/model";
import { applyOutboundMessage } from "../../lib/chat/reducer";
import { isInteractiveToolMessage } from "./ProcessDisclosure";
import { PinnedSwarmDock } from "./PinnedSwarmDock";
import { SwarmBoardDrawer } from "./SwarmBoardDrawer";
import { SwarmInlineCard } from "./SwarmInlineCard";
import { isAntigravityModelForUi } from "./swarmDetect";
import { extractSwarmSnapshotFromMessage, latestSwarmSnapshot } from "./swarmUtils";

function makeSnapshot(overrides: Partial<SwarmSnapshot> = {}): SwarmSnapshot {
  return {
    swarmId: "11111111-1111-4111-8111-111111111111",
    title: "解析器并行重构",
    phase: "running",
    revision: 2,
    updatedAt: 1_760_000_000_000,
    startedAt: 1_760_000_000_000 - 45_000,
    members: [
      {
        name: "coordinator",
        role: "coordinator",
        status: "waiting",
        model: "gemini-4-neon-high",
        stepCount: 4,
        activity: "等待成员汇报",
        unreadCount: 0,
      },
      {
        name: "parser",
        role: "worker",
        status: "working",
        model: "gemini-4-neon-high",
        channels: ["parser"],
        stepCount: 7,
        activity: "编辑 parser.ts",
        unreadCount: 1,
        lastPostSeq: 2,
      },
      {
        name: "verifier",
        role: "verifier",
        status: "waiting",
        model: "gemini-4-neon-high",
        channels: ["parser"],
        stepCount: 3,
        activity: "等待 @提及",
        unreadCount: 0,
      },
    ],
    channels: [
      { name: "main", memberCount: 3, postCount: 1 },
      { name: "parser", topic: "词法与语法", memberCount: 2, postCount: 2 },
    ],
    posts: [
      {
        seq: 1,
        agent: "coordinator",
        channel: "main",
        text: "@all 启动解析器重构任务",
        mentions: ["all"],
      },
      {
        seq: 2,
        agent: "parser",
        channel: "parser",
        text: "@verifier 已完成 #1 核心解析改动，请检查边界单测",
        mentions: ["verifier"],
      },
      {
        seq: 3,
        agent: "verifier",
        channel: "parser",
        text: "@coordinator 校验通过，所有单测全绿",
        mentions: ["coordinator"],
      },
    ],
    totalPosts: 3,
    ...overrides,
  };
}

describe("Antigravity native swarm reducer & UI (OCV5-809)", () => {
  it("applies live swarm_snapshot frames with monotonic revision guard and settles on final", () => {
    const sess = createSession({ id: "s-swarm", agentId: "main" });
    sess._sendingInFlight = true;

    const rev2 = makeSnapshot({ revision: 2 });
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-swarm", kind: "dm" },
      frameSeq: 1,
      isFinal: false,
      blocks: [{ kind: "swarm_snapshot", blockId: "agy-swarm-11111111-t0", snapshot: rev2 }],
    });

    const latest1 = latestSwarmSnapshot(sess.messages);
    expect(latest1?.revision).toBe(2);
    expect(latest1?.title).toBe("解析器并行重构");
    const toolRow = sess.messages.find((m) => m.toolName === SWARM_BOARD_TOOL_NAME);
    expect(toolRow).toBeTruthy();
    expect(isInteractiveToolMessage(toolRow!)).toBe(true);

    // Out-of-order stale revision (rev 1) must be ignored.
    const staleRev1 = makeSnapshot({ revision: 1, title: "旧标题" });
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-swarm", kind: "dm" },
      frameSeq: 2,
      isFinal: false,
      blocks: [{ kind: "swarm_snapshot", blockId: "agy-swarm-11111111-t0", snapshot: staleRev1 }],
    });
    expect(latestSwarmSnapshot(sess.messages)?.revision).toBe(2);
    expect(latestSwarmSnapshot(sess.messages)?.title).toBe("解析器并行重构");

    // Final turn frame auto-settles an open running swarm to completed.
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-swarm", kind: "dm" },
      frameSeq: 3,
      isFinal: true,
      blocks: [],
    });
    const settled = latestSwarmSnapshot(sess.messages);
    expect(settled?.phase).toBe("completed");
    expect(settled?.members.every((m) => m.status !== "working")).toBe(true);
  });

  it("BLOCKER 6: late/replayed swarm_snapshot never overwrites frozen authoritative tape history", () => {
    const sess = createSession({ id: "s-tape", agentId: "main" });
    const settledRev7 = makeSnapshot({ phase: "completed", revision: 7, title: "历史已收口蜂群" });
    const frozenRow: ChatMessage = {
      id: "tape-row-1",
      role: "tool",
      text: SWARM_BOARD_TOOL_NAME,
      ts: Date.now() - 10_000,
      blockId: "agy-swarm-11111111-t0",
      toolName: SWARM_BOARD_TOOL_NAME,
      _source: "server",
      _timelineRecord: true,
      _turnTapeComplete: true,
      _completed: true,
      inputJson: {
        swarmId: settledRev7.swarmId,
        title: settledRev7.title,
        phase: settledRev7.phase,
        snapshot: settledRev7,
      },
      output: "蜂群「历史已收口蜂群」",
    };
    sess.messages.push(frozenRow);

    // Late running/rev2 frame for the SAME blockId must be ignored (no mutation, no duplicate row).
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-tape", kind: "dm" },
      frameSeq: 10,
      isFinal: false,
      blocks: [
        {
          kind: "swarm_snapshot",
          blockId: "agy-swarm-11111111-t0",
          snapshot: makeSnapshot({ phase: "running", revision: 2, title: "迟到旧帧" }),
        },
      ],
    });

    expect(sess.messages).toHaveLength(1);
    expect(frozenRow._completed).toBe(true);
    expect(extractSwarmSnapshotFromMessage(frozenRow)?.phase).toBe("completed");
    expect(extractSwarmSnapshotFromMessage(frozenRow)?.revision).toBe(7);

    // A brand-new turn with a NEW blockId sharing the same swarmId creates its own mutable row
    // without touching the frozen historical row.
    sess._sendingInFlight = true;
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-tape", kind: "dm" },
      frameSeq: 11,
      isFinal: false,
      blocks: [
        {
          kind: "swarm_snapshot",
          blockId: "agy-swarm-11111111-t1",
          snapshot: makeSnapshot({ phase: "running", revision: 1, title: "新一轮蜂群" }),
        },
      ],
    });
    expect(sess.messages).toHaveLength(2);
    expect(extractSwarmSnapshotFromMessage(sess.messages[0])?.title).toBe("历史已收口蜂群");
    expect(extractSwarmSnapshotFromMessage(sess.messages[1])?.title).toBe("新一轮蜂群");
  });

  it("BLOCKER 5: useSwarmBoard reacts to in-place wsMessages mutations via messagesVersion and tracks card identity", () => {
    const sess = createSession({ id: "s-live", agentId: "main" });
    sess._sendingInFlight = true;

    const { result, rerender } = renderHook(
      ({ version }) =>
        useSwarmBoard({
          sessionKey: "s-live",
          wsMessages: sess.messages,
          messagesVersion: version,
        }),
      { initialProps: { version: 1 } },
    );

    expect(result.current.latestSwarm).toBeNull();

    // Mutate sess.messages IN PLACE (exact useChatSocket behavior) and tick version.
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-live", kind: "dm" },
      frameSeq: 1,
      isFinal: false,
      blocks: [
        {
          kind: "swarm_snapshot",
          blockId: "agy-swarm-11111111-t0",
          snapshot: makeSnapshot({ revision: 1, title: "第一版标题" }),
        },
      ],
    });
    rerender({ version: 2 });
    expect(result.current.latestSwarm?.revision).toBe(1);
    expect(result.current.latestSwarm?.title).toBe("第一版标题");

    // Open drawer for this card, then mutate in place to rev 3 + terminal without reopening drawer.
    act(() => {
      result.current.openBoard({
        snapshot: result.current.latestSwarm!,
        cardId: result.current.latestCard!.messageId,
        blockId: result.current.latestCard!.blockId,
      });
    });
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "k1",
      channel: "webchat",
      peer: { id: "s-live", kind: "dm" },
      frameSeq: 2,
      isFinal: false,
      blocks: [
        {
          kind: "swarm_snapshot",
          blockId: "agy-swarm-11111111-t0",
          snapshot: makeSnapshot({ revision: 3, title: "实时更新标题", phase: "completed" }),
        },
      ],
    });
    rerender({ version: 3 });
    expect(result.current.activeDrawerSwarm?.revision).toBe(3);
    expect(result.current.activeDrawerSwarm?.title).toBe("实时更新标题");
    expect(result.current.activeDrawerSwarm?.phase).toBe("completed");
  });

  it("BLOCKER 3: isAntigravityModelForUi excludes remote_pool and -remote Antigravity routes", () => {
    const models = [
      { id: "antigravity-gemini-4-neon-high", engine: "antigravity", placement: "local" },
      { id: "antigravity-gemini-4-carbon-remote", engine: "antigravity", placement: "remote_pool" },
      { id: "custom-agy-remote-alias", engine: "antigravity", placement: "remote_pool" },
      { id: "gpt-6.2-astra", engine: "codex", placement: "local" },
    ];
    expect(isAntigravityModelForUi("antigravity-gemini-4-neon-high", models)).toBe(true);
    expect(isAntigravityModelForUi("antigravity-gemini-4-carbon-remote", models)).toBe(false);
    expect(isAntigravityModelForUi("custom-agy-remote-alias", models)).toBe(false);
    expect(isAntigravityModelForUi("antigravity-foo-remote", [])).toBe(false);
    expect(isAntigravityModelForUi("gpt-6.2-astra", models)).toBe(false);
  });

  it("recovers full SwarmSnapshot from a persisted server-authored SwarmBoard tool row after refresh", () => {
    const snap = makeSnapshot({ phase: "completed", revision: 8 });
    const persistedRow: ChatMessage = {
      id: "srv-s1-main-t0-tool-agy-swarm-11111111-t0",
      role: "tool",
      text: SWARM_BOARD_TOOL_NAME,
      ts: Date.now(),
      toolName: SWARM_BOARD_TOOL_NAME,
      _source: "server",
      _completed: true,
      inputJson: { swarmId: snap.swarmId, title: snap.title, phase: snap.phase, snapshot: snap },
      output: "蜂群「解析器并行重构」· 3 成员协作中 · 3 条讨论",
    };
    const extracted = extractSwarmSnapshotFromMessage(persistedRow);
    expect(extracted?.swarmId).toBe(snap.swarmId);
    expect(extracted?.posts).toHaveLength(3);
  });

  it("renders SwarmInlineCard & PinnedSwarmDock and forwards member focus clicks with card identity", () => {
    const snap = makeSnapshot();
    const onOpenBoard = vi.fn();
    render(
      <div>
        <SwarmInlineCard snapshot={snap} cardId="m-1" blockId="b-1" onOpenBoard={onOpenBoard} />
        <PinnedSwarmDock snapshot={snap} cardId="m-1" blockId="b-1" dismissed={false} onOpenBoard={onOpenBoard} onDismiss={vi.fn()} />
      </div>,
    );

    expect(screen.getByTestId("swarm-inline-card")).toBeTruthy();
    expect(screen.getByTestId("pinned-swarm-dock")).toBeTruthy();
    expect(screen.getByText("编辑 parser.ts")).toBeTruthy();

    fireEvent.click(screen.getByTestId("swarm-open-board-btn"));
    expect(onOpenBoard).toHaveBeenCalledWith({ snapshot: snap, cardId: "m-1", blockId: "b-1" });

    const grid = screen.getByTestId("swarm-member-grid");
    fireEvent.click(within(grid).getByText("@parser"));
    expect(onOpenBoard).toHaveBeenLastCalledWith({ snapshot: snap, cardId: "m-1", blockId: "b-1", focusMember: "parser" });
  });

  it("filters SwarmBoardDrawer feed by channel, member, and search query", () => {
    const snap = makeSnapshot();
    render(
      <SwarmBoardDrawer
        open
        onOpenChange={vi.fn()}
        snapshot={snap}
      />,
    );

    const drawer = screen.getByTestId("swarm-board-drawer");
    expect(within(drawer).getByText("解析器并行重构")).toBeTruthy();
    expect(within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]")).toHaveLength(3);

    // Filter to channel #parser (2 posts)
    fireEvent.click(within(drawer).getByTitle("词法与语法"));
    expect(within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]")).toHaveLength(2);

    // Search narrows down to #3
    fireEvent.change(within(drawer).getByLabelText("搜索蜂群讨论"), { target: { value: "全绿" } });
    const rows = within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-swarm-post-seq")).toBe("3");
  });

  it("OCV5-819: merges delta swarm_snapshot posts onto hydrated LiveUnit SwarmBoard card in place", () => {
    const fullRev1 = makeSnapshot({
      revision: 1,
      postsMode: "full",
      posts: [
        { seq: 1, agent: "coordinator", channel: "main", text: "初始拆解", mentions: [] },
      ],
      totalPosts: 1,
    });
    const reduced = reduceLiveFrames([
      {
        recordId: "r-1",
        streamKey: "dispatch:d1:1",
        clientMessageId: "cm-1",
        payload: {
          type: "outbound.message",
          frameSeq: 1,
          sessionKey: "agent:main:webchat:dm:s-delta",
          blocks: [{ kind: "swarm_snapshot", blockId: "agy-swarm-11111111-t0", snapshot: fullRev1 }],
        },
      },
    ]);
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;

    const sess = createSession({ id: "s-delta", agentId: "main" });
    sess.messages = reduced.state.units.map((u) => liveUnitToMessage(u));
    restoreLiveUnitStreamingState(sess, reduced.state.units);

    // Next WS frame arrives as lightweight delta carrying only post #2
    const deltaRev2 = makeSnapshot({
      revision: 2,
      postsMode: "delta",
      deltaBaseSeq: 1,
      posts: [
        { seq: 2, agent: "parser", channel: "parser", text: "增量新进展", mentions: ["coordinator"] },
      ],
      totalPosts: 2,
    });
    applyOutboundMessage(sess, {
      type: "outbound.message",
      sessionKey: "agent:main:webchat:dm:s-delta",
      channel: "webchat",
      peer: { id: "s-delta", kind: "dm" },
      frameSeq: 2,
      isFinal: false,
      blocks: [{ kind: "swarm_snapshot", blockId: "agy-swarm-11111111-t0", snapshot: deltaRev2 }],
    });

    const swarmCards = sess.messages.filter((m) => m.role === "tool" && m.toolName === SWARM_BOARD_TOOL_NAME);
    expect(swarmCards).toHaveLength(1);
    const snap = extractSwarmSnapshotFromMessage(swarmCards[0]);
    expect(snap?.revision).toBe(2);
    expect(snap?.posts.map((p) => p.seq)).toEqual([1, 2]);
  });

  it("OCV5-819: renders isolated worktree badges and merge-safety notice for workspace=share members", () => {
    const snap = makeSnapshot({
      members: [
        {
          name: "coordinator",
          role: "coordinator",
          status: "waiting",
          stepCount: 2,
          unreadCount: 0,
        },
        {
          name: "writer-a",
          role: "worker",
          status: "working",
          workspace: "share",
          stepCount: 5,
          activity: "编辑 api.ts",
          unreadCount: 0,
        },
      ],
    });
    render(
      <div>
        <SwarmInlineCard snapshot={snap} cardId="m-wt" blockId="b-wt" onOpenBoard={vi.fn()} />
        <SwarmBoardDrawer open onOpenChange={vi.fn()} snapshot={snap} />
      </div>,
    );
    expect(screen.getByText("1 独立 worktree")).toBeTruthy();
    expect(screen.getByTestId("swarm-worktree-notice")).toBeTruthy();
    expect(screen.getAllByText("worktree").length).toBeGreaterThanOrEqual(2);
  });
});
