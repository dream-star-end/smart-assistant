/**
 * Wave 4B 前台闭环 API 客户端与纯辅助函数（OCV5-833）。
 *
 * 严格保持仅由 React.lazy 懒加载组件引用，不进入首屏静态 modulepreload 闭包（first-screen-budget）。
 * 覆盖 4 组后端契约：
 *   1. Office 零轮次预览：GET /api/file/office-preview & /api/file/office-preview/page
 *   2. 科研文献库批量导入与原文 Span 溯源：
 *      GET /api/me/research/library?projectId=
 *      POST /api/me/research/library/import-ids
 *      GET /api/me/research/library/:docId/span/:spanId
 *   3. 统一「待拍板」聚合收件箱：
 *      GET /api/me/pending-decisions
 *      POST /api/me/pending-decisions/:id/resolve
 *   4. Swarm 交互式操控与剧本模板：
 *      POST /api/sessions/:id/swarm/command
 */
import type { AuthSession, ResearchLibraryDoc, ResearchLibraryUploadResult } from "../types";
import { ApiError, bearerHeaders, callWithRefresh, jsonOrThrow } from "./http";

// ── 1. Office 零轮次预览 ────────────────────────────────────────────────────

export interface OfficePreviewQaIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  page?: number;
  sheet?: string;
  cell?: string;
}

export interface OfficePreviewPage {
  index: number;
  imgPath: string;
  notes?: string;
  pageUrl?: string;
}

export interface OfficePreviewXlsxCell {
  cell: string;
  value: string | number | boolean | null;
  formula?: string;
  error?: string;
}

export interface OfficePreviewXlsxErrorCell {
  sheet: string;
  cell: string;
  error: string;
  formula?: string;
}

export interface OfficePreviewXlsxSheet {
  name: string;
  totalRows: number;
  totalCols: number;
  truncated: boolean;
  rows: Array<Array<OfficePreviewXlsxCell>>;
  formulas: Array<{ cell: string; formula: string; value: string | number | boolean | null }>;
  errorCells: OfficePreviewXlsxErrorCell[];
}

export type OfficePreviewPayload =
  | {
      kind: "pptx" | "docx";
      filePath: string;
      sha256: string;
      mtimeMs: number;
      cacheKey: string;
      cached: boolean;
      previewHandle?: string;
      pages: OfficePreviewPage[];
      qaIssues: OfficePreviewQaIssue[];
    }
  | {
      kind: "xlsx";
      filePath: string;
      sha256: string;
      mtimeMs: number;
      cacheKey: string;
      cached: boolean;
      maxRowsPerSheet: number;
      sheets: OfficePreviewXlsxSheet[];
      errorCells: OfficePreviewXlsxErrorCell[];
      qaIssues: OfficePreviewQaIssue[];
    };

const OFFICE_PREVIEW_EXT_RE = /\.(pptx|docx|xlsx)$/i;
const XLSX_ERROR_RE = /^#(?:DIV\/0!|REF!|VALUE!|NAME\?|N\/A|NUM!|NULL!|CALC!|SPILL!)$/;

export function supportsNativeOfficePreview(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("/api/") && OFFICE_PREVIEW_EXT_RE.test(trimmed);
}

export function isXlsxCellError(cell: OfficePreviewXlsxCell): boolean {
  if (typeof cell.error === "string" && cell.error.trim().length > 0) return true;
  if (typeof cell.value === "string" && XLSX_ERROR_RE.test(cell.value.trim())) return true;
  return false;
}

export function formatXlsxCellDisplay(cell: OfficePreviewXlsxCell, mode: "values" | "formulas"): string {
  if (mode === "formulas" && typeof cell.formula === "string" && cell.formula.trim()) {
    return cell.formula.startsWith("=") ? cell.formula : `=${cell.formula}`;
  }
  if (cell.error) return cell.error;
  if (cell.value === null || cell.value === undefined) return "";
  if (typeof cell.value === "boolean") return cell.value ? "TRUE" : "FALSE";
  return String(cell.value);
}

