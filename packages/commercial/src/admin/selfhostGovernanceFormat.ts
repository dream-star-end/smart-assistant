/**
 * OCV5-914 — Pure formatting, translation, integrity verification, and normalization
 * helpers for the Selfhost Governance Control Plane (L3 admin-ops, zero I/O, zero env).
 */
import { sha256HexUtf8, timingSafeHexEqual } from "../crypto/digest.js";
import {
  isValidGovernanceApprovalId, isValidGovernanceMode,
  type GovernanceApprovalClassification, type GovernanceApprovalDecision, type GovernanceApprovalKind,
  type GovernanceApprovalRecommendation, type GovernanceApprovalStatus, type GovernanceAuditItem,
  type GovernanceBreakerState, type GovernanceCockpitGauge, type GovernanceCockpitSummary, type GovernanceMode,
  type GovernanceModeState, type GovernanceResumeStatus, type GovernanceRiskCategory, type GovernanceSafetyLight,
  type GovernanceSafetyLightKey, type GovernanceStewardVerdict, type PendingGovernanceApproval,
  type SafetyLightLevel,
} from "./selfhostGovernanceTypes.js";

type JsonRecord = Record<string, unknown>;
type AuditFormatter = (raw: JsonRecord, outcome: string) => { label: string; detail: string };

const SHA64_RE = /^[0-9a-f]{64}$/;
const MODE_LABELS: Readonly<Record<GovernanceMode, string>> = {
  autonomous: "全自动自治",
  debt_first: "仅修债（暂停新特性）",
  emergency_stop: "紧急急停",
};
const LIGHT_RANK: Readonly<Record<SafetyLightLevel, number>> = { green: 0, unknown: 1, yellow: 2, red: 3 };
const LIGHT_KEYS: ReadonlySet<string> = new Set<GovernanceSafetyLightKey>([
  "commercialIsolation", "billingFormulaSafety", "dataIntegrity", "rollbackSafety",
]);
const APPROVAL_KINDS: ReadonlySet<string> = new Set<GovernanceApprovalKind>(["blast_voucher", "a0_approval", "breaker_unlock"]);
const APPROVAL_STATUSES: ReadonlySet<string> = new Set<GovernanceApprovalStatus>([
  "pending", "approving", "approved", "rejected", "expired", "reconcile_required",
]);
const APPROVAL_CLASSES: ReadonlySet<string> = new Set<GovernanceApprovalClassification>([
  "absolute_reject", "human_review_required", "auto_pass",
]);
const RISK_CATEGORIES: ReadonlySet<string> = new Set<GovernanceRiskCategory>(["ux_degradation", "billing_change"]);
const RECOMMENDATION_ACTIONS: ReadonlySet<string> = new Set<GovernanceApprovalRecommendation["action"]>([
  "approve", "reject", "caution",
]);
const RESUME_STATUSES: ReadonlySet<string> = new Set<GovernanceResumeStatus>([
  "not_started", "starting", "started", "running", "not_started_busy", "head_moved", "completed", "failed", "skipped", "not_applicable",
]);
const STEWARD_VERDICTS: ReadonlySet<string> = new Set(["approve", "veto", "missing", "invalid"]);

const asRec = (v: unknown): JsonRecord | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonRecord) : null);
const asStr = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const fmtPct = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "未采集");
const fmtNum = (v: unknown, unit = ""): string => (typeof v === "number" && Number.isFinite(v) ? `${v}${unit}` : "未采集");
const fmtSigned = (v: unknown): string => (typeof v !== "number" || !Number.isFinite(v) ? "未采集" : v > 0 ? `+${v}` : String(v));

export function mapSafetyLight(raw: unknown): SafetyLightLevel {
  if (raw === "RED" || raw === "red") return "red";
  if (raw === "AMBER" || raw === "yellow") return "yellow";
  if (raw === "GREEN" || raw === "green") return "green";
  return "unknown";
}

function worstLight(lights: readonly SafetyLightLevel[]): SafetyLightLevel {
  return lights.reduce<SafetyLightLevel>((acc, l) => (LIGHT_RANK[l] > LIGHT_RANK[acc] ? l : acc), "green");
}

function canonicalSort(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(canonicalSort);
  const rec = asRec(val);
  if (!rec) return val;
  const sorted: JsonRecord = {};
  for (const key of Object.keys(rec).sort()) sorted[key] = canonicalSort(rec[key]);
  return sorted;
}

