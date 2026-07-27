import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { TurnCostReminder } from "./TurnCostReminder";

describe("TurnCostReminder", () => {
  test("shows exact settled cumulative spend and uses the existing stop action", () => {
    const onStop = vi.fn();
    render(<TurnCostReminder credits="731" onStop={onStop} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "本轮多步骤任务已累计消耗 731 积分，任务仍在继续。",
    );
    fireEvent.click(screen.getByRole("button", { name: "停止本轮" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