export async function fetchOfficePreview(
  auth: AuthSession,
  filePath: string,
  opts: { maxRows?: number; signal?: AbortSignal } = {},
): Promise<OfficePreviewPayload> {
  const params = new URLSearchParams({ path: filePath });
  if (opts.maxRows !== undefined) params.set("maxRows", String(opts.maxRows));
  const body = await jsonOrThrow<{ preview?: OfficePreviewPayload }>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/file/office-preview?${params.toString()}`, {
        method: "GET",
        credentials: "include",
        headers: bearerHeaders(t),
        signal: opts.signal,
      }),
    ),
  );
  if (!body.preview) {
    throw new ApiError({ status: 502, code: "EMPTY_PREVIEW", message: "office preview payload missing" });
  }
  return body.preview;
}

export async function fetchOfficePreviewPageBlob(
  auth: AuthSession,
  pageUrl: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await callWithRefresh(auth, (t) =>
    fetch(pageUrl, {
      method: "GET",
      credentials: "include",
      headers: bearerHeaders(t),
      signal,
    }),
  );
  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      code: "PAGE_FETCH_FAILED",
      message: `preview page fetch failed (${res.status})`,
    });
  }
  return res.blob();
}

// ── 2. 科研文献库批量导入与原文 Span 溯源 ───────────────────────────────────

export interface ResearchAuthor {
  name: string;
  id?: string;
}

export interface ResearchSourceRecord {
  id: string;
  title: string;
  authors: ResearchAuthor[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  openalexId?: string;
  pmid?: string;
  citationCount?: number;
  oa?: { isOA: boolean; url?: string; license?: string; source?: string };
  lang?: "zh" | "en" | "other";
  retracted?: boolean | null;
  identifiersVerified?: boolean;
}

export interface BatchImportItemResult {
  dedupeKey: string;
  raw: string;
  docId: string;
  title: string | null;
  spanCount: number;
  source: "crossref" | "arxiv" | "bibtex";
  bibliographicResolved: boolean;
  fulltextVerified: boolean;
  verified: boolean;
  resolvedSource?: ResearchSourceRecord;
  userSuppliedTextUnverified?: boolean;
  projectId?: string;
}

export interface BatchImportDuplicate {
  dedupeKey: string;
  raw: string;
  reason: "duplicate_in_batch" | "already_in_library";
  existingDocId?: string;
}

export interface BatchImportFailure {
  dedupeKey: string;
  raw: string;
  reason: string;
}

export interface BatchImportOutcome {
  ok: true;
  totalSubmitted: number;
  imported: BatchImportItemResult[];
  duplicates: BatchImportDuplicate[];
  failed: BatchImportFailure[];
  projectId?: string;
}

export type SpanPageSource = "explicit" | "section" | "formfeed" | "estimated";

export interface ContextSpanSnippet {
  spanId: string;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface LocatedSpan {
  docId: string;
  title: string | null;
  lang: "zh" | "en" | "other";
  spanId: string;
  spanIndex: number;
  totalSpans: number;
  sectionPath: string[];
  charStart: number;
  charEnd: number;
  page: number;
  pageSource: SpanPageSource;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  beforeSpans: ContextSpanSnippet[];
  afterSpans: ContextSpanSnippet[];
  verifiedSource?: ResearchSourceRecord;
}

export function buildResearchImportPayload(
  input: string,
  projectId?: string,
): { identifiers?: string[]; bibtex?: string; rawText?: string; projectId?: string } {
  const trimmed = input.trim();
  const base = projectId ? { projectId } : {};
  if (!trimmed) return base;
  if (/@[A-Za-z]+\s*[{(]/.test(trimmed)) {
    return { ...base, bibtex: trimmed };
  }
  const lines = trimmed
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length > 0 && lines.every((l) => l.length <= 200)) {
    return { ...base, identifiers: lines };
  }
  return { ...base, rawText: trimmed };
}

export async function listProjectResearchLibrary(
  auth: AuthSession,
  projectId?: string,
  signal?: AbortSignal,
): Promise<ResearchLibraryDoc[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const body = await jsonOrThrow<{ documents?: ResearchLibraryDoc[] }>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/me/research/library${qs}`, {
        method: "GET",
        credentials: "include",
        headers: bearerHeaders(t),
        signal,
      }),
    ),
  );
  return body.documents ?? [];
}

