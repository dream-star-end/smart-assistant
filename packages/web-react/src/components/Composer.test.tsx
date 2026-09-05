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

describe("Composer environment preparing", () => {
  test("shows a 20s prep progress in the input area", () => {
    render(<Composer onSend={() => {}} environmentPreparing />);
    expect(screen.getByRole("status")).toHaveTextContent("环境准备中，约 20 秒");
  });

  test("hides the prep progress by default", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByText(/环境准备中/)).toBeNull();
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
