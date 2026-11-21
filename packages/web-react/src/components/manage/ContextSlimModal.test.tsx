import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession, ContextHealthReport } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { ContextSlimModal } from "./ContextSlimModal";
import { ContextArchiveDrawer } from "./ContextArchiveDrawer";
import { AutoDreamToggleRow } from "./MemoryContextHealthCard";

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
      safeAutoArchive: true,
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
      safeAutoArchive: true,
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
      safeAutoArchive: true,
      actionable: true,
      reversible: false,
      meta: { ids: ["arch-99"] },
    },
  ],
  recentRuns: [],
};

describe("ContextSlimModal & ContextArchiveDrawer (OCV5-840)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
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
    expect(screen.getByRole("region", { name: /安全归档（可随时在归档箱还原）/ })).toBeTruthy();
    const permanentRegion = screen.getByRole("region", { name: /永久清理（不可撤销，不进归档箱）/ });
    expect(permanentRegion).toBeTruthy();
    expect(within(permanentRegion).getAllByText("不可撤销").length).toBe(3);

    // Reversible items are pre-checked; permanent skill_history & stale_archival are UNCHECKED by default
    expect((screen.getByRole("checkbox", { name: "选择 旧发版记录" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择 legacy-helper" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "选择 alpha 历史快照" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "选择 beta 历史快照" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "选择 过期低频归档记忆 (1 条)" }) as HTMLInputElement).checked).toBe(false);

    const submitBtn = screen.getByRole("button", { name: /一键安全归档（2）/ });
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSlimmed).toHaveBeenCalledTimes(1));
    expect(archiveMem).toHaveBeenCalledWith(auth, "main", ["old-release.md"], "manual_slim");
    expect(archiveSkill).toHaveBeenCalledWith(auth, "legacy-helper", "manual_slim");
    // Permanent cleanup must NOT be invoked when unchecked
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

    // Uncheck the 2 pre-selected reversible items, then check ONLY alpha (leave beta unchecked)
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
    // Toast reports permanent cleanup honestly without promising restoreability
    const toastEl = screen.getByText(/已永久清理 1 项旧快照\/过期归档/);
    expect(toastEl).toBeTruthy();
    expect(toastEl.textContent).not.toContain("可随时在归档箱还原");
    expect(toastEl.textContent).not.toContain("已安全归档");
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
    fireEvent.click(screen.getByRole("button", { name: /归档 2 项并永久清理 1 项/ }));

    await waitFor(() => expect(onSlimmed).toHaveBeenCalledTimes(1));
    expect(runHygiene).toHaveBeenCalledWith(auth, "main", {
      dryRun: false,
      archiveExpiredMemories: false,
      archiveColdSkills: false,
      pruneSkillHistory: false,
      decayArchival: true,
      pruneArchivalIds: ["arch-99"],
    });
    const toastMsg = screen.getByText(/已安全归档 2 项（可随时在归档箱还原）；已永久清理 1 项旧快照\/过期归档/);
    expect(toastMsg).toBeTruthy();
  });

  it("lists archived memories and restores a single entry", async () => {
    vi.spyOn(api, "listArchivedMemories").mockResolvedValue({
      items: [
        {
          id: "arch-1",
          batchId: "batch-20261122-aaaa",
          slug: "old-release",
          file: "old-release.md",
          originalRelPath: "memory/old-release.md",
          archivedRelPath: "memory-archive/batches/batch-20261122-aaaa/old-release.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "expired",
          actor: "janitor",
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
          batchId: "batch-20261122-aaaa",
          slug: "old-release",
          file: "old-release.md",
          originalRelPath: "memory/old-release.md",
          archivedRelPath: "memory-archive/batches/batch-20261122-aaaa/old-release.md",
          archivedAt: "2026-11-22T00:00:00.000Z",
          reason: "expired",
          actor: "janitor",
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

    const restoreBtn = await screen.findByRole("button", { name: /一键还原/ });
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

    const btn = await screen.findByRole("button", { name: /归档已过期记忆/ });
    fireEvent.click(btn);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(runHygiene).toHaveBeenCalledWith(auth, "main", {
      dryRun: false,
      archiveExpiredMemories: true,
      archiveColdSkills: false,
      pruneSkillHistory: false,
      decayArchival: false,
    });
    expect(screen.getByText(/过期记忆归档完成：已归档 2 条过期记忆.*可随时在归档箱还原/)).toBeTruthy();
  });
});
