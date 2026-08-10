import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";
import SelfhealPage from "../index";
import type {
  IncidentDetailResp,
  IncidentRow,
  ReleaseFuseResp,
  ReleaseRequestRow,
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
  latest_repair_status: null,
  latest_repair_at: null,
};

const SUPPRESSED: SuppressedConditionRow[] = [
  {
    condition_key: "ops.monitor:mem",
    firing: true,
    mode: "probe",
    level: "warning",
    observed_at: "2026-07-11T02:00:00Z",
    occurrence_count: "4",
    suppressed_until_clear: true,
    suppressed_at: "2026-07-11T02:00:00Z",
    suppressed_by: "admin:boss",
  },
];

// 结构化 pending_release detail(契约 §11 形状)。判定/富化数据源。
const PENDING_DETAIL: Record<string, unknown> = {
  phase: "pending_release",
  sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  baseSha: "0f0e0d0c0b0a0f0e0d0c0b0a0f0e0d0c0b0a0f0e",
  changedFiles: ["packages/gateway/src/foo.ts", "packages/web-react/src/bar.tsx"],
  changedFilesTotal: 2,
  classification: {
    surfaces: ["web", "runtime-source"],
    deployArgs: ["--with-dist"],
    manual: [],
    verifyLayers: ["lint", "typecheck", "gateway"],
  },
  verification: {
    layers: [
      { name: "lint", ok: true },
      { name: "typecheck", ok: true },
    ],
  },
  deployPlanHash: "d".repeat(64),
  manifestHash: "c".repeat(64),
};

const PENDING_EVENT: RepairEventRow = {
  id: "101",
  repair_id: "42",
  kind: "progress",
  message: "verify PASS → pending_release，等待人工放行",
  created_at: "2026-07-11T00:05:00Z",
  detail: PENDING_DETAIL,
};

// 非 pending_release 的进度事件(detail.phase 非 pending_release)。
const PLAIN_EVENT: RepairEventRow = {
  id: "100",
  repair_id: "42",
  kind: "progress",
  message: "正在分析根因…",
  created_at: "2026-07-11T00:03:00Z",
  detail: { phase: "progress" },
};

function detailWith(
  events: RepairEventRow[],
  repairStatus: RepairStatus = "running",
  releaseRequests?: ReleaseRequestRow[],
): IncidentDetailResp {
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
        releaseRequests,
      },
    ],
    events,
  };
}

// 每个用例可改写的详情响应(默认无 pending_release)。
let detail: IncidentDetailResp = detailWith([]);
// 每个用例可改写的熔断状态(默认未熔断)。
let fuse: ReleaseFuseResp = { engaged: false };

function routeGet(path: string): Promise<unknown> {
  if (path === "/selfheal/incidents") {
    return Promise.resolve({ rows: [INC], next_before: null, total: 1, open_total: 1 });
  }
  if (path === "/selfheal/conditions") return Promise.resolve({ rows: SUPPRESSED });
  if (path === "/selfheal/release-fuse") return Promise.resolve(fuse);
  if (path === "/selfheal/user-notices") return Promise.resolve({
    binding: { channelId: "5", bindingCode: "A1B2C3D4", active: false, boundIdentity: null, boundAt: null },
    proposals: [],
  });
  if (path.startsWith("/selfheal/incidents/")) return Promise.resolve(detail);
  return Promise.resolve({});
}

function releaseReq(over: Partial<ReleaseRequestRow> = {}): ReleaseRequestRow {
  return {
    releaseRequestId: "rr-9f8e7d6c",
    sourceEventId: PENDING_EVENT.id,
    status: "queued",
    approvedSha: PENDING_DETAIL.sha as string,
    baseSha: PENDING_DETAIL.baseSha as string,
    deployPlanHash: PENDING_DETAIL.deployPlanHash as string,
    failureReason: null,
    createdAt: "2026-07-11T00:06:00Z",
    updatedAt: "2026-07-11T00:06:00Z",
    ...over,
  };
}

