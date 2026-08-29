import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TurnCostReminder } from "./TurnCostReminder";

describe("TurnCostReminder", () => {
  test("shows exact settled cumulative spend without duplicating the composer Stop", () => {
    render(<TurnCostReminder credits="731" />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "本轮多步骤任务已累计消耗 731 积分，任务仍在继续。",
    );
    expect(screen.queryByRole("button", { name: /停止/ })).not.toBeInTheDocument();
  });
});
