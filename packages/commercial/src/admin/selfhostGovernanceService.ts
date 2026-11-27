/**
 * OCV5-914 — Selfhost Visual Governance Control Plane Service (L3 admin-ops).
 *
 * Host `oc-governor` is the SOLE writer of approval files (zero Node dual-write).
 * Zero raw environment reads, zero shell interpolation (`execFile` arg arrays with
 * 15s hard timeout), `lstat`+`realpath` symlink/traversal defense, sha256 verification
 * on read, tail-read for large `audit.jsonl`, atomic `--claim-from` resume claim +
 * systemd unit status reconciliation, exact HEAD SHA check before resume, and
 * independent idempotent `resumeApproval` without re-issuing vouchers.
 */
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createDefaultCheckDeployBusy,
  createDefaultProbeUnitStatus,
  createDefaultReadRepoHeadSha,
  createDefaultSpawnDetachedDeploy,
  defaultExecFile,
} from "./selfhostGovernanceExec.js";
import {
  buildFallbackCockpit,
  formatCockpitFromDigest,
  normalizeBreakerState,
  normalizeModeState,
  normalizePendingApproval,
  translateAuditEntry,
} from "./selfhostGovernanceFormat.js";
import {
  GovernanceServiceError,
  isCommercialGovernanceBranch,
  isValidGovernanceApprovalId,
  isValidGovernanceMode,
  type CheckDeployBusyFn,
  type DecideGovernanceApprovalInput,
  type ExecFileFn,
  type ExecFileResult,
  type GovernanceAuditItem,
  type GovernanceBreakerState,
  type GovernanceCockpitSummary,
  type GovernanceMode,
  type GovernanceModeState,
  type GovernanceOverviewResponse,
  type GovernanceResumeStatus,
  type PendingGovernanceApproval,
  type ProbeUnitStatusFn,
  type ReadRepoHeadShaFn,
  type SelfhostGovernanceConfig,
  type SelfhostGovernanceService,
  type SpawnDetachedDeployFn,
} from "./selfhostGovernanceTypes.js";

const DEFAULT_COCKPIT_DIR = "/opt/openclaude/var/selfevolve-report";
const DEFAULT_DEPLOY_LOCK_PATH = "/run/openclaude-v5-selfhost/deploy.lock";
const DEFAULT_SYSTEMD_RUN_BIN = "/usr/bin/systemd-run";
const DEFAULT_SYSTEMCTL_BIN = "/usr/bin/systemctl";
const DEFAULT_SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_COMMAND_TIMEOUT_MS = 15_000;
const MAX_APPROVAL_FILE_BYTES = 256 * 1024;
const MAX_AUX_FILE_BYTES = 2 * 1024 * 1024;
const AUDIT_TAIL_BYTES = 256 * 1024;
const MAX_APPROVAL_SCAN_FILES = 200;
const MAX_PENDING_ITEMS = 50;
const MAX_RECENT_DECISIONS = 20;
const MAX_AUDIT_ITEMS = 30;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA64_RE = /^[0-9a-f]{64}$/;

type JsonRecord = Record<string, unknown>;
type SafeReadOutcome =
  | { status: "ok"; text: string; realPath: string }
  | { status: "missing" }
  | { status: "invalid"; reason: string };
type JsonReadChecked =
  | { status: "ok"; doc: JsonRecord }
  | { status: "missing" }
  | { status: "error"; reason: string };

