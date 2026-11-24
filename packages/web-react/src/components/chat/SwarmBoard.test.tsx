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
import { extractSwarmSnapshotFromMessage, humanizeSwarmModel, latestSwarmSnapshot } from "./swarmUtils";

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
        <PinnedSwarmDock snapshot={snap} cardId="m-1" blockId="b-1" onOpenBoard={onOpenBoard} />
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
        onOpenBoard={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();

    const longTitle = "Wave 1 并行交付：P0 止血 + PG/WS 性能攻坚 + 提效与合规加固";
    rerender(
      <PinnedSwarmDock
        snapshot={makeSnapshot({ phase: "running", title: longTitle })}
        cardId="m-run"
        blockId="b-run"
        onOpenBoard={vi.fn()}
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
    // OCV5-850: 卡片运行态收敛为外框柔和边框慢呼吸，去除多余水波红点与图标外扩光晕
    const runCard = screen.getByTestId("swarm-inline-card");
    expect(runCard.className).toContain("oc-border-breathe");
    expect(runCard.querySelector(".oc-alive-dot")).toBeNull();
    const runIcon = screen.getByTestId("swarm-header-icon");
    expect(runIcon.className).toContain("oc-icon-badge");
    expect(runIcon.className).toContain("oc-icon-badge-accent");
    expect(runIcon.className).not.toContain("oc-breathe-aura");
    expect(runIcon.className).not.toContain("bg-primary");
    expect(screen.getByTestId("swarm-open-board-btn").className).toContain("oc-btn-accent-craft");

    rerender(
      <SwarmInlineCard snapshot={makeSnapshot({ phase: "completed" })} cardId="m-v" blockId="b-v" onOpenBoard={vi.fn()} />,
    );
    expect(screen.getByTestId("swarm-inline-card").className).not.toContain("oc-border-breathe");
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

    // OCV5-850: 抽屉顶栏保持清爽静默语义徽标，不再叠加水波红点与图标外扩光晕
    expect(drawer.getAttribute("data-swarm-active")).toBe("true");
    const drawerIcon = within(drawer).getByTestId("swarm-drawer-icon");
    expect(drawerIcon.className).toContain("oc-icon-badge-accent");
    expect(drawerIcon.className).not.toContain("oc-breathe-aura");
    expect(drawer.querySelector(".oc-alive-dot")).toBeNull();

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

  it("hardening: missing_base delta triggers forceSync + stale flag, and active frames never set completedAt", () => {
    const sess = createSession({ id: "s-gap", agentId: "main" });
    sess._sendingInFlight = true;
    const forceSync = vi.fn();

    // Active frame (rev 1) must NOT stamp completedAt.
    applyOutboundMessage(
      sess,
      {
        type: "outbound.message",
        sessionKey: "k1",
        channel: "webchat",
        peer: { id: "s-gap", kind: "dm" },
        frameSeq: 1,
        isFinal: false,
        blocks: [
          {
            kind: "swarm_snapshot",
            blockId: "agy-swarm-11111111-t0",
            snapshot: makeSnapshot({
              revision: 1,
              phase: "running",
              postsMode: "full",
              posts: [{ seq: 1, agent: "coordinator", channel: "main", text: "开局", mentions: [] }],
              totalPosts: 1,
            }),
          },
        ],
      },
      { forceSync },
    );
    const row = sess.messages.find((m) => m.toolName === SWARM_BOARD_TOOL_NAME)!;
    expect(row.completedAt).toBeUndefined();
    expect(sess._swarmSyncStale).toBe(false);

    // Gapped delta (deltaBaseSeq: 5 > prevHeadSeq: 1) marks stale and requests forceSync.
    applyOutboundMessage(
      sess,
      {
        type: "outbound.message",
        sessionKey: "k1",
        channel: "webchat",
        peer: { id: "s-gap", kind: "dm" },
        frameSeq: 2,
        isFinal: false,
        blocks: [
          {
            kind: "swarm_snapshot",
            blockId: "agy-swarm-11111111-t0",
            snapshot: makeSnapshot({
              revision: 3,
              phase: "running",
              postsMode: "delta",
              deltaBaseSeq: 5,
              posts: [{ seq: 6, agent: "parser", channel: "main", text: "跳帧", mentions: [] }],
              totalPosts: 6,
            }),
          },
        ],
      },
      { forceSync },
    );
    expect(sess._swarmSyncStale).toBe(true);
    expect(forceSync).toHaveBeenCalledWith("s-gap");

    // Full terminal snapshot clears stale flag and records completedAt.
    applyOutboundMessage(
      sess,
      {
        type: "outbound.message",
        sessionKey: "k1",
        channel: "webchat",
        peer: { id: "s-gap", kind: "dm" },
        frameSeq: 3,
        isFinal: false,
        blocks: [
          {
            kind: "swarm_snapshot",
            blockId: "agy-swarm-11111111-t0",
            snapshot: makeSnapshot({
              revision: 4,
              phase: "completed",
              postsMode: "full",
              totalPosts: 3,
            }),
          },
        ],
      },
      { forceSync },
    );
    expect(sess._swarmSyncStale).toBe(false);
    expect(row.completedAt).toBeTypeOf("number");
  });

  it("hardening: terminal swarm renders read-only command bar with follow-up quote action and zero dangerous controls", () => {
    const onQuote = vi.fn();
    const onOpenChange = vi.fn();
    const completed = makeSnapshot({
      phase: "completed",
      startedAt: 1_760_000_000_000 - 125_000,
      updatedAt: 1_760_000_000_000,
    });
    render(
      <SwarmBoardDrawer
        open
        onOpenChange={onOpenChange}
        snapshot={completed}
        sessionId="s-done"
        onQuoteToComposer={onQuote}
      />,
    );
    const bar = screen.getByTestId("swarm-command-bar");
    expect(bar.getAttribute("data-swarm-readonly")).toBe("true");
    expect(screen.queryByTestId("swarm-command-input")).toBeNull();
    expect(screen.queryByTestId("swarm-command-send")).toBeNull();
    expect(screen.queryByTestId("swarm-terminate-trigger")).toBeNull();
    expect(screen.getByTestId("swarm-drawer-elapsed").textContent).toContain("总耗时 02:05");

    fireEvent.click(screen.getByTestId("swarm-readonly-followup-btn"));
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hardening: initialFocusSeq highlights target post, [/] stepping preserves active filters, and long Markdown folds via CSS without breaking fences", () => {
    const longFenceText = [
      "详细对比报告：",
      "> 引用块需要富文本识别，见 [规范链接](https://example.com/spec)",
      "```ts",
      ...Array.from({ length: 30 }, (_, i) => `export const line_${i} = "payload_${i}_0123456789abcdef";`),
      "```",
    ].join("\n");
    const snap = makeSnapshot({
      posts: [
        { seq: 1, agent: "coordinator", channel: "main", text: "@all 启动任务", mentions: ["all"] },
        { seq: 2, agent: "parser", channel: "parser", text: longFenceText, mentions: [] },
        { seq: 3, agent: "verifier", channel: "parser", text: "@coordinator #2 检查通过", mentions: ["coordinator"] },
      ],
    });
    render(
      <SwarmBoardDrawer
        open
        onOpenChange={vi.fn()}
        snapshot={snap}
        initialFocusChannel="main"
        initialFocusSeq={2}
      />,
    );

    const drawer = screen.getByTestId("swarm-board-drawer");
    // Even though initialFocusChannel="main" mismatched #2's channel="parser", #2 stays visible & highlighted.
    expect(drawer.querySelector('[data-swarm-post-seq="2"]')).toBeTruthy();
    // Long Markdown is folded visually via CSS max-h and expands cleanly without cutting fences.
    expect(within(drawer).getByTestId("swarm-post-folded-2").className).toContain("max-h-72");
    fireEvent.click(within(drawer).getByTestId("swarm-post-expand-2"));
    expect(within(drawer).queryByTestId("swarm-post-folded-2")).toBeNull();

    // Filter to channel #parser (2 posts: #2 and #3), then press `[` to step without clearing the filter!
    fireEvent.click(within(drawer).getByTitle("词法与语法"));
    expect(within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "[" });
    expect(within(drawer).getByTestId("swarm-board-feed").querySelectorAll("[data-swarm-post-seq]")).toHaveLength(2);
  });

  it("hardening: semantic [stall]/[control:kill]/[steer] callouts, alert focus, member profile bar, token+cache summary, abort confirm, and charter compliance", () => {
    const onStopSwarm = vi.fn();
    const snap = makeSnapshot({
      phase: "running",
      members: [
        {
          name: "coordinator",
          role: "coordinator",
          status: "waiting",
          stepCount: 4,
          unreadCount: 0,
          inputTokens: 20_000,
          outputTokens: 4_000,
          cacheReadTokens: 80_000,
          toolCalls: 3,
        },
        {
          name: "worker-err",
          role: "worker",
          status: "working",
          workspace: "share",
          workspaceBranch: "swarm/worker-err",
          workspacePath: "/tmp/wt-worker-err",
          stepCount: 9,
          unreadCount: 1,
          failed: true,
          activity: "正在运行端到端集成测试并检查状态机收敛",
          lastError: "AssertionError: full untruncated diagnostic message for worker-err failure",
          inputTokens: 30_000,
          outputTokens: 6_000,
          cacheReadTokens: 20_000,
          thinkingTokens: 5_000,
          elapsedMs: 42_000,
          toolCalls: 8,
          lastPostSeq: 2,
        },
      ],
      posts: [
        { seq: 1, agent: "user:1", channel: "main", text: "[steer] @worker-err 优先排查超时", mentions: ["worker-err"] },
        { seq: 2, agent: "monitor", channel: "main", text: "[stall] @worker-err 连续 180s 无进展", mentions: ["worker-err"] },
        { seq: 3, agent: "coordinator", channel: "main", text: "[control:kill] 回收超时成员", mentions: [] },
      ],
      totalPosts: 3,
    });

    render(
      <div>
        <SwarmInlineCard snapshot={snap} cardId="m-obs" blockId="b-obs" onOpenBoard={vi.fn()} />
        <SwarmBoardDrawer
          open
          onOpenChange={vi.fn()}
          snapshot={snap}
          syncStale
          onStopSwarm={onStopSwarm}
        />
      </div>,
    );

    const drawer = screen.getByTestId("swarm-board-drawer");
    // Z-index & mobile visual-height & zero oc-live-status-shine on working rows
    expect(drawer.className).toContain("z-[var(--z-drawer)]");
    expect(drawer.className).toContain("var(--oc-visual-height");
    expect(drawer.querySelector(".oc-live-status-shine")).toBeNull();
    expect(screen.getByTestId("swarm-inline-card").querySelector(".oc-live-status-shine")).toBeNull();

    // Sync reconnecting pill + whole-swarm token & cache hit rate summary
    expect(within(drawer).getByTestId("swarm-sync-reconnecting")).toBeTruthy();
    expect(within(drawer).getByTestId("swarm-drawer-total-tokens").textContent).toContain("50.0k↑ 10.0k↓");
    expect(within(drawer).getByTestId("swarm-drawer-total-tokens").textContent).toContain("缓存 67%");
    expect(screen.getByTestId("swarm-inline-total-tokens").textContent).toContain("50.0k↑ 10.0k↓");

    // Semantic post badges & data-swarm-post-kind
    expect(drawer.querySelector('[data-swarm-post-seq="1"]')?.getAttribute("data-swarm-post-kind")).toBe("steer");
    expect(drawer.querySelector('[data-swarm-post-seq="2"]')?.getAttribute("data-swarm-post-kind")).toBe("stall");
    expect(drawer.querySelector('[data-swarm-post-seq="3"]')?.getAttribute("data-swarm-post-kind")).toBe("control_kill");

    // Alert banner -> one-click focus opens Member Profile Bar with full error & branch & cache
    expect(within(drawer).getByTestId("swarm-alert-banner")).toBeTruthy();
    fireEvent.click(within(drawer).getByTestId("swarm-alert-focus-btn"));
    const profileBar = within(drawer).getByTestId("swarm-member-profile-bar");
    expect(within(profileBar).getByTestId("swarm-member-profile-error").textContent).toContain(
      "full untruncated diagnostic message for worker-err failure",
    );
    expect(within(profileBar).getByTestId("swarm-member-profile-workspace").textContent).toContain(
      "swarm/worker-err",
    );
    expect(within(profileBar).getByTestId("swarm-member-profile-cache").textContent).toContain("缓存 20.0k");

    // Two-step abort entire swarm confirmation
    fireEvent.click(within(drawer).getByTestId("swarm-abort-trigger"));
    expect(within(drawer).getByTestId("swarm-abort-confirm")).toBeTruthy();
    fireEvent.click(within(drawer).getByTestId("swarm-abort-confirm-btn"));
    expect(onStopSwarm).toHaveBeenCalledTimes(1);
  });

  it("OCV5-879: humanizeSwarmModel renders all built-in Antigravity models and effort levels clearly", () => {
    expect(humanizeSwarmModel("gemini-4-neon-xhigh")).toBe("Gemini 4 Neon · XHigh");
    expect(humanizeSwarmModel("gemini-4-carbon-low")).toBe("Gemini 4 Carbon · Low");
    expect(humanizeSwarmModel("gemini-4-hydrogen-medium")).toBe("Gemini 4 Hydrogen · Medium");
    expect(humanizeSwarmModel("gemini-pro-orchestrator")).toBe("Orchestrator Carbon");
    expect(humanizeSwarmModel("gemini-pro-orchestrator-neon")).toBe("Orchestrator Neon");
    expect(humanizeSwarmModel("claude-opus-5-5-high")).toBe("Claude Opus 5.5 · High");
    expect(humanizeSwarmModel("claude-sonnet-5-5-low")).toBe("Claude Sonnet 5.5 · Low");
    expect(humanizeSwarmModel("gpt-oss-120b-medium")).toBe("GPT-OSS 120B");
  });
});
