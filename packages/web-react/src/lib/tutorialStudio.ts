import { tutorialHref } from "../hooks/useAppRoute";
import { ApiError, apiErrorMessage } from "./api";
import type { ChatMessage } from "./chat/model";
import { isRenderableChatMessage } from "./chat/sanitizeChatMessages";
import type {
  CommunityTutorialCategory,
  CommunityTutorialDetail,
  CommunityTutorialStatus,
  ProjectAsset,
  TutorialArtifact,
  TutorialKind,
  TutorialLeakReport,
  TutorialSnapshotPayload,
} from "./types";

/** 发布快照会从公开轨迹里剥离的内部角色（前端预览与提交前过滤同源）。 */
export const TUTORIAL_STRIPPED_ROLES = [
  "system",
  "permission",
  "runtime-event",
  "delegate-progress",
] as const;

export type TutorialStrippedRole = (typeof TUTORIAL_STRIPPED_ROLES)[number];

const STRIPPED_ROLE_SET = new Set<string>(TUTORIAL_STRIPPED_ROLES);

export const TUTORIAL_STRIPPED_ROLE_LABELS: Record<TutorialStrippedRole, string> = {
  system: "系统提示 / 内部通知",
  permission: "权限确认卡",
  "runtime-event": "运行时事件",
  "delegate-progress": "委派进度投影",
};

export const MAX_TUTORIAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_TUTORIAL_ARTIFACTS_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_TUTORIAL_ARTIFACT_COUNT = 8;

const ALLOWED_EXACT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
  "image/png",
  "image/webp",
]);

const BANNED_MIME = new Set(["image/svg+xml", "image/svg", "text/xml+svg"]);

const EXT_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  svg: "image/svg+xml",
};

export type SnapshotPublishBlockedReason = "unauthenticated" | "sending" | "empty";

export type SnapshotPublishGate =
  | { ok: true }
  | { ok: false; reason: SnapshotPublishBlockedReason };

export function snapshotPublishGate(opts: {
  authed: boolean;
  sending: boolean;
  messageCount: number;
}): SnapshotPublishGate {
  if (!opts.authed) return { ok: false, reason: "unauthenticated" };
  if (opts.sending) return { ok: false, reason: "sending" };
  if (opts.messageCount <= 0) return { ok: false, reason: "empty" };
  return { ok: true };
}

export function snapshotPublishGateMessage(reason: SnapshotPublishBlockedReason | undefined): string {
  if (reason === "unauthenticated") return "登录后才能从当前会话生成教程快照。";
  if (reason === "sending") return "当前会话仍在发送中，结束后才能发布快照。";
  if (reason === "empty") return "当前会话没有可发布的消息。";
  return "";
}

export function isStrippedTutorialRole(role: string | undefined): boolean {
  return !!role && STRIPPED_ROLE_SET.has(role);
}

export function publicSnapshotMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !isStrippedTutorialRole(message.role));
}

export function serializeSnapshotMessages(
  messages: ChatMessage[],
): Array<{ id: string; role: string; text: string; ts: number }> {
  return publicSnapshotMessages(messages).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    ts: message.ts,
  }));
}

export function snapshotMessagesFromUnknown(raw: unknown): ChatMessage[] {
  const source = Array.isArray(raw) ? raw : [];
  return source.filter(isRenderableChatMessage).filter((message) => !isStrippedTutorialRole(message.role));
}

export function tutorialKindOf(item: { kind?: TutorialKind | null }): TutorialKind {
  return item.kind === "snapshot" ? "snapshot" : "markdown";
}

export function canWithdrawCommunityTutorial(status: CommunityTutorialStatus): boolean {
  return status === "draft" || status === "pending" || status === "approved";
}

/**
 * 撤回确认框正文：按状态说清后果（审计 TU-08）。已上线会从公开目录下线且没有"恢复"路径，
 * 待审核只是退出队列；草稿撤回后同样不能再提交这一份。
 */
export function withdrawConsequence(status: CommunityTutorialStatus): string {
  switch (status) {
    case "approved":
      return "这份教程会从公开目录下线，其他人将无法再打开；之后要重新发布需再次提交审核。";
    case "pending":
      return "这份教程会退出审核队列；之后要发布需重新提交。";
    default:
      return "这份草稿会标记为已撤回，不能再继续提交。";
  }
}

