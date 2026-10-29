// #1240: 流式回合里 App 每帧都带着新的回调 / isSending 闭包 / socketVersion 重渲 Sidebar。
// 会话行必须只在自己的数据变化时重渲，搜索 effect 不能因回调换引用而每帧重跑。
// 行渲染次数用 SessionStatusDot(每行一个)计数。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, User } from "../lib/types";
import { Sidebar } from "./Sidebar";
import { SEARCH_DEBOUNCE_MS } from "./sidebar/constants";

const dotRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./SessionStatusDot", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./SessionStatusDot")>();
  return {
    ...mod,
    SessionStatusDot: (props: Parameters<typeof mod.SessionStatusDot>[0]) => {
      dotRenders.count += 1;
      return mod.SessionStatusDot(props);
    },
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  dotRenders.count = 0;
});

const user: User = { id: "u1", displayName: "测试用户", roles: ["user"], role: "user" };

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, title: `会话 ${id}`, ownerUserId: "u1", updatedAt: new Date().toISOString(), messageCount: 2, ...over };
}

const sessions = [session("s1"), session("s2"), session("s3")];

/** 模拟 App 一次重渲：所有回调和 isSending 都是新闭包，socketVersion 前进。 */
function frame(version: number, sending: ReadonlySet<string> = new Set(), extra: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return (
    <Sidebar
      sessions={sessions}
      user={user}
      activeId="s1"
      onSelect={() => {}}
      onNew={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onArchive={() => {}}
      onMarkRead={() => {}}
      isSending={(id) => sending.has(id)}
      liveTerminal={() => undefined}
      socketVersion={version}
      virtualizeThreshold={1000}
      {...extra}
    />
  );
}

describe("Sidebar 渲染预算 (#1240)", () => {
  it("App 每帧重渲(新回调 / 新 isSending / socketVersion 前进)时，数据没变的会话行不重渲", () => {
    const { rerender } = render(frame(1));
    expect(dotRenders.count).toBe(3);
    for (let v = 2; v <= 20; v++) rerender(frame(v));
    expect(dotRenders.count).toBe(3);
  });

  it("只有运行态变化的那一行重渲，回调仍调到最新的那一个", () => {
    const { rerender } = render(frame(1));
    dotRenders.count = 0;
    rerender(frame(2, new Set(["s2"])));
    expect(dotRenders.count).toBe(1);
    const onSelect = vi.fn();
    rerender(frame(3, new Set(["s2"]), { onSelect }));
    fireEvent.click(screen.getByRole("button", { name: "会话 s3" }));
    expect(onSelect).toHaveBeenCalledWith("s3");
  });

  it("搜索中 App 每帧换 onSearchMessages 引用：防抖不被重置，消息搜索照常发出且只发一次", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (_q: string, _signal: AbortSignal) => [] as never[]);
    const { rerender } = render(frame(1, new Set(), { onSearchMessages: search }));
    fireEvent.change(screen.getByPlaceholderText("搜索标题或消息"), { target: { value: "京都" } });
    // 流式回合：每 50ms 一帧，每帧都是新的 onSearchMessages 闭包。
    for (let v = 2; v <= 12; v++) {
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
      rerender(frame(v, new Set(), { onSearchMessages: (q, signal) => search(q, signal) }));
    }
    expect(search).toHaveBeenCalledTimes(1);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThan(11 * 50);
  });
});
