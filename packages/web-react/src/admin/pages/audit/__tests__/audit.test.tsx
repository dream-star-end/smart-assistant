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

import { ApiError } from "../../../lib/adminApi";
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
  input_meta: {
    error_class: "process_exit",
    failure_kind: "process_exit",
    exit_code: 2,
    termination_reason: "exit_code",
  },
  input_hash: "aaa111",
  output_hash: "bbb222",
  duration_ms: 120,
  success: false,
  error_msg: null,
  created_at: new Date().toISOString(),
};
const AGENT_STATS = {
  window: "24h",
  rollup: {
    success_calls: 581,
    failure_calls: 26,
    total_calls: 607,
    failure_rate: 26 / 607,
  },
  coverage: {
    scope: "current_online_fleet",
    mode: "best_effort",
    partial: false,
    expected_containers: 8,
    covered_containers: 8,
    started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    ended_at: new Date().toISOString(),
  },
  failures: {
    events: 26,
    affected_users: 6,
    groups: [
      {
        tool: "Bash",
        error_class: "process_exit",
        events: 15,
        users: 5,
        sessions: 7,
        p50_ms: 120,
        p95_ms: 950,
      },
    ],
  },
};
const SECURITY_ROW = {
  id: "3",
  type: "route_bypass",
  actor_user_id: "88",
  target: "route:/api/admin/secret",
  detail: { path: "/api/admin/secret" },
  ip: "10.0.0.9",
  user_agent: "Mozilla/5.0",
  created_at: new Date().toISOString(),
};
const HOST_ROW = {
  id: 12,
  hostId: "11111111-2222-3333-4444-555555555555",
  operation: "bootstrap.image_pull",
  operationId: "op-1",
  reasonCode: "manual",
  detail: { image: "runtime:v5" },
  actor: "admin:1",
  ts: new Date().toISOString(),
};
const TRACE = {
  trace_id: "tr-abc-123",
  user_id: "42",
  username: "Alice",
  session_key: "sess-xyz",
  agent_id: "agent-1",
  model: "glm-5.2",
  created_at: new Date().toISOString(),
};
const PRODUCT_FRICTION = {
  generated_at: new Date().toISOString(),
  windows: { operational_days: 7, funnel_days: 30 },
  events: [{
    surface: "auth", stage: "refresh", code: "REFRESH_RACE",
    journeys_1d: "2", journeys_7d: "3", attempts_1d: "3", attempts_7d: "5",
    failed_7d: "0", recovered_7d: "3", pending_7d: "0", affected_users_7d: "2",
  }],
  models: [{
    model: "qwen3.7-max", attempts_1d: "10", success_1d: "7", failures_1d: "2", cancellations_1d: "1",
    attempts_7d: "40", success_7d: "35", failures_7d: "3", cancellations_7d: "2",
  }],
  model_failures: [{ model: "qwen3.7-max", code: "NO_OUTPUT", failures_1d: "1", failures_7d: "2", affected_users_7d: "2" }],
  images: [{ status: "failed", code: "IMAGE_UPSTREAM_RATE_LIMITED", records: "1", affected_users: "1" }],
  image_attempts: [{ outcome: "failed", code: "IMAGE_UPSTREAM_RATE_LIMITED", attempts_1d: "1", attempts_7d: "1", affected_users_7d: "1" }],
  orders: [{ status: "canceled", orders: "2", affected_users: "2", amount_cents: "2000" }],
  github: [{ status: "failed", code: "workspace_timeout", selections: "1", affected_users: "1", stale: "0", deleted_session: "0", missing_session: "1" }],
  ratings: [{ rating: "down", ratings: "2", affected_users: "2", missing_reason: "1", missing_trace: "0" }],
};

