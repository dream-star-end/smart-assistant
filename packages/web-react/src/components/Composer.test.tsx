import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

describe("Composer 控件边框 token", () => {
  test("外壳非聚焦用 border-border-control，聚焦用 border-border-strong，不用分隔线 border-border", () => {
    const { container } = render(<Composer onSend={() => {}} />);
    const shell = container.querySelector(".rounded-\\[26px\\]");
    expect(shell).toBeTruthy();
    expect(shell?.className).toContain("border-border-control");
    expect(shell?.className).toContain("focus-within:border-border-strong");
    expect(shell?.className).not.toMatch(/(?:^|\s)border-border(?:\s|$)/);
  });
});

describe("Composer Stop ownership", () => {
  test("the composer is the sole active Stop control", () => {
    const onStop = vi.fn();
    render(<Composer busy onSend={() => {}} onStop={onStop} />);

    const stop = screen.getByRole("button", { name: "停止" });
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("an in-flight Stop stays on the same control and cannot be submitted twice", () => {
    const onStop = vi.fn();
    render(<Composer busy stopping onSend={() => {}} onStop={onStop} />);

    const stopping = screen.getByRole("button", { name: "正在停止" });
    expect(stopping).toBeDisabled();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    fireEvent.click(stopping);
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe("Composer 仓库 pill 单实例", () => {
  const bound = {
    selected: true as const,
    owner: "acme",
    repo: "aurora",
    branch: "main",
    status: "ready" as const,
    selection_version: 1,
  };

  test("showRepoPill=false 时卸载中栏 pill", () => {
    const { rerender } = render(
      <Composer onSend={() => {}} onOpenRepo={() => {}} repoSelection={bound} />,
    );
    expect(screen.getByTestId("repo-pill")).toBeInTheDocument();
    rerender(
      <Composer onSend={() => {}} onOpenRepo={() => {}} showRepoPill={false} repoSelection={bound} />,
    );
    expect(screen.queryByTestId("repo-pill")).toBeNull();
  });
});

describe("Composer 模型选择器", () => {
  const MODELS = [
    { id: "glm-5.2", display_name: "GLM-5.2" },
    { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
  ];

  test("选择器在发送钮左侧，textarea 带 min-w-0", () => {
    const { container } = render(
      <Composer
        onSend={() => {}}
        models={MODELS}
        selectedModelId="glm-5.2"
        onSelectModel={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "选择对话模型" });
    const send = screen.getByRole("button", { name: "发送" });
    expect(trigger.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const textarea = container.querySelector("textarea");
    expect(textarea?.className).toContain("min-w-0");
  });
});