/** Byte-identical to oc-governor.sh compute_approval_sha256 ("pending-approval-v1\n" + sorted JSON). */
export function computeApprovalSha256(doc: JsonRecord): string {
  const clone: JsonRecord = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== "sha256") clone[k] = v;
  }
  const canonical = `pending-approval-v1\n${JSON.stringify(canonicalSort(clone))}`;
  return sha256HexUtf8(canonical);
}

export function verifyApprovalSha256(doc: JsonRecord): boolean {
  const stored = asStr(doc.sha256);
  if (!stored || !SHA64_RE.test(stored)) return false;
  const expected = computeApprovalSha256(doc);
  return timingSafeHexEqual(stored, expected);
}

export function normalizeModeState(
  raw: JsonRecord | null,
  options?: { missing?: boolean; corruptReason?: string },
): GovernanceModeState {
  if (options?.missing) {
    return {
      mode: "autonomous",
      effectiveMode: "autonomous",
      corrupt: false,
      uninitialized: true,
      autoMergeFrozen: false,
      reason: "模式文件尚未初始化（列车当前默认按全自动放行，建议显式保存运行模式）",
      updatedAt: "",
      updatedBy: "system",
    };
  }
  const modeRaw = asStr(raw?.mode);
  if (!raw || !modeRaw || !isValidGovernanceMode(modeRaw)) {
    return {
      mode: "emergency_stop",
      effectiveMode: "unknown",
      corrupt: true,
      uninitialized: false,
      autoMergeFrozen: true,
      reason: options?.corruptReason ?? "mode.json 已损坏或不可读，控制面按 fail-closed 冻结，请核验后显式设置模式",
      updatedAt: "",
      updatedBy: "system",
    };
  }
  return {
    mode: modeRaw,
    effectiveMode: modeRaw,
    corrupt: false,
    uninitialized: false,
    autoMergeFrozen: asBool(raw.autoMergeFrozen) ?? modeRaw !== "autonomous",
    reason: asStr(raw.reason) ?? "",
    updatedAt: asStr(raw.updatedAt) ?? "",
    updatedBy: asStr(raw.updatedBy) ?? "system",
  };
}

export function normalizeBreakerState(input: {
  breakerDoc: JsonRecord | null;
  costDoc: JsonRecord | null;
  cardLines: string[];
  recentRollbacks: number;
  readError?: boolean;
  readErrorMessage?: string;
}): GovernanceBreakerState {
  const { breakerDoc: b, costDoc: c, cardLines, recentRollbacks, readError, readErrorMessage } = input;
  const costTripped = c?.tripped === true;
  const dailyUsd = asNum(c?.dailyUsd);
  const limitUsd = asNum(c?.limitUsd);
  const fallbackCost = dailyUsd !== undefined && limitUsd !== undefined
    ? `单日算力开销 $${dailyUsd} 已触及熔断上限 $${limitUsd}`
    : "单日算力预算触发熔断";
  const costReason = costTripped ? asStr(c?.reason) ?? fallbackCost : undefined;
  const reason = asStr(b?.reason) ?? costReason;
  const train = asStr(b?.latestTrain) ?? asStr(b?.train);
  const triggeredAt = asStr(b?.trippedAt) ?? asStr(b?.triggeredAt) ?? asStr(c?.checkedAt);
  return {
    tripped: b?.tripped === true || costTripped,
    ...(reason ? { reason } : {}),
    ...(train ? { train } : {}),
    ...(triggeredAt ? { triggeredAt } : {}),
    cardLines,
    costTripped,
    ...(costReason ? { costReason } : {}),
    recentRollbacks,
    ...(readError ? { readError: true, readErrorMessage: readErrorMessage ?? "熔断状态文件损坏或无法读取" } : {}),
  };
}

function normalizeSafetyLight(raw: unknown): GovernanceSafetyLight | null {
  const obj = asRec(raw);
  const key = asStr(obj?.key);
  if (!obj || !key || !LIGHT_KEYS.has(key)) return null;
  return { key: key as GovernanceSafetyLightKey, label: asStr(obj.label) ?? key, level: mapSafetyLight(obj.level), detail: asStr(obj.detail) ?? "" };
}

