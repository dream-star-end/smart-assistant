import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultExecFile } from "../selfhostGovernanceExec.js";
import { computeApprovalSha256 } from "../selfhostGovernanceFormat.js";
import { createSelfhostGovernanceService } from "../selfhostGovernanceService.js";
import {
  GovernanceServiceError,
  type ExecFileFn,
  type PendingGovernanceApproval,
  type ProbeUnitStatusResult,
  type SpawnDetachedDeployInput,
} from "../selfhostGovernanceTypes.js";

const NOW_ISO = "2026-11-27T10:00:00Z";
const NOW_DATE = () => new Date(NOW_ISO);
const VALID_SHA = "a".repeat(40);
const MOVED_SHA = "c".repeat(40);

interface RecordedExec {
  file: string;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

function makeSignedApprovalDoc(
  overrides: Partial<PendingGovernanceApproval> & { schemaVersion?: number } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    id: "gov-billing-aaa111222333",
    kind: "blast_voucher",
    status: "pending",
    classification: "human_review_required",
    version: 1,
    code: "BILLING_CORE_LOCKED",
    scope: "billing",
    branch: "feat/v5-selfhost",
    sha: VALID_SHA,
    trainId: "train-20261127-01",
    ticketId: "OCV5-914",
    title: "计费防线拦截：涉及核心计费文件变更",
    plainSummary: "本次提交触及计费账本目录，需管理员确认放行。",
    approveEffect: "批准后签发绑定本次 SHA 的 4 小时爆破半径凭证。",
    rejectEffect: "驳回后不签发任何凭证，继续保持拦截。",
    files: ["packages/commercial/src/billing/remoteNativeTurnBilling.ts"],
    totalChangedFiles: 3,
    safetyLights: [
      { key: "commercialIsolation", label: "商业版隔离", level: "green", detail: "仅改动个人版分支" },
      { key: "billingFormulaSafety", label: "计费公式安全", level: "yellow", detail: "涉及非核心计费文件运行时逻辑" },
      { key: "dataIntegrity", label: "数据无损", level: "green", detail: "无破坏性表结构变更" },
      { key: "rollbackSafety", label: "秒级回滚", level: "green", detail: "双槽可回滚" },
    ],
    stewardVerdict: {
      present: true,
      verdict: "approve",
      authorFamily: "gemini",
      stewardFamily: "openai",
      stewardModel: "gpt-6.2-astra",
      hmacVerified: true,
      summary: "跨家族审计签收通过",
      recordedAt: "2026-11-27T09:50:00Z",
    },
    createdAt: "2026-11-27T09:55:00Z",
    expiresAt: "2026-11-28T09:55:00Z",
    ...overrides,
  };
  base.sha256 = computeApprovalSha256(base);
  return base;
}

