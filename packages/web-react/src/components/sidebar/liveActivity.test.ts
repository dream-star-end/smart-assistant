import { describe, expect, it } from "vitest";
import type { ChatProject, Session } from "../../lib/types";
import {
  collectLiveActivity,
  filterLiveActivityItems,
  liveActivityItemLabel,
  resolveEffectiveLiveFilter,
} from "./liveActivity";

function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: "2026-11-20T04:00:00.000Z",
    messageCount: 2,
    ...over,
  };
}

function makeProject(id: string, name: string): ChatProject {
  return {
    id,
    name,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    sessionCount: 1,
  };
}

describe("liveActivity 纯聚合模型", () => {
  it("无活态会话时返回 total=0 与全 0 计数", () => {
    const summary = collectLiveActivity({
      sessions: [
        makeSession({ id: "s1", lastOutcome: "completed" }),
        makeSession({ id: "s2", lastOutcome: "crashed" }),
        makeSession({ id: "s3", archived: true, runState: "running" }),
      ],
    });
    expect(summary.total).toBe(0);
    expect(summary.items).toEqual([]);
    expect(summary.counts).toEqual({ all: 0, needs_you: 0, running: 0, unread_done: 0 });
  });

  it("按 待拍板(approval > answer) > 运行中 > 刚完成未读 稳定排序且单会话不重复入桶", () => {
    const sessions: Session[] = [
      makeSession({ id: "s-unread-old", title: "旧未读", updatedAt: "2026-11-20T01:00:00.000Z", lastOutcome: "completed" }),
      makeSession({ id: "s-unread-new", title: "新未读", updatedAt: "2026-11-20T02:00:00.000Z", lastOutcome: "completed" }),
      makeSession({ id: "s-err-unread", title: "报错未读不算完成", updatedAt: "2026-11-20T05:00:00.000Z", lastOutcome: "crashed" }),
      makeSession({ id: "s-run-old", title: "运行旧", updatedAt: "2026-11-20T03:00:00.000Z", runState: "running" }),
      makeSession({ id: "s-swarm", title: "蜂群协作", updatedAt: "2026-11-20T04:00:00.000Z", projectId: "p1" }),
      makeSession({ id: "s-answer", title: "待回复", updatedAt: "2026-11-20T06:00:00.000Z", runState: "running" }),
      makeSession({ id: "s-approval-old", title: "待拍板旧", updatedAt: "2026-11-20T04:00:00.000Z", runState: "running" }),
      makeSession({ id: "s-approval-new", title: "待拍板新", updatedAt: "2026-11-20T05:00:00.000Z" }),
    ];

    const summary = collectLiveActivity({
      sessions,
      projects: [makeProject("p1", "科研论文")],
      isSending: (id) => id === "s-approval-old",
      sessionNeedsYou: (id) => {
        if (id === "s-approval-old" || id === "s-approval-new") return "approval";
        if (id === "s-answer") return "answer";
        return null;
      },
      unreadIds: new Set(["s-unread-old", "s-unread-new", "s-err-unread", "s-run-old"]),
      swarmSessionIds: new Set(["s-swarm"]),
    });

    expect(summary.counts).toEqual({
      all: 7,
      needs_you: 3,
      running: 2,
      unread_done: 2,
    });
    expect(summary.items.map((i) => i.session.id)).toEqual([
      "s-approval-new",
      "s-approval-old",
      "s-answer",
      "s-swarm",
      "s-run-old",
      "s-unread-new",
      "s-unread-old",
    ]);
    expect(summary.byBucket.running[0]!.isSwarm).toBe(true);
    expect(summary.byBucket.running[0]!.projectName).toBe("科研论文");
    expect(liveActivityItemLabel(summary.byBucket.needs_you[0]!)).toBe("待拍板");
    expect(liveActivityItemLabel(summary.byBucket.needs_you[2]!)).toBe("待回复");
    expect(liveActivityItemLabel(summary.byBucket.running[0]!)).toBe("协作中");
    expect(liveActivityItemLabel(summary.byBucket.running[1]!)).toBe("运行中");
    expect(liveActivityItemLabel(summary.byBucket.unread_done[0]!)).toBe("已完成");
  });

  it("未传 unreadIds 时回退读取 session.unread；传空 Set 时清零未读", () => {
    const s = makeSession({ id: "s1", unread: true, lastOutcome: "completed" });
    expect(collectLiveActivity({ sessions: [s] }).counts.unread_done).toBe(1);
    expect(collectLiveActivity({ sessions: [s], unreadIds: new Set() }).counts.unread_done).toBe(0);
  });

  it("resolveEffectiveLiveFilter 在当前筛选桶清空后自动回落 all", () => {
    const summary = collectLiveActivity({
      sessions: [makeSession({ id: "s1", runState: "running" })],
    });
    expect(resolveEffectiveLiveFilter(summary, "running")).toBe("running");
    expect(resolveEffectiveLiveFilter(summary, "needs_you")).toBe("all");
    expect(filterLiveActivityItems(summary, "needs_you").map((i) => i.session.id)).toEqual(["s1"]);
  });
});
