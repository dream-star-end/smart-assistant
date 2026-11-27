import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingGovernanceApproval } from "../../lib/api/governanceApi";
import { ApiError } from "../../lib/api/http";
import type { AuthSession } from "../../lib/types";
import GovernanceApprovalBlock, { type GovernanceApprovalSpec } from "./GovernanceApprovalBlock";

const mockUseOptionalAuth = vi.fn<() => AuthSession | null>();
const mockGetApproval = vi.fn();
const mockDecideApproval = vi.fn();
const mockResumeApproval = vi.fn();

vi.mock("../../hooks/useProjectScope", () => ({
  useOptionalAuth: () => mockUseOptionalAuth(),
}));

vi.mock("../../lib/api/governanceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api/governanceApi")>();
  return {
    ...actual,
    getGovernanceApproval: (...args: unknown[]) => mockGetApproval(...args),
    decideGovernanceApproval: (...args: unknown[]) => mockDecideApproval(...args),
    resumeGovernanceApproval: (...args: unknown[]) => mockResumeApproval(...args),
  };
});

const fakeAuth = {
  getToken: () => "tok-admin",
  setToken: vi.fn(),
  clear: vi.fn(),
} as unknown as AuthSession;

function makeApproval(overrides: Partial<PendingGovernanceApproval> = {}): PendingGovernanceApproval {
  return {
    id: "gov-blast_20261127_001",
    kind: "blast_voucher",
    status: "pending",
    code: "BILLING_CORE_LOCKED",
    branch: "feat/ocv5-visual-governance-console",
    sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    trainId: "train-20261127-01",
    ticketId: "OCV5-914",
    version: 3,
    sha256: "deadbeef0123456789",
    title: "服务端权威标题：核心计费文件放行审批",
    plainSummary: "本次变更触及计费防线，需要核验后决定是否放行。",
    approveEffect: "签发一次性放行凭证并尝试自动续跑发版列车",
    rejectEffect: "终止本次发版并退回整改",
    files: ["packages/commercial/src/billing/ledger.ts"],
    totalChangedFiles: 1,
    safetyLights: [
      { key: "commercialIsolation", label: "商业版隔离", level: "green", detail: "仅影响自托管分支" },
      { key: "billingFormulaSafety", label: "计费公式安全", level: "yellow", detail: "涉及账本核心文件，请复核" },
      { key: "dataIntegrity", label: "数据完整性", level: "green", detail: "无破坏性 DDL 变更" },
      { key: "rollbackSafety", label: "回滚安全性", level: "unknown", detail: "尚未采集到回滚演练信号" },
    ],
    stewardVerdict: {
      present: true,
      verdict: "approve",
      stewardFamily: "OpenAI",
      stewardModel: "gpt-5.4",
      hmacVerified: true,
      summary: "跨家族独立审计通过",
    },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

const validSpec: GovernanceApprovalSpec = {
  type: "governance_approval",
  approvalId: "gov-blast_20261127_001",
  title: "模型伪造的标题（不应直接渲染）",
  subtitle: "模型伪造的副标题（不应直接渲染）",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseOptionalAuth.mockReturnValue(fakeAuth);
});

afterEach(() => {
  cleanup();
});

describe("GovernanceApprovalBlock", () => {
  it("fetches authoritative approval by valid approvalId and renders 4 safety lights including unknown without trusting spec text", async () => {
    mockGetApproval.mockResolvedValueOnce({ approval: makeApproval() });

    render(<GovernanceApprovalBlock spec={validSpec} />);

    expect(screen.getByTestId("governance-approval-skeleton")).toBeInTheDocument();
    expect(await screen.findByText("服务端权威标题：核心计费文件放行审批")).toBeInTheDocument();
    expect(screen.queryByText("模型伪造的标题（不应直接渲染）")).not.toBeInTheDocument();
    expect(screen.getByText("商业版隔离")).toBeInTheDocument();
    expect(screen.getByText("计费公式安全")).toBeInTheDocument();
    expect(screen.getByText("数据完整性")).toBeInTheDocument();
    expect(screen.getByText("回滚安全性")).toBeInTheDocument();
    expect(screen.getByText("未采集 / 待核验")).toBeInTheDocument();
    expect(mockGetApproval).toHaveBeenCalledWith(fakeAuth, "gov-blast_20261127_001", expect.any(AbortSignal));
  });

  it("rejects invalid approvalId immediately without calling backend", () => {
    render(<GovernanceApprovalBlock spec={{ type: "governance_approval", approvalId: "../etc/passwd" }} />);

    expect(screen.getByTestId("governance-approval-invalid")).toBeInTheDocument();
    expect(mockGetApproval).not.toHaveBeenCalled();
  });

  it("approves with expectedVersion/expectedSha256, shows artifact & resume status, and supports one-shot assistant notification", async () => {
    const pending = makeApproval();
    const approved = makeApproval({
      status: "approved",
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "voucher-20261127-xyz",
        resumeStatus: "started",
        resumeUnit: "ocv5-train-01.service",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendUserText = vi.fn();

    render(<GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续发版" }));

    expect(await screen.findByText("voucher-20261127-xyz")).toBeInTheDocument();
    expect(screen.getByText(/已自动拉起发版列车/)).toBeInTheDocument();
    expect(mockDecideApproval).toHaveBeenCalledWith(fakeAuth, "gov-blast_20261127_001", {
      decision: "approve",
      note: undefined,
      autoResumeTrain: true,
      expectedVersion: 3,
      expectedSha256: "deadbeef0123456789",
    });

    fireEvent.click(screen.getByRole("button", { name: "通知助手继续验收" }));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("voucher-20261127-xyz"));
    expect(screen.getByRole("button", { name: "已通知助手继续" })).toBeDisabled();
  });

  it("supports safe resume retry without re-issuing voucher when resumeStatus is not_started_busy", async () => {
    const busyApproved = makeApproval({
      status: "approved",
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "voucher-existing-1",
        resumeStatus: "not_started_busy",
      },
    });
    const resumed = makeApproval({
      status: "approved",
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "voucher-existing-1",
        resumeStatus: "started",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: busyApproved });
    mockResumeApproval.mockResolvedValueOnce({ ok: true, approval: resumed });

    render(<GovernanceApprovalBlock spec={validSpec} />);
    expect(await screen.findByText(/发版锁正忙，凭证已签发但未自动发车/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /仅重触发版/ }));
    expect(await screen.findByText(/已自动拉起发版列车/)).toBeInTheDocument();
    expect(mockResumeApproval).toHaveBeenCalledWith(fakeAuth, "gov-blast_20261127_001");
  });

  it("rejects with note and updates card to rejected state", async () => {
    const pending = makeApproval();
    const rejected = makeApproval({
      status: "rejected",
      decision: {
        action: "reject",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        note: "需补充计费单测后再提交",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: rejected });

    render(<GovernanceApprovalBlock spec={validSpec} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.change(screen.getByLabelText("审批备注"), { target: { value: "需补充计费单测后再提交" } });
    fireEvent.click(screen.getByRole("button", { name: "驳回并退回整改" }));

    expect(await screen.findByText(/已由 admin-uid3 驳回退回/)).toBeInTheDocument();
    expect(screen.getByText(/需补充计费单测后再提交/)).toBeInTheDocument();
  });

  it("distinguishes 409 approving vs terminal synced state", async () => {
    mockGetApproval
      .mockResolvedValueOnce({ approval: makeApproval() })
      .mockResolvedValueOnce({ approval: makeApproval({ status: "approving" }) });
    mockDecideApproval.mockRejectedValueOnce(new ApiError({ status: 409, message: "in progress", code: "CONFLICT" }));

    const r1 = render(<GovernanceApprovalBlock spec={validSpec} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续发版" }));
    expect(await screen.findByText("该审批单正在处理中，请稍候刷新。")).toBeInTheDocument();
    r1.unmount();

    mockGetApproval
      .mockResolvedValueOnce({ approval: makeApproval() })
      .mockResolvedValueOnce({
        approval: makeApproval({
          status: "approved",
          decision: { action: "approve", decidedBy: "console-admin", decidedAt: new Date().toISOString(), issuedArtifactId: "voucher-synced-999" },
        }),
      });
    mockDecideApproval.mockRejectedValueOnce(new ApiError({ status: 409, message: "already decided", code: "CONFLICT" }));

    render(<GovernanceApprovalBlock spec={validSpec} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续发版" }));
    expect(await screen.findByText("该审批单已在其他页面完成处理，已同步最新状态。")).toBeInTheDocument();
    expect(screen.getByText("voucher-synced-999")).toBeInTheDocument();
  });

  it("B8-chat: shows completely neutral unavailable notice with zero existence leakage on 401/403/404-disabled/unauthenticated", async () => {
    const forbiddenLeakRe = /个人版|自治治理|管理员/;

    mockGetApproval.mockRejectedValueOnce(new ApiError({ status: 403, message: "Forbidden" }));
    const r1 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el1 = await screen.findByText("该操作卡片当前不可用");
    expect(el1.textContent).not.toMatch(forbiddenLeakRe);
    r1.unmount();

    mockGetApproval.mockRejectedValueOnce(new ApiError({ status: 404, message: "Disabled", code: "SELFHOST_GOVERNANCE_DISABLED" }));
    const r2 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el2 = await screen.findByText("该操作卡片当前不可用");
    expect(el2.textContent).not.toMatch(forbiddenLeakRe);
    r2.unmount();

    mockUseOptionalAuth.mockReturnValue(null);
    const r3 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el3 = screen.getByText("该操作卡片当前不可用");
    expect(el3.textContent).not.toMatch(forbiddenLeakRe);
    r3.unmount();

    mockUseOptionalAuth.mockReturnValue(fakeAuth);
    mockGetApproval.mockRejectedValueOnce(new ApiError({ status: 404, message: "Not found", code: "NOT_FOUND" }));
    render(<GovernanceApprovalBlock spec={validSpec} />);
    expect(await screen.findByText("审批单不存在或已归档")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开治理控制台/ })).toHaveAttribute("href", "/admin/#tab=governance");
  });

  it("NB3: aborts in-flight fetch on unmount and ignores stale responses after switching approvalId", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst!: (val: { approval: PendingGovernanceApproval }) => void;
    mockGetApproval
      .mockImplementationOnce((_auth: unknown, _id: unknown, signal?: AbortSignal) => {
        firstSignal = signal;
        return new Promise((resolve) => { resolveFirst = resolve; });
      })
      .mockResolvedValueOnce({ approval: makeApproval({ id: "gov-blast_20261127_002", title: "新审批单标题" }) });

    const { rerender, unmount } = render(<GovernanceApprovalBlock spec={validSpec} />);
    await waitFor(() => expect(firstSignal).toBeDefined());
    expect(firstSignal?.aborted).toBe(false);

    rerender(<GovernanceApprovalBlock spec={{ type: "governance_approval", approvalId: "gov-blast_20261127_002" }} />);
    expect(firstSignal?.aborted).toBe(true);
    expect(await screen.findByText("新审批单标题")).toBeInTheDocument();

    // Late resolution of first request must not overwrite current card
    resolveFirst({ approval: makeApproval({ id: "gov-blast_20261127_001", title: "迟到的旧审批单标题" }) });
    await Promise.resolve();
    expect(screen.getByText("新审批单标题")).toBeInTheDocument();
    expect(screen.queryByText("迟到的旧审批单标题")).not.toBeInTheDocument();

    unmount();
  });
});