/** 分类枚举 → 用户可见中文；目录卡 / Markdown 详情 / 快照详情共用，禁止直出 `coding`（审计 TU-09）。 */
export const COMMUNITY_CATEGORY_LABEL: Record<CommunityTutorialCategory, string> = {
  research: "科研",
  coding: "编码",
  general: "通用",
};

export function communityCategoryLabel(category: CommunityTutorialCategory | string): string {
  return COMMUNITY_CATEGORY_LABEL[category as CommunityTutorialCategory] ?? category;
}

/**
 * 手写教程表单的提交门槛（审计 TU-05）：与后端最小长度一致，空表单不再靠服务端拒绝才知道。
 * 返回第一条没过的原因；全部通过返回 null。
 */
export function communityTutorialDraftIssue(draft: {
  title: string;
  summary: string;
  bodyMarkdown: string;
}): string | null {
  if (draft.title.trim().length < 4) return "标题至少 4 个字";
  if (draft.summary.trim().length < 10) return "摘要至少 10 个字，说明适合谁、能得到什么";
  if (draft.bodyMarkdown.trim().length < 40) return "正文至少 40 个字，写清准备、步骤和如何核对结果";
  return null;
}

/** 「提交快照审核」禁用时的原因（审计 TU-27）；可提交返回 null。 */
export function snapshotSubmitIssue(input: {
  title: string;
  summary: string;
  publicMessageCount: number;
}): string | null {
  if (!input.title.trim()) return "还没有标题";
  if (input.summary.trim().length < 10) return "摘要至少 10 个字";
  if (input.publicMessageCount === 0) return "剥离内部角色后没有可公开的消息";
  return null;
}

export function leakReportFromUnknown(value: unknown): TutorialLeakReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as TutorialLeakReport;
  if (Array.isArray(report.leaks) || Array.isArray(report.strippedRoles) || Array.isArray(report.findings)) {
    return report;
  }
  return null;
}

export function leakReportFromApiError(err: unknown): TutorialLeakReport | null {
  if (!(err instanceof ApiError) || err.body == null || typeof err.body !== "object") return null;
  const body = err.body as { leakReport?: unknown };
  return leakReportFromUnknown(body.leakReport) ?? leakReportFromUnknown(err.body);
}

export function formatTutorialLeakRules(report: TutorialLeakReport | null | undefined): string {
  if (!report) return "";
  const rules = [
    ...(report.leaks ?? []).map((item) => (item.field ? `${item.rule}（${item.field}）` : item.rule)),
    ...(report.findings ?? []).map((item) => item.code || item.type || item.message),
  ].filter(Boolean);
  return rules.join("、");
}

export function tutorialPublishErrorMessage(err: unknown, fallback: string): string {
  const base = apiErrorMessage(err, fallback);
  const rules = formatTutorialLeakRules(leakReportFromApiError(err));
  if (!rules) return base;
  return `${base}：${rules}`;
}

export const DEFAULT_TUTORIAL_EVAL_MATERIALS_JSON = `{
  "items": []
}`;

export const DEFAULT_TUTORIAL_EVAL_RUBRIC_JSON = `{
  "checks": [
    {
      "id": "reproducible-output",
      "method": "contains",
      "passCriterion": "结论"
    }
  ]
}`;

export function parseTutorialEvalMaterialsJson(raw: string): { items: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("冻结材料 JSON 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new Error('冻结材料必须是含 items 数组的对象，例如 { "items": [] }');
  }
  return parsed as { items: unknown[] };
}

export function parseTutorialEvalRubricJson(raw: string): { checks: Array<Record<string, unknown>> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("rubric JSON 不是合法 JSON");
  }
  const checks = parsed && typeof parsed === "object" ? (parsed as { checks?: unknown }).checks : null;
  if (!Array.isArray(checks) || checks.length < 1) {
    throw new Error("rubric.checks 必须是非空数组");
  }
  for (const [index, check] of checks.entries()) {
    if (!check || typeof check !== "object") throw new Error(`rubric.checks[${index}] 无效`);
    const row = check as { id?: unknown; method?: unknown; passCriterion?: unknown };
    if (typeof row.id !== "string" || !row.id.trim()) throw new Error(`rubric.checks[${index}].id 必填`);
    if (!['contains', 'regex', 'min_length'].includes(String(row.method))) {
      throw new Error(`rubric.checks[${index}].method 必须是 contains / regex / min_length`);
    }
    if (typeof row.passCriterion !== "string" || !row.passCriterion.trim()) {
      throw new Error(`rubric.checks[${index}].passCriterion 必填`);
    }
  }
  return parsed as { checks: Array<Record<string, unknown>> };
}

