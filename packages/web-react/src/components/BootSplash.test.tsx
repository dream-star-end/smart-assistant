import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BootSplash, resetBootSplashForTest } from "./BootSplash";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - start);
  resetBootSplashForTest();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
let start = Date.now();

// OCV5-421: no text on a normal network; a quiet hint after 4 s; a reload offer after 20 s.
test("spinner only at first, slow hint after 4 s, reload after 20 s", () => {
  start = Date.now();
  render(<BootSplash />);
  expect(screen.queryByTestId("boot-slow-hint")).toBeNull();
  act(() => { vi.advanceTimersByTime(4100); });
  expect(screen.getByTestId("boot-slow-hint")).toHaveTextContent("网络较慢，正在加载…");
  expect(screen.queryByRole("button", { name: /^继续$/ })).toBeNull();
  act(() => { vi.advanceTimersByTime(16_000); });
  expect(screen.getByRole("button", { name: /^继续$/ })).toBeInTheDocument();
});

// Several lazy boundaries mount their own splash in turn during boot; the clock must not restart.
test("a splash remounted during the same loading period keeps counting", () => {
  start = Date.now();
  const first = render(<BootSplash />);
  act(() => { vi.advanceTimersByTime(3000); });
  first.unmount();
  act(() => { vi.advanceTimersByTime(300); });
  render(<BootSplash />);
  act(() => { vi.advanceTimersByTime(900); });
  expect(screen.getByTestId("boot-slow-hint")).toBeInTheDocument();
});

test("a splash that appears long after boot counts from its own mount", () => {
  start = Date.now() - 60_000; // page has been open for a minute
  render(<BootSplash />);
  expect(screen.queryByTestId("boot-slow-hint")).toBeNull();
  act(() => { vi.advanceTimersByTime(4100); });
  expect(screen.getByTestId("boot-slow-hint")).toBeInTheDocument();
});
