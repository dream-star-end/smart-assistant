import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

const adminGet = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>(
    "../../../lib/adminApi",
  );
  return { ...actual, adminGet: (...a: unknown[]) => adminGet(...a) };
});

import AuditPage from "../index";

// CopyChip / TimeAgo 依赖 TooltipProvider,页面动作用 useToast → 与其它页面测试一致包裹两 provider。
function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

const ADMIN_ROW = {
  id: "5",
  admin_id: "42",
  action: "user.patch",
  target: "user:123",
  before: { credits: 100, status: "active" },
  after: { credits: 200, status: "active" },
  ip: "10.0.0.1",
  user_agent: "Mozilla/5.0",
  created_at: new Date().toISOString(),
};
const AGENT_ROW = {
  id: "9",
  user_id: "7",
  session_id: "sess-abc",
  tool: "Bash",
  input_meta: { cmd: "ls" },
  input_hash: "aaa111",
  output_hash: "bbb222",
  duration_ms: 120,
  success: true,
  error_msg: null,
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  adminGet.mockReset();
  adminGet.mockImplementation((path: string) => {
    if (path === "/audit") return Promise.resolve({ rows: [ADMIN_ROW], next_before: null });
    if (path === "/agent-audit")
      return Promise.resolve({ rows: [AGENT_ROW], next_before: null });
    return Promise.resolve({ rows: [], next_before: null });
  });
});
afterEach(cleanup);

describe("AuditPage", () => {
  test("管理审计渲染 action 与 admin_id,并带 limit=100 拉取", async () => {
    renderPage(<AuditPage />);
    // 动作徽标
    expect(await screen.findByText("user.patch")).toBeTruthy();
    // 操作者 admin_id(CopyChip)
    expect(screen.getByText("42")).toBeTruthy();
    // 首载请求 /audit,limit=100
    const call = adminGet.mock.calls.find((c) => c[0] === "/audit");
    expect(call?.[1]).toMatchObject({ limit: 100 });
  });

  test("点『查看 diff』打开对比,变更字段高亮、未变字段不高亮", async () => {
    renderPage(<AuditPage />);
    await screen.findByText("user.patch");
    fireEvent.click(screen.getByRole("button", { name: "查看 diff" }));

    // Modal 标题
    expect(await screen.findByText("审计变更对比")).toBeTruthy();

    // credits 100 → 200:变更行高亮
    const changed = await screen.findByTestId("diff-row-credits");
    expect(changed.getAttribute("data-changed")).toBe("true");
    expect(changed.className).toContain("bg-warning-soft");

    // status active → active:未变,不高亮
    const same = screen.getByTestId("diff-row-status");
    expect(same.getAttribute("data-changed")).toBe("false");
    expect(same.className).not.toContain("bg-warning-soft");
  });

  test("切到『Agent 工具审计』触发 /agent-audit 拉取并渲染", async () => {
    renderPage(<AuditPage />);
    await screen.findByText("user.patch");
    // 初始不应请求 agent-audit
    expect(adminGet.mock.calls.some((c) => c[0] === "/agent-audit")).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "Agent 工具审计" }));

    await waitFor(() => {
      expect(adminGet.mock.calls.some((c) => c[0] === "/agent-audit")).toBe(true);
    });
    // 工具行渲染
    expect(await screen.findByText("Bash")).toBeTruthy();
  });
});
