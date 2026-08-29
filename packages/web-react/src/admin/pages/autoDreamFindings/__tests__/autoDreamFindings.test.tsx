import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui";

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return { ...actual, adminGet: (...args: unknown[]) => adminGet(...args), adminSend: (...args: unknown[]) => adminSend(...args) };
});

import AutoDreamFindingsPage from "../index";

const ROW = {
  id: "7",
  fingerprint: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  taxonomy: "reliability",
  capability_id: "chat.retry",
  severity: "high",
  title: "恢复后仍重复失败",
  problem: "用户需要重复操作",
  impact: "影响任务完成",
  recommendation: "合并重复失败",
  status: "new",
  occurrence_count: "3",
  affected_user_count: "2",
  run_count: "3",
  evidence_confidence: "corroborated",
  first_seen_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  last_seen_at: new Date().toISOString(),
  last_model: "qwen3.8-max",
  owner: null,
};

beforeEach(() => {
  adminGet.mockReset().mockResolvedValue({ rows: [ROW], total: 1, model: "qwen3.8-max" });
  adminSend.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("AutoDreamFindingsPage", () => {
  test("默认当前模型最近30天，并展示影响用户、聚类和负责人", async () => {
    render(<TooltipProvider><AutoDreamFindingsPage /></TooltipProvider>);
    expect(await screen.findByText("恢复后仍重复失败")).toBeInTheDocument();
    expect(screen.getByText("cluster abcdef123456")).toBeInTheDocument();
    expect(screen.getByText("未指派")).toBeInTheDocument();
    expect(adminGet).toHaveBeenCalledWith("/auto-dream-findings", expect.objectContaining({
      model: "current",
      seen_within: "30d",
      min_affected_users: "1",
    }));
  });

  test("复用既有状态批量分诊，不创建第二套归档状态", async () => {
    render(<TooltipProvider><AutoDreamFindingsPage /></TooltipProvider>);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择发现 恢复后仍重复失败" }));
    fireEvent.click(screen.getByRole("button", { name: "批量分诊" }));
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("PATCH", "/auto-dream-findings/batch", {
      ids: ["7"],
      status: "triaged",
    }));
  });

  test("详情可独立指派负责人", async () => {
    render(<TooltipProvider><AutoDreamFindingsPage /></TooltipProvider>);
    fireEvent.click(await screen.findByText("恢复后仍重复失败"));
    fireEvent.change(await screen.findByLabelText("发现负责人"), { target: { value: "ops-a" } });
    fireEvent.click(screen.getByRole("button", { name: "保存负责人" }));
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("PATCH", "/auto-dream-findings/7", { owner: "ops-a" }));
  });
});