export async function uploadProjectResearchDoc(
  auth: AuthSession,
  file: File,
  projectId?: string,
): Promise<ResearchLibraryUploadResult> {
  const params = new URLSearchParams({ filename: file.name });
  if (projectId) params.set("projectId", projectId);
  return jsonOrThrow<ResearchLibraryUploadResult>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/me/research/library?${params.toString()}`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...bearerHeaders(t),
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      }),
    ),
  );
}

export async function deleteResearchLibraryDoc(auth: AuthSession, docId: string): Promise<{ ok: boolean }> {
  return jsonOrThrow<{ ok: boolean }>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/me/research/library/${encodeURIComponent(docId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    ),
  );
}

export async function importResearchIds(
  auth: AuthSession,
  body: { identifiers?: string[]; bibtex?: string; rawText?: string; projectId?: string },
): Promise<BatchImportOutcome> {
  return jsonOrThrow<BatchImportOutcome>(
    callWithRefresh(auth, (t) =>
      fetch("/api/me/research/library/import-ids", {
        method: "POST",
        credentials: "include",
        headers: {
          ...bearerHeaders(t),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

export async function fetchResearchSpan(
  auth: AuthSession,
  docId: string,
  spanId: string,
  opts: { contextWindow?: number; maxContextChars?: number; signal?: AbortSignal } = {},
): Promise<LocatedSpan> {
  const params = new URLSearchParams();
  if (opts.contextWindow !== undefined) params.set("contextWindow", String(opts.contextWindow));
  if (opts.maxContextChars !== undefined) params.set("maxContextChars", String(opts.maxContextChars));
  const qs = params.toString();
  const path = `/api/me/research/library/${encodeURIComponent(docId)}/span/${encodeURIComponent(spanId)}${qs ? `?${qs}` : ""}`;
  return jsonOrThrow<LocatedSpan>(
    callWithRefresh(auth, (t) =>
      fetch(path, {
        method: "GET",
        credentials: "include",
        headers: bearerHeaders(t),
        signal: opts.signal,
      }),
    ),
  );
}

// ── 3. 统一「待拍板」聚合区 ─────────────────────────────────────────────────

export type PendingDecisionSource =
  | "turn_permission"
  | "connector_write"
  | "taskboard"
  | "browser_handoff";

export type PendingDecisionAction = "approve" | "deny";
export type PendingDecisionRiskLevel = "low" | "medium" | "high" | "critical";
export type PendingDecisionStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface PendingDecisionItem {
  id: string;
  source: PendingDecisionSource;
  sourceId: string;
  userId: string;
  sessionId: string | null;
  title: string;
  summary: string;
  riskLevel: PendingDecisionRiskLevel;
  status: PendingDecisionStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  expiresAt: string | null;
  allowedActions: readonly PendingDecisionAction[];
}

export interface PendingDecisionWarning {
  source: PendingDecisionSource;
  code: string;
  message: string;
}

export interface ListPendingDecisionsResponse {
  items: PendingDecisionItem[];
  counts: {
    total: number;
    bySource: Record<PendingDecisionSource, number>;
  };
  warnings?: PendingDecisionWarning[];
  generatedAt: string;
}

export interface ResolvePendingDecisionRequest {
  decision: PendingDecisionAction;
  reason?: string;
  idempotencyKey?: string;
  originChannel?: string;
}

export interface ResolvePendingDecisionResponse {
  id: string;
  source: PendingDecisionSource;
  sourceId: string;
  decision: PendingDecisionAction;
  status: "approved" | "denied";
  idempotentReplay: boolean;
  resolvedAt: string;
  message?: string;
}

export const PENDING_DECISION_SOURCE_LABELS: Readonly<Record<PendingDecisionSource, string>> = {
  turn_permission: "工具权限确认",
  connector_write: "连接器外部写入",
  taskboard: "任务单待验收",
  browser_handoff: "浏览器人工接管",
};

/**
 * 判断该待拍板项是否必须走交互式直达处理（绝不展示误导性二元「批准」按钮）：
 *   - `browser_handoff`：需跳转实时浏览器接管视口完成登录/2FA/人机校验；
 *   - `metadata.requiresInteractiveAnswer === true`（`ask_user`）：需在网页会话填写结构化回答；
 *   - `allowedActions` 不包含 `approve`。
 */
export function isInteractiveOnlyDecision(item: PendingDecisionItem): boolean {
  if (item.source === "browser_handoff") return true;
  if (item.metadata?.requiresInteractiveAnswer === true) return true;
  if (!item.allowedActions.includes("approve")) return true;
  return false;
}

export async function listPendingDecisions(
  auth: AuthSession,
  opts: { sources?: PendingDecisionSource[]; limit?: number; signal?: AbortSignal } = {},
): Promise<ListPendingDecisionsResponse> {
  const params = new URLSearchParams();
  if (opts.sources && opts.sources.length > 0) params.set("source", opts.sources.join(","));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return jsonOrThrow<ListPendingDecisionsResponse>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/me/pending-decisions${qs ? `?${qs}` : ""}`, {
        method: "GET",
        credentials: "include",
        headers: bearerHeaders(t),
        signal: opts.signal,
      }),
    ),
  );
}

