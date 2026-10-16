import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { dispatchActivityLabel, TurnActivity } from "./TurnActivity";

afterEach(() => cleanup());

describe("OCV5-428 TurnActivity before admission", () => {
  test("connecting shows the service state and the queue count, not 「思考中」", () => {
    render(
      <TurnActivity
        info={{
          startedAt: null,
          agentName: "助手",
          dispatch: { phase: "connecting", queued: 1, serviceStarting: false },
        }}
      />,
    );
    expect(screen.getByText("正在连接服务… · 1 条待发送")).toBeInTheDocument();
    expect(screen.queryByText(/思考中/)).toBeNull();
  });

  test("4503 provisioning → 服务启动中", () => {
    expect(dispatchActivityLabel({ phase: "connecting", queued: 2, serviceStarting: true }).text)
      .toBe("服务启动中，就绪后自动发送 · 2 条待发送");
  });

  test("sending / paused copy", () => {
    expect(dispatchActivityLabel({ phase: "sending", queued: 1, serviceStarting: false }).text).toBe("正在发送…");
    expect(dispatchActivityLabel({ phase: "sending", queued: 3, serviceStarting: false }).text)
      .toBe("正在发送… · 3 条待发送");
    expect(dispatchActivityLabel({ phase: "paused", queued: 2, serviceStarting: false }).text).toBe("2 条待发送");
  });

  test("without dispatch the existing 「思考中」 row is unchanged", () => {
    render(<TurnActivity info={{ startedAt: null, agentName: "助手" }} />);
    expect(screen.getByText(/思考中/)).toBeInTheDocument();
  });
});
