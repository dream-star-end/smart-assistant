import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TooltipProvider } from "../../../components/ui";
import type {
  GovernanceOverviewResponse,
  PendingGovernanceApproval,
} from "../../../lib/api/governanceApi";
import { ApiError } from "../../../lib/api/http";
import GovernancePage from "./index";

const getGovernanceOverview = vi.fn();
const setGovernanceMode = vi.fn();
const unlockGovernanceBreaker = vi.fn();
const decideGovernanceApproval = vi.fn();
const resumeGovernanceApproval = vi.fn();

vi.mock("../../../lib/api/governanceApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/api/governanceApi")>(
    "../../../lib/api/governanceApi",
  );
  return {
    ...actual,
    getGovernanceOverview: (...args: unknown[]) => getGovernanceOverview(...args),
    setGovernanceMode: (...args: unknown[]) => setGovernanceMode(...args),
    unlockGovernanceBreaker: (...args: unknown[]) => unlockGovernanceBreaker(...args),
    decideGovernanceApproval: (...args: unknown[]) => decideGovernanceApproval(...args),
    resumeGovernanceApproval: (...args: unknown[]) => resumeGovernanceApproval(...args),
  };
});

function makeApproval(
  over: Partial<PendingGovernanceApproval> = {},
): PendingGovernanceApproval {
  return {
    id: "gov-blast-001",
    kind: "blast_voucher",
    status: "pending",
    code: "BILLING_CORE_LOCKED",
    scope: "billing_noncore",
    branch: "feat/selfhost-fix",
    sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    trainId: "train-20261127-01",
    ticketId: "OCV5-914",
    version: 1,
    sha256: "e3b0c44298fc1c149afbf4c8996fb924",
    title: "放行计费辅助适配层改动",
    plainSummary: "本次仅调整日志与超时兜底，不改动扣费公式与账本余额写入逻辑。",
    approveEffect: "签发 4 小时一次性凭证并自动续跑当前发版列车",
    rejectEffect: "终止本次发版并退回工程师整改",
    files: ["packages/commercial/src/billing/proxyBilling.ts"],
    totalChangedFiles: 1,
    safetyLights: [
      {
        key: "commercialIsolation",
        label: "商业版隔离",
        level: "green",
        detail: "仅限个人自托管分支，未触碰商业生产分支",
      },
      {
        key: "billingFormulaSafety",
        label: "计费公式安全",
        level: "yellow",
        detail: "命中计费目录辅助文件，需人工复核确认无扣费变更",
      },
      {
        key: "dataIntegrity",
        label: "数据安全",
        level: "green",
        detail: "无破坏性 DDL 或删表操作",
      },
      {
        key: "rollbackSafety",
        label: "可回滚保障",
        level: "unknown",
        detail: "暂未采集到历史回滚基准数据",
      },
    ],
    stewardVerdict: {
      present: true,
      verdict: "approve",
      authorFamily: "Anthropic Claude",
      stewardFamily: "OpenAI GPT",
      stewardModel: "gpt-5.4",
      hmacVerified: true,
      summary: "跨家族审计确认未改动任何计费公式或 SQL 写路径。",
    },
    createdAt: "2026-11-27T01:00:00Z",
    expiresAt: "2026-11-28T01:00:00Z",
    ...over,
  };
}

function makeOverview(
  over: Partial<GovernanceOverviewResponse> = {},
): GovernanceOverviewResponse {
  return {
    enabled: true,
    mode: {
      mode: "autonomous",
      effectiveMode: "autonomous",
      corrupt: false,
      autoMergeFrozen: false,
      reason: "默认全自动运行",
      updatedAt: "2026-11-27T00:30:00Z",
      updatedBy: "admin:uid3",
    },
    breaker: {
      tripped: false,
      cardLines: [],
      costTripped: false,
      recentRollbacks: 0,
    },
    pendingApprovals: [makeApproval()],
    recentDecisions: [
      makeApproval({
        id: "gov-prev-001",
        status: "approved",
        title: "历史放行记录",
        decision: {
          action: "approve",
          decidedBy: "admin:uid3",
          decidedAt: "2026-11-26T18:00:00Z",
          issuedArtifactId: "voucher-prev-99",
          resumeStatus: "not_started_busy",
        },
      }),
    ],
    cockpit: {
      available: true,
      generatedAt: "2026-11-27T01:20:00Z",
      overallLight: "unknown",
      gauges: [
        {
          id: "delivery",
          title: "交付稳定性",
          light: "green",
          summary: "近 7 天发版成功率保持在安全区间",
          metrics: [
            { label: "7 天回滚", value: "0 次" },
            { label: "成功率", value: "100%" },
          ],
        },
        {
          id: "telemetry",
          title: "远端指标采集",
          light: "unknown",
          summary: "本周尚未采集到完整样本",
          metrics: [{ label: "样本数", value: "N/A" }],
        },
      ],
    },
    auditTrail: [
      {
        ts: "2026-11-27T01:10:00Z",
        action: "check_blast_radius",
        label: "爆破半径安全拦截",
        actor: "deploy-train",
        outcome: "blocked",
        detail: "拦截 1 个计费目录文件，已生成审批单 gov-blast-001",
      },
    ],
    ...over,
  };
}