export async function resolvePendingDecision(
  auth: AuthSession,
  id: string,
  body: ResolvePendingDecisionRequest,
): Promise<ResolvePendingDecisionResponse> {
  return jsonOrThrow<ResolvePendingDecisionResponse>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/me/pending-decisions/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...bearerHeaders(t),
          "content-type": "application/json",
        },
        body: JSON.stringify({ originChannel: "web", ...body }),
      }),
    ),
  );
}

// ── 4. Swarm 交互式操控指令与剧本模板 ───────────────────────────────────────

export type SwarmWakeDelivery = "woken" | "board_only_unwoken" | "not_applicable";

export interface SwarmSteerSuccess {
  ok: true;
  seq: number;
  target: string;
  channel: string;
  agent: string;
  text: string;
  mentions: string[];
  time: string;
  wakeDelivery?: SwarmWakeDelivery;
  wakeDetail?: string;
}

export type SwarmTerminateStatus = "requested" | "confirmed" | "already_killed";

export interface SwarmTerminateSuccess {
  ok: true;
  status: SwarmTerminateStatus;
  memberName: string;
  alreadyKilled: boolean;
  noticeSeq?: number;
  time: string;
  wakeDelivery?: SwarmWakeDelivery;
  wakeDetail?: string;
}

export async function sendSwarmSteer(
  auth: AuthSession,
  sessionId: string,
  input: { target: string; message: string; channel?: string },
): Promise<SwarmSteerSuccess> {
  return jsonOrThrow<SwarmSteerSuccess>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/swarm/command`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...bearerHeaders(t),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "steer",
          target: input.target,
          message: input.message,
          ...(input.channel ? { channel: input.channel } : {}),
        }),
      }),
    ),
  );
}

export async function requestSwarmTerminate(
  auth: AuthSession,
  sessionId: string,
  input: { memberName: string; reason?: string },
): Promise<SwarmTerminateSuccess> {
  return jsonOrThrow<SwarmTerminateSuccess>(
    callWithRefresh(auth, (t) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/swarm/command`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...bearerHeaders(t),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "terminate",
          memberName: input.memberName,
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        }),
      }),
    ),
  );
}

export type SwarmPlaybookId =
  | "parallel-impl-verify"
  | "multi-source-lit-verify"
  | "arch-deep-audit"
  | "multi-option-review"
  | "research-write-review-revise"
  | "research-controlled-exp-loop";

export interface SwarmPlaybookPreset {
  id: SwarmPlaybookId;
  title: string;
  category: "engineering" | "research" | "decision";
  categoryLabel: string;
  summary: string;
  roles: readonly string[];
  defaultTaskHint: string;
  guardrailSummary: string;
}

