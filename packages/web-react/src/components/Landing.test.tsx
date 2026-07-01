import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Landing } from "./Landing";

const base = { theme: "light" as const, onCycleTheme: () => {} };

afterEach(cleanup);

describe("Landing 落地页", () => {
  test("叙事 / 动态演示 / 教程示例 / 4 档定价 + 加量包 均呈现", () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />);

    // 叙事主题
    expect(screen.getByText(/越用越好用，越用越懂你/)).toBeInTheDocument();
    // 动态演示：首个场景的用户提问立即可见（不参与打字动画）
    expect(screen.getByText(/业绩看板/)).toBeInTheDocument();
    // 教程区 + 可复制示例
    expect(screen.getByText(/五分钟，玩转每个功能/)).toBeInTheDocument();
    expect(screen.getAllByText(/试着说/).length).toBeGreaterThan(0);
    // 4 档套餐
    for (const name of ["免费版", "Pro", "Max", "Ultra"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // 价格锚点
    expect(screen.getByText("¥88")).toBeInTheDocument();
    expect(screen.getByText("¥498")).toBeInTheDocument();
    // 加量包
    expect(screen.getByText("积分加量包")).toBeInTheDocument();
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