function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  window.location.hash = "#tab=selfheal";
  adminGet.mockReset();
  adminSend.mockReset();
  detail = detailWith([]);
  fuse = { engaged: false };
  adminGet.mockImplementation((path: string) => routeGet(path));
  adminSend.mockResolvedValue({});
});
afterEach(cleanup);

describe("已压制 conditions 区块", () => {
  test("按真实 server snake_case envelope 渲染事故总数、open age 与修复状态", async () => {
    renderPage(<SelfhealPage />);
    expect(await screen.findByText("服务不可用")).toBeTruthy();
    expect(screen.getByText("共 1 条 · 1 条未恢复")).toBeTruthy();
    expect(screen.getByText(/已持续/)).toBeTruthy();
    expect(screen.getByText("未触发")).toBeTruthy();
  });

  test("incident_id 深链在列表命中后自动打开真实事故详情", async () => {
    window.location.hash = "#tab=selfheal&incident_id=9";
    renderPage(<SelfhealPage />);
    expect(await screen.findByRole("dialog", { name: "服务不可用" })).toBeTruthy();
    expect(adminGet.mock.calls.some((call) => call[0] === "/selfheal/incidents/9")).toBe(true);
  });

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
      toastText: "已关闭检测项并标记恢复；不会因此直接向用户发通知",
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
    expect(await screen.findByText("已标记为已恢复；不会因此直接向用户发通知")).toBeTruthy();
  });
});

async function openDetail() {
  fireEvent.click(await screen.findByText("服务不可用"));
}

/** 打开详情后走一键放行 → confirm 弹窗确认放行。 */
async function clickReleaseAndConfirm(buttonName = "一键放行") {
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await waitFor(() => {
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs.some((d) => within(d).queryByRole("button", { name: "确认放行" }))).toBe(true);
  });
  const confirmDialog = screen
    .getAllByRole("dialog")
    .find((d) => within(d).queryByRole("button", { name: "确认放行" }));
  fireEvent.click(within(confirmDialog!).getByRole("button", { name: "确认放行" }));
}

describe("repair 待放行卡（detail.phase 判定）", () => {
  test("running + detail.phase=pending_release → 显示待放行卡", async () => {
    detail = detailWith([PENDING_EVENT], "running");
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText("修复已就绪，待放行部署")).toBeTruthy();
    expect(screen.getByRole("button", { name: "一键放行" })).toBeTruthy();
  });

  test("running 但事件 detail.phase 非 pending_release → 不渲染待放行卡(渲染正在修复卡)", async () => {
    detail = detailWith([PLAIN_EVENT], "running");
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText(/正在修复（第 1 次尝试/)).toBeTruthy();
    expect(screen.queryByText("修复已就绪，待放行部署")).toBeNull();
    expect(screen.queryByRole("button", { name: "一键放行" })).toBeNull();
  });

  test("消息含 pending_release 文本但 detail 缺失 → 不再误判为待放行(废除文本匹配)", async () => {
    detail = detailWith(
      [{ ...PLAIN_EVENT, message: "verify → pending_release 文本", detail: undefined }],
      "running",
    );
    renderPage(<SelfhealPage />);
    await openDetail();
    await screen.findByText("codex 修复（1）");
    expect(screen.queryByText("修复已就绪，待放行部署")).toBeNull();
  });

  test("有 pending_release 事件但 repair 非 running → 不渲染待放行卡", async () => {
    detail = detailWith([PENDING_EVENT], "succeeded");
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText("codex 修复（1）")).toBeTruthy();
    expect(screen.queryByText("修复已就绪，待放行部署")).toBeNull();
    expect(screen.queryByRole("button", { name: "一键放行" })).toBeNull();
  });
});