describe("selfhostGovernanceService", () => {
  let tmpRoot: string;
  let govRoot: string;
  let ctrlDir: string;
  let pendingDir: string;
  let cockpitDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "ocv5-gov-svc-"));
    govRoot = path.join(tmpRoot, "harness-gate");
    ctrlDir = path.join(govRoot, "control");
    pendingDir = path.join(ctrlDir, "pending-approvals");
    cockpitDir = path.join(tmpRoot, "selfevolve-report");
    await mkdir(pendingDir, { recursive: true });
    await mkdir(cockpitDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeControlFile(relPath: string, content: string): Promise<void> {
    const full = path.join(ctrlDir, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async function writeApproval(doc: Record<string, unknown>): Promise<void> {
    await writeControlFile(path.join("pending-approvals", `${String(doc.id)}.json`), JSON.stringify(doc, null, 2));
  }

  function createFakeGovernor(
    calls: RecordedExec[],
    opts?: { delayDecideMs?: number; breakerTrippedModeReject?: boolean; conflictOnClaim?: boolean },
  ): ExecFileFn {
    return async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      const cmd = args[0];
      if (cmd === "mode") {
        const mode = args[1]!;
        if (mode === "autonomous" && opts?.breakerTrippedModeReject) {
          throw new Error("BREAKER_TRIPPED_USE_UNLOCK: breaker is tripped");
        }
        const reason = args[args.indexOf("--reason") + 1]!;
        const doc = { schemaVersion: 1, mode, autoMergeFrozen: mode !== "autonomous", reason, updatedAt: NOW_ISO, updatedBy: "root" };
        await writeControlFile("mode.json", JSON.stringify(doc, null, 2));
        return { stdout: JSON.stringify(doc), stderr: "" };
      }
      if (cmd === "unlock-breaker") {
        const reason = args[args.indexOf("--reason") + 1]!;
        await writeControlFile("breaker.json", JSON.stringify({ schemaVersion: 1, tripped: false, unlockReason: reason, unlockedAt: NOW_ISO }));
        await writeControlFile("cost-breaker.json", JSON.stringify({ schemaVersion: 1, tripped: false }));
        await rm(path.join(ctrlDir, "breaker-card.md"), { force: true });
        return { stdout: JSON.stringify({ ok: true, mode: "autonomous", tripped: false }), stderr: "" };
      }
      if (cmd === "decide-pending-approval") {
        if (opts?.delayDecideMs) await new Promise((r) => setTimeout(r, opts.delayDecideMs));
        const id = args[args.indexOf("--id") + 1]!;
        const decision = args[args.indexOf("--decision") + 1] as "approve" | "reject";
        const actor = args[args.indexOf("--actor") + 1]!;
        const noteIdx = args.indexOf("--note");
        const expVerIdx = args.indexOf("--expected-version");
        const expShaIdx = args.indexOf("--expected-sha256");
        const p = path.join(pendingDir, `${id}.json`);
        const raw = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
        if (raw.status !== "pending") throw new Error("ALREADY_RESOLVED");
        if (expVerIdx >= 0 && Number(args[expVerIdx + 1]) !== raw.version) throw new Error("CONFLICT_VERSION_MISMATCH");
        if (expShaIdx >= 0 && args[expShaIdx + 1] !== raw.sha256) throw new Error("CONFLICT_SHA256_MISMATCH");
        raw.status = decision === "approve" ? "approved" : "rejected";
        raw.version = Number(raw.version ?? 1) + 1;
        raw.decision = {
          action: decision,
          decidedBy: actor,
          decidedAt: NOW_ISO,
          ...(noteIdx >= 0 ? { note: args[noteIdx + 1] } : {}),
          ...(decision === "approve"
            ? { issuedArtifactId: raw.kind === "blast_voucher" ? "bv-1122334455667788" : "a0-artifact-01", resumeStatus: raw.kind === "blast_voucher" ? "not_started" : "not_applicable" }
            : {}),
        };
        raw.sha256 = computeApprovalSha256(raw);
        await writeFile(p, JSON.stringify(raw, null, 2), "utf8");
        return { stdout: JSON.stringify(raw), stderr: "" };
      }
      if (cmd === "update-approval-resume") {
        const id = args[args.indexOf("--id") + 1]!;
        const status = args[args.indexOf("--status") + 1]!;
        const claimIdx = args.indexOf("--claim-from");
        const expUnitIdx = args.indexOf("--expected-unit");
        const unitIdx = args.indexOf("--unit");
        const detailIdx = args.indexOf("--detail");
        const p = path.join(pendingDir, `${id}.json`);
        const raw = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
        const dec = (raw.decision ?? {}) as Record<string, unknown>;
        const cur = String(dec.resumeStatus ?? "not_started");
        if (claimIdx < 0 && expUnitIdx < 0 && ["starting", "started", "running", "completed"].includes(cur)) {
          throw new Error(`RESUME_FENCE_REQUIRED: current=${cur}`);
        }
        if (claimIdx >= 0) {
          if (opts?.conflictOnClaim) throw new Error("RESUME_ALREADY_CLAIMED");
          const allowed = new Set(args[claimIdx + 1]!.split(","));
          if (!allowed.has(cur)) throw new Error(`RESUME_ALREADY_CLAIMED: current=${cur}`);
        }
        if (expUnitIdx >= 0 && String(dec.resumeUnit ?? "") !== args[expUnitIdx + 1]) {
          throw new Error(`RESUME_UNIT_MISMATCH: current=${String(dec.resumeUnit ?? "")}`);
        }
        dec.resumeStatus = status;
        if (unitIdx >= 0) dec.resumeUnit = args[unitIdx + 1];
        else if (["not_started_busy", "head_moved", "not_applicable", "skipped"].includes(status)) dec.resumeUnit = undefined;
        if (detailIdx >= 0) dec.resumeDetail = args[detailIdx + 1];
        raw.decision = dec;
        raw.version = Number(raw.version ?? 1) + 1;
        raw.sha256 = computeApprovalSha256(raw);
        await writeFile(p, JSON.stringify(raw, null, 2), "utf8");
        return { stdout: JSON.stringify(raw), stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd}`);
    };
  }

  it("B9: distinguishes missing mode.json (uninitialized autonomous) from corrupt mode.json, reports corrupt breaker.json readError, and never renders N/A cockpit as green", async () => {
    // 1. Missing mode.json matches physical train default (autonomous + uninitialized: true, NOT frozen)
    const svcMissing = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir: path.join(tmpRoot, "missing-cockpit"),
      now: NOW_DATE,
    });
    const ovMissing = await svcMissing.getOverview();
    assert.equal(ovMissing.mode.mode, "autonomous");
    assert.equal(ovMissing.mode.effectiveMode, "autonomous");
    assert.equal(ovMissing.mode.uninitialized, true);
    assert.equal(ovMissing.mode.corrupt, false);
    assert.equal(ovMissing.mode.autoMergeFrozen, false);

    // 2. Corrupt mode.json + corrupt breaker.json + N/A cockpit digest
    await writeControlFile("mode.json", "{corrupt json");
    await writeControlFile("breaker.json", "{broken breaker json");
    await writeFile(
      path.join(cockpitDir, "2026-11-27-cockpit-digest.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-11-27T07:00:00Z",
        overallStatus: "N/A",
        gauges: {
          structureAndRework: { status: "N/A", rework14d: { ratio: "N/A" }, archViolations: { total: "N/A" }, prodLoc7d: { netDelta: "N/A" } },
          deliveryAndExperience: { status: "N/A", trainPassRate7d: { rate: "N/A" }, weeklyRollbacks: "N/A", retentionLatest: { passed: "N/A" } },
          computeAndWaste: { status: "N/A", weeklyConsumption: { totalUsd: "N/A" }, waste: { failedTrainRatio: "N/A" }, costBreakerTripped: "N/A" },
          metaGuardrailIntegrity: {
            status: "N/A",
            a0Audit7d: { approvedRelaxations: "N/A", interceptedAttempts: "N/A" },
            stewardSignoff7d: { signoffRate: "N/A" },
            commercialBranchZeroTouch: { confirmedZeroUnauthorized: "N/A" },
          },
        },
      }),
      "utf8",
    );

    const svcCorrupt = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir,
      now: NOW_DATE,
    });
    const ov = await svcCorrupt.getOverview();
    assert.equal(ov.mode.corrupt, true);
    assert.equal(ov.mode.effectiveMode, "unknown");
    assert.equal(ov.mode.autoMergeFrozen, true);
    assert.equal(ov.breaker.readError, true);
    assert.match(ov.breaker.readErrorMessage ?? "", /breaker\.json/);
    assert.equal(ov.cockpit.available, true);
    assert.equal(ov.cockpit.overallLight, "unknown");
    assert.deepEqual(ov.cockpit.gauges.map((g) => g.light), ["unknown", "unknown", "unknown", "unknown"]);
    assert.equal(ov.cockpit.gauges[3]!.metrics[2]!.value, "未核验");
    assert.equal(ov.cockpit.gauges[2]!.metrics[2]!.value, "未采集");
  });

  it("NB1: tail-reads audit.jsonl larger than 2 MiB and skips .expired-* archive files", async () => {
    const fillerLine = JSON.stringify({
      ts: "2026-11-20T00:00:00Z",
      action: "check_blast_radius",
      actor: "root",
      branch: "feat/v5-selfhost",
      outcome: "ok",
      padding: "x".repeat(500),
    });
    const lines = Array.from({ length: 4500 }, () => fillerLine);
    lines.push(
      JSON.stringify({
        ts: "2026-11-27T09:59:00Z",
        action: "decide_pending_approval",
        actor: "admin:3",
        approvalId: "gov-tail-0001",
        decision: "approve",
        outcome: "ok",
      }),
    );
    await writeControlFile("audit.jsonl", `${lines.join("\n")}\n`);
    await writeControlFile("pending-approvals/gov-tail-0001.expired-20261126T000000Z.json", JSON.stringify(makeSignedApprovalDoc({ id: "gov-tail-0001" })));

    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir: path.join(tmpRoot, "missing-cockpit"),
      now: NOW_DATE,
    });
    const ov = await svc.getOverview();
    assert.equal(ov.auditTrail.length, 30);
    assert.equal(ov.auditTrail[0]!.action, "decide_pending_approval");
    assert.equal(ov.pendingApprovals.length, 0);
    assert.equal(ov.recentDecisions.length, 0);
    assert.equal(ov.cockpit.available, false);
    assert.equal(ov.cockpit.gauges.some((g) => g.light === "green"), false);
  });

  it("B4: rejects tampered sha256, unknown status, corrupt expiresAt, symlinks, and path traversal", async () => {
    const tampered = makeSignedApprovalDoc({ id: "gov-tampered-01" });
    tampered.title = "tampered after sign";
    await writeApproval(tampered);

    const badStatus = makeSignedApprovalDoc({ id: "gov-badstatus-02" });
    badStatus.status = "weird_status";
    badStatus.sha256 = computeApprovalSha256(badStatus);
    await writeApproval(badStatus);

    const badExp = makeSignedApprovalDoc({ id: "gov-badexp-03" });
    badExp.expiresAt = "not-a-date";
    badExp.sha256 = computeApprovalSha256(badExp);
    await writeApproval(badExp);

    const secretFile = path.join(tmpRoot, "secret.json");
    await writeFile(secretFile, JSON.stringify(makeSignedApprovalDoc({ id: "gov-symlink-04" })), "utf8");
    await symlink(secretFile, path.join(pendingDir, "gov-symlink-04.json"));

    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir,
      now: NOW_DATE,
    });

    await assert.rejects(() => svc.getApproval("../secret"), (e: unknown) => e instanceof GovernanceServiceError && e.status === 400 && e.code === "VALIDATION");
    for (const id of ["gov-tampered-01", "gov-badstatus-02", "gov-badexp-03", "gov-symlink-04"]) {
      await assert.rejects(() => svc.getApproval(id), (e: unknown) => e instanceof GovernanceServiceError && e.status === 400 && e.code === "INVALID_APPROVAL_FILE");
    }
  });

  it("B6+B7: atomic --claim-from before spawn, unit failure reconciliation allows safe retry without re-issuing, head_moved & not_started_busy honored", async () => {
    const calls: RecordedExec[] = [];
    const spawns: SpawnDetachedDeployInput[] = [];
    let currentHead = MOVED_SHA;
    let lockBusy = true;
    let unitProbe: ProbeUnitStatusResult = { status: "unknown" };

    await writeApproval(makeSignedApprovalDoc({ id: "gov-moved-01" }));
    await writeApproval(makeSignedApprovalDoc({ id: "gov-busy-02" }));

    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir,
      repoRoot: "/opt/openclaude/openclaude-v5-selfhost",
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      execFileFn: createFakeGovernor(calls),
      readRepoHeadShaFn: async () => currentHead,
      checkDeployBusyFn: async () => ({ busy: lockBusy, detail: "deploy lock held" }),
      probeUnitStatusFn: async () => unitProbe,
      spawnDetachedDeployFn: async (input) => {
        spawns.push(input);
        return { started: true, unitName: input.unitName, detail: "unit started" };
      },
      now: NOW_DATE,
    });

    // 1. HEAD moved -> head_moved, 0 spawns
    const resMoved = await svc.decideApproval("gov-moved-01", { decision: "approve", autoResumeTrain: true }, "admin:3");
    assert.equal(resMoved.decision?.resumeStatus, "head_moved");
    assert.equal(spawns.length, 0);

    // 2. HEAD matches, lock busy -> not_started_busy, 0 spawns
    currentHead = VALID_SHA;
    const resBusy = await svc.decideApproval("gov-busy-02", { decision: "approve", autoResumeTrain: true }, "admin:3");
    assert.equal(resBusy.decision?.resumeStatus, "not_started_busy");
    assert.equal(spawns.length, 0);

    // 3. Lock frees -> resumeApproval claims --claim-from -> starting -> spawns -> started
    lockBusy = false;
    const callsBeforeResume = calls.length;
    const resResumed = await svc.resumeApproval("gov-busy-02", "admin:3");
    assert.equal(resResumed.decision?.resumeStatus, "started");
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]!.env.OC_V5_BLAST_VOUCHER, "bv-1122334455667788");
    assert.equal(spawns[0]!.env.OC_V5_EXPECTED_HEAD, VALID_SHA);
    const claimCall = calls.slice(callsBeforeResume)[0]!;
    assert.equal(claimCall.args[0], "update-approval-resume");
    assert.ok(claimCall.args.includes("--claim-from"));
    assert.ok(claimCall.args.includes("starting"));

    // 4. Unit is still running -> getApproval reflects running, retry blocked 409 RESUME_ALREADY_CLAIMED
    unitProbe = { status: "running", detail: "ActiveState=active" };
    assert.equal((await svc.getApproval("gov-busy-02")).decision?.resumeStatus, "running");
    await assert.rejects(
      () => svc.resumeApproval("gov-busy-02", "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 409 && e.code === "RESUME_ALREADY_CLAIMED",
    );

    // 5. Unit crashes -> getApproval reconciles to failed & allows safe retry without re-issuing voucher
    unitProbe = { status: "failed", detail: "ActiveState=failed, Result=exit-code" };
    const failedView = await svc.getApproval("gov-busy-02");
    assert.equal(failedView.decision?.resumeStatus, "failed");
    unitProbe = { status: "unknown" };
    const retried = await svc.resumeApproval("gov-busy-02", "admin:3");
    assert.equal(retried.decision?.resumeStatus, "started");
    assert.equal(spawns.length, 2);
  });

  it("N2+B1+NB6: passes --publish-github-status for a0_approval when githubRepo is set, forbids commercial/absolute_reject, maps BREAKER_TRIPPED_USE_UNLOCK", async () => {
    const calls: RecordedExec[] = [];
    await writeApproval(makeSignedApprovalDoc({ id: "gov-a0-gh-01", kind: "a0_approval", code: "A0_GUARDRAIL_CHANGED" }));
    await writeApproval(makeSignedApprovalDoc({ id: "gov-comm-02", branch: "origin/feat/v5-aurora-rewrite" }));
    await writeApproval(makeSignedApprovalDoc({ id: "gov-abs-03", classification: "absolute_reject" }));

    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir,
      githubRepo: "openclaude/openclaude",
      execFileFn: createFakeGovernor(calls, { breakerTrippedModeReject: true }),
      now: NOW_DATE,
    });

    const a0Res = await svc.decideApproval("gov-a0-gh-01", { decision: "approve", note: "审阅通过" }, "admin:3");
    assert.equal(a0Res.status, "approved");
    assert.equal(calls[0]!.args[0], "decide-pending-approval");
    assert.ok(calls[0]!.args.includes("--publish-github-status"));
    assert.equal(calls[0]!.env?.GITHUB_REPOSITORY, "openclaude/openclaude");

    await assert.rejects(
      () => svc.decideApproval("gov-comm-02", { decision: "approve" }, "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 403 && e.code === "COMMERCIAL_BRANCH_FORBIDDEN",
    );
    await assert.rejects(
      () => svc.decideApproval("gov-abs-03", { decision: "approve" }, "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 403 && e.code === "COMMERCIAL_BRANCH_FORBIDDEN",
    );
    await assert.rejects(
      () => svc.setMode("autonomous", "尝试跳过解锁", "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 409 && e.code === "BREAKER_TRIPPED_USE_UNLOCK",
    );
  });

  it("Steward P1 regression: omits --collect, persists durable failed/completed via wrapper, and NEVER turns unloaded/missing systemd unit into completed", async () => {
    const calls: RecordedExec[] = [];
    const systemdCalls: RecordedExec[] = [];
    let systemctlOutput = "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n";
    await writeApproval(makeSignedApprovalDoc({ id: "gov-steward-01" }));

    const fakeGov = createFakeGovernor(calls);
    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir,
      repoRoot: "/opt/openclaude/openclaude-v5-selfhost",
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      systemdRunBin: "/usr/bin/systemd-run",
      systemctlBin: "/usr/bin/systemctl",
      readRepoHeadShaFn: async () => VALID_SHA,
      checkDeployBusyFn: async () => ({ busy: false }),
      execFileFn: async (file, args, opts) => {
        if (file === "/usr/bin/systemd-run") {
          systemdCalls.push({ file, args, env: opts.env });
          return { stdout: "", stderr: "" };
        }
        if (file === "/usr/bin/systemctl") {
          assert.ok(!args.includes("--value"), "systemctl show must parse property names, not positional --value lines");
          assert.ok(args.some((a) => a.includes("LoadState")), "systemctl show must query LoadState");
          return { stdout: systemctlOutput, stderr: "" };
        }
        return await fakeGov(file, args, opts);
      },
      now: NOW_DATE,
    });

    const decided = await svc.decideApproval("gov-steward-01", { decision: "approve", autoResumeTrain: true }, "admin:3");
    assert.equal(decided.decision?.resumeStatus, "started");
    assert.equal(systemdCalls.length, 1);
    assert.ok(!systemdCalls[0]!.args.includes("--collect"), "systemd-run MUST NOT pass --collect");
    assert.ok(systemdCalls[0]!.args.includes("/bin/bash"), "systemd-run MUST invoke durable outcome wrapper");
    assert.ok(systemdCalls[0]!.args.includes("gov-steward-01"), "wrapper args MUST bind approvalId");
    assert.ok(systemdCalls[0]!.args.includes(VALID_SHA), "wrapper args MUST bind targetSha");

    // 1. Collected/missing unit returning LoadState=not-found + inactive/dead/success MUST reconcile to failed (NEVER completed!)
    const afterMissingUnit = await svc.getApproval("gov-steward-01");
    assert.equal(afterMissingUnit.decision?.resumeStatus, "failed");

    // 2. Retry succeeds safely without issuing a second voucher
    const retried = await svc.resumeApproval("gov-steward-01", "admin:3");
    assert.equal(retried.decision?.resumeStatus, "started");
    assert.equal(systemdCalls.length, 2);

    // 3. Even LoadState=loaded + inactive/dead/success WITHOUT durable completed write MUST reconcile to failed
    systemctlOutput = "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\n";
    const afterUnreportedExit = await svc.getApproval("gov-steward-01");
    assert.equal(afterUnreportedExit.decision?.resumeStatus, "failed");

    // 4. Running unit with LoadState=loaded + ActiveState=active reports running
    await svc.resumeApproval("gov-steward-01", "admin:3");
    systemctlOutput = "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\n";
    const whileRunning = await svc.getApproval("gov-steward-01");
    assert.equal(whileRunning.decision?.resumeStatus, "running");
  });

  it("Steward P1 real-process E2E: failing deploy exits via real wrapper + real oc-governor.sh, stays failed after unit unload, and retries cleanly", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const realGovBin = path.join(repoRoot, "scripts/harness-gate/oc-governor.sh");
    const failScript = path.join(path.dirname(govRoot), "fail-deploy.sh");
    await writeFile(failScript, "#!/usr/bin/env bash\nexit 42\n", "utf8");
    await chmod(failScript, 0o755);

    const govEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", OC_GOVERNOR_ROOT: govRoot };
    await defaultExecFile(
      realGovBin,
      [
        "record-pending-approval", "--id", "gov-realwrap-01", "--kind", "blast_voucher",
        "--code", "BILLING_CORE_LOCKED", "--branch", "feat/v5-selfhost", "--sha", VALID_SHA,
        "--scope", "billing", "--files-json", JSON.stringify(["packages/commercial/src/billing/ledger.ts"]),
      ],
      { timeout: 10_000, env: govEnv },
    );

    let wrapperRuns = 0;
    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: realGovBin,
      cockpitDir,
      repoRoot,
      deployScriptPath: failScript,
      systemdRunBin: "/usr/bin/systemd-run",
      systemctlBin: "/usr/bin/systemctl",
      readRepoHeadShaFn: async () => VALID_SHA,
      checkDeployBusyFn: async () => ({ busy: false }),
      execFileFn: async (file, args, opts) => {
        if (file === "/usr/bin/systemd-run") {
          const sepIdx = args.indexOf("--");
          assert.ok(sepIdx >= 0);
          const cmd = args.slice(sepIdx + 1);
          wrapperRuns += 1;
          await new Promise<void>((resolve) => {
            execFileCb(cmd[0]!, cmd.slice(1), { env: { ...opts.env, ...govEnv }, timeout: 10_000 }, () => resolve());
          });
          return { stdout: "", stderr: "" };
        }
        if (file === "/usr/bin/systemctl") {
          return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n", stderr: "" };
        }
        return await defaultExecFile(file, args, opts);
      },
    });

    const decided = await svc.decideApproval("gov-realwrap-01", { decision: "approve", autoResumeTrain: true }, "admin:3");
    assert.equal(wrapperRuns, 1);
    assert.equal(decided.status, "approved");
    assert.equal(decided.decision?.resumeStatus, "failed");
    assert.match(decided.decision?.resumeDetail ?? "", /exit=42/);

    // Refresh after unit is unloaded (LoadState=not-found + Result=success) still stays failed & retryable
    const reloaded = await svc.getApproval("gov-realwrap-01");
    assert.equal(reloaded.decision?.resumeStatus, "failed");
    const retried = await svc.resumeApproval("gov-realwrap-01", "admin:3");
    assert.equal(wrapperRuns, 2);
    assert.equal(retried.decision?.resumeStatus, "failed");
  });

  it("Steward P1 fencing regression: delayed stale unit-old probe after retry MUST NOT clobber unit-new started state", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const realGovBin = path.join(repoRoot, "scripts/harness-gate/oc-governor.sh");
    const govEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", OC_GOVERNOR_ROOT: govRoot };
    await defaultExecFile(
      realGovBin,
      [
        "record-pending-approval", "--id", "gov-fence-01", "--kind", "blast_voucher",
        "--code", "BILLING_CORE_LOCKED", "--branch", "feat/v5-selfhost", "--sha", VALID_SHA,
        "--scope", "billing", "--files-json", JSON.stringify(["packages/commercial/src/billing/ledger.ts"]),
      ],
      { timeout: 10_000, env: govEnv },
    );

    let delayedProbeEntered!: () => void;
    const probeEnteredPromise = new Promise<void>((resolve) => { delayedProbeEntered = resolve; });
    let releaseDelayedProbe!: () => void;
    const delayedProbeGate = new Promise<void>((resolve) => { releaseDelayedProbe = resolve; });
    let oldProbeCalls = 0;
    const spawnedUnits: string[] = [];

    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: realGovBin,
      cockpitDir,
      repoRoot,
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      readRepoHeadShaFn: async () => VALID_SHA,
      checkDeployBusyFn: async () => ({ busy: false }),
      spawnDetachedDeployFn: async (input) => {
        spawnedUnits.push(input.unitName);
        return { started: true, unitName: input.unitName, detail: `started ${input.unitName}` };
      },
      probeUnitStatusFn: async (unitName) => {
        if (unitName === spawnedUnits[0]) {
          oldProbeCalls += 1;
          if (oldProbeCalls === 1) {
            delayedProbeEntered();
            await delayedProbeGate;
          }
          return { status: "failed", detail: `old unit ${unitName} failed` };
        }
        return { status: "running", detail: `new unit ${unitName} running` };
      },
      now: NOW_DATE,
    });

    // 1. First attempt starts unit-old
    const first = await svc.decideApproval("gov-fence-01", { decision: "approve", autoResumeTrain: true }, "admin:3");
    assert.equal(first.decision?.resumeStatus, "started");
    const unitOld = first.decision?.resumeUnit!;
    assert.equal(unitOld, spawnedUnits[0]);

    // 2. readB deterministically enters and stalls on unit-old probe; readA finishes & marks unit-old failed
    const readB = svc.getApproval("gov-fence-01");
    await probeEnteredPromise;
    const afterReadA = await svc.getApproval("gov-fence-01");
    assert.equal(afterReadA.decision?.resumeStatus, "failed");

    // 3. Admin retries -> claims and starts distinct unit-new
    const second = await svc.resumeApproval("gov-fence-01", "admin:3");
    assert.equal(second.decision?.resumeStatus, "started");
    const unitNew = second.decision?.resumeUnit!;
    assert.notEqual(unitNew, unitOld, "retry must mint a distinct execution unitName");

    // 4. Stale readB resolves now with failed for unit-old -> MUST be rejected by --expected-unit fence!
    releaseDelayedProbe();
    const afterReadB = await readB;
    assert.equal(afterReadB.decision?.resumeUnit, unitNew);
    assert.equal(afterReadB.decision?.resumeStatus, "started");

    // 5. Third retry while unit-new is still active MUST be rejected 409 RESUME_ALREADY_CLAIMED
    await assert.rejects(
      () => svc.resumeApproval("gov-fence-01", "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 409 && e.code === "RESUME_ALREADY_CLAIMED",
    );
  });

  it("Steward P1 starting-lease regression: concurrent GET before systemd-run unit exists MUST NOT release starting claim; expired orphan claim reclaims cleanly", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const realGovBin = path.join(repoRoot, "scripts/harness-gate/oc-governor.sh");
    let nowMs = Date.parse(NOW_ISO);
    const govEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: NOW_ISO };
    await defaultExecFile(
      realGovBin,
      [
        "record-pending-approval", "--id", "gov-startlease-01", "--kind", "blast_voucher",
        "--code", "BILLING_CORE_LOCKED", "--branch", "feat/v5-selfhost", "--sha", VALID_SHA,
        "--scope", "billing", "--files-json", JSON.stringify(["packages/commercial/src/billing/ledger.ts"]),
      ],
      { timeout: 10_000, env: govEnv },
    );

    let enteredSpawn!: () => void;
    const spawnEntered = new Promise<void>((resolve) => { enteredSpawn = resolve; });
    let allowSpawnFinish!: () => void;
    const spawnCanFinish = new Promise<void>((resolve) => { allowSpawnFinish = resolve; });
    const spawnedUnits: string[] = [];
    let probeCalls = 0;

    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: realGovBin,
      cockpitDir,
      repoRoot,
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      commandEnv: { OC_GOVERNOR_NOW_ISO: NOW_ISO },
      readRepoHeadShaFn: async () => VALID_SHA,
      checkDeployBusyFn: async () => ({ busy: false }),
      spawnDetachedDeployFn: async (input) => {
        spawnedUnits.push(input.unitName);
        enteredSpawn();
        await spawnCanFinish;
        return { started: true, unitName: input.unitName, detail: `started ${input.unitName}` };
      },
      probeUnitStatusFn: async () => {
        probeCalls += 1;
        return { status: "failed", detail: "LoadState=not-found" };
      },
      now: () => new Date(nowMs),
    });

    // 1. Start approve+resume; pause inside spawnDetachedDeploy right after `starting` claim was persisted
    const decidePromise = svc.decideApproval("gov-startlease-01", { decision: "approve", autoResumeTrain: true }, "admin:3");
    await spawnEntered;

    // 2. Concurrent GET while unit does not exist yet MUST NOT probe/release starting claim!
    const midRead = await svc.getApproval("gov-startlease-01");
    assert.equal(midRead.decision?.resumeStatus, "starting");
    assert.equal(probeCalls, 0, "active starting claim must not be prematurely probed as failed");

    // 3. Finish spawn -> transitions cleanly to started with single spawn
    allowSpawnFinish();
    const afterStart = await decidePromise;
    assert.equal(afterStart.decision?.resumeStatus, "started");
    assert.equal(spawnedUnits.length, 1);

    // 4. Wrapper persists completed with expected-unit -> succeeds cleanly
    await defaultExecFile(
      realGovBin,
      [
        "update-approval-resume", "--id", "gov-startlease-01", "--status", "completed",
        "--expected-unit", spawnedUnits[0]!, "--unit", spawnedUnits[0]!, "--detail", "exit=0",
      ],
      { timeout: 10_000, env: govEnv },
    );
    const doneView = await svc.getApproval("gov-startlease-01");
    assert.equal(doneView.decision?.resumeStatus, "completed");

    // 5. Separately verify an expired orphan `starting` claim (>60s old, not in-flight) reclaims cleanly to failed
    await defaultExecFile(
      realGovBin,
      [
        "record-pending-approval", "--id", "gov-orphanstart-01", "--kind", "blast_voucher",
        "--code", "BILLING_CORE_LOCKED", "--branch", "feat/v5-selfhost", "--sha", VALID_SHA,
        "--scope", "billing", "--files-json", JSON.stringify(["packages/commercial/src/billing/ledger.ts"]),
      ],
      { timeout: 10_000, env: govEnv },
    );
    await defaultExecFile(
      realGovBin,
      ["decide-pending-approval", "--id", "gov-orphanstart-01", "--decision", "approve", "--actor", "admin:3"],
      { timeout: 10_000, env: govEnv },
    );
    await defaultExecFile(
      realGovBin,
      ["update-approval-resume", "--id", "gov-orphanstart-01", "--status", "starting", "--claim-from", "not_started", "--unit", "oc-v5-orphan-unit"],
      { timeout: 10_000, env: govEnv },
    );
    // Before 60s expiry -> stays starting
    assert.equal((await svc.getApproval("gov-orphanstart-01")).decision?.resumeStatus, "starting");
    // After 60s lease expires -> probes and reclaims to failed
    nowMs += 65_000;
    const reclaimed = await svc.getApproval("gov-orphanstart-01");
    assert.equal(reclaimed.decision?.resumeStatus, "failed");
    assert.equal(probeCalls, 1);
  });

  it("Steward P1 approving-reconcile regression: GET does NOT reconcile live in-flight decideApproval, while crashed orphan approving reconciles via oc-governor", async () => {
    const calls: RecordedExec[] = [];
    await writeApproval(makeSignedApprovalDoc({ id: "gov-inflight-01" }));
    let enteredDecide!: () => void;
    const decideEntered = new Promise<void>((resolve) => { enteredDecide = resolve; });
    let releaseDecide!: () => void;
    const decideCanFinish = new Promise<void>((resolve) => { releaseDecide = resolve; });

    const fakeGov = createFakeGovernor(calls);
    const svc = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir,
      execFileFn: async (file, args, opts) => {
        if (args[0] === "decide-pending-approval") {
          const p = path.join(pendingDir, "gov-inflight-01.json");
          const cur = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
          cur.status = "approving";
          cur.version = 2;
          cur.sha256 = computeApprovalSha256(cur);
          await writeFile(p, JSON.stringify(cur), "utf8");
          enteredDecide();
          await decideCanFinish;
          cur.status = "pending";
          cur.version = 1;
          cur.sha256 = computeApprovalSha256(cur);
          await writeFile(p, JSON.stringify(cur), "utf8");
        }
        if (args[0] === "reconcile-pending-approval") {
          calls.push({ file, args, env: opts.env });
          const id = args[args.indexOf("--id") + 1]!;
          const p = path.join(pendingDir, `${id}.json`);
          const cur = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
          cur.status = "approved";
          cur.version = Number(cur.version ?? 1) + 1;
          cur.decision = { action: "approve", decidedBy: "admin:3", decidedAt: NOW_ISO, issuedArtifactId: "bv-reconciled0001", resumeStatus: "not_started" };
          cur.sha256 = computeApprovalSha256(cur);
          await writeFile(p, JSON.stringify(cur), "utf8");
          return { stdout: JSON.stringify(cur), stderr: "" };
        }
        return await fakeGov(file, args, opts);
      },
      now: NOW_DATE,
    });

    // 1. Live in-flight decideApproval transitions doc to 'approving' on disk -> concurrent GET MUST NOT call reconcile-pending-approval!
    const decidePromise = svc.decideApproval("gov-inflight-01", { decision: "approve", autoResumeTrain: false }, "admin:3");
    await decideEntered;
    const midGet = await svc.getApproval("gov-inflight-01");
    assert.equal(midGet.status, "approving");
    assert.equal(calls.filter((c) => c.args[0] === "reconcile-pending-approval").length, 0);
    releaseDecide();
    assert.equal((await decidePromise).status, "approved");

    // 2. Crashed orphan 'approving' (not in-flight) -> resumeApproval reconciles via oc-governor before resuming
    await writeApproval(makeSignedApprovalDoc({ id: "gov-orphan-app-01", status: "approving", version: 2 }));
    const res = await svc.getApproval("gov-orphan-app-01");
    assert.equal(res.status, "approved");
    assert.equal(res.decision?.issuedArtifactId, "bv-reconciled0001");
    assert.equal(calls.filter((c) => c.args[0] === "reconcile-pending-approval").length, 1);
  });

  it("Steward P1 dual-instance concurrency regression (real oc-governor.sh): pre-check atomic claim and fenced status writes prevent stale lock-busy or HEAD failures from overwriting another instance's active claim", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const realGovBin = path.join(repoRoot, "scripts/harness-gate/oc-governor.sh");
    let nowMs = Date.parse(NOW_ISO);
    const govEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", OC_GOVERNOR_ROOT: govRoot, OC_GOVERNOR_NOW_ISO: NOW_ISO };
    const spawnedUnits: string[] = [];

    const recordAndApprove = async (id: string) => {
      await defaultExecFile(
        realGovBin,
        [
          "record-pending-approval", "--id", id, "--kind", "blast_voucher",
          "--code", "BILLING_CORE_LOCKED", "--branch", "feat/v5-selfhost", "--sha", VALID_SHA,
          "--scope", "billing", "--files-json", JSON.stringify(["packages/commercial/src/billing/ledger.ts"]),
        ],
        { timeout: 10_000, env: govEnv },
      );
      await defaultExecFile(
        realGovBin,
        ["decide-pending-approval", "--id", id, "--decision", "approve", "--actor", "admin:3"],
        { timeout: 10_000, env: govEnv },
      );
    };

    // Scenario 1: Two independent service instances race on the same approved/not_started item.
    // Instance A claims, passes lock check, spawns unit-A -> started.
    // Instance B sees busy lock, but MUST fail atomic claim with 409 RESUME_ALREADY_CLAIMED and NEVER overwrite started.
    await recordAndApprove("gov-dual-race-01");
    let aEnteredLock!: () => void;
    const aAtLock = new Promise<void>((resolve) => { aEnteredLock = resolve; });
    let releaseA!: () => void;
    const aCanFinish = new Promise<void>((resolve) => { releaseA = resolve; });

    const svcA = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: realGovBin,
      cockpitDir,
      repoRoot,
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      commandEnv: { OC_GOVERNOR_NOW_ISO: NOW_ISO },
      readRepoHeadShaFn: async () => VALID_SHA,
      checkDeployBusyFn: async () => {
        aEnteredLock();
        await aCanFinish;
        return { busy: false };
      },
      probeUnitStatusFn: async () => ({ status: "unknown" }),
      spawnDetachedDeployFn: async (input) => {
        spawnedUnits.push(input.unitName);
        return { started: true, unitName: input.unitName, detail: "unit-A started" };
      },
      now: () => new Date(nowMs),
    });

    const svcB = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: realGovBin,
      cockpitDir,
      repoRoot,
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      commandEnv: { OC_GOVERNOR_NOW_ISO: NOW_ISO },
      readRepoHeadShaFn: async () => VALID_SHA,
      checkDeployBusyFn: async () => ({ busy: true, detail: "stale busy observation from B" }),
      probeUnitStatusFn: async () => ({ status: "unknown" }),
      spawnDetachedDeployFn: async (input) => {
        spawnedUnits.push(input.unitName);
        return { started: true, unitName: input.unitName, detail: "unit-B must never spawn" };
      },
      now: () => new Date(nowMs),
    });

    const pA = svcA.resumeApproval("gov-dual-race-01", "admin:3");
    await aAtLock;
    // B tries to resume while A holds atomic starting claim -> 409 RESUME_ALREADY_CLAIMED immediately before checkDeployBusy
    await assert.rejects(
      () => svcB.resumeApproval("gov-dual-race-01", "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 409 && e.code === "RESUME_ALREADY_CLAIMED",
    );
    releaseA();
    const resA = await pA;
    assert.equal(resA.decision?.resumeStatus, "started");
    assert.equal(spawnedUnits.length, 1);
    const unitA = resA.decision?.resumeUnit;
    assert.ok(unitA && unitA === spawnedUnits[0]);

    // Retry after A started MUST still 409 and keep unitA intact
    await assert.rejects(
      () => svcB.resumeApproval("gov-dual-race-01", "admin:3"),
      (e: unknown) => e instanceof GovernanceServiceError && e.status === 409 && e.code === "RESUME_ALREADY_CLAIMED",
    );
    assert.equal(spawnedUnits.length, 1);

    // Scenario 2: Instance B claims starting, then stalls past the 60s lease inside checkDeployBusy / readRepoHeadSha.
    // Instance A legitimately reclaims expired orphan starting -> failed, then claims & starts unit-A2.
    // When stalled B wakes up with busy=true (or HEAD failure), its fenced write MUST NOT overwrite A2's started claim!
    for (const [id, lateMode] of [
      ["gov-dual-stale-busy", "busy"],
      ["gov-dual-stale-head", "head_error"],
    ] as const) {
      await recordAndApprove(id);
      const spawnsBefore: number = spawnedUnits.length;
      let bStalled!: () => void;
      const bIsStalled = new Promise<void>((resolve) => { bStalled = resolve; });
      let wakeB!: () => void;
      const bCanWake = new Promise<void>((resolve) => { wakeB = resolve; });

      const staleB = createSelfhostGovernanceService({
        governorRoot: govRoot,
        governorBin: realGovBin,
        cockpitDir,
        repoRoot,
        deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
        commandEnv: { OC_GOVERNOR_NOW_ISO: NOW_ISO },
        readRepoHeadShaFn: async () => {
          if (lateMode === "head_error") {
            bStalled();
            await bCanWake;
            throw new Error("git rev-parse transient failure");
          }
          return VALID_SHA;
        },
        checkDeployBusyFn: async () => {
          if (lateMode === "busy") {
            bStalled();
            await bCanWake;
            return { busy: true, detail: "late lock busy after lease expiry" };
          }
          return { busy: false };
        },
        probeUnitStatusFn: async () => ({ status: "unknown" }),
        spawnDetachedDeployFn: async (input) => {
          spawnedUnits.push(input.unitName);
          return { started: true, unitName: input.unitName };
        },
        now: () => new Date(nowMs),
      });

      let ownerUnit: string | undefined;
      const takeoverA = createSelfhostGovernanceService({
        governorRoot: govRoot,
        governorBin: realGovBin,
        cockpitDir,
        repoRoot,
        deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
        commandEnv: { OC_GOVERNOR_NOW_ISO: NOW_ISO },
        readRepoHeadShaFn: async () => VALID_SHA,
        checkDeployBusyFn: async () => ({ busy: false }),
        probeUnitStatusFn: async (unit) =>
          ownerUnit && unit === ownerUnit
            ? { status: "running", detail: "ActiveState=active" }
            : { status: "failed", detail: "LoadState=not-found" },
        spawnDetachedDeployFn: async (input) => {
          ownerUnit = input.unitName;
          spawnedUnits.push(input.unitName);
          return { started: true, unitName: input.unitName, detail: "takeover-A started" };
        },
        now: () => new Date(nowMs),
      });

      const pB = staleB.resumeApproval(id, "admin:3");
      await bIsStalled;

      // Advance past 60s starting lease so takeoverA reclaims orphan starting -> failed and spawns unit-A
      nowMs += 65_000;
      const reclaimed = await takeoverA.getApproval(id);
      assert.equal(reclaimed.decision?.resumeStatus, "failed");
      const startedA = await takeoverA.resumeApproval(id, "admin:3");
      assert.equal(startedA.decision?.resumeStatus, "started");
      assert.equal(spawnedUnits.length, spawnsBefore + 1);
      assert.ok(ownerUnit && startedA.decision?.resumeUnit === ownerUnit);

      // Wake stalled B -> its late busy / HEAD-error write is fenced by claimFrom+expectedUnit and returns A's started state
      wakeB();
      const lateBRes = await pB;
      assert.equal(lateBRes.decision?.resumeStatus, "started");
      assert.equal(lateBRes.decision?.resumeUnit, ownerUnit);

      // Authoritative disk state still belongs to ownerUnit (active/running), and second retry is blocked -> strictly 1 spawn total
      const diskView = await takeoverA.getApproval(id);
      assert.equal(diskView.decision?.resumeStatus, "running");
      assert.equal(diskView.decision?.resumeUnit, ownerUnit);
      assert.equal(spawnedUnits.length, spawnsBefore + 1);
    }
  });
});