function renderPage() {
  return render(
    <TooltipProvider>
      <GovernancePage />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("GovernancePage", () => {
  test("renders disabled notice gracefully on 404 or 403", async () => {
    getGovernanceOverview.mockRejectedValueOnce(
      new ApiError({
        status: 404,
        code: "SELFHOST_GOVERNANCE_DISABLED",
        message: "disabled",
      }),
    );

    renderPage();

    expect(
      await screen.findByText("自治治理控制面仅在个人版自托管实例启用"),
    ).toBeInTheDocument();
  });

  test("renders unknown gray lights, honest audit heading, steward endorsement, and expandable scope details", async () => {
    getGovernanceOverview.mockResolvedValueOnce(makeOverview());

    renderPage();

    expect(await screen.findByText("运行健康 · 近 7 天回滚 0 次")).toBeInTheDocument();
    expect(screen.getByText("放行计费辅助适配层改动")).toBeInTheDocument();
    expect(screen.getByText("宿主记录的近期治理操作流水")).toBeInTheDocument();
    expect(screen.queryByText(/不可篡改/)).not.toBeInTheDocument();
    // Both safety light and cockpit gauge with level="unknown" render neutral "未采集 / 待核验".
    expect(screen.getAllByText("未采集 / 待核验").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/OpenAI GPT（gpt-5\.4） 独立审计通过 · 签章有效/)).toBeInTheDocument();

    // Technical scope files are collapsed by default.
    expect(screen.queryByText("packages/commercial/src/billing/proxyBilling.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看涉及范围/ }));
    expect(screen.getByText("packages/commercial/src/billing/proxyBilling.ts")).toBeInTheDocument();
  });

  test("shows red alert and clears active autonomous highlight when mode config is corrupt/unknown", async () => {
    getGovernanceOverview.mockResolvedValueOnce(
      makeOverview({
        mode: {
          mode: "autonomous",
          effectiveMode: "unknown",
          corrupt: true,
          autoMergeFrozen: true,
          reason: "mode.json 校验失败",
          updatedAt: "2026-11-27T00:30:00Z",
          updatedBy: "system",
        },
      }),
    );

    renderPage();

    expect(await screen.findByText(/物理总闸配置文件缺失或已损坏/)).toBeInTheDocument();
    expect(screen.queryByText("当前生效")).not.toBeInTheDocument();
  });

  test("switches governance mode via inline confirmation without terminal", async () => {
    const initial = makeOverview();
    const updatedMode = {
      mode: "debt_first" as const,
      effectiveMode: "debt_first" as const,
      corrupt: false,
      autoMergeFrozen: true,
      reason: "先清理历史技术债",
      updatedAt: "2026-11-27T01:30:00Z",
      updatedBy: "admin:uid3",
    };
    getGovernanceOverview
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(makeOverview({ mode: updatedMode }));
    setGovernanceMode.mockResolvedValueOnce({ ok: true, mode: updatedMode });

    renderPage();
    await screen.findByText("全自动自治");

    fireEvent.click(screen.getByRole("button", { name: /仅修债暂停新功能/ }));
    fireEvent.change(screen.getByLabelText("切换总闸原因"), {
      target: { value: "先清理历史技术债" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));

    await waitFor(() => {
      expect(setGovernanceMode).toHaveBeenCalledWith(expect.anything(), {
        mode: "debt_first",
        reason: "先清理历史技术债",
      });
    });
    expect(await screen.findByText("自动合入已冻结")).toBeInTheDocument();
  });

  test("requires >=8 char unlock reason and blocks switching to autonomous while breaker is tripped", async () => {
    const tripped = makeOverview({
      mode: {
        mode: "debt_first",
        effectiveMode: "debt_first",
        corrupt: false,
        autoMergeFrozen: true,
        reason: "熔断自动降级",
        updatedAt: "2026-11-27T01:15:00Z",
        updatedBy: "governor",
      },
      breaker: {
        tripped: true,
        reason: "连续两次健康探针失败",
        train: "train-20261127-99",
        triggeredAt: "2026-11-27T01:15:00Z",
        cardLines: ["1. 发版后 /healthz 超时 30s", "2. 系统已自动回滚至稳定版本"],
        costTripped: false,
        recentRollbacks: 2,
      },
    });
    const unlocked = makeOverview({
      breaker: { tripped: false, cardLines: [], costTripped: false, recentRollbacks: 2 },
    });
    getGovernanceOverview.mockResolvedValueOnce(tripped).mockResolvedValueOnce(unlocked);
    unlockGovernanceBreaker.mockResolvedValueOnce({ ok: true, breaker: unlocked.breaker });

    renderPage();
    expect(await screen.findByText("发版熔断器已触发")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /全自动自治/ })).toBeDisabled();

    // Empty or short (<8 chars) reason keeps unlock disabled.
    const unlockBtn = screen.getByRole("button", { name: /确认根因并一键解锁/ });
    expect(unlockBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("熔断解锁原因"), { target: { value: "已修好" } });
    expect(unlockBtn).toBeDisabled();
    expect(unlockGovernanceBreaker).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("熔断解锁原因"), {
      target: { value: "已定位连接池配置并验证恢复" },
    });
    expect(unlockBtn).not.toBeDisabled();
    fireEvent.click(unlockBtn);

    await waitFor(() => {
      expect(unlockGovernanceBreaker).toHaveBeenCalledWith(expect.anything(), {
        reason: "已定位连接池配置并验证恢复",
      });
    });
    expect(await screen.findByText("运行健康 · 近 7 天回滚 2 次")).toBeInTheDocument();
  });

  test("approves pending item with optimistic lock fields and supports safe retry resume on busy train", async () => {
    const busyApproved = makeApproval({
      status: "approved",
      version: 2,
      decision: {
        action: "approve",
        decidedBy: "admin:uid3",
        decidedAt: "2026-11-27T01:35:00Z",
        note: "核对无误，放行",
        issuedArtifactId: "voucher-20261127-abc",
        resumeStatus: "not_started_busy",
      },
    });
    const resumedApproved = makeApproval({
      ...busyApproved,
      decision: {
        ...busyApproved.decision!,
        resumeStatus: "started",
        resumeUnit: "oc-v5-resume-abc",
      },
    });
    getGovernanceOverview
      .mockResolvedValueOnce(makeOverview())
      .mockResolvedValueOnce(makeOverview({ pendingApprovals: [], recentDecisions: [busyApproved] }))
      .mockResolvedValueOnce(makeOverview({ pendingApprovals: [], recentDecisions: [resumedApproved] }));
    decideGovernanceApproval.mockResolvedValueOnce({ ok: true, approval: busyApproved });
    resumeGovernanceApproval.mockResolvedValueOnce({ ok: true, approval: resumedApproved });

    renderPage();
    await screen.findByText("放行计费辅助适配层改动");

    fireEvent.change(screen.getByLabelText("审批备注"), { target: { value: "核对无误，放行" } });
    fireEvent.click(screen.getByRole("button", { name: "批准并自动继续发版" }));

    await waitFor(() => {
      expect(decideGovernanceApproval).toHaveBeenCalledWith(expect.anything(), "gov-blast-001", {
        decision: "approve",
        note: "核对无误，放行",
        autoResumeTrain: true,
        expectedVersion: 1,
        expectedSha256: "e3b0c44298fc1c149afbf4c8996fb924",
      });
    });

    expect(
      await screen.findByText("当前没有需要你拍板的拦截项，代码自治流水线正常运转中"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /近期已裁决记录/ }));
    expect(screen.getByText(/发版锁正忙，凭证已签发但未自动发车/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /仅重触发版（复用已签凭证）/ }));
    await waitFor(() => {
      expect(resumeGovernanceApproval).toHaveBeenCalledWith(expect.anything(), "gov-blast-001");
    });
    expect(await screen.findByText(/已自动拉起发版列车/)).toBeInTheDocument();
  });

  test("renders head_moved and reconcile_required statuses truthfully without resume button", async () => {
    getGovernanceOverview.mockResolvedValueOnce(
      makeOverview({
        pendingApprovals: [],
        recentDecisions: [
          makeApproval({
            id: "gov-head-001",
            status: "approved",
            title: "主分支前进单",
            decision: {
              action: "approve",
              decidedBy: "admin:uid3",
              decidedAt: "2026-11-27T01:10:00Z",
              issuedArtifactId: "voucher-head-1",
              resumeStatus: "head_moved",
            },
          }),
          makeApproval({
            id: "gov-rec-001",
            status: "reconcile_required",
            title: "需核对异常单",
            lastError: "状态写入中断",
            decision: {
              action: "approve",
              decidedBy: "admin:uid3",
              decidedAt: "2026-11-27T01:12:00Z",
              issuedArtifactId: "voucher-rec-1",
            },
          }),
        ],
      }),
    );

    renderPage();
    await screen.findByText("当前没有需要你拍板的拦截项，代码自治流水线正常运转中");
    fireEvent.click(screen.getByRole("button", { name: /近期已裁决记录/ }));

    expect(screen.getByText(/主分支已前进到新提交，未自动发版/)).toBeInTheDocument();
    expect(screen.getByText("需核对状态，请勿重复签发")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /仅重触发版/ })).not.toBeInTheDocument();
  });

  test("aborts in-flight overview fetch on unmount", () => {
    let capturedSignal: AbortSignal | undefined;
    getGovernanceOverview.mockImplementationOnce((_auth: unknown, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {
        // Keep pending to verify unmount abort.
      });
    });

    const { unmount } = renderPage();
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("shows uninitialized warning badge without frozen label and breaker readError alert instead of healthy green", async () => {
    getGovernanceOverview.mockResolvedValueOnce(
      makeOverview({
        mode: {
          mode: "autonomous",
          effectiveMode: "autonomous",
          uninitialized: true,
          autoMergeFrozen: false,
          reason: "模式文件尚未初始化（列车当前默认按全自动放行，建议显式保存运行模式）",
          updatedAt: "2026-11-27T00:30:00Z",
          updatedBy: "system",
        },
        breaker: {
          tripped: false,
          cardLines: [],
          costTripped: false,
          recentRollbacks: 0,
          readError: true,
          readErrorMessage: "breaker.json JSON 解析失败",
        },
      }),
    );

    renderPage();

    expect(await screen.findByText("尚未初始化（默认按全自动放行）")).toBeInTheDocument();
    expect(screen.queryByText("自动合入已冻结")).not.toBeInTheDocument();
    expect(screen.getByText("熔断状态文件读取异常，无法确认健康")).toBeInTheDocument();
    expect(screen.getByText("breaker.json JSON 解析失败")).toBeInTheDocument();
    expect(screen.queryByText(/运行健康/)).not.toBeInTheDocument();
  });

  test("disables retry on starting/running, shows failed reason with retry, and displays expired auto-reissue hint", async () => {
    const failedApproval = makeApproval({
      id: "gov-failed-001",
      status: "approved",
      title: "续跑失败记录",
      decision: {
        action: "approve",
        decidedBy: "admin:uid3",
        decidedAt: "2026-11-27T01:20:00Z",
        issuedArtifactId: "voucher-fail-1",
        resumeStatus: "failed",
        resumeDetail: "systemd unit exited with status 1",
      },
    });
    const retriedApproval = makeApproval({
      ...failedApproval,
      decision: {
        ...failedApproval.decision!,
        resumeStatus: "running",
        resumeUnit: "oc-v5-retry-1",
      },
    });

    getGovernanceOverview
      .mockResolvedValueOnce(
        makeOverview({
          pendingApprovals: [],
          recentDecisions: [
            makeApproval({
              id: "gov-starting-001",
              status: "approved",
              title: "正在拉起发版单",
              decision: {
                action: "approve",
                decidedBy: "admin:uid3",
                decidedAt: "2026-11-27T01:25:00Z",
                issuedArtifactId: "voucher-start-1",
                resumeStatus: "starting",
              },
            }),
            failedApproval,
            makeApproval({
              id: "gov-expired-001",
              status: "expired",
              title: "已过期审批单",
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(makeOverview({ pendingApprovals: [], recentDecisions: [retriedApproval] }));
    resumeGovernanceApproval.mockResolvedValueOnce({ ok: true, approval: retriedApproval });

    renderPage();
    await screen.findByText("当前没有需要你拍板的拦截项，代码自治流水线正常运转中");
    fireEvent.click(screen.getByRole("button", { name: /近期已裁决记录/ }));

    expect(screen.getByText(/发版列车正在执行中…/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /仅重触发版（发版执行中）/ })).toBeDisabled();
    expect(screen.getByText("失败原因：systemd unit exited with status 1")).toBeInTheDocument();
    expect(
      screen.getByText("该审批单已过期，下次发车拦截时将自动生成新一轮待拍板审批单"),
    ).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /仅重触发版（复用已签凭证）/ });
    expect(retryBtn).not.toBeDisabled();
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(resumeGovernanceApproval).toHaveBeenCalledWith(expect.anything(), "gov-failed-001");
    });
  });
});
