import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession, ContextHealthReport } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { ContextSlimModal } from "./ContextSlimModal";
import { ContextArchiveDrawer } from "./ContextArchiveDrawer";
import {
  _resetAutoDreamRunningForTest,
  AutoDreamToggleRow,
  ContextHealthSummaryCard,
  formatRestoreOutcomeFeedback,
} from "./MemoryContextHealthCard";

const auth = {
  snapshot: () => ({ token: "t", epoch: 1 }),
} as unknown as AuthSession;

const SAMPLE_REPORT: ContextHealthReport = {
  agentId: "main",
  generatedAt: "2026-11-22T00:00:00.000Z",
  status: "warning",
  totalBytes: 42_000,
  reclaimableBytes: 24_500,
  slots: [],
  summary: {
    coreMemoryCount: 12,
    coreMemoryBytes: 14_000,
    coreMemoryIndexBytes: 2_000,
    expiredMemoryCount: 1,
    oversizedMemoryCount: 1,
    activeSkillCount: 20,
    activeSkillBytes: 24_000,
    coldSkillCount: 1,
    oversizedSkillCount: 0,
    skillHistoryCount: 12,
    skillHistoryBytes: 10_000,
    claudeMdBytes: 2_000,
    userMdBytes: 1_000,
    archivalCount: 10,
    archivalBytes: 4_000,
    staleArchivalCount: 1,
    archivedMemoryCount: 2,
    archivedSkillCount: 1,
  },
  slimCandidates: [
    {
      id: "cand-mem-1",
      kind: "expired_memory",
      target: "memory/old-release.md",
      label: "旧发版记录",
      bytes: 4_500,
      reason: "已超过保留截止日期",
      safeAutoArchive: true,
      actionable: true,
      reversible: true,
    },
    {
      id: "cand-skill-1",
      kind: "cold_skill",
      target: "skill/legacy-helper",
      label: "legacy-helper",
      bytes: 8_000,
      reason: "超过 60 天未使用",
      safeAutoArchive: true,
      actionable: true,
      reversible: true,
    },
    {
      id: "skill_history:alpha",
      kind: "skill_history",
      target: "alpha",
      label: "alpha 历史快照",
      bytes: 6_000,
      reason: "历史快照 6 份，可滚动裁剪多余的 1 份旧版本",
      safeAutoArchive: false,
      actionable: true,
      reversible: false,
      meta: { name: "alpha" },
    },
    {
      id: "skill_history:beta",
      kind: "skill_history",
      target: "beta",
      label: "beta 历史快照",
      bytes: 4_000,
      reason: "历史快照 6 份，可滚动裁剪多余的 1 份旧版本",
      safeAutoArchive: false,
      actionable: true,
      reversible: false,
      meta: { name: "beta" },
    },
    {
      id: "stale_archival:arch-99",
      kind: "stale_archival",
      target: "arch-99",
      label: "过期低频归档记忆 (1 条)",
      bytes: 2_000,
      reason: "超过 60 天且零命中",
      safeAutoArchive: false,
      actionable: true,
      reversible: false,
      meta: { ids: ["arch-99"] },
    },
  ],
  recentRuns: [
    {
      runId: "run-sem-1",
      batchId: "batch-sem-1",
      agentId: "main",
      mode: "auto",
      dryRun: false,
      startedAt: "2026-11-22T00:00:00.000Z",
      finishedAt: "2026-11-22T00:00:02.000Z",
      expiredMemoriesArchived: 1,
      coldSkillsArchived: 0,
      skillHistoriesPruned: 0,
      archivalDecayed: 0,
      archivalCleaned: 0,
      bytesFreed: 5_000,
      archivedMemoryFiles: ["old-release.md"],
      archivedSkillNames: [],
      mergedMemoryGroups: 2,
      mergedMemorySources: 5,
      semanticSummary: "昨晚已自动合并 2 组相似记忆并收纳 1 条过期记录",
      errors: [],
    },
  ],
};

