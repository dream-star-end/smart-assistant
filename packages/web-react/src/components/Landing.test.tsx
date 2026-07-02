import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Landing } from "./Landing";

const base = { theme: "light" as const, onCycleTheme: () => {} };

afterEach(cleanup);

describe("Landing 落地页", () => {
  test("叙事 / 动态演示 / 对比区 / 快速上手 / FAQ 均呈现，定价区已移除", () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);

    // 叙事主题（对比区副文案保留该锚点）
    expect(screen.getByText(/越用越好用，越用越懂你/)).toBeInTheDocument();
    // 动态演示：首个场景的用户提问 + 成果面板交付物文件名均立即可见（不参与打字动画）
    expect(screen.getAllByText(/坪效/).length).toBeGreaterThanOrEqual(2);
    // 差异化对比区
    expect(screen.getByText("不是又一个聊天机器人")).toBeInTheDocument();
    // 快速上手：三步 + 可复制「开口第一句」
    expect(screen.getByText(/三步开始，一分钟上手/)).toBeInTheDocument();
    expect(screen.getByText(/开口第一句，照抄就行/)).toBeInTheDocument();
    expect(screen.getAllByTitle("点击复制").length).toBeGreaterThan(4);
    // FAQ 信任区（nav/footer 链接 + 区标题，故用 getAllBy）
    expect(screen.getAllByText("常见问题").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("需要会写提示词吗？")).toBeInTheDocument();
    // 包月套餐说明已按要求移除
    expect(screen.queryByText(/包月套餐/)).toBeNull();
    expect(screen.queryByText("¥88")).toBeNull();
    // 「无需信用卡」已按要求移除
    expect(screen.queryByText(/无需信用卡/)).toBeNull();
  });

  test("nav「登录」触发 onLogin；「免费开始」触发 onStart", () => {
    const onStart = vi.fn();
    const onLogin = vi.fn();
    render(<Landing {...base} onStart={onStart} onLogin={onLogin} />);

    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(onLogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("button", { name: /免费开始/ })[0]);
    expect(onStart).toHaveBeenCalled();
  });
});
