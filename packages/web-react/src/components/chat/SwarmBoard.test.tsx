import { SWARM_BOARD_TOOL_NAME, reduceLiveFrames, type SwarmSnapshot } from "@openclaude/protocol/browser";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(cleanup);

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

  it("OCV5-835: isAntigravityModelForUi supports both local and remote_pool Antigravity routes", () => {
    const models = [
      { id: "antigravity-gemini-4-neon-high", engine: "antigravity", placement: "local" },
      { id: "antigravity-gemini-4-carbon-remote", engine: "antigravity", placement: "remote_pool" },
      { id: "custom-agy-remote-alias", engine: "antigravity", placement: "remote_pool" },
      { id: "gpt-6.2-astra", engine: "codex", placement: "local" },
    ];
    expect(isAntigravityModelForUi("antigravity-gemini-4-neon-high", models)).toBe(true);
    expect(isAntigravityModelForUi("antigravity-gemini-4-carbon-remote", models)).toBe(true);
    expect(isAntigravityModelForUi("custom-agy-remote-alias", models)).toBe(true);
    expect(isAntigravityModelForUi("antigravity-foo-remote", [])).toBe(true);
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

  it("OCV5-819: renders isolated worktree badges on member rows without exposing worktree cleanup notice", () => {
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
    expect(screen.queryByTestId("swarm-worktree-notice")).toBeNull();
    expect(screen.getAllByText("worktree").length).toBeGreaterThanOrEqual(2);
  });

  it("OCV5-831 #1 & #4: PinnedSwarmDock hides completed swarms and enforces overflow-hidden truncation on long titles", () => {
    const completed = makeSnapshot({ phase: "completed" });
    const { container, rerender } = render(
      <PinnedSwarmDock
        snapshot={completed}
        cardId="m-done"
        blockId="b-done"
        dismissed={false}
        onOpenBoard={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();

    const longTitle = "Wave 1 并行交付：P0 止血 + PG/WS 性能攻坚 + 提效与合规加固";
    rerender(
      <PinnedSwarmDock
        snapshot={makeSnapshot({ phase: "running", title: longTitle })}
        cardId="m-run"
        blockId="b-run"
        dismissed={false}
        onOpenBoard={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const dock = screen.getByTestId("pinned-swarm-dock");
    const titleEl = within(dock).getByText(longTitle);
    expect(titleEl.className).toContain("min-w-0");
    expect(titleEl.className).toContain("flex-1");
    expect(titleEl.className).toContain("truncate");
  });

  it("OCV5-831 #5: folds killed members by default with expand toggle and keeps crisp cutout ring on avatar dots", () => {
    const onOpenBoard = vi.fn();
    const snap = makeSnapshot({
      phase: "running",
      members: [
        { name: "coordinator", role: "coordinator", status: "waiting", stepCount: 12, activity: "统筹中", unreadCount: 0 },
        { name: "parser", role: "worker", status: "working", stepCount: 124, activity: "编辑 parser.ts", unreadCount: 0 },
        { name: "worker-1", role: "worker", status: "killed", stepCount: 40, activity: "已回收", unreadCount: 0 },
        { name: "worker-2", role: "worker", status: "killed", stepCount: 38, activity: "已回收", unreadCount: 0 },
        { name: "worker-3", role: "worker", status: "killed", stepCount: 19, activity: "已回收", unreadCount: 0 },
      ],
    });
    render(<SwarmInlineCard snapshot={snap} cardId="m-k" blockId="b-k" onOpenBoard={onOpenBoard} />);

    const activeGrid = screen.getByTestId("swarm-member-grid");
    expect(within(activeGrid).getByText("@parser")).toBeTruthy();
    expect(within(activeGrid).queryByText("@worker-1")).toBeNull();

    // Avatar status dot retains ring-2 ring-surface cutout border
    const parserDot = screen.getByTestId("swarm-member-dot-parser");
    expect(parserDot.className).toContain("ring-2");
    expect(parserDot.className).toContain("ring-surface");

    // Killed members start folded into compact disclosure bar
    const killedToggle = screen.getByTestId("swarm-killed-toggle");
    expect(killedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(killedToggle.textContent).toContain("已回收 3 名成员");
    expect(screen.queryByTestId("swarm-killed-grid")).toBeNull();

    // Expanding reveals all killed cards and preserves member click focus
    fireEvent.click(killedToggle);
    expect(killedToggle.getAttribute("aria-expanded")).toBe("true");
    const killedGrid = screen.getByTestId("swarm-killed-grid");
    fireEvent.click(within(killedGrid).getByText("@worker-1"));
    expect(onOpenBoard).toHaveBeenCalledWith({
      snapshot: snap,
      cardId: "m-k",
      blockId: "b-k",
      focusMember: "worker-1",
    });
  });

  it("OCV5-831 #9a & #10: replaces heavy black icon with semantic oc-icon-badge and restores CTA visual focus", () => {
    const { rerender } = render(
      <SwarmInlineCard snapshot={makeSnapshot({ phase: "running" })} cardId="m-v" blockId="b-v" onOpenBoard={vi.fn()} />,
    );
    const runIcon = screen.getByTestId("swarm-header-icon");
    expect(runIcon.className).toContain("oc-icon-badge");
    expect(runIcon.className).toContain("oc-icon-badge-accent");
    expect(runIcon.className).not.toContain("bg-primary");
    expect(screen.getByTestId("swarm-open-board-btn").className).toContain("oc-btn-accent-craft");

    rerender(
      <SwarmInlineCard snapshot={makeSnapshot({ phase: "completed" })} cardId="m-v" blockId="b-v" onOpenBoard={vi.fn()} />,
    );
    const doneIcon = screen.getByTestId("swarm-header-icon");
    expect(doneIcon.className).toContain("oc-icon-badge");
    expect(doneIcon.className).toContain("oc-icon-badge-success");
    expect(doneIcon.className).not.toContain("bg-primary");
    const doneBtn = screen.getByTestId("swarm-open-board-btn");
    expect(doneBtn.className).toContain("bg-accent-soft");
    expect(doneBtn.className).toContain("text-accent");
  });

  it("OCV5-836: SwarmBoardDrawer blocks auto-focus on search input, uses mobile bottom-sheet layout, and collapses mobile search by default", () => {
    const snap = makeSnapshot();
    render(<SwarmBoardDrawer open onOpenChange={vi.fn()} snapshot={snap} />);

    const drawer = screen.getByTestId("swarm-board-drawer");
    const desktopSearch = within(drawer).getByLabelText("搜索蜂群讨论");

    // P0: opening drawer must NEVER auto-focus the search input (prevents iOS keyboard popup)
    expect(document.activeElement).not.toBe(desktopSearch);
    expect(document.activeElement?.tagName).not.toBe("INPUT");

    // Mobile bottom-sheet geometry & desktop centered dialog breakpoints
    expect(drawer.className).toContain("h-[92dvh]");
    expect(drawer.className).toContain("rounded-t-2xl");
    expect(drawer.className).toContain("rounded-b-none");
    expect(drawer.className).toContain("oc-sheet-in-bottom");
    expect(drawer.className).toContain("sm:h-[84dvh]");
    expect(drawer.className).toContain("sm:rounded-2xl");

    // Breathing modern swarm icon badge
    const drawerIcon = within(drawer).getByTestId("swarm-drawer-icon");
    expect(drawerIcon.className).toContain("oc-breathe-aura");

    // Mobile search bar is collapsed by default; clicking toggle opens & focuses it
    expect(within(drawer).queryByTestId("swarm-mobile-search-bar")).toBeNull();
    const searchToggle = within(drawer).getByLabelText("搜索讨论");
    expect(searchToggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(searchToggle);
    expect(searchToggle.getAttribute("aria-expanded")).toBe("true");
    const mobileSearchInput = within(drawer).getByTestId("swarm-mobile-search-input");
    expect(document.activeElement).toBe(mobileSearchInput);

    // Typing filters posts and shows compact hit count only when searching
    fireEvent.change(mobileSearchInput, { target: { value: "全绿" } });
    expect(within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]")).toHaveLength(1);
    expect(within(drawer).getByTestId("swarm-search-hit-count").textContent).toContain("找到 1 条");

    // Clicking cancel clears search and collapses mobile search bar
    fireEvent.click(within(drawer).getByTestId("swarm-mobile-search-close"));
    expect(within(drawer).queryByTestId("swarm-mobile-search-bar")).toBeNull();
    expect(within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]")).toHaveLength(3);
    expect(within(drawer).queryByTestId("swarm-search-hit-count")).toBeNull();
  });

  it("OCV5-836: omits redundant channel bar when swarm only has a single main channel", () => {
    const singleChannelSnap = makeSnapshot({
      channels: [{ name: "main", memberCount: 3, postCount: 3 }],
    });
    render(<SwarmBoardDrawer open onOpenChange={vi.fn()} snapshot={singleChannelSnap} />);

    const drawer = screen.getByTestId("swarm-board-drawer");
    expect(within(drawer).queryByTestId("swarm-channel-bar")).toBeNull();
    expect(within(drawer).queryByText(/全部频道/)).toBeNull();
  });

  it("OCV5-836: folds killed members by default in SwarmBoardDrawer roster and expands on click", () => {
    const snap = makeSnapshot({
      phase: "running",
      members: [
        { name: "coordinator", role: "coordinator", status: "waiting", stepCount: 10, activity: "统筹中", unreadCount: 0 },
        { name: "parser", role: "worker", status: "working", stepCount: 25, activity: "重构中", unreadCount: 0 },
        { name: "worker-old-1", role: "worker", status: "killed", stepCount: 14, activity: "已回收", unreadCount: 0 },
        { name: "worker-old-2", role: "worker", status: "killed", stepCount: 18, activity: "已回收", unreadCount: 0 },
      ],
    });
    render(<SwarmBoardDrawer open onOpenChange={vi.fn()} snapshot={snap} />);

    const roster = screen.getByTestId("swarm-roster-rail");
    const liveList = within(roster).getByTestId("swarm-roster-live-list");
    expect(within(liveList).getByText("@parser")).toBeTruthy();
    expect(within(liveList).queryByText("@worker-old-1")).toBeNull();

    const toggle = within(roster).getByTestId("swarm-roster-killed-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("已回收 2 名成员");
    expect(within(roster).queryByTestId("swarm-roster-killed-list")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const killedList = within(roster).getByTestId("swarm-roster-killed-list");
    expect(within(killedList).getByText("@worker-old-1")).toBeTruthy();
    expect(within(killedList).getByText("@worker-old-2")).toBeTruthy();
  });
});
