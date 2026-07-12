import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import SelfhealPage from "../index";
import type {
  IncidentDetailResp,
  IncidentRow,
  RepairEventRow,
  RepairStatus,
  SuppressedConditionRow,
} from "../types";

// adminApi 走 mock(保留真实 ApiError/apiErrorMessage);只桩 adminGet/adminSend。
const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual =
    await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return {
    ...actual,
    adminGet: (...a: unknown[]) => adminGet(...a),
    adminSend: (...a: unknown[]) => adminSend(...a),
  };
});

const INC: IncidentRow = {
  id: "9",
  status: "open",
  severity: "critical",
  surface: "chat",
  user_title: "服务不可用",
  opened_at: "2026-07-11T00:00:00Z",
  updated_at: "2026-07-11T00:10:00Z",
};

const SUPPRESSED: SuppressedConditionRow[] = [
  {
    conditionKey: "ops.monitor:mem",
    suppressedAt: "2026-07-11T02:00:00Z",
    suppressedBy: "admin:boss",
    level: "warning",
  },
];

const PENDING_EVENT: RepairEventRow = {
  id: "e1",
  repair_id: "42",
  kind: "progress",
  message: "verify PASS → pending_release，等待人工放行",
  created_at: "2026-07-11T00:05:00Z",
};

function detailWith(events: RepairEventRow[], repairStatus: RepairStatus = "running"): IncidentDetailResp {
  return {
    incident: { ...INC, condition_key: "ops.monitor:svc_v5", rev: 3 },
    repairs: [
      {
        id: "42",
        status: repairStatus,
        attempt: 1,
        summary: null,
        started_at: "2026-07-11T00:01:00Z",
        finished_at: null,
      },
    ],
    events,
  };
}

// 每个用例可改写的详情响应(默认无 pending_release)。
let detail: IncidentDetailResp = detailWith([]);

function routeGet(path: string): Promise<unknown> {
  if (path === "/selfheal/incidents") return Promise.resolve({ incidents: [INC] });
  if (path === "/selfheal/conditions") return Promise.resolve({ items: SUPPRESSED });
  if (path.startsWith("/selfheal/incidents/")) return Promise.resolve(detail);
  return Promise.resolve({});
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
  detail = detailWith([]);
  adminGet.mockImplementation((path: string) => routeGet(path));
  adminSend.mockResolvedValue({});
});
afterEach(cleanup);

describe("已压制 conditions 区块", () => {
  test("渲染压制行:conditionKey/级别/操作人 + 解除压制按钮", async () => {
    renderPage(<SelfhealPage />);
    expect(await screen.findByText("ops.monitor:mem")).toBeTruthy();
    expect(screen.getByText("已压制的检测项")).toBeTruthy();
    expect(screen.getByText("admin:boss")).toBeTruthy();
    expect(screen.getByRole("button", { name: "解除压制" })).toBeTruthy();
  });

  test("解除压制走确认弹窗后打 POST /selfheal/conditions/unsuppress", async () => {
    renderPage(<SelfhealPage />);
    await screen.findByText("ops.monitor:mem");
    fireEvent.click(screen.getByRole("button", { name: "解除压制" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "解除压制" }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/selfheal/conditions/unsuppress", {
        conditionKey: "ops.monitor:mem",
      }),
    );
    // 成功 toast + 双列表刷新(conditions + incidents)。
    expect(await screen.findByText("已解除压制，该检测项恢复正常投影")).toBeTruthy();
  });
});

describe("resolve 的 mode-aware toast 文案", () => {
  const CASES: { resolution: string; toastText: string }[] = [
    {
      resolution: "suppressed_until_clear",
      toastText: "已压制该检测项并标记恢复；检测真实恢复后压制自动解除",
    },
    {
      resolution: "condition_closed",
      toastText: "已关闭检测项并标记恢复，恢复通知将下发",
    },
    {
      resolution: "condition_already_clear",
      toastText: "检测项已恢复，事故已标记恢复",
    },
  ];

  test.each(CASES)("resolution=$resolution → 对应文案", async ({ resolution, toastText }) => {
    adminSend.mockResolvedValue({ resolved: true, resolution });
    renderPage(<SelfhealPage />);
    await screen.findByText("服务不可用");
    fireEvent.click(screen.getByRole("button", { name: "标记恢复" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "标记已恢复" }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/selfheal/incidents/9/resolve"),
    );
    expect(await screen.findByText(toastText)).toBeTruthy();
  });

  test("响应缺 resolution(旧后端/空体)→ 回落通用文案", async () => {
    adminSend.mockResolvedValue(undefined);
    renderPage(<SelfhealPage />);
    await screen.findByText("服务不可用");
    fireEvent.click(screen.getByRole("button", { name: "标记恢复" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "标记已恢复" }));
    expect(await screen.findByText("已标记为已恢复，恢复通知将下发")).toBeTruthy();
  });
});

describe("repair 待放行卡 + 一键放行", () => {
  test("running + pending_release progress 事件 → 显示待放行卡,确认后打 release", async () => {
    detail = detailWith([PENDING_EVENT], "running");
    renderPage(<SelfhealPage />);
    fireEvent.click(await screen.findByText("服务不可用"));
    expect(await screen.findByText("修复已就绪，待放行部署")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "一键放行" }));
    // 详情 Modal 已打开,confirm 是第二个 dialog —— 按"确认放行"按钮定位。
    await waitFor(() => {
      const dialogs = screen.getAllByRole("dialog");
      expect(
        dialogs.some((d) => within(d).queryByRole("button", { name: "确认放行" })),
      ).toBe(true);
    });
    const dialogs = screen.getAllByRole("dialog");
    const confirmDialog = dialogs.find((d) =>
      within(d).queryByRole("button", { name: "确认放行" }),
    );
    fireEvent.click(within(confirmDialog!).getByRole("button", { name: "确认放行" }));

    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/selfheal/repairs/42/release"),
    );
    expect(await screen.findByText("已放行，部署将由执行侧继续完成")).toBeTruthy();
  });

  test("running 但无 pending_release 事件 → 不渲染待放行卡(渲染正在修复卡)", async () => {
    detail = detailWith(
      [{ ...PENDING_EVENT, message: "正在分析根因…" }],
      "running",
    );
    renderPage(<SelfhealPage />);
    fireEvent.click(await screen.findByText("服务不可用"));
    expect(await screen.findByText(/正在修复（第 1 次尝试/)).toBeTruthy();
    expect(screen.queryByText("修复已就绪，待放行部署")).toBeNull();
    expect(screen.queryByRole("button", { name: "一键放行" })).toBeNull();
  });

  test("有 pending_release 事件但 repair 非 running → 不渲染待放行卡", async () => {
    detail = detailWith([PENDING_EVENT], "succeeded");
    renderPage(<SelfhealPage />);
    fireEvent.click(await screen.findByText("服务不可用"));
    expect(await screen.findByText("codex 修复（1）")).toBeTruthy();
    expect(screen.queryByText("修复已就绪，待放行部署")).toBeNull();
    expect(screen.queryByRole("button", { name: "一键放行" })).toBeNull();
  });
});
