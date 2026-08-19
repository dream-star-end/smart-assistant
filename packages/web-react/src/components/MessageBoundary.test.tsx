import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { MessageBoundary } from "./MessageBoundary";
import { MessageList } from "./MessageRenderer";

// 把 UserCard 换成"遇到 id==='bad' 必抛"的版本:构造一条渲染必抛的消息(签名计算安全、
// 渲染期抛),验证 per-message boundary 只降级该条、相邻消息不受影响。其余卡保持原实现。
vi.mock("./chat/cards", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./chat/cards")>();
  function ThrowingUserCard(props: { msg: ChatMessage }) {
    if (props.msg.id === "bad") throw new Error("boom: 坏消息数据");
    return <mod.UserCard {...props} />;
  }
  return { ...mod, UserCard: ThrowingUserCard };
});

afterEach(cleanup);

function mk(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, text, ts: 1 } as ChatMessage;
}

describe("MessageBoundary per-message 错误边界", () => {
  test("坏消息显示占位,相邻消息正常渲染,无整树卸载", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MessageList
        messages={[mk("good-1", "user", "前一条消息"), mk("bad", "user", "炸弹"), mk("good-2", "user", "后一条消息")]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    // 坏消息 → 一行紧凑占位(含消息 id 前缀小字)
    expect(screen.getByText("此条消息渲染失败")).toBeInTheDocument();
    expect(screen.getByText("#bad")).toBeInTheDocument();
    // 相邻消息照常渲染(React 未卸载整棵树)
    expect(screen.getByText("前一条消息")).toBeInTheDocument();
    expect(screen.getByText("后一条消息")).toBeInTheDocument();
    // componentDidCatch 带消息 id 上报
    expect(err.mock.calls.some((c) => String(c[0]).includes("id=bad"))).toBe(true);
    err.mockRestore();
  });

  test("签名不变维持占位;签名变化(新数据到达)自动重试子树", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    function MaybeThrow({ ok }: { ok: boolean }) {
      if (!ok) throw new Error("坏中间态");
      return <div>已恢复</div>;
    }
    const { rerender } = render(
      <MessageBoundary messageId="m1" sig="s1">
        <MaybeThrow ok={false} />
      </MessageBoundary>,
    );
    expect(screen.getByText("此条消息渲染失败")).toBeInTheDocument();
    // 同签名重渲 → 不反复抛,维持占位
    rerender(
      <MessageBoundary messageId="m1" sig="s1">
        <MaybeThrow ok={false} />
      </MessageBoundary>,
    );
    expect(screen.getByText("此条消息渲染失败")).toBeInTheDocument();
    // 签名变化(流式补全坏中间态)→ 重试渲染成功,占位消失
    rerender(
      <MessageBoundary messageId="m1" sig="s2">
        <MaybeThrow ok={true} />
      </MessageBoundary>,
    );
    expect(screen.getByText("已恢复")).toBeInTheDocument();
    expect(screen.queryByText("此条消息渲染失败")).toBeNull();
    err.mockRestore();
  });

  test("深层畸形 plan steps:[null] 只占位该条,相邻消息正常渲染", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MessageList
        messages={[
          mk("good-1", "user", "前一条消息"),
          { id: "plan-bad", role: "plan", text: "坏计划", ts: 1, steps: [null] } as unknown as ChatMessage,
          mk("good-2", "assistant", "后一条消息"),
        ]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("前一条消息")).toBeInTheDocument();
    expect(screen.getByText("后一条消息")).toBeInTheDocument();
    expect(screen.getByText("此条消息数据结构异常，已跳过渲染")).toBeInTheDocument();
    expect(screen.queryByText("坏计划")).toBeNull();
    err.mockRestore();
  });
});