describe("ContextSlimModal, ContextArchiveDrawer & MemoryContextHealthCard (OCV5-840 / OCV5-841)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetAutoDreamRunningForTest();
  });
  afterEach(() => {
    cleanup();
    _resetAutoDreamRunningForTest();
  });

  it("OCV5-841: ContextHealthSummaryCard shows 运行中 when enabled and 已暂停 when disabled (never hardcoded)", () => {
    const onOpenSlim = vi.fn();
    const onOpenArchive = vi.fn();

    const { rerender } = render(
      <ContextHealthSummaryCard
        report={SAMPLE_REPORT}
        autoEnabled={true}
        onOpenSlim={onOpenSlim}
        onOpenArchive={onOpenArchive}
      />,
    );

    const card = screen.getByTestId("context-health-summary-card");
    expect(screen.getByText("上下文自动保持干净")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("昨晚已自动合并 2 组相似记忆并收纳 1 条过期记录")).toBeTruthy();
    expect(card.textContent).not.toMatch(/常驻底噪|CLAUDE|KB|L1\/L2/i);

    fireEvent.click(screen.getByRole("button", { name: /查看已收纳记录（3）/ }));
    expect(onOpenArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "手动整理" }));
    expect(onOpenSlim).toHaveBeenCalledTimes(1);

    // W2: when auto-dream is paused/off, must show 已暂停 and NOT 运行中
    rerender(
      <ContextHealthSummaryCard
        report={SAMPLE_REPORT}
        autoEnabled={false}
        onOpenSlim={onOpenSlim}
        onOpenArchive={onOpenArchive}
      />,
    );
    expect(screen.queryByText("运行中")).toBeNull();
    expect(screen.getByText("已暂停")).toBeTruthy();
  });

  it("pre-selects only reversible candidates, leaves permanent items unchecked with irreversible warnings", async () => {
    const archiveMem = vi.spyOn(api, "archiveMemoryFiles").mockResolvedValue({
      ok: true,
      batchId: "b1",
      archived: [
        {
          id: "m1",
          batchId: "b1",
          slug: "old-release",
          file: "old-release.md",
          originalRelPath: "memory/old-release.md",
          archivedRelPath: "memory-archive/batches/b1/m1__old-release.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "manual_slim",
          actor: "ui",
          bytes: 4_500,
        },
      ],
      skipped: [],
      bytesSaved: 4_500,
    });
    const archiveSkill = vi.spyOn(api, "archiveSkill").mockResolvedValue({
      ok: true,
      batchId: "b2",
      entry: {
        id: "s1",
        batchId: "b2",
        name: "legacy-helper",
        archivedRelPath: "skills-archive/batches/b2/s1__legacy-helper",
        archivedAt: "2026-11-22T00:00:00.000Z",
        reason: "manual_slim",
        actor: "ui",
        bytes: 8_000,
      },
    });
    const runHygiene = vi.spyOn(api, "runContextHygiene");
    const onSlimmed = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <ToastProvider>
        <ContextSlimModal
          open
          onOpenChange={onOpenChange}
          auth={auth}
          agentId="main"
          report={SAMPLE_REPORT}
          onSlimmed={onSlimmed}
        />
      </ToastProvider>,
    );

    // Group headers strictly separate reversible archive vs permanent cleanup
    expect(screen.getByRole("region", { name: /安全收纳（可随时在已收纳记录恢复）/ })).toBeTruthy();
    const permanentRegion = screen.getByRole("region", { name: /永久清理（不可撤销，不进已收纳记录）/ });
    expect(permanentRegion).toBeTruthy();
    expect(within(permanentRegion).getAllByText("不可撤销").length).toBe(3);

    // Reversible items are pre-checked; permanent skill_history & stale_archival are UNCHECKED by default
    expect((screen.getByRole("checkbox", { name: "选择 旧发版记录" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择 legacy-helper" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择 alpha 历史快照" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "选择 beta 历史快照" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "选择 过期低频归档记忆 (1 条)" }) as HTMLInputElement).checked).toBe(false);

    const submitBtn = screen.getByRole("button", { name: /安全收纳所选项（2）/ });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSlimmed).toHaveBeenCalledTimes(1));
    expect(archiveMem).toHaveBeenCalledWith(auth, "main", ["old-release.md"], "manual_slim");
    expect(archiveSkill).toHaveBeenCalledWith(auth, "legacy-helper", "manual_slim");
    expect(runHygiene).not.toHaveBeenCalled();
  });

  it("B2: sends exact pruneSkillHistoryNames:['alpha'] without 'beta' when only alpha is checked", async () => {
    const archiveMem = vi.spyOn(api, "archiveMemoryFiles");
    const archiveSkill = vi.spyOn(api, "archiveSkill");
    const runHygiene = vi.spyOn(api, "runContextHygiene").mockResolvedValue({
      ok: true,
      run: {
        runId: "r-alpha",
        batchId: null,
        agentId: "main",
        mode: "manual",
        dryRun: false,
        startedAt: "2026-11-22T00:00:00.000Z",
        finishedAt: "2026-11-22T00:00:01.000Z",
        expiredMemoriesArchived: 0,
        coldSkillsArchived: 0,
        skillHistoriesPruned: 1,
        archivalDecayed: 0,
        archivalCleaned: 0,
        bytesFreed: 6_000,
        archivedMemoryFiles: [],
        archivedSkillNames: [],
        errors: [],
      },
    });
    const onSlimmed = vi.fn();

    render(
      <ToastProvider>
        <ContextSlimModal
          open
          onOpenChange={vi.fn()}
          auth={auth}
          agentId="main"
          report={SAMPLE_REPORT}
          onSlimmed={onSlimmed}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 旧发版记录" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 legacy-helper" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 alpha 历史快照" }));

    const submitBtn = screen.getByRole("button", { name: /永久清理所选项（1）/ });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSlimmed).toHaveBeenCalledTimes(1));
    expect(archiveMem).not.toHaveBeenCalled();
    expect(archiveSkill).not.toHaveBeenCalled();
    expect(runHygiene).toHaveBeenCalledTimes(1);
    expect(runHygiene).toHaveBeenCalledWith(auth, "main", {
      dryRun: false,
      archiveExpiredMemories: false,
      archiveColdSkills: false,
      pruneSkillHistory: true,
      pruneSkillHistoryNames: ["alpha"],
      decayArchival: false,
    });
    const toastEl = screen.getByText(/已永久清理 1 项旧快照\/过期记录/);
    expect(toastEl).toBeTruthy();
    expect(toastEl.textContent).not.toContain("恢复原样");
    expect(toastEl.textContent).not.toContain("已安全收纳");
  });

  it("forwards exact pruneArchivalIds alongside reversible archive and distinguishes both in toast", async () => {
    vi.spyOn(api, "archiveMemoryFiles").mockResolvedValue({
      ok: true,
      batchId: "b3",
      archived: [
        {
          id: "m1",
          batchId: "b3",
          slug: "old-release",
          file: "old-release.md",
          originalRelPath: "memory/old-release.md",
          archivedRelPath: "memory-archive/batches/b3/m1__old-release.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "manual_slim",
          actor: "ui",
          bytes: 4_500,
        },
      ],
      skipped: [],
      bytesSaved: 4_500,
    });
    vi.spyOn(api, "archiveSkill").mockResolvedValue({
      ok: true,
      batchId: "b4",
      entry: {
        id: "s1",
        batchId: "b4",
        name: "legacy-helper",
        archivedRelPath: "skills-archive/batches/b4/s1__legacy-helper",
        archivedAt: "2026-11-22T00:00:00.000Z",
        reason: "manual_slim",
        actor: "ui",
        bytes: 8_000,
      },
    });
    const runHygiene = vi.spyOn(api, "runContextHygiene").mockResolvedValue({
      ok: true,
      run: {
        runId: "r-arch",
        batchId: null,
        agentId: "main",
        mode: "manual",
        dryRun: false,
        startedAt: "2026-11-22T00:00:00.000Z",
        finishedAt: "2026-11-22T00:00:01.000Z",
        expiredMemoriesArchived: 0,
        coldSkillsArchived: 0,
        skillHistoriesPruned: 0,
        archivalDecayed: 1,
        archivalCleaned: 1,
        bytesFreed: 2_000,
        archivedMemoryFiles: [],
        archivedSkillNames: [],
        errors: [],
      },
    });
    const onSlimmed = vi.fn();

    render(
      <ToastProvider>
        <ContextSlimModal
          open
          onOpenChange={vi.fn()}
          auth={auth}
          agentId="main"
          report={SAMPLE_REPORT}
          onSlimmed={onSlimmed}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 过期低频归档记忆 (1 条)" }));
    fireEvent.click(screen.getByRole("button", { name: /收纳 2 项并永久清理 1 项/ }));

    await waitFor(() => expect(onSlimmed).toHaveBeenCalledTimes(1));
    expect(runHygiene).toHaveBeenCalledWith(auth, "main", {
      dryRun: false,
      archiveExpiredMemories: false,
      archiveColdSkills: false,
      pruneSkillHistory: false,
      decayArchival: true,
      pruneArchivalIds: ["arch-99"],
    });
    const toastMsg = screen.getByText(/已安全收纳 2 项（随时可在已收纳记录恢复原样）；已永久清理 1 项旧快照\/过期记录/);
    expect(toastMsg).toBeTruthy();
  });

  it("OCV5-841: ContextArchiveDrawer labels semantic merge batches warmly and supports single/batch restore", async () => {
    vi.spyOn(api, "listArchivedMemories").mockResolvedValue({
      items: [
        {
          id: "arch-1",
          batchId: "batch-sem-20261122",
          slug: "old-release",
          file: "old-release.md",
          originalRelPath: "memory/old-release.md",
          archivedRelPath: "memory-archive/batches/batch-sem-20261122/arch-1__old-release.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "semantic_auto_merge",
          actor: "semantic_merger",
          bytes: 2_048,
          title: "旧发版记录",
        },
      ],
    });
    vi.spyOn(api, "listArchivedSkills").mockResolvedValue({ items: [] });
    const restoreMem = vi.spyOn(api, "restoreArchivedMemories").mockResolvedValue({
      ok: true,
      restored: [
        {
          id: "arch-1",
          batchId: "batch-sem-20261122",
          slug: "old-release",
          file: "old-release.md",
          originalRelPath: "memory/old-release.md",
          archivedRelPath: "memory-archive/batches/batch-sem-20261122/arch-1__old-release.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "semantic_auto_merge",
          actor: "semantic_merger",
          bytes: 2_048,
          title: "旧发版记录",
        },
      ],
      skipped: [],
    });
    const onRestored = vi.fn();

    render(
      <TooltipProvider>
        <ToastProvider>
          <ContextArchiveDrawer
            open
            onOpenChange={vi.fn()}
            auth={auth}
            agentId="main"
            onRestored={onRestored}
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    expect(await screen.findByText("已收纳记录 · 随时可恢复")).toBeTruthy();
    expect(await screen.findByText(/自动合并相似记忆 · 原件 1 条/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /撤销本次自动整理/ })).toBeTruthy();

    const restoreBtn = screen.getByRole("button", { name: /恢复原样/ });
    fireEvent.click(restoreBtn);

    await waitFor(() => expect(restoreMem).toHaveBeenCalledWith(auth, "main", { id: "arch-1" }));
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("B2: AutoDreamToggleRow quick cleanup only archives expired memories (never permanent prune/decay)", async () => {
    vi.spyOn(api, "getPreferences").mockResolvedValue({
      prefs: {},
      features: {
        auto_dream: {
          eligible: true,
          available: true,
          enabled: true,
          optimizer_enabled: false,
          legacy_enabled: true,
          effective: true,
          telemetry_ready: null,
          telemetry_blockers: [],
          minimum_plan_code: "max",
          min_interval_hours: 24,
          min_new_sessions: 5,
        },
      },
    } as Awaited<ReturnType<typeof api.getPreferences>>);
    const runHygiene = vi.spyOn(api, "runContextHygiene").mockResolvedValue({
      ok: true,
      run: {
        runId: "r-safe",
        batchId: "b-safe",
        agentId: "main",
        mode: "manual",
        dryRun: false,
        startedAt: "2026-11-22T00:00:00.000Z",
        finishedAt: "2026-11-22T00:00:01.000Z",
        expiredMemoriesArchived: 2,
        coldSkillsArchived: 0,
        skillHistoriesPruned: 0,
        archivalDecayed: 0,
        archivalCleaned: 0,
        bytesFreed: 4_096,
        archivedMemoryFiles: ["a.md", "b.md"],
        archivedSkillNames: [],
        errors: [],
      },
    });
    const onChanged = vi.fn();

    render(
      <TooltipProvider>
        <ToastProvider>
          <AutoDreamToggleRow auth={auth} agentId="main" onChanged={onChanged} />
        </ToastProvider>
      </TooltipProvider>,
    );

    const btn = await screen.findByRole("button", { name: /立即自动整理一次/ });
    fireEvent.click(btn);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(runHygiene).toHaveBeenCalledWith(auth, "main", {
      dryRun: false,
      archiveExpiredMemories: true,
      archiveColdSkills: false,
      pruneSkillHistory: false,
      decayArchival: false,
    });
    expect(screen.getByText(/自动整理完成：已收纳 2 条过期记忆.*恢复原样/)).toBeTruthy();
  });

  it("W2: AutoDreamToggleRow undoBatch reports error honestly on API failure (never fake success)", async () => {
    vi.spyOn(api, "getPreferences").mockResolvedValue({
      prefs: {},
      features: {
        auto_dream: {
          eligible: true,
          available: true,
          enabled: true,
          optimizer_enabled: false,
          legacy_enabled: true,
          effective: true,
          telemetry_ready: null,
          telemetry_blockers: [],
          minimum_plan_code: "max",
          min_interval_hours: 24,
          min_new_sessions: 5,
        },
      },
    } as Awaited<ReturnType<typeof api.getPreferences>>);
    vi.spyOn(api, "getContextHygieneHistory").mockResolvedValue({
      runs: SAMPLE_REPORT.recentRuns,
    });
    vi.spyOn(api, "restoreArchivedMemories").mockRejectedValue(new Error("boom 500"));
    vi.spyOn(api, "restoreArchivedSkills").mockResolvedValue({
      ok: true,
      restored: [],
      skipped: [],
    });
    const onChanged = vi.fn();

    render(
      <TooltipProvider>
        <ToastProvider>
          <AutoDreamToggleRow
            auth={auth}
            agentId="main"
            recentHygieneRuns={SAMPLE_REPORT.recentRuns}
            onChanged={onChanged}
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    const historyToggle = await screen.findByRole("button", { name: /最近整理记录/ });
    fireEvent.click(historyToggle);
    const undoBtn = await screen.findByRole("button", { name: /撤销本次自动整理/ });
    fireEvent.click(undoBtn);

    expect(await screen.findByText("恢复未成功，请稍后重试")).toBeTruthy();
    expect(screen.queryByText(/已恢复原样/)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("W2: ContextArchiveDrawer reports preservedEditedFiles honestly without claiming full restore", async () => {
    vi.spyOn(api, "listArchivedMemories").mockResolvedValue({
      items: [
        {
          id: "arch-edit-1",
          batchId: "batch-edit-1",
          slug: "old-a",
          file: "old-a.md",
          originalRelPath: "memory/old-a.md",
          archivedRelPath: "memory-archive/batches/batch-edit-1/arch-edit-1__old-a.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "semantic_auto_merge",
          actor: "semantic_merger",
          bytes: 1_024,
          title: "旧记录 A",
        },
      ],
    });
    vi.spyOn(api, "listArchivedSkills").mockResolvedValue({ items: [] });
    vi.spyOn(api, "restoreArchivedMemories").mockResolvedValue({
      ok: true,
      restored: [
        {
          id: "arch-edit-1",
          batchId: "batch-edit-1",
          slug: "old-a",
          file: "old-a.md",
          originalRelPath: "memory/old-a.md",
          archivedRelPath: "memory-archive/batches/batch-edit-1/arch-edit-1__old-a.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "semantic_auto_merge",
          actor: "semantic_merger",
          bytes: 1_024,
          title: "旧记录 A",
        },
      ],
      skipped: [],
      preservedEditedFiles: ["merged-note.edited-1234.md"],
    });
    const onRestored = vi.fn();

    render(
      <TooltipProvider>
        <ToastProvider>
          <ContextArchiveDrawer
            open
            onOpenChange={vi.fn()}
            auth={auth}
            agentId="main"
            onRestored={onRestored}
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    const undoBtn = await screen.findByRole("button", { name: /撤销本次自动整理/ });
    fireEvent.click(undoBtn);

    expect(
      await screen.findByText("已恢复 1 项，另有 1 项因含人工修改或已存在而安全保留"),
    ).toBeTruthy();
    expect(screen.queryByText(/已恢复原样/)).toBeNull();
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("W2 residual: distinguishes archive_corrupted / archive_missing_or_invalid from safe target_exists preservation", () => {
    const corruptedMixed = formatRestoreOutcomeFeedback([
      {
        status: "fulfilled",
        value: {
          ok: true,
          restored: ["a.md"],
          skipped: ["b.md:archive_corrupted"],
        },
      },
    ]);
    expect(corruptedMixed).toEqual({
      message: "已恢复 1 项，另有 1 项未能恢复（归档文件缺失或损坏）",
      tone: "info",
      changed: true,
    });
    expect(corruptedMixed.message).not.toContain("安全保留");
    expect(corruptedMixed.message).not.toContain("已恢复原样");

    const allMixed = formatRestoreOutcomeFeedback([
      {
        status: "fulfilled",
        value: {
          ok: true,
          restored: ["a.md"],
          skipped: ["c.md:target_exists", { id: "d", reason: "archive_missing_or_invalid" }],
        },
      },
    ]);
    expect(allMixed).toEqual({
      message: "已恢复 1 项，另有 1 项因含人工修改或已存在而安全保留，另有 1 项未能恢复（归档文件缺失或损坏）",
      tone: "info",
      changed: true,
    });
  });
});
