import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CopyIconButton } from "./paneParts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("复制后的复位定时器:再点取代旧的,卸载时清掉,不在面板拆除后回写", async () => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
  const setSpy = vi.spyOn(window, "setTimeout");
  const clearSpy = vi.spyOn(window, "clearTimeout");
  const resetTimers = () => setSpy.mock.calls.flatMap((call, i) => (call[1] === 1500 ? [setSpy.mock.results[i]?.value] : []));
  const cleared = () => clearSpy.mock.calls.map((call) => call[0]);
  const { unmount } = render(<CopyIconButton getText={() => "x"} />);
  const button = screen.getByRole("button", { name: "复制全文" });
  fireEvent.click(button);
  await waitFor(() => expect(resetTimers()).toHaveLength(1));
  fireEvent.click(button);
  await waitFor(() => expect(resetTimers()).toHaveLength(2));
  const [first, second] = resetTimers();
  expect(cleared()).toContain(first);
  unmount();
  expect(cleared()).toContain(second);
});