function normalizeStewardVerdict(raw: unknown): GovernanceStewardVerdict {
  const obj = asRec(raw);
  if (!obj) return { present: false, verdict: "missing" };
  const vRaw = asStr(obj.verdict);
  const verdict: GovernanceStewardVerdict["verdict"] =
    vRaw && STEWARD_VERDICTS.has(vRaw) ? (vRaw as GovernanceStewardVerdict["verdict"]) : "invalid";
  const out: GovernanceStewardVerdict = { present: asBool(obj.present) ?? verdict !== "missing", verdict };
  const af = asStr(obj.authorFamily); if (af) out.authorFamily = af;
  const sf = asStr(obj.stewardFamily); if (sf) out.stewardFamily = sf;
  const sm = asStr(obj.stewardModel); if (sm) out.stewardModel = sm;
  const hv = asBool(obj.hmacVerified); if (hv !== undefined) out.hmacVerified = hv;
  const sum = asStr(obj.summary); if (sum) out.summary = sum;
  const rec = asStr(obj.recordedAt); if (rec) out.recordedAt = rec;
  return out;
}

function normalizeDecision(raw: unknown): GovernanceApprovalDecision | undefined {
  const obj = asRec(raw);
  if (!obj || (obj.action !== "approve" && obj.action !== "reject")) return undefined;
  const out: GovernanceApprovalDecision = {
    action: obj.action,
    decidedBy: asStr(obj.decidedBy) ?? "unknown",
    decidedAt: asStr(obj.decidedAt) ?? "",
  };
  const note = asStr(obj.note); if (note) out.note = note;
  const artifact = asStr(obj.issuedArtifactId) ?? asStr(obj.voucherId); if (artifact) out.issuedArtifactId = artifact;
  const rs = asStr(obj.resumeStatus); if (rs && RESUME_STATUSES.has(rs)) out.resumeStatus = rs as GovernanceResumeStatus;
  const ru = asStr(obj.resumeUnit); if (ru) out.resumeUnit = ru;
  const rd = asStr(obj.resumeDetail); if (rd) out.resumeDetail = rd;
  const rce = asStr(obj.resumeClaimExpiresAt); if (rce) out.resumeClaimExpiresAt = rce;
  return out;
}

function normalizeRecommendation(raw: unknown): GovernanceApprovalRecommendation | undefined {
  const obj = asRec(raw);
  const action = asStr(obj?.action);
  const label = asStr(obj?.label);
  const reason = asStr(obj?.reason);
  if (!obj || !action || !RECOMMENDATION_ACTIONS.has(action) || !label || !reason) return undefined;
  return { action: action as GovernanceApprovalRecommendation["action"], label, reason };
}

export function inferRiskCategory(code: string, scope?: string): GovernanceRiskCategory {
  const upperCode = code.toUpperCase();
  const lowerScope = (scope ?? "").toLowerCase();
  if (
    upperCode === "BILLING_CORE_LOCKED" ||
    upperCode.includes("BILLING") ||
    upperCode.includes("COST") ||
    lowerScope.includes("billing") ||
    lowerScope.includes("cost") ||
    lowerScope.includes("payment")
  ) {
    return "billing_change";
  }
  return "ux_degradation";
}

function summarizeFilesPlain(files: readonly string[]): string {
  if (files.length === 0) return "";
  const shortNames = files.slice(0, 2).map((f) => {
    const parts = f.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1]! : f;
  });
  return files.length > 2 ? `${shortNames.join("、")} 等 ${files.length} 个文件` : shortNames.join("、");
}

