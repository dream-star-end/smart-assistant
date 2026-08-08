import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RecoveryStatusCard } from "./RecoveryStatusCard";

afterEach(cleanup);

describe("RecoveryStatusCard", () => {
  test.each([
    ["waiting-service", "等待服务恢复"],
    ["retrying", "自动重试中"],
    ["resumed", "已从断点继续"],
    ["needs-confirmation", "需要确认"],
    ["stopping", "正在停止"],
    ["completed", "已完成"],
  ] as const)("%s uses one low-cognition primary label", (kind, label) => {
    render(<RecoveryStatusCard status={{ kind }} />);
    expect(screen.getByRole("status")).toHaveTextContent(label);
  });

  test("attempt and error code stay in expandable details; Stop remains available while active", () => {
    const onStop = vi.fn();
    render(
      <RecoveryStatusCard
        status={{ kind: "retrying", attempt: 4, errorCode: "relay_timeout" }}
        onStop={onStop}
      />,
    );
    screen.getByRole("status");
    expect(screen.getByText("relay_timeout")).not.toBeVisible();
    expect(screen.getByText("第 4 次")).not.toBeVisible();
    fireEvent.click(screen.getByText("查看详情"));
    expect(screen.getByText("第 4 次")).toBeVisible();
    expect(screen.getByText("relay_timeout")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("persisted Stop has a distinct authoritative receipt label", () => {
    render(<RecoveryStatusCard status={{ kind: "stopping", masterPersisted: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("停止请求已收到，正在停止");
  });
});