beforeEach(() => {
  adminGet.mockReset();
  adminGet.mockImplementation((path: string) => {
    if (path === "/audit") return Promise.resolve({ rows: [ADMIN_ROW], next_before: null });
    if (path === "/agent-audit")
      return Promise.resolve({ rows: [AGENT_ROW], next_before: null });
    if (path === "/agent-audit/stats") return Promise.resolve(AGENT_STATS);
    if (path === "/security-events")
      return Promise.resolve({ rows: [SECURITY_ROW], next_before: null });
    if (path === "/host-audit")
      return Promise.resolve({ rows: [HOST_ROW], next_before: null });
    if (path === "/product-friction") return Promise.resolve(PRODUCT_FRICTION);
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

  test("切到『Agent 工具失败』触发 /agent-audit 拉取并渲染", async () => {
    renderPage(<AuditPage />);
    await screen.findByText("user.patch");
    // 初始不应请求 agent-audit
    expect(adminGet.mock.calls.some((c) => c[0] === "/agent-audit")).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "Agent 工具失败" }));

    await waitFor(() => {
      expect(adminGet.mock.calls.some((c) => c[0] === "/agent-audit")).toBe(true);
    });
    // 聚合与失败明细都会显示工具名
    expect((await screen.findAllByText("Bash")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("已上报调用失败率")).toBeTruthy();
    expect(screen.getByText("4.28%")).toBeTruthy();
    expect(screen.getByText("8/8")).toBeTruthy();
    expect(screen.getAllByText("进程异常退出").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/明细只记录失败调用，日志行数不等于平台事故数/),
    ).toBeTruthy();
  });

  test("Agent 统计覆盖不完整时明确降级，且零样本不伪造失败率", async () => {
    adminGet.mockImplementation((path: string) => {
      if (path === "/audit") return Promise.resolve({ rows: [ADMIN_ROW], next_before: null });
      if (path === "/agent-audit") return Promise.resolve({ rows: [], next_before: null });
      if (path === "/agent-audit/stats") {
        return Promise.resolve({
          ...AGENT_STATS,
          rollup: { success_calls: 0, failure_calls: 0, total_calls: 0, failure_rate: null },
          coverage: {
            ...AGENT_STATS.coverage,
            partial: true,
            expected_containers: 8,
            covered_containers: 6,
          },
          failures: { events: 0, affected_users: 0, groups: [] },
        });
      }
      return Promise.resolve({ rows: [], next_before: null });
    });

    renderPage(<AuditPage />);
    await screen.findByText("user.patch");
    fireEvent.click(screen.getByRole("tab", { name: "Agent 工具失败" }));

    expect(await screen.findByText("6/8")).toBeTruthy();
    expect(screen.getAllByText(/不是服务等级协议（SLA）/).length).toBe(2);
    const rateCard = screen.getByText("已上报调用失败率").parentElement;
    expect(rateCard?.textContent).toContain("—");
  });

  test("切到『安全事件』触发 /security-events 拉取并渲染", async () => {
    renderPage(<AuditPage />);
    await screen.findByText("user.patch");
    // 初始不应请求 security-events
    expect(adminGet.mock.calls.some((c) => c[0] === "/security-events")).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "安全事件" }));

    await waitFor(() => {
      expect(adminGet.mock.calls.some((c) => c[0] === "/security-events")).toBe(true);
    });
    // 类型徽标（route_bypass → 路由放行）
    expect(await screen.findByText("路由放行")).toBeTruthy();
    // 首拉带 limit=100
    const call = adminGet.mock.calls.find((c) => c[0] === "/security-events");
    expect(call?.[1]).toMatchObject({ limit: 100 });
  });

  test("产品摩擦按来源展示尝试、终局与恢复，不把重试当事故相加", async () => {
    renderPage(<AuditPage />);
    await screen.findByText("user.patch");
    fireEvent.click(screen.getByRole("tab", { name: "产品摩擦" }));

    expect((await screen.findAllByText("qwen3.7-max")).length).toBeGreaterThanOrEqual(2);
    expect(adminGet.mock.calls.some((c) => c[0] === "/product-friction")).toBe(true);
    expect(screen.getByText(/重试是过程，不等于终局失败/)).toBeTruthy();
    expect(screen.getByText(/不跨来源相加/)).toBeTruthy();
    expect(screen.getByText("REFRESH_RACE")).toBeTruthy();
    expect(screen.getByText("24 小时模型尝试").parentElement?.textContent).toContain("10");
    expect(screen.getByText("24 小时终局失败").parentElement?.textContent).toContain("2");
    expect(screen.getByText("7 天自动恢复").parentElement?.textContent).toContain("3");
    expect(screen.getByText("7 天进行中旅程").parentElement?.textContent).toContain("0");
    expect(screen.getByText("终局未成功")).toBeTruthy();
    expect(screen.getByText("待物化会话")).toBeTruthy();
    expect(screen.getByText("NO_OUTPUT")).toBeTruthy();
    expect(screen.getAllByText("IMAGE_UPSTREAM_RATE_LIMITED").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("workspace_timeout")).toBeTruthy();
  });

  test("请求ID反查成功 → 弹卡片展示归属信息", async () => {
    adminGet.mockImplementation((path: string) => {
      if (path.startsWith("/trace/")) return Promise.resolve({ trace: TRACE });
      if (path === "/audit") return Promise.resolve({ rows: [ADMIN_ROW], next_before: null });
      return Promise.resolve({ rows: [], next_before: null });
    });

    renderPage(<AuditPage />);
    const input = await screen.findByLabelText("请求ID反查输入");
    fireEvent.change(input, { target: { value: "tr-abc-123" } });
    fireEvent.click(screen.getByRole("button", { name: "反查" }));

    // Modal 标题 + 模型字段（唯一）
    expect(await screen.findByText("请求ID反查")).toBeTruthy();
    expect(await screen.findByText("glm-5.2")).toBeTruthy();
    // 命中的 trace 路径（encodeURIComponent 后仍以 /trace/ 起头）
    expect(adminGet.mock.calls.some((c) => String(c[0]).startsWith("/trace/"))).toBe(true);
  });

  test("请求ID反查 404 → 显示未找到该请求ID", async () => {
    adminGet.mockImplementation((path: string) => {
      if (path.startsWith("/trace/"))
        return Promise.reject(new ApiError({ status: 404, message: "trace not found" }));
      if (path === "/audit") return Promise.resolve({ rows: [ADMIN_ROW], next_before: null });
      return Promise.resolve({ rows: [], next_before: null });
    });

    renderPage(<AuditPage />);
    const input = await screen.findByLabelText("请求ID反查输入");
    fireEvent.change(input, { target: { value: "missing-id" } });
    fireEvent.click(screen.getByRole("button", { name: "反查" }));

    expect(await screen.findByText("未找到该请求ID")).toBeTruthy();
  });
});