interface GovernanceRuntime {
  governorRoot: string;
  governorBin: string;
  ctrlDir: string;
  pendingDir: string;
  cockpitDir: string;
  deployScriptPath?: string;
  repoRoot?: string;
  deployLockPath: string;
  githubRepo?: string;
  timeoutMs: number;
  commandEnv: Readonly<Record<string, string>>;
  execFn: ExecFileFn;
  checkDeployBusy: CheckDeployBusyFn;
  readRepoHeadSha: ReadRepoHeadShaFn;
  probeUnitStatus: ProbeUnitStatusFn;
  spawnDetachedDeploy: SpawnDetachedDeployFn;
  nowFn: () => Date;
  inFlightApprovals: Set<string>;
  resumeAttemptSeq: number;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

function parseJsonObject(raw: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch (err) {
    void err;
    return null;
  }
}

async function resolveRegularDir(
  dirPath: string,
): Promise<{ status: "ok"; realDir: string } | { status: "missing" } | { status: "invalid"; reason: string }> {
  try {
    const dirStat = await lstat(dirPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return { status: "invalid", reason: "base directory is not a regular directory" };
    return { status: "ok", realDir: await realpath(dirPath) };
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { status: "missing" };
    return { status: "invalid", reason: err instanceof Error ? err.message : "stat dir failed" };
  }
}

async function resolveRegularFileInDir(
  dirPath: string,
  fileName: string,
): Promise<{ status: "ok"; realPath: string; size: number } | { status: "missing" } | { status: "invalid"; reason: string }> {
  if (/[/\\\0]|\.\./.test(fileName)) return { status: "invalid", reason: "illegal filename" };
  const dirRes = await resolveRegularDir(dirPath);
  if (dirRes.status !== "ok") return dirRes;
  const candidate = path.join(dirRes.realDir, fileName);
  try {
    const st = await lstat(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return { status: "invalid", reason: "symlink or non-regular file" };
    const realCandidate = await realpath(candidate);
    if (!realCandidate.startsWith(`${dirRes.realDir}${path.sep}`)) return { status: "invalid", reason: "resolved path escapes base directory" };
    return { status: "ok", realPath: realCandidate, size: st.size };
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { status: "missing" };
    return { status: "invalid", reason: err instanceof Error ? err.message : "stat failed" };
  }
}

async function readRegularFileWithinDir(dirPath: string, fileName: string, maxBytes: number): Promise<SafeReadOutcome> {
  const res = await resolveRegularFileInDir(dirPath, fileName);
  if (res.status !== "ok") return res;
  if (res.size > maxBytes) return { status: "invalid", reason: `file exceeds ${maxBytes} bytes limit` };
  try {
    return { status: "ok", text: await readFile(res.realPath, "utf8"), realPath: res.realPath };
  } catch (err) {
    return { status: "invalid", reason: err instanceof Error ? err.message : "read failed" };
  }
}

async function readOptionalJsonChecked(dirPath: string, fileName: string, maxBytes: number): Promise<JsonReadChecked> {
  const res = await readRegularFileWithinDir(dirPath, fileName, maxBytes);
  if (res.status === "missing") return { status: "missing" };
  if (res.status === "invalid") return { status: "error", reason: `${fileName}: ${res.reason}` };
  const doc = parseJsonObject(res.text);
  if (!doc) return { status: "error", reason: `${fileName}: JSON 格式损坏` };
  return { status: "ok", doc };
}

async function readTailWithinDir(dirPath: string, fileName: string, tailBytes: number): Promise<string | null> {
  const res = await resolveRegularFileInDir(dirPath, fileName);
  if (res.status !== "ok" || res.size === 0) return null;
  const start = Math.max(0, res.size - tailBytes);
  const length = res.size - start;
  const fh = await open(res.realPath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    if (start === 0) return chunk;
    const firstNl = chunk.indexOf("\n");
    return firstNl >= 0 ? chunk.slice(firstNl + 1) : "";
  } finally {
    await fh.close();
  }
}

function validateReason(raw: string, fieldName: string): string {
  if (typeof raw !== "string" || /[\r\n\0]/.test(raw)) {
    throw new GovernanceServiceError(400, "VALIDATION", `${fieldName} must be a single-line string`);
  }
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > 400) {
    throw new GovernanceServiceError(400, "VALIDATION", `${fieldName} must be between 4 and 400 characters`);
  }
  return trimmed;
}

function validateOptionalNote(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || /[\r\n\0]/.test(raw)) throw new GovernanceServiceError(400, "VALIDATION", "note must be a single-line string");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 400) throw new GovernanceServiceError(400, "VALIDATION", "note must be <= 400 characters");
  return trimmed;
}

