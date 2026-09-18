import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AgentGate } from "./AgentGate";

afterEach(cleanup);

const noop = vi.fn();

// C-34:面板用 h1 与 App 的页面级 sr-only h1 并存;余额缺口「12000」与顶栏「128,900」格式不一致。
describe("AgentGate 标题层级与数字格式", () => {
  it("面板标题是 h2(一页只保留 App 的 h1)", () => {
    render(<AgentGate phase={{ kind: "unsubscribed" }} onOpen={noop} onRetry={noop} onTopUp={noop} />);
    expect(screen.getByRole("heading", { level: 2, name: "开通你的专属智能体" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("余额缺口按千分位显示,与顶栏余额同一格式", () => {
    render(
      <AgentGate phase={{ kind: "insufficient", shortfall: "12000" }} onOpen={noop} onRetry={noop} onTopUp={noop} />,
    );
    expect(screen.getByText(/还差 12,000 积分/)).toBeInTheDocument();
  });

  it("缺口未知时不出现数字句式", () => {
    render(<AgentGate phase={{ kind: "insufficient", shortfall: null }} onOpen={noop} onRetry={noop} onTopUp={noop} />);
    expect(screen.getByText("开通智能体所需积分不足，充值后即可开通。")).toBeInTheDocument();
  });

  it("ready / idle 不渲染面板", () => {
    const { container } = render(
      <AgentGate phase={{ kind: "idle" } as never} onOpen={noop} onRetry={noop} onTopUp={noop} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
