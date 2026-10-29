import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useStopShortcut } from "./useStopShortcut";

afterEach(cleanup);
function Harness(props: { enabled: boolean; turnKey: string; onStop: () => void }) {
  return useStopShortcut({ ...props, getStopAction: () => props.onStop });
}

test("Esc requests confirmation; cancel keeps running and explicit confirm stops once", async () => {
  const onStop = vi.fn();
  render(<Harness enabled turnKey="s1:turn1" onStop={onStop} />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(await screen.findByRole("dialog", { name: "停止当前任务？" })).toBeInTheDocument();
  expect(onStop).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "继续运行" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "继续运行" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onStop).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(await screen.findByRole("button", { name: "停止任务" }));
  await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
});

test.each([{ enabled: false, turnKey: "s1:turn1" }, { enabled: true, turnKey: "s1:turn2" }, { enabled: true, turnKey: "s2:turn1" }])(
  "a stale confirmation cannot stop a completed, replacement, or other session turn: %j", async (next) => {
    const onStop = vi.fn();
    const { rerender } = render(<Harness enabled turnKey="s1:turn1" onStop={onStop} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("dialog");
    rerender(<Harness {...next} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onStop).not.toHaveBeenCalled();
  },
);