async function execGovernor(rt: GovernanceRuntime, args: readonly string[]): Promise<ExecFileResult> {
  try {
    return await rt.execFn(rt.governorBin, args, { timeout: rt.timeoutMs, env: rt.commandEnv, cwd: rt.repoRoot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GovernanceServiceError(502, "GOVERNOR_FAILED", `oc-governor failed: ${msg.slice(0, 300)}`);
  }
}

async function readModeStateFromDisk(ctrlDir: string): Promise<GovernanceModeState> {
  const res = await readRegularFileWithinDir(ctrlDir, "mode.json", MAX_APPROVAL_FILE_BYTES);
  if (res.status === "missing") return normalizeModeState(null, { missing: true });
  if (res.status === "invalid") return normalizeModeState(null, { corruptReason: `mode.json 不可信（${res.reason}），按 fail-closed 冻结` });
  const parsed = parseJsonObject(res.text);
  if (!parsed) return normalizeModeState(null, { corruptReason: "mode.json JSON 损坏，按 fail-closed 冻结" });
  return normalizeModeState(parsed);
}

async function readRecentRollbackCount(ctrlDir: string, nowMs: number): Promise<number> {
  const tail = await readTailWithinDir(ctrlDir, "rollbacks.jsonl", AUDIT_TAIL_BYTES);
  if (!tail) return 0;
  const sinceMs = nowMs - SEVEN_DAYS_MS;
  let count = 0;
  for (const line of tail.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = parseJsonObject(trimmed);
    const ts = typeof obj?.ts === "string" ? Date.parse(obj.ts) : Number.NaN;
    if (!Number.isNaN(ts) && ts >= sinceMs && ts <= nowMs) count += 1;
  }
  return count;
}

async function readBreakerStateWithMeta(
  ctrlDir: string,
  nowMs: number,
): Promise<{ breaker: GovernanceBreakerState; hasCostBreakerFile: boolean }> {
  const [breakerRes, costRes, cardRes, recentRollbacks] = await Promise.all([
    readOptionalJsonChecked(ctrlDir, "breaker.json", MAX_AUX_FILE_BYTES),
    readOptionalJsonChecked(ctrlDir, "cost-breaker.json", MAX_AUX_FILE_BYTES),
    readRegularFileWithinDir(ctrlDir, "breaker-card.md", MAX_APPROVAL_FILE_BYTES),
    readRecentRollbackCount(ctrlDir, nowMs),
  ]);
  const cardLines =
    cardRes.status === "ok"
      ? cardRes.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 20)
      : [];
  const errors: string[] = [];
  if (breakerRes.status === "error") errors.push(breakerRes.reason);
  if (costRes.status === "error") errors.push(costRes.reason);
  const breakerDoc = breakerRes.status === "ok" ? breakerRes.doc : null;
  const costDoc = costRes.status === "ok" ? costRes.doc : null;
  return {
    breaker: normalizeBreakerState({
      breakerDoc, costDoc, cardLines, recentRollbacks,
      ...(errors.length > 0 ? { readError: true, readErrorMessage: `熔断状态文件读取异常：${errors.join("；")}` } : {}),
    }),
    hasCostBreakerFile: costDoc !== null && typeof costDoc.tripped === "boolean",
  };
}

async function readAuditTrail(ctrlDir: string): Promise<GovernanceAuditItem[]> {
  const tail = await readTailWithinDir(ctrlDir, "audit.jsonl", AUDIT_TAIL_BYTES);
  if (!tail) return [];
  const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const items: GovernanceAuditItem[] = [];
  for (let i = lines.length - 1; i >= 0 && items.length < MAX_AUDIT_ITEMS; i -= 1) {
    const obj = parseJsonObject(lines[i]!);
    const item = obj ? translateAuditEntry(obj) : null;
    if (item) items.push(item);
  }
  return items;
}

function isStartingClaimReclaimable(rt: GovernanceRuntime, item: PendingGovernanceApproval): boolean {
  if (rt.inFlightApprovals.has(item.id)) return false;
  const expIso = item.decision?.resumeClaimExpiresAt;
  if (!expIso) return false;
  const expMs = Date.parse(expIso);
  return !Number.isNaN(expMs) && rt.nowFn().getTime() >= expMs;
}

async function reconcileApprovingIfNeeded(
  rt: GovernanceRuntime,
  item: PendingGovernanceApproval,
  opts: { allowWhenInFlightSelf?: boolean; strict?: boolean } = {},
): Promise<PendingGovernanceApproval> {
  if (item.status !== "approving") return item;
  if (!opts.allowWhenInFlightSelf && rt.inFlightApprovals.has(item.id)) return item;
  try {
    await execGovernor(rt, ["reconcile-pending-approval", "--id", item.id]);
    return await loadApprovalByIdRaw(rt, item.id);
  } catch (err) {
    if (opts.strict) throw err;
    return await loadApprovalByIdRaw(rt, item.id).catch((readErr) => {
      void readErr;
      return item;
    });
  }
}

async function reconcileUnitStatusIfActive(
  rt: GovernanceRuntime,
  item: PendingGovernanceApproval,
): Promise<PendingGovernanceApproval> {
  const rs = item.decision?.resumeStatus;
  const unit = item.decision?.resumeUnit;
  if (item.status !== "approved" || !unit || (rs !== "started" && rs !== "starting")) return item;
  if (rs === "starting" && !isStartingClaimReclaimable(rt, item)) return item;
  const probed = await rt.probeUnitStatus(unit);
  if (probed.status === "unknown") return item;
  if (probed.status === "running") {
    return {
      ...item,
      decision: { ...item.decision!, resumeStatus: "running", ...(probed.detail ? { resumeDetail: probed.detail } : {}) },
    };
  }
  if (probed.status !== "failed") return item;
  const claimFrom = rs === "starting" ? "starting" : "started,running";
  try {
    await execGovernor(rt, [
      "update-approval-resume", "--id", item.id, "--status", "failed", "--unit", unit,
      "--claim-from", claimFrom, "--expected-unit", unit,
      ...(probed.detail ? ["--detail", probed.detail] : []),
    ]);
  } catch (err) {
    void err;
  }
  return await loadApprovalByIdRaw(rt, item.id).catch((err) => {
    void err;
    return item;
  });
}

async function selectBoundedApprovalFileNames(realDir: string): Promise<string[]> {
  const rawNames = (await readdir(realDir)).filter((name) => {
    if (!name.endsWith(".json") || name.includes(".expired-")) return false;
    return isValidGovernanceApprovalId(name.slice(0, -5));
  });
  if (rawNames.length <= MAX_APPROVAL_SCAN_FILES) return rawNames;
  const withMtime = await Promise.all(
    rawNames.map(async (name) => {
      try {
        const st = await lstat(path.join(realDir, name));
        return { name, mtimeMs: st.mtimeMs };
      } catch (err) {
        void err;
        return { name, mtimeMs: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.slice(0, MAX_APPROVAL_SCAN_FILES).map((x) => x.name);
}

async function readAllApprovals(
  rt: GovernanceRuntime,
  nowMs: number,
): Promise<{ pendingApprovals: PendingGovernanceApproval[]; recentDecisions: PendingGovernanceApproval[] }> {
  const dirRes = await resolveRegularDir(rt.pendingDir);
  if (dirRes.status !== "ok") return { pendingApprovals: [], recentDecisions: [] };
  const names = await selectBoundedApprovalFileNames(dirRes.realDir);
  const pending: PendingGovernanceApproval[] = [];
  const recent: PendingGovernanceApproval[] = [];
  for (const name of names) {
    const stem = name.slice(0, -5);
    const res = await readRegularFileWithinDir(rt.pendingDir, name, MAX_APPROVAL_FILE_BYTES);
    const obj = res.status === "ok" ? parseJsonObject(res.text) : null;
    const rawItem = obj ? normalizePendingApproval(obj, nowMs) : null;
    if (!rawItem || rawItem.id !== stem) continue;
    const item = await reconcileApprovingIfNeeded(rt, rawItem);
    if (item.status === "pending" || item.status === "approving") pending.push(item);
    else recent.push(item);
  }
  pending.sort((a, b) => Date.parse(b.createdAt || "0") - Date.parse(a.createdAt || "0"));
  recent.sort((a, b) => Date.parse(b.decision?.decidedAt || b.createdAt || "0") - Date.parse(a.decision?.decidedAt || a.createdAt || "0"));
  const topRecent = await Promise.all(
    recent.slice(0, MAX_RECENT_DECISIONS).map((item) => reconcileUnitStatusIfActive(rt, item)),
  );
  return { pendingApprovals: pending.slice(0, MAX_PENDING_ITEMS), recentDecisions: topRecent };
}

async function readLatestCockpit(
  cockpitDir: string,
  fallbackInput: {
    mode: GovernanceModeState;
    breaker: GovernanceBreakerState;
    hasCostBreakerFile: boolean;
    pendingApprovals: PendingGovernanceApproval[];
    auditTrail: GovernanceAuditItem[];
    nowIso: string;
  },
): Promise<GovernanceCockpitSummary> {
  const dirRes = await resolveRegularDir(cockpitDir);
  if (dirRes.status !== "ok") return buildFallbackCockpit(fallbackInput);
  try {
    const names = (await readdir(dirRes.realDir)).filter((n) => /cockpit.*\.json$/i.test(n)).sort((a, b) => b.localeCompare(a));
    for (const name of names) {
      const checked = await readOptionalJsonChecked(cockpitDir, name, MAX_AUX_FILE_BYTES);
      const parsed = checked.status === "ok" ? formatCockpitFromDigest(checked.doc) : null;
      if (parsed) return parsed;
    }
  } catch (err) {
    void err;
  }
  return buildFallbackCockpit(fallbackInput);
}

async function loadApprovalByIdRaw(rt: GovernanceRuntime, id: string): Promise<PendingGovernanceApproval> {
  if (!isValidGovernanceApprovalId(id)) throw new GovernanceServiceError(400, "VALIDATION", "invalid approval id");
  const res = await readRegularFileWithinDir(rt.pendingDir, `${id}.json`, MAX_APPROVAL_FILE_BYTES);
  if (res.status === "missing") throw new GovernanceServiceError(404, "NOT_FOUND", `approval not found: ${id}`);
  if (res.status === "invalid") throw new GovernanceServiceError(400, "INVALID_APPROVAL_FILE", `invalid approval file: ${res.reason}`);
  const obj = parseJsonObject(res.text);
  const item = obj ? normalizePendingApproval(obj, rt.nowFn().getTime()) : null;
  if (!item || item.id !== id) throw new GovernanceServiceError(400, "INVALID_APPROVAL_FILE", "approval document failed integrity or schema check");
  return item;
}

async function loadApprovalById(
  rt: GovernanceRuntime,
  id: string,
  opts: { allowReconcileApproving?: boolean; strictReconcile?: boolean } = {},
): Promise<PendingGovernanceApproval> {
  const raw = await loadApprovalByIdRaw(rt, id);
  const reconciled = await reconcileApprovingIfNeeded(rt, raw, {
    allowWhenInFlightSelf: opts.allowReconcileApproving,
    strict: opts.strictReconcile,
  });
  return reconcileUnitStatusIfActive(rt, reconciled);
}

async function recordResumeStatus(
  rt: GovernanceRuntime,
  id: string,
  status: GovernanceResumeStatus,
  opts: { unit?: string; expectedUnit?: string; train?: string; detail?: string; claimFrom?: string } = {},
): Promise<PendingGovernanceApproval> {
  const args = [
    "update-approval-resume", "--id", id, "--status", status,
    ...(opts.claimFrom ? ["--claim-from", opts.claimFrom] : []),
    ...(opts.expectedUnit ? ["--expected-unit", opts.expectedUnit] : []),
    ...(opts.unit ? ["--unit", opts.unit] : []),
    ...(opts.train ? ["--train", opts.train] : []),
    ...(opts.detail ? ["--detail", opts.detail] : []),
  ];
  await execGovernor(rt, args);
  return loadApprovalByIdRaw(rt, id);
}

async function claimResumeSlot(rt: GovernanceRuntime, id: string, unitName: string): Promise<void> {
  try {
    await recordResumeStatus(rt, id, "starting", {
      claimFrom: "not_started,not_started_busy,failed",
      unit: unitName,
      detail: "正在认领并拉起脱离发版列车…",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("RESUME_ALREADY_CLAIMED")) {
      const latest = await loadApprovalById(rt, id).catch((e) => { void e; return undefined; });
      throw new GovernanceServiceError(409, "RESUME_ALREADY_CLAIMED", "该审批单的发版续跑已被其他请求认领或正在执行中", { approval: latest });
    }
    throw err;
  }
}

async function recordFencedResumeResult(
  rt: GovernanceRuntime,
  id: string,
  status: GovernanceResumeStatus,
  expectedUnit: string,
  opts: { unit?: string; train?: string; detail?: string } = {},
): Promise<PendingGovernanceApproval> {
  try {
    return await recordResumeStatus(rt, id, status, { claimFrom: "starting", expectedUnit, ...opts });
  } catch (err) {
    if (err instanceof Error && /RESUME_ALREADY_CLAIMED|RESUME_UNIT_MISMATCH|RESUME_FENCE_REQUIRED/.test(err.message)) {
      return await loadApprovalByIdRaw(rt, id);
    }
    throw err;
  }
}

async function spawnAndRecordBlastResume(
  rt: GovernanceRuntime,
  approval: PendingGovernanceApproval,
  voucherId: string,
  targetSha: string,
  deployScriptPath: string,
  unitName: string,
): Promise<PendingGovernanceApproval> {
  try {
    const spawned = await rt.spawnDetachedDeploy({
      unitName, deployScriptPath, args: ["--deploy", "--allow-dirty", "--platform-from-head"],
      env: { OC_V5_BLAST_VOUCHER: voucherId, OC_V5_EXPECTED_HEAD: targetSha },
      cwd: rt.repoRoot, approvalId: approval.id, targetSha, governorBin: rt.governorBin, governorRoot: rt.governorRoot,
    });
    if (!spawned.started) {
      return await recordFencedResumeResult(rt, approval.id, "failed", unitName, {
        unit: spawned.unitName, detail: spawned.detail ?? "自动续跑发版启动失败",
      });
    }
    return await recordFencedResumeResult(rt, approval.id, "started", unitName, {
      unit: spawned.unitName, train: approval.trainId, detail: spawned.detail ?? `已拉起发版单元 (${spawned.unitName})`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await recordFencedResumeResult(rt, approval.id, "failed", unitName, {
      unit: unitName, detail: `凭证已签发但自动续跑失败：${msg.slice(0, 180)}`,
    }).catch((recErr) => { void recErr; return loadApprovalByIdRaw(rt, approval.id); });
  }
}

async function runSafeBlastResume(rt: GovernanceRuntime, approval: PendingGovernanceApproval): Promise<PendingGovernanceApproval> {
  const voucherId = approval.decision?.issuedArtifactId?.trim() ?? "";
  if (!voucherId) throw new GovernanceServiceError(400, "VALIDATION", "approved blast_voucher is missing issuedArtifactId");
  if (isCommercialGovernanceBranch(approval.branch) || approval.classification === "absolute_reject") {
    throw new GovernanceServiceError(403, "COMMERCIAL_BRANCH_FORBIDDEN", "commercial or absolute_reject approval cannot be resumed");
  }
  const safeSlug = approval.id.replace(/[^a-z0-9-]/gi, "-").slice(0, 32);
  rt.resumeAttemptSeq += 1;
  const unitName = `oc-v5-gov-resume-${safeSlug}-${Math.floor(rt.nowFn().getTime() / 1000)}-${process.pid}-${rt.resumeAttemptSeq}`;
  await claimResumeSlot(rt, approval.id, unitName);
  try {
    if (!rt.deployScriptPath) {
      return await recordFencedResumeResult(rt, approval.id, "not_applicable", unitName, { detail: "未配置自动发版脚本路径" });
    }
    if (!approval.sha || !SHA40_RE.test(approval.sha) || !rt.repoRoot) {
      return await recordFencedResumeResult(rt, approval.id, "failed", unitName, { detail: "审批单缺少有效 40 位提交 SHA 或仓库路径，保守拒绝自动发版" });
    }
    const headSha = await rt.readRepoHeadSha(rt.repoRoot);
    if (!headSha) {
      return await recordFencedResumeResult(rt, approval.id, "failed", unitName, { detail: "无法读取仓库当前 HEAD 提交，保守拒绝自动发版" });
    }
    if (headSha !== approval.sha) {
      return await recordFencedResumeResult(rt, approval.id, "head_moved", unitName, {
        detail: `主分支已前进至 ${headSha.slice(0, 12)}（审批绑定 ${approval.sha.slice(0, 12)}），未自动发版`,
      });
    }
    const busyCheck = await rt.checkDeployBusy(rt.deployLockPath);
    if (busyCheck.busy) {
      return await recordFencedResumeResult(rt, approval.id, "not_started_busy", unitName, {
        detail: busyCheck.detail ?? "发版锁正忙，凭证已签发但未自动发车；请稍后点击安全重试",
      });
    }
    return await spawnAndRecordBlastResume(rt, approval, voucherId, approval.sha, rt.deployScriptPath, unitName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return await recordFencedResumeResult(rt, approval.id, "failed", unitName, {
      unit: unitName, detail: `自动续跑前检查异常：${msg.slice(0, 180)}`,
    }).catch((recErr) => { void recErr; return loadApprovalByIdRaw(rt, approval.id); });
  }
}

async function mapGovernorDecideError(rt: GovernanceRuntime, id: string, err: unknown): Promise<never> {
  if (err instanceof GovernanceServiceError && err.code !== "GOVERNOR_FAILED") throw err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/COMMERCIAL_BRANCH_HARD_LOCK|ABSOLUTE_REJECT/.test(msg)) {
    throw new GovernanceServiceError(403, "COMMERCIAL_BRANCH_FORBIDDEN", msg);
  }
  if (/RESUME_ALREADY_CLAIMED/.test(msg)) {
    const latest = await loadApprovalById(rt, id).catch((e) => { void e; return undefined; });
    throw new GovernanceServiceError(409, "RESUME_ALREADY_CLAIMED", msg, { approval: latest });
  }
  if (/CONFLICT_VERSION_MISMATCH|CONFLICT_SHA256_MISMATCH|ALREADY_RESOLVED|VERSION_CONFLICT|SHA256_CONFLICT|APPROVAL_EXPIRED|IN_PROGRESS|LOCK_TIMEOUT/.test(msg)) {
    const latest = await loadApprovalById(rt, id).catch((e) => { void e; return undefined; });
    throw new GovernanceServiceError(409, "CONFLICT_ALREADY_RESOLVED", msg, { approval: latest });
  }
  if (/APPROVAL_TAMPERED|INVALID_SCHEMA|INVALID_JSON|INVALID_APPROVAL_FILE/.test(msg)) {
    throw new GovernanceServiceError(400, "INVALID_APPROVAL_FILE", msg);
  }
  if (/NOT_FOUND/.test(msg)) throw new GovernanceServiceError(404, "NOT_FOUND", msg);
  if (/ALLOW_WHOLE_COMMIT_REQUIRED|VALIDATION|INVALID_/.test(msg)) {
    throw new GovernanceServiceError(400, "VALIDATION", msg);
  }
  throw err;
}

function validateDecideInput(id: string, input: DecideGovernanceApprovalInput): { note?: string } {
  if (!isValidGovernanceApprovalId(id)) throw new GovernanceServiceError(400, "VALIDATION", "invalid approval id");
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new GovernanceServiceError(400, "VALIDATION", "decision must be 'approve' or 'reject'");
  }
  if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)) {
    throw new GovernanceServiceError(400, "VALIDATION", "expectedVersion must be a positive integer");
  }
  if (input.expectedSha256 !== undefined && !SHA64_RE.test(input.expectedSha256)) {
    throw new GovernanceServiceError(400, "VALIDATION", "expectedSha256 must be a 64-char lowercase hex digest");
  }
  return { note: validateOptionalNote(input.note) };
}

function assertDecidePreconditions(
  current: PendingGovernanceApproval,
  input: DecideGovernanceApprovalInput,
): { expVer?: number; expSha?: string } {
  if (current.status !== "pending") {
    throw new GovernanceServiceError(409, "CONFLICT_ALREADY_RESOLVED", `approval ${current.id} is already ${current.status}`, { approval: current });
  }
  if (input.decision === "approve" && (isCommercialGovernanceBranch(current.branch) || current.classification === "absolute_reject")) {
    throw new GovernanceServiceError(403, "COMMERCIAL_BRANCH_FORBIDDEN", "physical hard-lock: commercial or absolute_reject approval cannot be approved");
  }
  if (
    (input.expectedVersion !== undefined && current.version !== undefined && current.version !== input.expectedVersion) ||
    (input.expectedSha256 !== undefined && current.sha256 !== undefined && current.sha256 !== input.expectedSha256)
  ) {
    throw new GovernanceServiceError(409, "CONFLICT_ALREADY_RESOLVED", `approval ${current.id} changed since it was loaded`, { approval: current });
  }
  return { expVer: input.expectedVersion ?? current.version, expSha: input.expectedSha256 ?? current.sha256 };
}

async function runDecideApproval(
  rt: GovernanceRuntime,
  id: string,
  input: DecideGovernanceApprovalInput,
  actor: string,
): Promise<PendingGovernanceApproval> {
  const { note } = validateDecideInput(id, input);
  if (rt.inFlightApprovals.has(id)) {
    const latest = await loadApprovalById(rt, id).catch((e) => { void e; return undefined; });
    throw new GovernanceServiceError(409, "CONFLICT_ALREADY_RESOLVED", `approval ${id} is currently being resolved`, { approval: latest });
  }
  rt.inFlightApprovals.add(id);
  try {
    let current: PendingGovernanceApproval;
    try {
      current = await loadApprovalById(rt, id, { allowReconcileApproving: true, strictReconcile: true });
    } catch (err) {
      return await mapGovernorDecideError(rt, id, err);
    }
    const { expVer, expSha } = assertDecidePreconditions(current, input);
    const publishGh = input.decision === "approve" && current.kind === "a0_approval" && Boolean(rt.githubRepo);
    const args: string[] = [
      "decide-pending-approval", "--id", id, "--decision", input.decision, "--actor", actor,
      ...(expVer !== undefined ? ["--expected-version", String(expVer)] : []),
      ...(expSha ? ["--expected-sha256", expSha] : []),
      ...(note ? ["--note", note] : []),
      ...(input.allowWholeCommit === true ? ["--allow-whole-commit"] : []),
      ...(publishGh ? ["--publish-github-status"] : []),
    ];
    try {
      await execGovernor(rt, args);
    } catch (err) {
      return await mapGovernorDecideError(rt, id, err);
    }
    const updated = await loadApprovalByIdRaw(rt, id);
    if (input.decision === "reject" || updated.status !== "approved" || updated.kind !== "blast_voucher") return updated;
    if (input.autoResumeTrain === false) {
      try {
        return await recordResumeStatus(rt, id, "skipped", { claimFrom: "not_started", detail: "已按管理员选择跳过自动续跑发版" });
      } catch (err) {
        if (err instanceof Error && /RESUME_ALREADY_CLAIMED|RESUME_FENCE_REQUIRED/.test(err.message)) return await loadApprovalByIdRaw(rt, id);
        throw err;
      }
    }
    return await runSafeBlastResume(rt, updated);
  } finally {
    rt.inFlightApprovals.delete(id);
  }
}

async function runResumeApproval(rt: GovernanceRuntime, id: string, _actor: string): Promise<PendingGovernanceApproval> {
  if (!isValidGovernanceApprovalId(id)) throw new GovernanceServiceError(400, "VALIDATION", "invalid approval id");
  if (rt.inFlightApprovals.has(id)) {
    const latest = await loadApprovalById(rt, id).catch((e) => { void e; return undefined; });
    throw new GovernanceServiceError(409, "RESUME_ALREADY_CLAIMED", `approval ${id} is currently busy`, { approval: latest });
  }
  rt.inFlightApprovals.add(id);
  try {
    let current: PendingGovernanceApproval;
    try {
      current = await loadApprovalById(rt, id, { allowReconcileApproving: true, strictReconcile: true });
    } catch (err) {
      return await mapGovernorDecideError(rt, id, err);
    }
    if (current.status !== "approved") {
      throw new GovernanceServiceError(409, "CONFLICT_ALREADY_RESOLVED", `approval ${id} is not approved (status=${current.status})`, { approval: current });
    }
    if (current.kind !== "blast_voucher") {
      throw new GovernanceServiceError(400, "VALIDATION", "only blast_voucher approvals support resume");
    }
    const rs = current.decision?.resumeStatus;
    if (rs === "starting" || rs === "started" || rs === "running" || rs === "completed") {
      throw new GovernanceServiceError(409, "RESUME_ALREADY_CLAIMED", `approval ${id} resume is already ${rs}`, { approval: current });
    }
    return await runSafeBlastResume(rt, current);
  } finally {
    rt.inFlightApprovals.delete(id);
  }
}

export {
  GovernanceServiceError,
  type DecideGovernanceApprovalInput,
  type GovernanceMode,
  type GovernanceOverviewResponse,
  type PendingGovernanceApproval,
  type SelfhostGovernanceConfig,
  type SelfhostGovernanceService,
};

export function createSelfhostGovernanceService(config: SelfhostGovernanceConfig): SelfhostGovernanceService {
  const governorRoot = path.resolve(config.governorRoot);
  const ctrlDir = path.join(governorRoot, "control");
  const timeoutMs = Math.min(config.commandTimeoutMs ?? MAX_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const execFn = config.execFileFn ?? defaultExecFile;
  const commandEnv: Readonly<Record<string, string>> = {
    PATH: config.commandPath ?? DEFAULT_SAFE_PATH,
    OC_GOVERNOR_ROOT: governorRoot,
    ...(config.githubRepo ? { GITHUB_REPOSITORY: config.githubRepo } : {}),
    ...(config.commandEnv ?? {}),
  };
  const rt: GovernanceRuntime = {
    governorRoot,
    governorBin: config.governorBin,
    ctrlDir,
    pendingDir: path.join(ctrlDir, "pending-approvals"),
    cockpitDir: path.resolve(config.cockpitDir ?? DEFAULT_COCKPIT_DIR),
    deployScriptPath: config.deployScriptPath,
    repoRoot: config.repoRoot,
    deployLockPath: config.deployLockPath ?? DEFAULT_DEPLOY_LOCK_PATH,
    githubRepo: config.githubRepo,
    timeoutMs,
    commandEnv,
    execFn,
    checkDeployBusy: config.checkDeployBusyFn ?? createDefaultCheckDeployBusy(execFn, timeoutMs, commandEnv),
    readRepoHeadSha: config.readRepoHeadShaFn ?? createDefaultReadRepoHeadSha(execFn, timeoutMs, commandEnv),
    probeUnitStatus: config.probeUnitStatusFn ?? createDefaultProbeUnitStatus(execFn, config.systemctlBin ?? DEFAULT_SYSTEMCTL_BIN, commandEnv),
    spawnDetachedDeploy:
      config.spawnDetachedDeployFn ??
      createDefaultSpawnDetachedDeploy(execFn, config.systemdRunBin ?? DEFAULT_SYSTEMD_RUN_BIN, timeoutMs, commandEnv),
    nowFn: config.now ?? (() => new Date()),
    inFlightApprovals: new Set<string>(),
    resumeAttemptSeq: 0,
  };

  return {
    async getOverview(): Promise<GovernanceOverviewResponse> {
      const now = rt.nowFn();
      const nowMs = now.getTime();
      const [mode, breakerMeta, approvals, auditTrail] = await Promise.all([
        readModeStateFromDisk(rt.ctrlDir),
        readBreakerStateWithMeta(rt.ctrlDir, nowMs),
        readAllApprovals(rt, nowMs),
        readAuditTrail(rt.ctrlDir),
      ]);
      const cockpit = await readLatestCockpit(rt.cockpitDir, {
        mode, breaker: breakerMeta.breaker, hasCostBreakerFile: breakerMeta.hasCostBreakerFile,
        pendingApprovals: approvals.pendingApprovals, auditTrail, nowIso: now.toISOString(),
      });
      return { enabled: true, mode, breaker: breakerMeta.breaker, pendingApprovals: approvals.pendingApprovals, recentDecisions: approvals.recentDecisions, cockpit, auditTrail };
    },
    getApproval: (id: string) => loadApprovalById(rt, id),
    async setMode(mode: GovernanceMode, reason: string, _actor: string): Promise<GovernanceModeState> {
      if (!isValidGovernanceMode(mode)) throw new GovernanceServiceError(400, "VALIDATION", `invalid governance mode: ${String(mode)}`);
      const trimmedReason = validateReason(reason, "reason");
      try {
        await execGovernor(rt, ["mode", mode, "--reason", trimmedReason]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("BREAKER_TRIPPED_USE_UNLOCK")) {
          throw new GovernanceServiceError(409, "BREAKER_TRIPPED_USE_UNLOCK", "熔断器尚未解锁，请先确认根因并解锁熔断后再切回全自动模式");
        }
        throw err;
      }
      return readModeStateFromDisk(rt.ctrlDir);
    },
    async unlockBreaker(reason: string, actor: string): Promise<GovernanceBreakerState> {
      const trimmedReason = validateReason(reason, "reason");
      const govReason = trimmedReason.length >= 8 ? trimmedReason : `[${actor}] ${trimmedReason}`;
      await execGovernor(rt, ["unlock-breaker", "--reason", govReason]);
      return (await readBreakerStateWithMeta(rt.ctrlDir, rt.nowFn().getTime())).breaker;
    },
    decideApproval: (id, input, actor) => runDecideApproval(rt, id, input, actor),
    resumeApproval: (id, actor) => runResumeApproval(rt, id, actor),
  };
}