export function sessionOutputAssets(
  assets: readonly ProjectAsset[],
  sessionId: string | null | undefined,
): ProjectAsset[] {
  if (!sessionId) return [];
  return assets.filter((asset) => asset.source === "output" && asset.sessionId === sessionId);
}

export function inferTutorialArtifactMime(asset: Pick<ProjectAsset, "name" | "mime">): string {
  const declared = (asset.mime ?? "").trim().toLowerCase();
  if (declared) return declared.split(";")[0]!.trim();
  const ext = asset.name.split(".").pop()?.trim().toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "";
}

export function isBannedTutorialMime(mime: string): boolean {
  const normalized = mime.trim().toLowerCase().split(";")[0]!.trim();
  if (!normalized) return false;
  if (BANNED_MIME.has(normalized)) return true;
  return normalized.includes("svg");
}

export function isAllowedTutorialArtifactMime(mime: string): boolean {
  const normalized = mime.trim().toLowerCase().split(";")[0]!.trim();
  if (!normalized || isBannedTutorialMime(normalized)) return false;
  if (ALLOWED_EXACT_MIME.has(normalized)) return true;
  return false;
}

export type TutorialArtifactGuardError = "type" | "svg" | "too-large" | "total-too-large" | "too-many";

export function tutorialArtifactGuardError(
  mime: string,
  bytes: number,
  opts?: { selectedBytes?: number; selectedCount?: number },
): TutorialArtifactGuardError | null {
  if (isBannedTutorialMime(mime)) return "svg";
  if (!isAllowedTutorialArtifactMime(mime)) return "type";
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_TUTORIAL_ARTIFACT_BYTES) return "too-large";
  const selectedCount = opts?.selectedCount ?? 0;
  if (selectedCount >= MAX_TUTORIAL_ARTIFACT_COUNT) return "too-many";
  const selectedBytes = opts?.selectedBytes ?? 0;
  if (selectedBytes + bytes > MAX_TUTORIAL_ARTIFACTS_TOTAL_BYTES) return "total-too-large";
  return null;
}

export function tutorialArtifactGuardMessage(error: TutorialArtifactGuardError): string {
  switch (error) {
    case "svg":
      return "SVG 不可作为教程成果发布。";
    case "type":
      return "当前只允许 text/markdown/json/html 与可去除元数据的 PNG/WebP 图片。";
    case "too-large":
      return `单件成果不能超过 ${Math.round(MAX_TUTORIAL_ARTIFACT_BYTES / (1024 * 1024))} MB。`;
    case "total-too-large":
      return `勾选成果合计不能超过 ${Math.round(MAX_TUTORIAL_ARTIFACTS_TOTAL_BYTES / (1024 * 1024))} MB。`;
    case "too-many":
      return `最多勾选 ${MAX_TUTORIAL_ARTIFACT_COUNT} 件成果。`;
  }
}

export function isSafeTutorialMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/api/tutorial-embeds/") || trimmed.startsWith("/api/tutorial-blobs/")) {
    return !trimmed.includes("..");
  }
  return false;
}

/** 社区投稿 HTML（不可信）：只给脚本，不给下载 / 弹窗 / 同源。 */
export const HTML_EMBED_SANDBOX = "allow-scripts";

/**
 * 展厅两类 iframe（仓内构建产物，可信）的沙箱（审计 TU-28）：看板内「下载可复算 CSV」「World Bank 来源」
 * 等链接此前点了没反应，放开下载与新窗口；仍**不给** `allow-same-origin`，与社区投稿的口径分开。
 */
export const SHOWCASE_IFRAME_SANDBOX =
  "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox";

export function htmlEmbedSandboxIsSafe(sandbox: string | null | undefined): boolean {
  if (!sandbox) return false;
  const tokens = sandbox.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const forbidden = new Set([
    "allow-same-origin",
    "allow-forms",
    "allow-popups",
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
  ]);
  return tokens.every((token) => token === "allow-scripts") && !tokens.some((token) => forbidden.has(token));
}

export function communityTutorialShareUrl(id: string, origin = typeof window !== "undefined" ? window.location.origin : ""): string {
  const href = tutorialHref({ pathname: "/", search: "", hash: "" }, null, null, id);
  return `${origin || ""}${href}`;
}