describe("待放行卡富化（human gate）", () => {
  test("展示 base→sha / 影响面 / 部署参数 / 验证层 / 改动文件 / planHash", async () => {
    detail = detailWith([PENDING_EVENT], "running");
    renderPage(<SelfhealPage />);
    await openDetail();
    await screen.findByText("修复已就绪，待放行部署");
    // 短 sha（前 12 位；base/sha 同一 span 内两段文本 → 用 regex 子串匹配）。
    expect(screen.getByText(/0f0e0d0c0b0a/)).toBeTruthy();
    expect(screen.getByText(/a1b2c3d4e5f6/)).toBeTruthy();
    // 影响面 badges + 部署参数
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("runtime-source")).toBeTruthy();
    expect(screen.getByText("--with-dist")).toBeTruthy();
    // deployPlanHash 短值（前 12 位）
    expect(screen.getByText(/dddddddddddd/)).toBeTruthy();
    // 验证层结果
    expect(screen.getByText("验证层结果")).toBeTruthy();
    // 改动文件（截断列表 + 总数）
    expect(screen.getByText("packages/gateway/src/foo.ts")).toBeTruthy();
    expect(screen.getByText(/改动文件/)).toBeTruthy();
  });

  test("manual 非空 → 显著警示 + 按钮旁警示 + 确认弹窗提示", async () => {
    const manualDetail = {
      ...PENDING_DETAIL,
      classification: {
        surfaces: [],
        deployArgs: [],
        manual: [{ path: "scripts/deploy-v5.sh", reason: "manual_path" }],
        verifyLayers: [],
      },
    };
    detail = detailWith([{ ...PENDING_EVENT, detail: manualDetail }], "running");
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(
      await screen.findByText(/以下改动无法安全自动部署/),
    ).toBeTruthy();
    expect(screen.getByText("scripts/deploy-v5.sh")).toBeTruthy();
    expect(screen.getByText(/含需人工介入的改动/)).toBeTruthy();
    // 确认弹窗内额外警示 manual 条数
    fireEvent.click(screen.getByRole("button", { name: "一键放行" }));
    expect(await screen.findByText(/含 1 项无法安全自动部署的改动/)).toBeTruthy();
  });

  test("detail 结构不完整（缺 sha/plan/manifest）→ 信息不完整警示,不崩溃", async () => {
    detail = detailWith(
      [{ ...PENDING_EVENT, detail: { phase: "pending_release" } }],
      "running",
    );
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText(/放行信息不完整/)).toBeTruthy();
    // 仍显示卡与放行按钮（后端 fail-closed 兜底），未崩溃。
    expect(screen.getByRole("button", { name: "一键放行" })).toBeTruthy();
  });
});

describe("放行 202 异步 + 状态流", () => {
  test("确认放行打 POST release,toast 为已提交请求(不再显示已部署)", async () => {
    detail = detailWith([PENDING_EVENT], "running");
    adminSend.mockResolvedValue({ ok: true, releaseRequestId: "rr-abc12345", status: "queued" });
    renderPage(<SelfhealPage />);
    await openDetail();
    await screen.findByText("修复已就绪，待放行部署");
    await clickReleaseAndConfirm();
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/selfheal/repairs/42/release", {
        expectedPendingReleaseEventId: PENDING_EVENT.id,
      }),
    );
    expect(await screen.findByText(/已提交放行请求/)).toBeTruthy();
    expect(screen.queryByText("已放行，个人版已确认部署完成")).toBeNull();
  });

  test("releaseRequests=deploying → 状态流显示部署中 + 放行禁用", async () => {
    detail = detailWith([PENDING_EVENT], "running", [releaseReq({ status: "deploying" })]);
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText("部署放行进行中")).toBeTruthy();
    expect(screen.getByText("正在部署…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "一键放行" })).toBeDisabled();
  });

  test("releaseRequests=deployed → 文案区分「代码已部署」≠ 已恢复", async () => {
    detail = detailWith([PENDING_EVENT], "running", [
      releaseReq({ status: "deployed", updatedAt: "2026-07-11T00:10:00Z" }),
    ]);
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText("代码已部署，等待探测确认恢复")).toBeTruthy();
    expect(screen.getByText(/代码已部署（等待探测确认事故恢复）/)).toBeTruthy();
  });

  test("同 source event 已 deploy_failed → 禁止二次部署，等待新的候选事件", async () => {
    detail = detailWith([PENDING_EVENT], "running", [
      releaseReq({
        status: "deploy_failed",
        failureReason: "canonical_advanced",
        updatedAt: "2026-07-11T00:12:00Z",
      }),
    ]);
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText("本候选已完成一次放行，等待新的修复候选")).toBeTruthy();
    expect(screen.getByText(/上次失败原因：canonical_advanced/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "一键放行" })).toBeDisabled();
  });

  test("新的 pending_release event 不复用旧终态请求，可生成新逻辑审批", async () => {
    const next = { ...PENDING_EVENT, id: "102", created_at: "2026-07-11T00:15:00Z" };
    detail = detailWith([PENDING_EVENT, next], "running", [
      releaseReq({ status: "deploy_failed", sourceEventId: PENDING_EVENT.id }),
    ]);
    renderPage(<SelfhealPage />);
    await openDetail();
    expect(await screen.findByText("修复已就绪，待放行部署")).toBeTruthy();
    expect(screen.getByRole("button", { name: "一键放行" })).not.toBeDisabled();
  });

  test("同 created_at 的 pending_release 事件按最大 bigint id 选择 exact 审批键", async () => {
    const sameTimeNewer = { ...PENDING_EVENT, id: "102" };
    detail = detailWith([sameTimeNewer, PENDING_EVENT], "running");
    adminSend.mockResolvedValue({ ok: true, releaseRequestId: "rr-new", status: "queued" });
    renderPage(<SelfhealPage />);
    await openDetail();
    await screen.findByText("修复已就绪，待放行部署");
    await clickReleaseAndConfirm();
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/selfheal/repairs/42/release", {
        expectedPendingReleaseEventId: "102",
      }),
    );
  });
});

