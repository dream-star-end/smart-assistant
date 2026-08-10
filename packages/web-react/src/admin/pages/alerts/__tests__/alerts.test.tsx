import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import { collapseEventTypes } from "../EventPicker";
import { activationBadge, friendlyTestError } from "../constants";
import AlertsPage from "../index";
import type { AlertChannel, CoverageRow, EventMeta, RuleStateRow } from "../types";

// adminApi 走 mock（保留真实 ApiError,便于 instanceof 分支）;只桩 adminGet/adminSend/adminText。
const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
    adminSend: (...a: unknown[]) => adminSend(...a),
    adminText: vi.fn(),
  };
});

const EVENTS: EventMeta[] = [
  { event_type: "payment.failed", severity: "critical", group: "payment", description: "支付失败", trigger: "passive" },
  { event_type: "ops.monitor_check_failed", severity: "warning", group: "ops", description: "监控失败", trigger: "passive" },
];

const CH_TG: AlertChannel = {
  id: "1", admin_id: "1", channel_type: "telegram", label: "ops-tg", enabled: true,
  severity_min: "warning", event_types: [], activation_status: "active",
  last_inbound_at: null, last_send_at: "2026-07-10T00:00:00Z", last_error: null,
  has_context_token: false, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};
const CH_AIBOT: AlertChannel = {
  id: "2", admin_id: "1", channel_type: "wecom_aibot", label: "ops-aibot", enabled: true,
  severity_min: "critical", event_types: ["payment.failed"], activation_status: "active",
  last_inbound_at: null, last_send_at: null, last_error: null, has_context_token: false,
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
  aibot_bot_id: "bot", aibot_bound: false, aibot_conn_state: "connected",
};

const COVERAGE: CoverageRow[] = [
  { event_type: "ops.monitor_check_failed", group: "ops", severity: "warning", description: "监控失败", trigger: "passive", subscriber_count: 0, deliverable_count: 0, last_fired_at: null, last_severity: null },
  { event_type: "payment.failed", group: "payment", severity: "critical", description: "支付失败", trigger: "passive", subscriber_count: 2, deliverable_count: 2, last_fired_at: "2026-07-09T00:00:00Z", last_severity: "critical" },
];

const RULES: RuleStateRow[] = [
  { rule_id: "account_pool.all_down", firing: true, acked: false, acked_at: null, acked_by: null, dedupe_key: "k", last_transition_at: "2026-07-09T00:00:00Z", last_evaluated_at: "2026-07-10T00:00:00Z", last_payload: { n: 1 } },
];

function routeGet(path: string): Promise<unknown> {
  switch (path) {
    case "/alerts/events": return Promise.resolve({ rows: EVENTS });
    case "/alerts/channels": return Promise.resolve({ rows: [CH_TG, CH_AIBOT] });
    case "/alerts/outbox": return Promise.resolve({ rows: [], next_before: null });
    case "/alerts/silences": return Promise.resolve({ rows: [] });
    case "/alerts/rule-states": return Promise.resolve({ rows: RULES });
    case "/alerts/events/coverage": return Promise.resolve({ rows: COVERAGE });
    default: return Promise.resolve({ rows: [] });
  }
}

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  adminGet.mockReset();
  adminSend.mockReset();
  adminGet.mockImplementation((path: string) => routeGet(path));
  adminSend.mockResolvedValue({});
});
afterEach(cleanup);

describe("AlertsPage 通道区", () => {
  test("渲染通道卡:类型/就绪徽标/订阅数/aibot 待绑定提示", async () => {
    renderPage(<AlertsPage />);
    expect(await screen.findByText("ops-tg")).toBeTruthy();
    expect(screen.getByText("ops-aibot")).toBeTruthy();
    expect(screen.getByText("Telegram")).toBeTruthy();
    expect(screen.getByText("企业微信智能机器人")).toBeTruthy();
    // telegram active → 就绪;aibot connected+未绑定 → 已连接·待绑定 + 显著提示
    expect(screen.getByText("就绪")).toBeTruthy();
    expect(screen.getByText("已连接·待绑定")).toBeTruthy();
    expect(screen.getByText(/给该机器人发一条消息/)).toBeTruthy();
    expect(screen.getByText("订阅全部")).toBeTruthy();
    expect(screen.getByText("订阅 1 种")).toBeTruthy();
  });

  test("测试送达打 POST /alerts/channels/:id/test", async () => {
    renderPage(<AlertsPage />);
    await screen.findByText("ops-tg");
    fireEvent.click(screen.getAllByText("测试送达")[0]);
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/alerts/channels/1/test", {}),
    );
  });

  test("删除通道走确认弹窗后打 DELETE", async () => {
    renderPage(<AlertsPage />);
    await screen.findByText("ops-tg");
    fireEvent.click(screen.getAllByText("删除")[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("DELETE", "/alerts/channels/1"),
    );
  });
});

describe("AlertsPage 分区切换", () => {
  test("切到事件流拉取 outbox", async () => {
    renderPage(<AlertsPage />);
    await screen.findByText("ops-tg");
    fireEvent.click(screen.getByRole("tab", { name: "事件流" }));
    await waitFor(() =>
      expect(adminGet.mock.calls.some((c) => c[0] === "/alerts/outbox")).toBe(true),
    );
  });

  test("规则与覆盖:孤儿事件横幅 + 展示 ops 运维组", async () => {
    renderPage(<AlertsPage />);
    await screen.findByText("ops-tg");
    fireEvent.click(screen.getByRole("tab", { name: "规则与覆盖" }));
    // 覆盖矩阵:1 个事件无人订阅 → 红色横幅
    expect(await screen.findByText(/没有任何通道订阅/)).toBeTruthy();
    // 新 ops.* 运维组必须展示(旧 vanilla 漏了它)
    expect(screen.getByText("运维")).toBeTruthy();
    // FIRING 规则可见
    expect(screen.getByText("FIRING")).toBeTruthy();
  });
});

describe("纯函数", () => {
  test("collapseEventTypes:全勾折叠成空数组=全部订阅", () => {
    const all = ["a.x", "b.y", "c.z"];
    expect(collapseEventTypes(["a.x", "b.y", "c.z"], all)).toEqual([]);
    expect(collapseEventTypes(["a.x"], all)).toEqual(["a.x"]);
    expect(collapseEventTypes([], all)).toEqual([]);
  });

  test("activationBadge:aibot 连接未绑定 = 已连接·待绑定(warning)", () => {
    const b = activationBadge(CH_AIBOT);
    expect(b.text).toBe("已连接·待绑定");
    expect(b.tone).toBe("warning");
  });

  test("friendlyTestError:pending 409 → 中文可操作指引", () => {
    const msg = friendlyTestError({
      message: "channel not active: pending",
      issue: () => undefined,
    });
    expect(msg).toContain("等待激活");
  });
});

describe("iLink QR 编码(vendored qrcode-generator)", () => {
  test("qrDataUrl 把短链字符串编码成 data:image gif", async () => {
    const { qrDataUrl } = await import("../qr/qr");
    const url = qrDataUrl("https://liteapp.weixin.qq.com/x/abc123");
    expect(url.startsWith("data:image/gif")).toBe(true);
    expect(url.length).toBeGreaterThan(64);
  });
});