function sanitizeLegacySummary(text: string): string {
  return text
    .replace(/(?:refs\/heads\/|origin\/)?feat\/[a-z0-9._/-]+/gi, "")
    .replace(/\b[0-9a-f]{40}\b/gi, "")
    .replace(/\b(?:HMAC|AST|SHA256|SHA-256|SHA)\b/gi, "")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function synthesizeWhatChanged(input: {
  riskCategory: GovernanceRiskCategory;
  kind: GovernanceApprovalKind;
  code: string;
  files: readonly string[];
  plainSummary?: string;
}): string {
  const fileText = summarizeFilesPlain(input.files);
  const upperCode = input.code.toUpperCase();
  if (input.riskCategory === "billing_change") {
    if (input.kind === "breaker_unlock" || upperCode.includes("COST")) {
      return "单日算力开销达到预算上限触发保护熔断，当前申请恢复自动运行。";
    }
    return fileText
      ? `调整了计费相关代码（${fileText}），可能影响计费规则或扣费逻辑。`
      : "本次改动涉及计费或预算控制相关逻辑。";
  }
  if (/DDL|SQL|MIGRATION/.test(upperCode)) {
    return fileText
      ? `包含数据库结构变更（${fileText}），可能影响线上数据结构或服务稳定性。`
      : "本次改动包含高风险数据库结构变更。";
  }
  if (input.kind === "breaker_unlock" || /BREAKER|ROLLBACK/.test(upperCode)) {
    return "近期发版触发了自动保护熔断，当前申请恢复自动更新。";
  }
  if (input.kind === "a0_approval" || upperCode.startsWith("A0_")) {
    return fileText
      ? `调整了核心发布安全护栏规则（${fileText}）。`
      : "本次改动调整了核心发布安全护栏规则。";
  }
  if (fileText) {
    return `修改了线上核心功能代码（${fileText}），可能影响用户体验或稳定性。`;
  }
  const cleaned = input.plainSummary ? sanitizeLegacySummary(input.plainSummary) : "";
  return cleaned || "本次改动触发了稳定性保护检查，需要人工确认。";
}

export function synthesizeWhyNeedYou(input: {
  riskCategory: GovernanceRiskCategory;
  kind: GovernanceApprovalKind;
  code: string;
}): string {
  const upperCode = input.code.toUpperCase();
  if (input.riskCategory === "billing_change") {
    if (input.kind === "breaker_unlock" || upperCode.includes("COST")) {
      return "命中「计费方式可能变化」保护：算力成本已触及预算阈值，需你确认开销可控后再恢复自动运行。";
    }
    return "命中「计费方式可能变化」保护：改动涉及计费核心逻辑，可能影响扣费或账单计算，需你确认无误后放行。";
  }
  if (/DDL|SQL|MIGRATION/.test(upperCode)) {
    return "命中「用户体验可能下降」保护：该数据库变更可能影响已有数据或导致服务中断，需你确认安全后放行。";
  }
  if (input.kind === "breaker_unlock" || /BREAKER|ROLLBACK/.test(upperCode)) {
    return "命中「用户体验可能下降」保护：近期发版出现异常已暂停自动更新，需你确认问题排查完毕后再恢复。";
  }
  if (input.kind === "a0_approval" || upperCode.startsWith("A0_")) {
    return "命中「用户体验可能下降」保护：调整发布安全护栏可能影响线上质量防线，需你确认后生效。";
  }
  return "命中「用户体验可能下降」保护：该改动可能影响线上功能稳定性或使用体验，需你确认风险可控后放行。";
}

export function synthesizeRecommendation(
  stewardVerdict: GovernanceStewardVerdict,
  safetyLights: readonly GovernanceSafetyLight[],
): GovernanceApprovalRecommendation {
  if (stewardVerdict.verdict === "veto") {
    return { action: "reject", label: "建议驳回", reason: "独立复核给出否决意见，建议先驳回并修改后再提交。" };
  }
  if (safetyLights.some((l) => l.level === "red")) {
    return { action: "reject", label: "建议驳回", reason: "安全核验存在高危红灯项，风险较高，建议先驳回排查。" };
  }
  if (stewardVerdict.verdict === "approve" && stewardVerdict.hmacVerified !== false) {
    if (safetyLights.some((l) => l.level === "yellow")) {
      return { action: "caution", label: "确认后可批准", reason: "独立复核已通过，但涉及敏感变更范围，确认符合预期后可批准放行。" };
    }
    return { action: "approve", label: "建议批准", reason: "独立复核已通过且安全核验无异常，确认符合预期后可直接批准。" };
  }
  return { action: "caution", label: "请谨慎核对", reason: "暂缺完整的独立复核结论，请确认改动内容与预期一致后再决定。" };
}

function extractApprovalOptionals(raw: JsonRecord): Partial<PendingGovernanceApproval> {
  const opt: Partial<PendingGovernanceApproval> = {};
  const scope = asStr(raw.scope); if (scope) opt.scope = scope;
  const sha = asStr(raw.sha); if (sha) opt.sha = sha;
  const trainId = asStr(raw.trainId) ?? asStr(raw.train); if (trainId) opt.trainId = trainId;
  const ticketId = asStr(raw.ticketId) ?? asStr(raw.ticket); if (ticketId) opt.ticketId = ticketId;
  const totalChangedFiles = asNum(raw.totalChangedFiles); if (totalChangedFiles !== undefined) opt.totalChangedFiles = totalChangedFiles;
  const version = asNum(raw.version); if (version !== undefined && Number.isInteger(version) && version >= 1) opt.version = version;
  const sha256 = asStr(raw.sha256); if (sha256 && SHA64_RE.test(sha256)) opt.sha256 = sha256;
  const cls = asStr(raw.classification); if (cls && APPROVAL_CLASSES.has(cls)) opt.classification = cls as GovernanceApprovalClassification;
  const awc = asBool(raw.allowWholeCommit); if (awc !== undefined) opt.allowWholeCommit = awc;
  const lastErr = asStr(raw.lastError); if (lastErr) opt.lastError = lastErr;
  const decision = normalizeDecision(raw.decision); if (decision) opt.decision = decision;
  return opt;
}

function validateApprovalCore(
  raw: JsonRecord,
  nowMs: number,
): { id: string; kind: GovernanceApprovalKind; status: GovernanceApprovalStatus; expiresAt: string } | null {
  if (raw.schemaVersion !== 1 || !verifyApprovalSha256(raw)) return null;
  const id = asStr(raw.id);
  const kindRaw = asStr(raw.kind);
  const statusRaw = asStr(raw.status);
  const expiresAt = asStr(raw.expiresAt);
  if (!id || !isValidGovernanceApprovalId(id) || !kindRaw || !APPROVAL_KINDS.has(kindRaw)) return null;
  if (!statusRaw || !APPROVAL_STATUSES.has(statusRaw) || !expiresAt) return null;
  const expMs = Date.parse(expiresAt);
  if (Number.isNaN(expMs)) return null;
  const status: GovernanceApprovalStatus =
    statusRaw === "pending" && nowMs >= expMs ? "expired" : (statusRaw as GovernanceApprovalStatus);
  return { id, kind: kindRaw as GovernanceApprovalKind, status, expiresAt };
}

export function normalizePendingApproval(raw: JsonRecord, nowMs: number): PendingGovernanceApproval | null {
  const core = validateApprovalCore(raw, nowMs);
  if (!core) return null;
  const code = asStr(raw.code) ?? "GOVERNANCE_LOCKED";
  const scope = asStr(raw.scope);
  const files = Array.isArray(raw.files) ? raw.files.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const safetyLights = Array.isArray(raw.safetyLights)
    ? raw.safetyLights.map(normalizeSafetyLight).filter((x): x is GovernanceSafetyLight => x !== null)
    : [];
  const stewardVerdict = normalizeStewardVerdict(raw.stewardVerdict);
  const rawPlainSummary = asStr(raw.plainSummary) ?? asStr(raw.summary);
  const rawRiskCategory = asStr(raw.riskCategory);
  const riskCategory: GovernanceRiskCategory =
    rawRiskCategory && RISK_CATEGORIES.has(rawRiskCategory)
      ? (rawRiskCategory as GovernanceRiskCategory)
      : inferRiskCategory(code, scope);
  const whatChanged =
    asStr(raw.whatChanged) ??
    synthesizeWhatChanged({ riskCategory, kind: core.kind, code, files, plainSummary: rawPlainSummary });
  const whyNeedYou =
    asStr(raw.whyNeedYou) ??
    synthesizeWhyNeedYou({ riskCategory, kind: core.kind, code });
  const recommendation =
    normalizeRecommendation(raw.recommendation) ??
    synthesizeRecommendation(stewardVerdict, safetyLights);
  return {
    ...core,
    code,
    branch: asStr(raw.branch) ?? "",
    title: asStr(raw.title) ?? `治理审批单 ${core.id}`,
    plainSummary: rawPlainSummary ?? whatChanged,
    riskCategory,
    whatChanged,
    whyNeedYou,
    recommendation,
    approveEffect: asStr(raw.approveEffect) ?? "批准后将放行本次变更并继续自动发版。",
    rejectEffect: asStr(raw.rejectEffect) ?? "驳回后不会放行本次变更，线上版本保持不变。",
    files, safetyLights, stewardVerdict,
    createdAt: asStr(raw.createdAt) ?? "",
    ...extractApprovalOptionals(raw),
  };
}

const modeLabelOf = (raw: string | undefined): string => (raw && isValidGovernanceMode(raw) ? MODE_LABELS[raw] : raw ?? "未知");
const shortSha = (raw: JsonRecord): string => (asStr(raw.sha) ?? "").slice(0, 12) || "-";
const suffixReason = (raw: JsonRecord): string => (asStr(raw.reason) ? `：${asStr(raw.reason)}` : "");

const AUDIT_FORMATTERS: Readonly<Record<string, AuditFormatter>> = {
  mode_set: (r) => ({ label: "切换总闸模式", detail: `由「${modeLabelOf(asStr(r.prevMode))}」切至「${modeLabelOf(asStr(r.mode))}」${suffixReason(r)}` }),
  check_blast_radius: (r, o) => {
    const br = asStr(r.branch) ?? "未知分支";
    if (o === "ok_auto_noncore_billing") return { label: "非核心计费辅助自动放行", detail: "仅涉及非核心计费辅助模块，未改动计费规则，已自动放行" };
    if (o === "ok_semantic_no_runtime_billing" || o === "ok_auto_no_runtime_billing") return { label: "纯注释/类型声明自动放行", detail: "仅改动注释或类型声明，未影响计费运行逻辑，已自动放行" };
    if (o === "ok_semantic_noncore") return { label: "爆破半径语义降噪放行", detail: `纯注释/类型变更且已过严格 HMAC 跨家族审计，自动放行（${br}）` };
    if (o === "blocked") return { label: "爆破半径拦截", detail: `已拦截高敏变更（${asStr(r.code) ?? "受保护路径"}，分支 ${br}）` };
    return { label: "爆破半径校验通过", detail: `分支 ${br} 爆破半径检查通过` };
  },
  issue_blast_voucher: (r) => ({ label: "签发爆破半径凭证", detail: `已签发凭证 ${asStr(r.voucherId) ?? "-"}（范围：${asStr(r.scope) ?? "-"}）` }),
  approve_a0: (r) => ({ label: "签发 A0 放行印章", detail: `已放行提交 ${shortSha(r)}${suffixReason(r)}` }),
  revoke_a0: (r) => ({ label: "撤销 A0 放行印章", detail: `已撤销提交 ${shortSha(r)}${suffixReason(r)}` }),
  check_a0: (r, o) => ({ label: "校验 A0 印章", detail: `提交 ${shortSha(r)} 校验结果：${asStr(r.reason) ?? o}` }),
  a0_tamper: (r, o) => ({ label: "拦截异常 A0 印章", detail: `提交 ${shortSha(r)} 校验结果：${asStr(r.reason) ?? o}` }),
  record_rollback: (r) => ({ label: "记录发版回滚", detail: `列车 ${asStr(r.train) ?? "-"} 回滚（近 7 天累计 ${fmtNum(r.rollbackCount7d, " 次")}）` }),
  trip_breaker: (r) => ({ label: "触发熔断总闸", detail: `列车 ${asStr(r.train) ?? "-"} 触发熔断（近 7 天累计 ${fmtNum(r.rollbackCount7d, " 次")}）` }),
  check_cost_breaker: (r, o) => ({ label: "算力预算检查", detail: `当日开销 $${fmtNum(r.dailyUsd)} / 上限 $${fmtNum(r.limitUsd)}（${o === "tripped" ? "已熔断" : "正常"}）` }),
  unlock_breaker: (r) => ({ label: "人工解锁熔断", detail: `已确认根因并恢复自治运行${suffixReason(r)}` }),
  record_pending_approval: (r) => ({ label: "生成待拍板审批单", detail: `已创建审批单 ${asStr(r.approvalId) ?? asStr(r.id) ?? "-"}（${asStr(r.code) ?? "待审核"}）` }),
  decide_pending_approval: (r) => {
    const isRej = asStr(r.decision) === "reject";
    return { label: isRej ? "驳回治理审批单" : "批准治理审批单", detail: `审批单 ${asStr(r.approvalId) ?? asStr(r.id) ?? "-"} 已${isRej ? "驳回" : "批准"}${suffixReason(r)}` };
  },
  resolve_pending_approval: (r) => {
    const isRej = asStr(r.decision) === "reject";
    return { label: isRej ? "驳回治理审批单" : "批准治理审批单", detail: `审批单 ${asStr(r.approvalId) ?? asStr(r.id) ?? "-"} 已${isRej ? "驳回" : "批准"}${suffixReason(r)}` };
  },
  update_approval_resume: (r) => ({ label: "更新续跑发版状态", detail: `审批单 ${asStr(r.approvalId) ?? asStr(r.id) ?? "-"} 续跑状态：${asStr(r.resumeStatus) ?? "-"}` }),
};

export function translateAuditEntry(raw: JsonRecord): GovernanceAuditItem | null {
  const ts = asStr(raw.ts);
  const action = asStr(raw.action);
  if (!ts || !action) return null;
  const outcome = asStr(raw.outcome) ?? "ok";
  const fmt = AUDIT_FORMATTERS[action];
  const { label, detail } = fmt ? fmt(raw, outcome) : { label: "治理控制面事件", detail: asStr(raw.reason) ?? `${action}（结果：${outcome}）` };
  return { ts, action, label, actor: asStr(raw.actor) ?? "system", outcome, detail };
}

function buildMetaGauge(m: JsonRecord): GovernanceCockpitGauge {
  const comm = asRec(m.commercialBranchZeroTouch);
  const a0 = asRec(m.a0Audit7d);
  const zeroTouch = comm?.confirmedZeroUnauthorized;
  const baseLight = mapSafetyLight(m.status);
  const light: SafetyLightLevel = zeroTouch === false ? "red" : zeroTouch !== true && baseLight === "green" ? "unknown" : baseLight;
  const isolationVal = zeroTouch === true ? "已核验零触碰" : zeroTouch === false ? "告警" : "未核验";
  const summary =
    zeroTouch === false ? "检测到商业分支越界尝试"
      : light === "green" ? "商业分支零触碰已核验，跨家族审计运行正常"
        : light === "unknown" ? "未采集 / 暂未核验（商业隔离或审计证据不全）"
          : "需关注元护栏拦截或审计波动";
  return {
    id: "metaGuardrailIntegrity", title: "元护栏完整性审计", light, summary,
    metrics: [
      { label: "7天 A0 放行/拦截", value: `${fmtNum(a0?.approvedRelaxations)} / ${fmtNum(a0?.interceptedAttempts)}` },
      { label: "跨家族审计通过率", value: fmtPct(asRec(m.stewardSignoff7d)?.signoffRate) },
      { label: "商业分支隔离", value: isolationVal },
    ],
  };
}

function buildComputeGauge(c: JsonRecord): GovernanceCockpitGauge {
  const costTrip = c.costBreakerTripped;
  const baseLight = mapSafetyLight(c.status);
  const light: SafetyLightLevel = costTrip === true ? "red" : costTrip !== false && baseLight === "green" ? "unknown" : baseLight;
  const cons = asRec(c.weeklyConsumption);
  const summary = costTrip === true ? "单日算力预算已触发熔断"
    : light === "green" ? "算力开销与失败列车浪费在护栏内"
      : light === "unknown" ? "未采集 / 暂未核验（暂无算力周报）" : "需关注近期算力波动或失败浪费";
  return {
    id: "computeAndWaste", title: "算力与浪费护栏", light, summary,
    metrics: [
      { label: "本周开销 (USD)", value: typeof cons?.totalUsd === "number" ? `$${cons.totalUsd}` : "未采集" },
      { label: "失败列车占比", value: fmtPct(asRec(c.waste)?.failedTrainRatio) },
      { label: "预算熔断", value: costTrip === true ? "已触发" : costTrip === false ? "正常" : "未采集" },
    ],
  };
}

export function formatCockpitFromDigest(raw: JsonRecord): GovernanceCockpitSummary | null {
  const g = asRec(raw.gauges);
  const s = asRec(g?.structureAndRework);
  const d = asRec(g?.deliveryAndExperience);
  const c = asRec(g?.computeAndWaste);
  const m = asRec(g?.metaGuardrailIntegrity);
  if (!s || !d || !c || !m) return null;
  const sL = mapSafetyLight(s.status);
  const dL = mapSafetyLight(d.status);
  const gauges: GovernanceCockpitGauge[] = [
    {
      id: "structureAndRework", title: "结构与返工晴雨表", light: sL,
      summary: sL === "green" ? "架构边界稳定，近 14 天返工率受控" : sL === "unknown" ? "未采集 / 暂未核验（等待结构周报样本）" : "需关注近期返工比例或架构违规趋势",
      metrics: [
        { label: "14天返工率", value: fmtPct(asRec(s.rework14d)?.ratio) },
        { label: "架构违规数", value: fmtNum(asRec(s.archViolations)?.total) },
        { label: "7天净增代码行", value: fmtSigned(asRec(s.prodLoc7d)?.netDelta) },
      ],
    },
    {
      id: "deliveryAndExperience", title: "交付与体验稳定性", light: dL,
      summary: dL === "green" ? "发版列车通过率与保留集验收健康" : dL === "unknown" ? "未采集 / 暂未核验（等待交付周报样本）" : "近期存在回滚或发版通过率波动",
      metrics: [
        { label: "7天发版通过率", value: fmtPct(asRec(d.trainPassRate7d)?.rate) },
        { label: "本周回滚次数", value: fmtNum(d.weeklyRollbacks, " 次") },
        { label: "保留集验收", value: asStr(asRec(d.retentionLatest)?.summary) ?? fmtNum(asRec(d.retentionLatest)?.passed) },
      ],
    },
    buildComputeGauge(c),
    buildMetaGauge(m),
  ];
  const generatedAt = asStr(raw.generatedAt);
  const declared = raw.overallStatus !== undefined ? mapSafetyLight(raw.overallStatus) : "unknown";
  return { available: true, ...(generatedAt ? { generatedAt } : {}), overallLight: worstLight([declared, ...gauges.map((x) => x.light)]), gauges };
}

function buildFallbackCostAndMetaGauges(
  breaker: GovernanceBreakerState,
  hasCostBreakerFile: boolean,
  pendingCount: number,
  blocked: number,
): [GovernanceCockpitGauge, GovernanceCockpitGauge] {
  const costLight: SafetyLightLevel = breaker.costTripped ? "red" : hasCostBreakerFile ? "green" : "unknown";
  const costSummary = breaker.costTripped
    ? breaker.costReason ?? "算力预算已触发熔断"
    : hasCostBreakerFile ? "单日算力预算检查正常" : "未采集 / 暂未核验（暂无算力检查记录）";
  const costVal = breaker.costTripped ? "已触发" : hasCostBreakerFile ? "正常" : "未采集";
  return [
    {
      id: "computeAndWaste", title: "算力与浪费护栏", light: costLight, summary: costSummary,
      metrics: [{ label: "算力熔断", value: costVal }, { label: "周报数据源", value: "未采集" }],
    },
    {
      id: "metaGuardrailIntegrity", title: "元护栏完整性审计", light: pendingCount > 0 ? "yellow" : "unknown",
      summary: pendingCount > 0 ? `当前有 ${pendingCount} 项高敏拦截等待拍板` : "未采集周报（实时控制面暂无待拍板拦截）",
      metrics: [{ label: "待拍板审批单", value: `${pendingCount} 项` }, { label: "近期拦截记录", value: `${blocked} 条` }],
    },
  ];
}

function resolveFallbackModeDisplay(mode: GovernanceModeState): { light: SafetyLightLevel; summary: string; label: string } {
  if (mode.corrupt || mode.effectiveMode === "unknown") {
    return { light: "red", summary: "模式文件损坏或不可读，控制面处于 fail-closed 异常态", label: "异常（待核验）" };
  }
  if (mode.uninitialized) {
    return { light: "yellow", summary: "模式文件尚未初始化（默认按全自动放行），建议显式保存运行模式", label: "未初始化（默认全自动）" };
  }
  const light: SafetyLightLevel = mode.mode === "emergency_stop" ? "red" : mode.mode === "debt_first" ? "yellow" : "unknown";
  return { light, summary: "未采集 / 暂未核验（尚未生成周报文件）", label: MODE_LABELS[mode.mode] };
}

export function buildFallbackCockpit(input: {
  mode: GovernanceModeState;
  breaker: GovernanceBreakerState;
  hasCostBreakerFile: boolean;
  pendingApprovals: readonly PendingGovernanceApproval[];
  auditTrail: readonly GovernanceAuditItem[];
  nowIso: string;
}): GovernanceCockpitSummary {
  const blocked = input.auditTrail.filter((a) => a.outcome === "blocked").length;
  const modeDisp = resolveFallbackModeDisplay(input.mode);
  const deliveryLight: SafetyLightLevel =
    input.breaker.readError || input.breaker.tripped ? "red" : input.breaker.recentRollbacks > 0 ? "yellow" : "unknown";
  const deliverySummary = input.breaker.readError
    ? (input.breaker.readErrorMessage ?? "熔断状态文件读取异常，无法确认健康")
    : input.breaker.tripped ? "发版熔断已触发，等待人工确认根因解锁" : "未采集周报（实时控制面暂无活跃熔断）";
  const [costGauge, metaGauge] = buildFallbackCostAndMetaGauges(
    input.breaker, input.hasCostBreakerFile, input.pendingApprovals.length, blocked,
  );
  const gauges: GovernanceCockpitGauge[] = [
    {
      id: "structureAndRework", title: "结构与返工晴雨表", light: modeDisp.light, summary: modeDisp.summary,
      metrics: [
        { label: "当前模式", value: modeDisp.label },
        { label: "自动合入", value: input.mode.autoMergeFrozen ? "已冻结" : "运行中" },
      ],
    },
    {
      id: "deliveryAndExperience", title: "交付与体验稳定性", light: deliveryLight, summary: deliverySummary,
      metrics: [
        { label: "近 7 天回滚", value: `${input.breaker.recentRollbacks} 次` },
        { label: "熔断状态", value: input.breaker.readError ? "读取异常" : input.breaker.tripped ? "已熔断" : "未触发" },
      ],
    },
    costGauge,
    metaGauge,
  ];
  return { available: false, generatedAt: input.nowIso, overallLight: worstLight(gauges.map((x) => x.light)), gauges };
}
