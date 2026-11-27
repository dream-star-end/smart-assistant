import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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
    approveEffect: "立即生效并自动继续发版",
    rejectEffect: "退回修改，线上版本保持不变",
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
      summary: "独立复核未发现异常计费变更",
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
  it("renders authoritative card with risk badge, structured 3-row summary, 4 lights, and effect comparison above buttons", async () => {
    mockGetApproval.mockResolvedValueOnce({
      approval: makeApproval({
        riskCategory: "billing_change",
        whatChanged: "调整了计费账本中的超时重试逻辑。",
        whyNeedYou: "改动触及核心计费文件，可能影响扣费方式。",
        recommendation: { action: "approve", label: "建议批准", reason: "仅优化异常处理，未改扣费公式。" },
      }),
    });

    render(<GovernanceApprovalBlock spec={validSpec} />);

    expect(screen.getByTestId("governance-approval-skeleton")).toBeInTheDocument();
    expect(await screen.findByText("服务端权威标题：核心计费文件放行审批")).toBeInTheDocument();
    expect(screen.queryByText("模型伪造的标题（不应直接渲染）")).not.toBeInTheDocument();

    // Risk badge + structured 3-row summary
    expect(screen.getByText("计费方式可能变化")).toBeInTheDocument();
    expect(screen.getByText("改了什么")).toBeInTheDocument();
    expect(screen.getByText("调整了计费账本中的超时重试逻辑。")).toBeInTheDocument();
    expect(screen.getByText("为什么找你")).toBeInTheDocument();
    expect(screen.getByText("改动触及核心计费文件，可能影响扣费方式。")).toBeInTheDocument();
    expect(screen.getByText("助手建议")).toBeInTheDocument();
    expect(screen.getByText("建议批准")).toBeInTheDocument();
    expect(screen.getByText("仅优化异常处理，未改扣费公式。")).toBeInTheDocument();

    // 4 safety lights including compact unknown label
    expect(screen.getByText("商业版隔离")).toBeInTheDocument();
    expect(screen.getByText("计费公式安全")).toBeInTheDocument();
    expect(screen.getByText("数据完整性")).toBeInTheDocument();
    expect(screen.getByText("回滚安全性")).toBeInTheDocument();
    expect(screen.getByText("待核验")).toBeInTheDocument();

    // Comparison card rendered before approve button
    const comparison = screen.getByTestId("governance-effect-comparison");
    const approveBtn = screen.getByRole("button", { name: "批准并自动继续" });
    expect(Boolean(comparison.compareDocumentPosition(approveBtn) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(mockGetApproval).toHaveBeenCalledWith(fakeAuth, "gov-blast_20261127_001", expect.any(AbortSignal));
  });

  it("infers ux_degradation badge and steward fallback recommendation for legacy records without new optional fields", async () => {
    mockGetApproval.mockResolvedValueOnce({
      approval: makeApproval({
        code: "DESTRUCTIVE_DDL_LOCKED",
        scope: "ddl",
        stewardVerdict: { present: true, verdict: "veto", summary: "包含删除字段操作，存在丢数风险。" },
      }),
    });

    render(<GovernanceApprovalBlock spec={validSpec} />);
    expect(await screen.findByText("用户体验可能下降")).toBeInTheDocument();
    expect(screen.getByText("建议驳回")).toBeInTheDocument();
    expect(screen.getByText("包含删除字段操作，存在丢数风险。")).toBeInTheDocument();
  });

  it("rejects invalid approvalId immediately without calling backend", () => {
    render(<GovernanceApprovalBlock spec={{ type: "governance_approval", approvalId: "../etc/passwd" }} />);

    expect(screen.getByTestId("governance-approval-invalid")).toBeInTheDocument();
    expect(mockGetApproval).not.toHaveBeenCalled();
  });

  it("approves with optimistic locks, auto-notifies assistant immediately without secondary button, and hides raw voucher/unit in technical drawer", async () => {
    const pending = makeApproval();
    const approved = makeApproval({
      status: "approved",
      version: 4,
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "bv-20261127-xyz",
        resumeStatus: "started",
        resumeUnit: "oc-v5-gov-resume-01.service",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendUserText = vi.fn();

    render(<GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} chatBusy={false} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));

    expect(await screen.findByText("已由你批准生效，正在自动续跑发版")).toBeInTheDocument();
    expect(mockDecideApproval).toHaveBeenCalledWith(fakeAuth, "gov-blast_20261127_001", {
      decision: "approve",
      note: undefined,
      autoResumeTrain: true,
      expectedVersion: 3,
      expectedSha256: "deadbeef0123456789",
    });

    // Automatically notified assistant immediately without requiring a second click
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("已批准"));
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("bv-20261127-xyz"));
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("已自动拉起发版"));
    expect(screen.getByTestId("governance-approval-auto-notified")).toHaveTextContent("✓ 已自动通知助手继续处理");
    expect(screen.queryByRole("button", { name: /通知助手继续/ })).not.toBeInTheDocument();

    // Raw voucher ID and systemd unit are hidden from main card surface until expanded
    expect(screen.queryByText(/bv-20261127-xyz/)).not.toBeInTheDocument();
    expect(screen.queryByText(/oc-v5-gov-resume-01\.service/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /查看技术详情/ }));
    expect(screen.getByText(/bv-20261127-xyz/)).toBeInTheDocument();
    expect(screen.getByText(/oc-v5-gov-resume-01\.service/)).toBeInTheDocument();
  });

  it("queues auto-notification when chatBusy is true and dispatches once (StrictMode safe) when chatBusy becomes false", async () => {
    const pending = makeApproval();
    const approved = makeApproval({
      status: "approved",
      version: 4,
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "bv-queued-001",
        resumeStatus: "started",
      },
    });
    mockGetApproval.mockResolvedValue({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendUserText = vi.fn();

    const { rerender } = render(
      <StrictMode>
        <GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} chatBusy={true} />
      </StrictMode>,
    );
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));
    expect(await screen.findByTestId("governance-approval-auto-queued")).toHaveTextContent(
      "已生效，待助手本轮结束后自动通知继续",
    );
    expect(sendUserText).not.toHaveBeenCalled();

    rerender(
      <StrictMode>
        <GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} chatBusy={false} />
      </StrictMode>,
    );

    await waitFor(() => expect(sendUserText).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("governance-approval-auto-notified")).toHaveTextContent("✓ 已自动通知助手继续处理");
  });

  it("clears queued auto-notification when approvalId switches before chatBusy finishes", async () => {
    const pending = makeApproval();
    const approved = makeApproval({
      status: "approved",
      version: 4,
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        resumeStatus: "started",
      },
    });
    mockGetApproval
      .mockResolvedValueOnce({ approval: pending })
      .mockResolvedValueOnce({ approval: makeApproval({ id: "gov-blast_20261127_002", title: "另一张审批单" }) });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendUserText = vi.fn();

    const { rerender } = render(
      <GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} chatBusy={true} />,
    );
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));
    expect(await screen.findByTestId("governance-approval-auto-queued")).toBeInTheDocument();

    rerender(
      <GovernanceApprovalBlock
        spec={{ type: "governance_approval", approvalId: "gov-blast_20261127_002" }}
        sendUserText={sendUserText}
        chatBusy={false}
      />,
    );
    expect(await screen.findByText("另一张审批单")).toBeInTheDocument();
    expect(sendUserText).not.toHaveBeenCalled();
  });

  it("shows fallback retry button only when auto-notify throws and succeeds on retry", async () => {
    const pending = makeApproval();
    const approved = makeApproval({
      status: "approved",
      version: 4,
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        resumeStatus: "started",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendUserText = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("socket disconnected");
      })
      .mockImplementationOnce(() => undefined);

    render(<GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} chatBusy={false} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));
    const retryBtn = await screen.findByRole("button", { name: "重试通知助手继续" });
    expect(sendUserText).toHaveBeenCalledTimes(1);

    fireEvent.click(retryBtn);
    expect(sendUserText).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("governance-approval-auto-notified")).toHaveTextContent("✓ 已自动通知助手继续处理");
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
    expect(await screen.findByText(/当前有其他更新进行中/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试自动发版" }));
    expect(await screen.findByText("已由你批准生效，正在自动续跑发版")).toBeInTheDocument();
    expect(mockResumeApproval).toHaveBeenCalledWith(fakeAuth, "gov-blast_20261127_001");
  });

  it("rejects with note, updates card to plain-language rejected state, and auto-notifies assistant with note", async () => {
    const pending = makeApproval();
    const rejected = makeApproval({
      status: "rejected",
      version: 4,
      decision: {
        action: "reject",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        note: "需补充计费单测后再提交",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: rejected });
    const sendUserText = vi.fn();

    render(<GovernanceApprovalBlock spec={validSpec} sendUserText={sendUserText} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");

    fireEvent.change(screen.getByLabelText("审批备注"), { target: { value: "需补充计费单测后再提交" } });
    fireEvent.click(screen.getByRole("button", { name: "驳回并退回" }));

    expect(await screen.findByText("已由你驳回，线上版本保持不变")).toBeInTheDocument();
    expect(screen.getByText(/需补充计费单测后再提交/)).toBeInTheDocument();
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("已驳回"));
    expect(sendUserText).toHaveBeenCalledWith(expect.stringContaining("需补充计费单测后再提交"));
  });

  it("distinguishes 409 approving vs terminal synced state", async () => {
    mockGetApproval
      .mockResolvedValueOnce({ approval: makeApproval() })
      .mockResolvedValueOnce({ approval: makeApproval({ status: "approving" }) });
    mockDecideApproval.mockRejectedValueOnce(new ApiError({ status: 409, message: "in progress", code: "CONFLICT" }));

    const r1 = render(<GovernanceApprovalBlock spec={validSpec} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));
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
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));
    expect(await screen.findByText("该审批单已在其他页面完成处理，已同步最新状态。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看技术详情/ }));
    expect(screen.getByText(/voucher-synced-999/)).toBeInTheDocument();
  });

  it("B8-chat: shows completely neutral unavailable notice with zero existence leakage before confirmed authorization, and allows details/link only after authorization is confirmed", async () => {
    const forbiddenLeakRe = /个人版|自治治理|管理员|治理控制台|审批单/;

    mockGetApproval.mockRejectedValueOnce(new ApiError({ status: 403, message: "Forbidden" }));
    const r1 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el1 = await screen.findByText("该操作卡片当前不可用");
    expect(el1.textContent).not.toMatch(forbiddenLeakRe);
    expect(screen.queryByRole("link", { name: /打开治理控制台/ })).not.toBeInTheDocument();
    r1.unmount();

    mockGetApproval.mockRejectedValueOnce(new ApiError({ status: 404, message: "Disabled", code: "SELFHOST_GOVERNANCE_DISABLED" }));
    const r2 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el2 = await screen.findByText("该操作卡片当前不可用");
    expect(el2.textContent).not.toMatch(forbiddenLeakRe);
    expect(screen.queryByRole("link", { name: /打开治理控制台/ })).not.toBeInTheDocument();
    r2.unmount();

    mockUseOptionalAuth.mockReturnValue(null);
    const r3 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el3 = screen.getByText("该操作卡片当前不可用");
    expect(el3.textContent).not.toMatch(forbiddenLeakRe);
    expect(screen.queryByRole("link", { name: /打开治理控制台/ })).not.toBeInTheDocument();
    r3.unmount();

    // Unconfirmed initial 404 NOT_FOUND must also remain completely neutral without console link
    mockUseOptionalAuth.mockReturnValue(fakeAuth);
    mockGetApproval.mockRejectedValueOnce(new ApiError({ status: 404, message: "Not found", code: "NOT_FOUND" }));
    const r4 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el4 = await screen.findByTestId("governance-approval-not-found");
    expect(el4).toHaveTextContent("该操作卡片当前不可用");
    expect(el4.textContent).not.toMatch(forbiddenLeakRe);
    expect(screen.queryByRole("link", { name: /打开治理控制台/ })).not.toBeInTheDocument();
    r4.unmount();

    // Unconfirmed initial network error: neutral retryable notice, zero console link or leakage
    mockGetApproval.mockRejectedValueOnce(new Error("TypeError: Failed to fetch governance upstream"));
    const r5 = render(<GovernanceApprovalBlock spec={validSpec} />);
    const el5 = await screen.findByTestId("governance-approval-error");
    expect(el5).toHaveTextContent("暂时无法加载该操作卡片，请稍后重试");
    expect(el5.textContent).not.toMatch(forbiddenLeakRe);
    expect(screen.queryByRole("link", { name: /打开治理控制台/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    r5.unmount();

    // Unconfirmed initial 502 error: neutral retryable notice, zero console link or leakage, recovers on retry
    mockGetApproval
      .mockRejectedValueOnce(new ApiError({ status: 502, message: "502 Bad Gateway: selfhost governance" }))
      .mockResolvedValueOnce({ approval: makeApproval() })
      .mockRejectedValueOnce(new ApiError({ status: 404, message: "Not found", code: "NOT_FOUND" }));
    render(<GovernanceApprovalBlock spec={validSpec} />);
    const el6 = await screen.findByTestId("governance-approval-error");
    expect(el6).toHaveTextContent("暂时无法加载该操作卡片，请稍后重试");
    expect(el6.textContent).not.toMatch(forbiddenLeakRe);
    expect(screen.queryByRole("link", { name: /打开治理控制台/ })).not.toBeInTheDocument();

    // Retry succeeds -> authorization is now confirmed; subsequent 404 refresh may show console link
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("服务端权威标题：核心计费文件放行审批")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新审批状态" }));
    expect(await screen.findByText("审批单不存在或已归档")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开治理控制台/ })).toHaveAttribute("href", "/admin/#tab=governance");
  });

  it("BLOCKER 7: awaits async sendUserText acceptance (false / reject) without marking sent, and retries message only without re-deciding", async () => {
    const pending = makeApproval();
    const approved = makeApproval({
      status: "approved",
      version: 4,
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "bv-async-001",
        resumeStatus: "started",
      },
    });

    // Case 1: async Promise.resolve(false) -> stays failed, retry resolves true -> sent once, decide called once
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendFalseThenTrue = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const r1 = render(<GovernanceApprovalBlock spec={validSpec} sendUserText={sendFalseThenTrue} chatBusy={false} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));

    const retryBtn1 = await screen.findByRole("button", { name: "重试通知助手继续" });
    expect(screen.queryByTestId("governance-approval-auto-notified")).not.toBeInTheDocument();
    expect(mockDecideApproval).toHaveBeenCalledTimes(1);
    expect(sendFalseThenTrue).toHaveBeenCalledTimes(1);

    fireEvent.click(retryBtn1);
    expect(await screen.findByTestId("governance-approval-auto-notified")).toHaveTextContent("✓ 已自动通知助手继续处理");
    expect(mockDecideApproval).toHaveBeenCalledTimes(1);
    expect(sendFalseThenTrue).toHaveBeenCalledTimes(2);
    r1.unmount();

    // Case 2: async Promise.reject -> stays failed, retry resolves true -> sent once, decide called once
    mockDecideApproval.mockClear();
    mockGetApproval.mockResolvedValueOnce({ approval: pending });
    mockDecideApproval.mockResolvedValueOnce({ ok: true, approval: approved });
    const sendRejectThenTrue = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("ws disconnected"))
      .mockResolvedValueOnce(true);

    render(<GovernanceApprovalBlock spec={validSpec} sendUserText={sendRejectThenTrue} chatBusy={false} />);
    await screen.findByText("服务端权威标题：核心计费文件放行审批");
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续" }));

    const retryBtn2 = await screen.findByRole("button", { name: "重试通知助手继续" });
    expect(screen.queryByTestId("governance-approval-auto-notified")).not.toBeInTheDocument();
    expect(mockDecideApproval).toHaveBeenCalledTimes(1);
    expect(sendRejectThenTrue).toHaveBeenCalledTimes(1);

    fireEvent.click(retryBtn2);
    expect(await screen.findByTestId("governance-approval-auto-notified")).toHaveTextContent("✓ 已自动通知助手继续处理");
    expect(mockDecideApproval).toHaveBeenCalledTimes(1);
    expect(sendRejectThenTrue).toHaveBeenCalledTimes(2);
  });

  it("BLOCKER 9: hides raw SHA, exit code, and resume unit on failed main card until technical details drawer is expanded", async () => {
    const failedApproval = makeApproval({
      status: "approved",
      version: 5,
      lastError: "wrapper aborted (exit=1)",
      decision: {
        action: "approve",
        decidedBy: "admin-uid3",
        decidedAt: new Date().toISOString(),
        issuedArtifactId: "voucher-fail-009",
        resumeStatus: "failed",
        resumeDetail: "发版单元执行失败 (exit=1, sha=a1b2c3d4e5f6)",
        resumeUnit: "oc-v5-gov-resume-unit-1",
      },
    });
    mockGetApproval.mockResolvedValueOnce({ approval: failedApproval });

    const { container } = render(<GovernanceApprovalBlock spec={validSpec} />);
    expect(
      await screen.findByText("审批已生效，但自动发版未能完成，请点击下方按钮重试；排查详情见「查看技术详情」。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试自动发版" })).toBeInTheDocument();

    // Collapsed drawer: zero raw SHA / exit=1 / systemd unit / voucher ID leakage on main card
    expect(container.textContent).not.toContain("a1b2c3d4e5f6");
    expect(container.textContent).not.toContain("exit=1");
    expect(container.textContent).not.toContain("oc-v5-gov-resume-unit-1");
    expect(container.textContent).not.toContain("voucher-fail-009");

    // Expanding technical details drawer reveals full diagnostics
    fireEvent.click(screen.getByRole("button", { name: /查看技术详情/ }));
    expect(screen.getAllByText(/a1b2c3d4e5f6/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/exit=1/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/oc-v5-gov-resume-unit-1/)).toBeInTheDocument();
    expect(screen.getByText(/voucher-fail-009/)).toBeInTheDocument();
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