describe("熔断 banner + 放行禁用/清除", () => {
  test("fuse engaged → 顶部红色 banner + 放行按钮禁用", async () => {
    fuse = {
      engaged: true,
      reason: "deploy_unknown@rr-x",
      releaseRequestId: "rr-deadbeef",
      engagedAt: "2026-07-11T00:20:00Z",
      engagedBy: "system",
    };
    detail = detailWith([PENDING_EVENT], "running");
    renderPage(<SelfhealPage />);
    expect(
      await screen.findByText("Tier2 部署熔断已触发 —— 所有一键放行已禁用"),
    ).toBeTruthy();
    expect(screen.getByText(/deploy_unknown@rr-x/)).toBeTruthy();
    await openDetail();
    expect(await screen.findByRole("button", { name: "一键放行" })).toBeDisabled();
    expect(screen.getByText(/全局部署熔断已触发，暂不可放行/)).toBeTruthy();
  });

  test("清除熔断 → prompt 填 reason 后打 POST /release-fuse/clear", async () => {
    fuse = {
      engaged: true,
      reason: "deploy_unknown",
      releaseRequestId: "rr-deadbeef",
      engagedAt: "2026-07-11T00:20:00Z",
    };
    renderPage(<SelfhealPage />);
    fireEvent.click(await screen.findByRole("button", { name: "清除熔断" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "已人工核对恢复稳定" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清除" }));
    await waitFor(() =>
      expect(adminSend).toHaveBeenCalledWith("POST", "/selfheal/release-fuse/clear", {
        reason: "已人工核对恢复稳定",
        expectedReleaseRequestId: "rr-deadbeef",
      }),
    );
    expect(await screen.findByText("已清除部署熔断，Tier2 放行恢复可用")).toBeTruthy();
  });

  test("清 A 后仍有 B pending → 提示熔断保持，不误报 Tier2 已恢复", async () => {
    fuse = {
      engaged: true,
      reason: "A unknown",
      releaseRequestId: "rr-a",
      engagedAt: "2026-07-11T00:20:00Z",
    };
    adminSend.mockResolvedValue({
      cleared: true,
      outcome: "cleared",
      releaseRequestId: "rr-a",
      remainingReleaseRequestId: "rr-b",
    });
    renderPage(<SelfhealPage />);
    fireEvent.click(await screen.findByRole("button", { name: "清除熔断" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "A 已人工裁决" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清除" }));
    expect(
      await screen.findByText("已裁决 rr-a；仍有 rr-b 待裁决，Tier2 熔断保持"),
    ).toBeTruthy();
    expect(screen.queryByText("已清除部署熔断，Tier2 放行恢复可用")).toBeNull();
  });
});
