import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

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
