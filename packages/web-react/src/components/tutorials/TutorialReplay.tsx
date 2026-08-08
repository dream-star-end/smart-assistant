import { ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import type {
  TutorialCase,
  TutorialCaseId,
} from "../../lib/tutorialCaseCatalog";
import { MessageList } from "../MessageRenderer";
import { Button } from "../ui";

type ReplayPageDescriptor = {
  path: string;
  sha256: string;
  bytes: number;
  messageCount: number;
  startOrdinal: number;
};

type ReplayManifest = {
  schemaVersion: 1;
  caseId: TutorialCaseId;
  messageCount: number;
  pages: ReplayPageDescriptor[];
};

type ReplayLoadState =
  | { status: "idle"; sourcePath: string }
  | { status: "loading"; sourcePath: string }
  | { status: "error"; sourcePath: string; message: string }
  | {
      status: "ready";
      sourcePath: string;
      manifest: ReplayManifest;
      loadedPages: number;
      messages: ChatMessage[];
      loadingMore: boolean;
    };

const MESSAGE_ROLES = new Set<ChatMessage["role"]>([
  "user",
  "assistant",
  "thinking",
  "tool",
  "agent-group",
  "plan",
  "goal",
  "permission",
  "delegate-progress",
  "runtime-event",
  "system",
]);

// Public tutorial replay must never carry tenant/user authentication identity as structured data.
// Text remains the exact already-sanitized visible transcript and is not rewritten in the browser.
const PRIVATE_FIELD_NAMES = new Set([
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "userid",
  "accountid",
  "tenantid",
  "orgid",
  "ip",
  "ipaddress",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "authorization",
  "cookie",
  "traceid",
  "requestid",
  "turntapeid",
  "clientmessageid",
  "sessionkey",
  "sessionid",
  "peerid",
  "containerid",
  "turnownerid",
  "turnkey",
  "idem",
  "idempotencykey",
  "retrymedia",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${label} 含未知字段 ${unexpected}`);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function hasPrivateIdentityField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateIdentityField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    return (
      normalized === "__proto__" ||
      normalized === "constructor" ||
      normalized === "prototype" ||
      PRIVATE_FIELD_NAMES.has(normalized) ||
      hasPrivateIdentityField(child)
    );
  });
}

function parseManifest(payload: unknown, caseId: TutorialCaseId): ReplayManifest {
  if (!isRecord(payload)) throw new Error("轨迹 manifest 必须是对象");
  assertExactKeys(payload, ["schemaVersion", "caseId", "messageCount", "pages"], "轨迹 manifest");
  if (payload.schemaVersion !== 1) throw new Error("轨迹 manifest 版本不受支持");
  if (payload.caseId !== caseId) throw new Error("轨迹 manifest 与当前案例不匹配");
  if (!isNonNegativeInteger(payload.messageCount)) throw new Error("轨迹总消息数无效");
  if (!Array.isArray(payload.pages) || payload.pages.length === 0) throw new Error("轨迹 manifest 没有分页");

  let nextOrdinal = 0;
  const pages = payload.pages.map((raw, index): ReplayPageDescriptor => {
    if (!isRecord(raw)) throw new Error(`轨迹第 ${index + 1} 页描述无效`);
    assertExactKeys(raw, ["path", "sha256", "bytes", "messageCount", "startOrdinal"], `轨迹第 ${index + 1} 页描述`);
    const expectedPath = `/tutorials/cases/${caseId}/messages-${String(index + 1).padStart(4, "0")}.json`;
    if (raw.path !== expectedPath) throw new Error(`轨迹第 ${index + 1} 页路径未与案例绑定`);
    if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw new Error(`轨迹第 ${index + 1} 页 SHA-256 无效`);
    if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) <= 0) throw new Error(`轨迹第 ${index + 1} 页字节数无效`);
    if (!Number.isSafeInteger(raw.messageCount) || (raw.messageCount as number) <= 0) throw new Error(`轨迹第 ${index + 1} 页消息数无效`);
    if (raw.startOrdinal !== nextOrdinal) throw new Error(`轨迹第 ${index + 1} 页序号不连续`);
    const descriptor = {
      path: raw.path,
      sha256: raw.sha256,
      bytes: raw.bytes,
      messageCount: raw.messageCount,
      startOrdinal: raw.startOrdinal,
    } as ReplayPageDescriptor;
    nextOrdinal += descriptor.messageCount;
    return descriptor;
  });
  if (nextOrdinal !== payload.messageCount) throw new Error("轨迹分页消息总数不一致");
  return {
    schemaVersion: 1,
    caseId,
    messageCount: payload.messageCount,
    pages,
  };
}

function validatePublicMedia(value: unknown, caseId: TutorialCaseId, messageId: string): void {
  if (!Array.isArray(value)) throw new Error(`轨迹消息 ${messageId} _media 无效`);
  const pathPattern = new RegExp(
    `^/tutorials/cases/${caseId}/media/[A-Za-z0-9][A-Za-z0-9._-]*$`,
  );
  for (const [index, media] of value.entries()) {
    if (!isRecord(media)) throw new Error(`轨迹消息 ${messageId} 第 ${index + 1} 个媒体无效`);
    assertExactKeys(media, ["kind", "url", "mimeType", "filename"], `轨迹消息 ${messageId} 媒体`);
    if (
      media.kind !== "image" &&
      media.kind !== "audio" &&
      media.kind !== "video" &&
      media.kind !== "file"
    ) throw new Error(`轨迹消息 ${messageId} 媒体类型无效`);
    if (typeof media.url !== "string" || !pathPattern.test(media.url)) throw new Error(`轨迹消息 ${messageId} 媒体路径未与案例绑定`);
    if (media.mimeType !== undefined && typeof media.mimeType !== "string") throw new Error(`轨迹消息 ${messageId} 媒体 MIME 无效`);
    if (media.filename !== undefined && typeof media.filename !== "string") throw new Error(`轨迹消息 ${messageId} 媒体文件名无效`);
  }
}

function parseMessage(
  value: unknown,
  caseId: TutorialCaseId,
  seenIds: Set<string>,
  previousTs: number | null,
): ChatMessage {
  if (!isRecord(value)) throw new Error("轨迹消息必须是对象");
  if (hasPrivateIdentityField(value)) throw new Error("轨迹消息包含禁止的隐私身份字段");
  if (typeof value.id !== "string" || !/^(?:msg|tutorial)-[A-Za-z0-9_-]+$/.test(value.id)) throw new Error("轨迹消息 id 未使用脱敏公共格式");
  if (seenIds.has(value.id)) throw new Error(`轨迹消息 id 重复：${value.id}`);
  if (typeof value.role !== "string" || !MESSAGE_ROLES.has(value.role as ChatMessage["role"])) throw new Error(`轨迹消息 ${value.id} role 无效`);
  if (typeof value.text !== "string") throw new Error(`轨迹消息 ${value.id} text 无效`);
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts) || value.ts < 0) throw new Error(`轨迹消息 ${value.id} ts 无效`);
  if (previousTs !== null && value.ts < previousTs) throw new Error(`轨迹消息 ${value.id} ts 顺序倒退`);
  if (value._media !== undefined) validatePublicMedia(value._media, caseId, value.id);
  seenIds.add(value.id);
  return value as ChatMessage;
}

function parsePage(
  payload: unknown,
  caseId: TutorialCaseId,
  pageIndex: number,
  descriptor: ReplayPageDescriptor,
  previousMessages: readonly ChatMessage[],
): ChatMessage[] {
  if (!isRecord(payload)) throw new Error(`轨迹第 ${pageIndex + 1} 页必须是对象`);
  assertExactKeys(payload, ["schemaVersion", "caseId", "pageIndex", "startOrdinal", "messages"], `轨迹第 ${pageIndex + 1} 页`);
  if (payload.schemaVersion !== 1) throw new Error(`轨迹第 ${pageIndex + 1} 页版本不受支持`);
  if (payload.caseId !== caseId) throw new Error(`轨迹第 ${pageIndex + 1} 页与当前案例不匹配`);
  if (payload.pageIndex !== pageIndex) throw new Error(`轨迹第 ${pageIndex + 1} 页索引不连续`);
  if (payload.startOrdinal !== descriptor.startOrdinal) throw new Error(`轨迹第 ${pageIndex + 1} 页起始序号不一致`);
  if (!Array.isArray(payload.messages) || payload.messages.length !== descriptor.messageCount) throw new Error(`轨迹第 ${pageIndex + 1} 页消息数不一致`);
  const seenIds = new Set(previousMessages.map((message) => message.id));
  let previousTs = previousMessages.at(-1)?.ts ?? null;
  return payload.messages.map((message) => {
    const parsed = parseMessage(message, caseId, seenIds, previousTs);
    previousTs = parsed.ts;
    return parsed;
  });
}

async function fetchText(path: string, signal: AbortSignal): Promise<{ text: string; bytes: Uint8Array }> {
  const response = await fetch(path, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`${path} 请求失败（HTTP ${response.status}）`);
  const text = await response.text();
  return { text, bytes: new TextEncoder().encode(text) };
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器无法校验轨迹完整性");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchPage(
  descriptor: ReplayPageDescriptor,
  caseId: TutorialCaseId,
  pageIndex: number,
  previousMessages: readonly ChatMessage[],
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  const raw = await fetchText(descriptor.path, signal);
  if (raw.bytes.byteLength !== descriptor.bytes) throw new Error(`轨迹第 ${pageIndex + 1} 页字节数校验失败`);
  if ((await sha256Hex(raw.bytes)) !== descriptor.sha256) throw new Error(`轨迹第 ${pageIndex + 1} 页 SHA-256 校验失败`);
  return parsePage(
    parseJson(raw.text, `轨迹第 ${pageIndex + 1} 页`),
    caseId,
    pageIndex,
    descriptor,
    previousMessages,
  );
}

class ReplayRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <p className="px-4 py-5 text-[12.5px] text-danger">轨迹消息格式无法安全展示。</p>;
    }
    return this.props.children;
  }
}

/**
 * verified replay 的 messagesPath 是轻量 manifest。用户点开后只读取 manifest + 第一页，
 * 后续页按按钮逐页追加；切案例与卸载会中止在途请求，旧响应无法覆盖新案例。
 */
export function TutorialReplay({
  caseId,
  replay,
}: {
  caseId: TutorialCaseId;
  replay: TutorialCase["replay"];
}) {
  const sourcePath = replay.messagesPath ?? "";
  const verifiedProvenance = replay.status === "verified" ? replay.provenance : null;
  const [loadState, setLoadState] = useState<ReplayLoadState>({
    status: "idle",
    sourcePath,
  });
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdentityRef = useRef(0);

  useEffect(() => {
    requestIdentityRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setLoadState({ status: "idle", sourcePath });
    return () => {
      requestIdentityRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [caseId, sourcePath]);

  const beginRequest = () => {
    requestIdentityRef.current += 1;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return { controller, identity: requestIdentityRef.current };
  };

  const isCurrentRequest = (identity: number) => requestIdentityRef.current === identity;

  const loadManifestAndFirstPage = async () => {
    if (!sourcePath || !verifiedProvenance) return;
    const { controller, identity } = beginRequest();
    setLoadState({ status: "loading", sourcePath });
    try {
      const manifestRaw = await fetchText(sourcePath, controller.signal);
      if (manifestRaw.bytes.byteLength !== verifiedProvenance.bytes) throw new Error("轨迹 manifest 字节数与采集凭据不一致");
      if ((await sha256Hex(manifestRaw.bytes)) !== verifiedProvenance.messagesSha256) throw new Error("轨迹 manifest SHA-256 与采集凭据不一致");
      const manifest = parseManifest(parseJson(manifestRaw.text, "轨迹 manifest"), caseId);
      if (manifest.messageCount !== verifiedProvenance.messageCount) throw new Error("轨迹 manifest 与采集凭据消息数不一致");
      const firstMessages = await fetchPage(
        manifest.pages[0],
        caseId,
        0,
        [],
        controller.signal,
      );
      if (!isCurrentRequest(identity)) return;
      setLoadState({
        status: "ready",
        sourcePath,
        manifest,
        loadedPages: 1,
        messages: firstMessages,
        loadingMore: false,
      });
    } catch (error) {
      if (controller.signal.aborted || !isCurrentRequest(identity)) return;
      setLoadState({
        status: "error",
        sourcePath,
        message: error instanceof Error ? error.message : "读取失败",
      });
    }
  };

  const loadNextPage = async () => {
    if (loadState.status !== "ready" || loadState.sourcePath !== sourcePath) return;
    const pageIndex = loadState.loadedPages;
    const descriptor = loadState.manifest.pages[pageIndex];
    if (!descriptor || loadState.loadingMore) return;
    const snapshot = loadState;
    const { controller, identity } = beginRequest();
    setLoadState({ ...snapshot, loadingMore: true });
    try {
      const nextMessages = await fetchPage(
        descriptor,
        caseId,
        pageIndex,
        snapshot.messages,
        controller.signal,
      );
      if (!isCurrentRequest(identity)) return;
      const messages = [...snapshot.messages, ...nextMessages];
      const loadedPages = pageIndex + 1;
      if (
        loadedPages === snapshot.manifest.pages.length &&
        messages.length !== snapshot.manifest.messageCount
      ) {
        throw new Error("轨迹完整消息数与 manifest 不一致");
      }
      setLoadState({
        ...snapshot,
        loadedPages,
        messages,
        loadingMore: false,
      });
    } catch (error) {
      if (controller.signal.aborted || !isCurrentRequest(identity)) return;
      setLoadState({
        status: "error",
        sourcePath,
        message: error instanceof Error ? error.message : "读取失败",
      });
    }
  };

  if (replay.status === "pending_capture" || !sourcePath) {
    return (
      <p className="mt-1 text-[12.5px] leading-5 text-muted">
        待真实运行采集。当前只展示经人工编写、可复查的案例步骤，绝不把模拟文字伪装成 Agent 轨迹。
      </p>
    );
  }

  const currentState = loadState.sourcePath === sourcePath
    ? loadState
    : ({ status: "idle", sourcePath } as const);
  const provenance = (
    <div className="mt-3 rounded-lg bg-surface px-3 py-2 text-[11px] leading-5 text-faint">
      <p>
        {replay.provenance.repeatRuns} 次独立运行 · {replay.provenance.messageCount} 条真实消息 · 发布 {replay.provenance.release}
      </p>
      <p>
        实跑：{replay.provenance.agentId} · {replay.provenance.modelId} · {replay.provenance.engine}
      </p>
      <p className="break-all">轨迹 SHA-256：{replay.provenance.messagesSha256}</p>
      <p className="break-all">运行 ID：{replay.provenance.runIds.join("、")}</p>
      <a href={replay.checkReport} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
        查看确定性验收报告
      </a>
    </div>
  );
  const artifactPathPattern = new RegExp(
    `^/tutorials/cases/${caseId}/artifacts/[A-Za-z0-9][A-Za-z0-9._-]*$`,
  );
  const actualArtifactsValid =
    replay.actualArtifacts.length > 0 &&
    replay.actualArtifacts.every(
      (artifact) =>
        artifactPathPattern.test(artifact.path) &&
        /^[a-f0-9]{64}$/.test(artifact.sha256) &&
        Number.isSafeInteger(artifact.bytes) &&
        artifact.bytes > 0,
    );
  const actualArtifacts = (
    <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-[11px] font-semibold text-fg">真实运行产物</p>
      {actualArtifactsValid ? (
        <ul className="mt-1.5 flex flex-col gap-2">
          {replay.actualArtifacts.map((artifact) => (
            <li key={artifact.path}>
              <a href={artifact.path} download className="text-[11.5px] font-medium text-accent hover:underline">
                {artifact.title} · {formatBytes(artifact.bytes)}
              </a>
              <p className="break-all text-[10.5px] text-faint">SHA-256：{artifact.sha256}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11.5px] text-danger">产物清单未通过公开路径与完整性校验，已拒绝展示下载链接。</p>
      )}
    </div>
  );
  const preview = replay.video || replay.poster ? (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-sidebar">
      {replay.video ? (
        <video controls playsInline preload="metadata" poster={replay.poster} className="aspect-video w-full object-cover">
          <source src={replay.video} type="video/webm" />
        </video>
      ) : (
        <img src={replay.poster} alt="案例真实运行预览" className="aspect-video w-full object-cover" />
      )}
      <p className="border-t border-border px-3 py-2 text-[11px] text-faint">短预览只帮助定位；下方轨迹保留完整过程，不以视频代替。</p>
    </div>
  ) : null;

  if (currentState.status === "idle") {
    return (
      <div className="mt-3">
        {provenance}
        {actualArtifacts}
        {preview}
        <Button variant="secondary" size="sm" onClick={() => void loadManifestAndFirstPage()}>
          加载真实完整过程 <ChevronDown size={14} />
        </Button>
        <p className="mt-2 text-[11.5px] text-faint">首次只读取 manifest 和第一页；后续过程由你逐页展开。</p>
      </div>
    );
  }

  if (currentState.status === "loading") {
    return <div>{provenance}{actualArtifacts}{preview}<p className="mt-3 inline-flex items-center gap-2 text-[12.5px] text-muted"><Loader2 size={14} className="animate-spin" /> 正在校验真实 Agent 过程…</p></div>;
  }

  if (currentState.status === "error") {
    return (
      <div className="mt-3">
        {provenance}
        {actualArtifacts}
        {preview}
        <p className="text-[12.5px] text-danger">真实过程读取失败：{currentState.message}</p>
        <Button variant="ghost" size="sm" onClick={() => void loadManifestAndFirstPage()} className="mt-2"><RotateCcw size={13} /> 从第一页重试</Button>
      </div>
    );
  }

  const remainingPages = currentState.manifest.pages.length - currentState.loadedPages;
  return (
    <div>
      {provenance}
      {actualArtifacts}
      {preview}
      <details open className="mt-3 rounded-xl border border-border bg-bg">
        <summary className="cursor-pointer px-4 py-3 text-[12.5px] font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
          真实 Agent 过程 · 已校验 {currentState.messages.length}/{currentState.manifest.messageCount} 条
        </summary>
        <div className="border-t border-border">
          <ReplayRenderBoundary key={`${sourcePath}:${currentState.loadedPages}`}>
            <MessageList
              messages={currentState.messages}
              sending={false}
              cb={{}}
              onRespondPermission={() => {}}
              readOnly
            />
          </ReplayRenderBoundary>
          {remainingPages > 0 && (
            <div className="border-t border-border px-4 py-3 text-center">
              <Button
                variant="secondary"
                size="sm"
                loading={currentState.loadingMore}
                onClick={() => void loadNextPage()}
              >
                加载下一页（还剩 {remainingPages} 页）
              </Button>
              <p className="mt-1.5 text-[11px] text-faint">每页独立校验字节数、SHA-256、顺序与消息结构；不截断。</p>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
