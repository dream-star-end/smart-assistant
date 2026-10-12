import { describe, expect, it } from "vitest";
import type { Session } from "../../lib/types";
import { mergeActivity } from "./projectHomeModel";

const s = (id: string, lastAt: number): Session =>
  ({ id, title: `会话 ${id}`, ownerUserId: "u", updatedAt: new Date(lastAt).toISOString(), messageCount: 1, lastAt }) as Session;

describe("mergeActivity", () => {
  it("merges chats, tickets and cron runs newest first and keeps the limit", () => {
    const items = mergeActivity({
      sessions: [s("a", 1000), s("b", 4000)],
      tickets: [{ id: "t1", identifier: "OCV5-1", title: "加项目标签", status: "todo", updatedAt: 3000 }],
      cron: [
        { id: "c1", label: "每日巡检", lastRunAt: new Date(5000).toISOString() },
        { id: "c2", prompt: "从未跑过", lastRunAt: null },
      ],
      limit: 3,
    });
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(["cron:c1", "chat:b", "ticket:t1"]);
  });

  it("never invents a time: entries without one are left out", () => {
    const items = mergeActivity({ sessions: [], tickets: [{ id: "t", identifier: "X-1", title: "x", status: "todo" }], limit: 5 });
    expect(items).toEqual([]);
  });
});
