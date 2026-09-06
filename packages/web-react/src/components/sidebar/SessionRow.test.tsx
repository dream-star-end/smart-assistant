import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { Session } from "../../lib/types";
import { SessionRow } from "./SessionRow";

afterEach(() => {
  cleanup();
});

function session(over: Partial<Session> & { id: string }): Session {
  return {
    title: `会话 ${over.id}`,
    ownerUserId: "u1",
    updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    messageCount: 2,
    createdAt: Date.now() - 30 * 60_000,
    lastAt: Date.now() - 10 * 60_000,
    ...over,
  };
}

function renderRow(over: Partial<Session> & { id: string }) {
  return render(
    <SessionRow
      session={session(over)}
      active={false}
      projects={[]}
      now={Date.now()}
      onSelect={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      multiSelect={false}
      selected={false}
      onToggleSelected={() => {}}
      onEnterMultiSelect={() => {}}
      allowDrag={false}
    />,
  );
}

describe("SessionRow 预览与相对时间", () => {
  it("有 lastMessagePreview 时渲染第二行", () => {
    renderRow({ id: "s1", title: "有预览", lastMessagePreview: "最后一句话" });
    expect(screen.getByText("最后一句话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "有预览" })).toBeInTheDocument();
  });

  it("无 preview 不渲染第二行", () => {
    renderRow({ id: "s2", title: "无预览" });
    expect(screen.getByRole("button", { name: "无预览" })).toBeInTheDocument();
    expect(screen.queryByText("最后一句话")).toBeNull();
    const btn = screen.getByRole("button", { name: "无预览" });
    expect(btn.querySelectorAll("span").length).toBe(1);
  });

  it("非运行态显示相对时间而不是 duration", () => {
    renderRow({ id: "s3", title: "空闲会话" });
    expect(screen.queryByText("20m")).toBeNull();
    expect(document.querySelector("[data-session-duration]")).toBeNull();
    const updated = document.querySelector("[data-session-updated]");
    expect(updated).not.toBeNull();
    expect(updated).toHaveTextContent(/分钟前|刚刚/);
  });

  it("运行中才显示 duration 文本", () => {
    renderRow({
      id: "s4",
      title: "正在跑",
      runState: "running",
      createdAt: Date.now() - 8 * 60_000,
    });
    const duration = document.querySelector("[data-session-duration]");
    expect(duration).toHaveTextContent("8m");
    expect(document.querySelector("[data-session-updated]")).toBeNull();
  });
});