export const SWARM_PLAYBOOK_PRESETS: readonly SwarmPlaybookPreset[] = Object.freeze([
  {
    id: "parallel-impl-verify",
    title: "并行实现+验收",
    category: "engineering",
    categoryLabel: "工程交付",
    summary: "按零冲突文件所有权并行拆解实现切片，P2P 直接交接验收与预整合闭环，避免协调者单点阻塞。",
    roles: ["coordinator", "worker-a", "worker-b", "verifier"],
    defaultTaskHint: "请填写要并行开发的功能需求、目标模块与验收标准",
    guardrailSummary: "严格文件所有权隔离，P2P 直交 @verifier（勿 CC @coordinator），引前文写 #seq",
  },
  {
    id: "multi-source-lit-verify",
    title: "多源文献深研+核验",
    category: "research",
    categoryLabel: "科研综述",
    summary: "多库并行检索去重、原文 Span 逐字证据抽取与 fail-closed 引用防幻觉核验。",
    roles: ["coordinator", "lit-scout", "evidence-analyst", "fact-verifier"],
    defaultTaskHint: "请填写研究主题、时间范围与核心对比问题",
    guardrailSummary: "遵循 quote-first 红线，未验证标识符或撤稿文献必须显式标出",
  },
  {
    id: "arch-deep-audit",
    title: "架构深度体检",
    category: "engineering",
    categoryLabel: "架构审计",
    summary: "全员只读三线并行审计：模块边界与债、鉴权安全与越界、性能热路径与泄漏。",
    roles: ["coordinator", "boundary-auditor", "security-auditor", "perf-auditor"],
    defaultTaskHint: "请填写要体检的子系统路径、关注风险与基线分支",
    guardrailSummary: "全员严格只读，每条 P0/P1/P2 发现必须附具体文件路径与行号",
  },
  {
    id: "multi-option-review",
    title: "多方案评审",
    category: "decision",
    categoryLabel: "技术选型",
    summary: "渐进稳健派、长期重构派与红队反方对抗评审，产出量化决策矩阵与回滚预案。",
    roles: ["coordinator", "proposer-conservative", "proposer-radical", "devil-advocate"],
    defaultTaskHint: "请填写待决策的技术问题、核心约束与评估维度",
    guardrailSummary: "双提案独立发帖防锚定，最终结论须附明确回滚路径",
  },
  {
    id: "research-write-review-revise",
    title: "论文写作+盲审+批判修订",
    category: "research",
    categoryLabel: "科研写作",
    summary: "跨强模型写稿、独立盲审与批判修订闭环，输出干净版 + Word 标黄 Diff 双版与去 AI 味报告。",
    roles: ["coordinator", "author-writer", "blind-reviewer", "revision-editor"],
    defaultTaskHint: "请填写论文题目/草稿路径、目标期刊引用规范与修订重点",
    guardrailSummary: "盲审员严格只读，终稿必过 oc-cite A/B 分级、oc-docx diff 双版与 oc-stylecheck",
  },
  {
    id: "research-controlled-exp-loop",
    title: "受控实验循环（防刷分）",
    category: "research",
    categoryLabel: "受控实验",
    summary: "锁评测脚本与测试集防 Reward Hacking，按单变量假设、复现验证与消融分析闭环迭代。",
    roles: ["coordinator", "exp-engineer", "eval-guardian", "ablation-analyst"],
    defaultTaskHint: "请填写实验目标、锁定评测脚本路径、基线指标与核心假设",
    guardrailSummary: "严禁改动锁定评测与测试集，每轮单变量改动须经独立守护员复现核验",
  },
]);

export function buildSwarmPlaybookDraft(preset: SwarmPlaybookPreset, existingText = ""): string {
  const cleaned = existingText.replace(/^\/swarm(?:-playbook\s+\S+)?\s*/i, "").trim();
  const taskLine = cleaned || `[${preset.defaultTaskHint}]`;
  return [
    `/swarm-playbook ${preset.id} ${taskLine}`,
    `角色编排：${preset.roles.map((r) => `@${r}`).join(" · ")}`,
    `执行红线：${preset.guardrailSummary}`,
  ].join("\n");
}