export function mediaSignPathForAsset(asset: ProjectAsset): string | null {
  const path = asset.containerPath?.trim() || asset.url?.trim() || "";
  return path || null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function tutorialBlobUrl(sha256: string, kind: "blob" | "embed" = "blob"): string {
  return kind === "embed" ? `/api/tutorial-embeds/${sha256}` : `/api/tutorial-blobs/${sha256}`;
}

export function artifactNeedsEmbedPreview(mime: string, kind?: string | null): boolean {
  if (kind === "htmlpreview") return true;
  const preview = artifactKind(mime);
  return preview === "html" || preview === "image" || preview === "audio" || preview === "video" || preview === "pdf";
}

function normalizeTutorialArtifact(entry: {
  sha256: string;
  name: string;
  mime: string;
  bytes: number;
  role?: string | null;
  kind?: string | null;
}): TutorialArtifact {
  const embed = artifactNeedsEmbedPreview(entry.mime, entry.kind);
  return {
    sha256: entry.sha256,
    name: entry.name,
    mime: entry.mime,
    bytes: entry.bytes,
    role: entry.role,
    kind: entry.kind,
    embedUrl: embed ? tutorialBlobUrl(entry.sha256, "embed") : null,
    downloadUrl: tutorialBlobUrl(entry.sha256),
    interactive: embed && (entry.kind === "htmlpreview" || artifactKind(entry.mime) === "html"),
  };
}

export function deriveTutorialArtifacts(item: Pick<CommunityTutorialDetail, "snapshot" | "artifacts" | "refs">): TutorialArtifact[] {
  if (item.artifacts && item.artifacts.length > 0) {
    return item.artifacts.map((artifact) =>
      normalizeTutorialArtifact({
        sha256: artifact.sha256,
        name: artifact.name,
        mime: artifact.mime,
        bytes: artifact.bytes,
        role: artifact.role,
        kind: artifact.kind,
      }),
    );
  }
  const bySha = new Map((item.refs ?? []).map((ref) => [ref.sha256, ref]));
  const fromSnapshot = (item.snapshot?.artifacts ?? []).map((entry) => {
    const ref = bySha.get(entry.sha256);
    const mime = entry.mimeType || entry.mime || ref?.mime || "";
    return normalizeTutorialArtifact({
      sha256: entry.sha256,
      name: entry.title || entry.name || ref?.role?.split(":")[1] || entry.sha256,
      mime,
      bytes: entry.bytes ?? ref?.bytes ?? 0,
      role: entry.role ?? ref?.role,
      kind: ref?.kind || artifactKind(mime),
    });
  });
  if (fromSnapshot.length > 0) return fromSnapshot;
  return (item.refs ?? [])
    .filter((ref) => ref.kind !== "messages")
    .map((ref) =>
      normalizeTutorialArtifact({
        sha256: ref.sha256,
        name: ref.role.split(":")[1] || ref.sha256,
        mime: ref.mime,
        bytes: ref.bytes,
        role: ref.role,
        kind: ref.kind,
      }),
    );
}

export async function fetchSnapshotPageMessages(
  urls: string[],
  fetcher: typeof fetch = fetch,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (const url of urls) {
    if (!isSafeTutorialMediaUrl(url) || !url.startsWith("/api/tutorial-blobs/")) {
      throw new Error("unsafe snapshot page url");
    }
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`snapshot page ${res.status}`);
    const rawText = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(rawText) as unknown;
    } catch {
      throw new Error("snapshot page is not valid JSON");
    }
    const raw =
      body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)
        ? (body as { messages: unknown[] }).messages
        : null;
    if (!raw) throw new Error("snapshot page is missing messages");
    const parsed = snapshotMessagesFromUnknown(raw);
    if (parsed.length !== raw.length) throw new Error("snapshot page contains invalid messages");
    messages.push(...parsed);
  }
  return messages;
}

export function snapshotPageBlobUrls(snapshot?: TutorialSnapshotPayload | null): string[] {
  return (snapshot?.pages ?? []).map((page) => tutorialBlobUrl(page.sha256));
}

export function artifactKind(mime: string): "text" | "image" | "audio" | "video" | "pdf" | "html" | "other" {
  const normalized = mime.trim().toLowerCase().split(";")[0]!.trim();
  if (normalized === "text/html") return "html";
  if (
    normalized === "text/plain"
    || normalized === "text/markdown"
    || normalized === "application/json"
  ) {
    return "text";
  }
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return "other";
}
