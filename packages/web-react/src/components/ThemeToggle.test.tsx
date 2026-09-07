import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ThemeToggle } from "./ThemeToggle";

afterEach(cleanup);

describe("ThemeToggle", () => {
  it("theme=light 时 title 含「切换到深色」", () => {
    render(<ThemeToggle theme="light" onCycle={() => {}} />);
    const btn = screen.getByRole("button", { name: /切换主题/ });
    expect(btn.getAttribute("title")).toContain("切换到深色");
  });

  it("点击调用 onCycle", () => {
    const onCycle = vi.fn();
    render(<ThemeToggle theme="light" onCycle={onCycle} />);
    fireEvent.click(screen.getByRole("button", { name: /切换主题/ }));
    expect(onCycle).toHaveBeenCalledTimes(1);
  });
});
