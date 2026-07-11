/**
 * oc-connect（应用连接器 CLI）的专属工具卡，重点是**写操作确认卡**（human-in-the-loop，
 * 安全关键）：CLI 在需要确认时 stdout 输出单个 JSON 对象
 * `{"oc_connect":{"type":"confirmation_required","id":…,"provider":…,"action":…,"summary":…,"expiresAt":…}}`，
 * 本模块从 Bash 工具输出解析该对象 → 渲染确认卡（summary + 查看完整内容 + 确认/拒绝）。
 *
 * 机制对齐（不发明并行机制）：
 *  - 分派：researchCards.OC_BODY_CARDS 注册 `oc-connect`（键受 OcCli 编译期约束）；
 *    解析不出确认对象 → 返回 null，由 researchToolCard 兜底 GenericOcCard（绝不泄漏命令）。
 *  - 鉴权动作（详情 GET / approve / deny）：经 ToolCardActionsContext.connectorConfirm
 *    注入（App 绑定 authRef），无 provider → 降级纯展示（同 onOpenMemory 等哲学）。
 *  - 决策后替用户发一条消息：ChatInteractionContext.sendUserText（```options 选择卡同机制）；
 *    无 provider → 卡上显示「请回复助手继续」降级文案。
 *
 * 状态注意：卡片状态是**本地乐观态 + 服务端响应回写**；组件重挂载（切会话回看历史）后
 * 回到 trigger 初始态，点击操作时后端 CAS 是唯一权威（重复 approve 会被 4xx 拒绝并回显）。
 */
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  confirmActionLabel,
  confirmStatusLabel,
  confirmStatusTone,
  connectorErrorText,
  connectorIcon,
  isConfirmExpired,
  isConfirmTerminal,
  type ConnectorConfirmationDetail,
  type ConnectorConfirmTrigger,
} from "../../lib/connectors";
import { cn } from "../../lib/utils";
import { Button, Spinner } from "../ui";
import { useChatInteraction, useToolCardActions } from "./context";
import type { ToolLike } from "./format";

// ── 解析：从 Bash stdout 提取 oc_connect 确认对象 ───────────────────────────

/** 字符串/转义感知的花括号配对：从 text[start]（须为 '{'）起返回完整对象文本；截断 → null。 */
function matchBraces(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从（可能混有其他日志行的）工具输出里解析确认触发对象。找 `"oc_connect"` 键 → 花括号
 * 配对提取其对象值 → JSON.parse → 严格校验必填字段。解析失败/字段缺失/非
 * confirmation_required → null（调用方回落通用卡）。纯函数，绝不抛异常。
 */
export function parseOcConnectConfirmation(
  text: string | null | undefined,
): ConnectorConfirmTrigger | null {
  if (!text) return null;
  const keyAt = text.indexOf('"oc_connect"');
  if (keyAt < 0) return null;
  const braceAt = text.indexOf("{", keyAt + '"oc_connect"'.length);
  if (braceAt < 0) return null;
  const objText = matchBraces(text, braceAt);
  if (!objText) return null;
  try {
    const v = JSON.parse(objText) as Record<string, unknown>;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      v.type === "confirmation_required" &&
      typeof v.id === "string" &&
      v.id &&
      typeof v.provider === "string" &&
      typeof v.action === "string" &&
      typeof v.summary === "string"
    ) {
      return {
        type: "confirmation_required",
        id: v.id,
        provider: v.provider,
        action: v.action,
        summary: v.summary,
        expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : "",
      };
    }
  } catch {
    /* 非法 JSON → null */
  }
  return null;
}

/** tool 的真实输出文本（优先 output，回落 bashTail；与 researchCards.outputText 同语义）。 */
function toolOutputText(tool: ToolLike): string | null {
  if (typeof tool.output === "string" && tool.output.trim()) return tool.output;
  const tail = tool.bashTail?.tail;
  if (typeof tail === "string" && tail.trim()) return tail;
  return null;
}

// ── 结构化详情渲染（服务端解密渲染的 detail：邮件/文件/日历/消息） ────────────

/** 已知 detail 键 → 中文标签（未知键回退原键名，不吞字段）。 */
const DETAIL_KEY_LABEL: Record<string, string> = {
  to: "收件人",
  cc: "抄送",
  bcc: "密送",
  subject: "主题",
  body: "正文",
  text: "正文",
  html: "正文(HTML)",
  attachments: "附件",
  path: "路径",
  size: "大小",
  sha256: "SHA256",
  hash: "哈希",
  filename: "文件名",
  title: "标题",
  content: "内容",
  parent: "所属页面",
  start: "开始时间",
  end: "结束时间",
  timezone: "时区",
  attendees: "参与者",
  recurrence: "重复规则",
  calendar: "日历",
  location: "地点",
  recipient: "接收对象",
  chat: "会话",
  message: "消息内容",
  url: "地址",
};

function detailKeyLabel(key: string): string {
  return DETAIL_KEY_LABEL[key] ?? key;
}

/** 原样保留换行的长文本值（邮件正文/消息全文）。 */
function DetailText({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words rounded-md bg-code px-2.5 py-2 text-[12.5px] leading-relaxed text-fg">
      {text}
    </div>
  );
}

/** 单个值：短标量内联；长字符串→保留换行块；数组拼顿号；嵌套对象→缩进 JSON。 */
function DetailValue({ value }: { value: unknown }): ReactNode {
  if (value == null) return <span className="text-faint">—</span>;
  if (typeof value === "string") {
    return value.length > 80 || value.includes("\n") ? (
      <DetailText text={value} />
    ) : (
      <span className="break-words text-fg">{value}</span>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="text-fg">{String(value)}</span>;
  }
  if (Array.isArray(value) && value.every((x) => typeof x === "string" || typeof x === "number")) {
    return <span className="break-words text-fg">{value.map(String).join("、")}</span>;
  }
  // 嵌套对象/对象数组（附件清单等）：缩进 JSON 展示，保证信息完整不丢。
  let dump = "";
  try {
    dump = JSON.stringify(value, null, 2);
  } catch {
    dump = String(value);
  }
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
      {dump}
    </pre>
  );
}

/** 结构化完整详情：对象 → 中文标签 KV 行；字符串 → 正文块；其余 → JSON。 */
export function ConfirmationDetailView({ detail }: { detail: unknown }): ReactNode {
  if (detail == null) return <div className="text-xs text-faint">（无更多内容）</div>;
  if (typeof detail === "string") return <DetailText text={detail} />;
  if (typeof detail === "object" && !Array.isArray(detail)) {
    const rows = Object.entries(detail as Record<string, unknown>).filter(
      ([, v]) => v != null && v !== "",
    );
    if (rows.length === 0) return <div className="text-xs text-faint">（无更多内容）</div>;
    return (
      <dl className="flex flex-col gap-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 text-[12.5px] sm:flex-row sm:gap-2">
            <dt className="shrink-0 font-medium text-faint sm:w-20">{detailKeyLabel(k)}</dt>
            <dd className="min-w-0 flex-1">
              <DetailValue value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <DetailValue value={detail} />;
}

// ── 状态徽标 ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const tone = confirmStatusTone(status);
  const cls =
    tone === "ok"
      ? "bg-success/10 text-success"
      : tone === "danger"
        ? "bg-danger/10 text-danger"
        : tone === "pending"
          ? "bg-warning/10 text-warning"
          : "bg-hover text-faint";
  const Icon =
    tone === "ok" ? CheckCircle2 : tone === "danger" ? XCircle : tone === "pending" ? Clock : AlertTriangle;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", cls)}>
      <Icon className="size-2.5" />
      {confirmStatusLabel(status)}
    </span>
  );
}

// ── 确认卡本体 ──────────────────────────────────────────────────────────────

export function ConnectorConfirmCard({ trigger }: { trigger: ConnectorConfirmTrigger }) {
  const { connectorConfirm } = useToolCardActions();
  const { sendUserText } = useChatInteraction();
  // 本地状态机：trigger 初始 pending（已过期直接 expired）；服务端响应是唯一回写来源。
  const [status, setStatus] = useState<string>(() =>
    trigger.expiresAt && isConfirmExpired(trigger.expiresAt) ? "expired" : "pending",
  );
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 决策成功但无 sendUserText 注入时的降级提示（"请回复助手继续"）。 */
  const [manualFollowUp, setManualFollowUp] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<ConnectorConfirmationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const Icon = connectorIcon(trigger.provider);
  const actionLabel = confirmActionLabel(trigger.action);
  const shortId = trigger.id.slice(0, 8);
  const actionable = status === "pending" && !isConfirmTerminal(status) && !!connectorConfirm;

  // 详情懒加载（服务端解密渲染完整参数；同时以其 status 为准同步本地状态）。
  // 注：副作用不放进 setState updater（StrictMode 会双调 updater → 双请求）。
  const toggleDetail = useCallback(() => {
    const next = !detailOpen;
    setDetailOpen(next);
    if (next && !detail && !detailLoading && connectorConfirm) {
      setDetailLoading(true);
      setDetailError(null);
      connectorConfirm
        .getDetail(trigger.id)
        .then((d) => {
          setDetail(d);
          if (d.status) setStatus(d.status);
        })
        .catch((e) => {
          setDetailError(
            e instanceof ApiError && e.code ? connectorErrorText(e.code) : "加载完整内容失败，请重试",
          );
        })
        .finally(() => setDetailLoading(false));
    }
  }, [detailOpen, detail, detailLoading, connectorConfirm, trigger.id]);

  const decide = useCallback(
    (decision: "approve" | "deny") => {
      if (!connectorConfirm || deciding) return;
      setDeciding(true);
      setError(null);
      connectorConfirm
        .decide(trigger.id, decision)
        .then((r) => {
          setStatus(r.status);
          const message =
            decision === "approve" ? `已确认执行（${shortId}）` : `已拒绝（${shortId}）`;
          if (sendUserText) {
            // 自动替用户发送确认消息，让助手继续执行/收尾（```options 选择卡同机制）。
            sendUserText(message);
            setManualFollowUp(null);
          } else {
            setManualFollowUp(
              decision === "approve" ? "已确认，请回复助手继续。" : "已拒绝，请回复助手继续。",
            );
          }
        })
        .catch((e) => {
          setError(e instanceof ApiError && e.code ? connectorErrorText(e.code) : "操作失败，请重试");
          // 后端 CAS 拒绝（已过期/已被处理等）→ 以服务端状态为准刷新本地态（best-effort）。
          connectorConfirm
            .getDetail(trigger.id)
            .then((d) => {
              if (d.status) setStatus(d.status);
            })
            .catch(() => {
              /* 状态刷新失败：保留本地态，错误文案已展示 */
            });
        })
        .finally(() => setDeciding(false));
    },
    [connectorConfirm, deciding, trigger.id, shortId, sendUserText],
  );

  return (
    <div className="mt-1.5 rounded-md border border-warning/40 bg-surface">
      {/* 头部：盾牌警示 + 动作中文名 + 状态徽标 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-warning">
          <ShieldAlert className="size-4" />
        </span>
        <span className="font-medium text-sm text-fg">写操作待确认 · {actionLabel}</span>
        <span className="ml-auto">
          <StatusBadge status={status} />
        </span>
      </div>

      <div className="px-3 py-2">
        {/* 摘要（来自 CLI 触发对象；完整参数以服务端账本为准） */}
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-accent">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 break-words text-[13px] leading-snug text-fg">
            {trigger.summary}
          </div>
        </div>

        {/* 查看完整内容：懒加载服务端解密渲染的结构化详情 */}
        <button
          type="button"
          onClick={toggleDetail}
          className="mt-2 inline-flex items-center gap-1 text-[12px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {detailOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          查看完整内容
        </button>
        {detailOpen && (
          <div className="mt-1.5 rounded-md border border-border px-2.5 py-2">
            {detailLoading && (
              <div className="flex items-center gap-2 py-1 text-xs text-faint">
                <Spinner /> 加载完整内容…
              </div>
            )}
            {detailError && <div className="py-1 text-xs text-danger">{detailError}</div>}
            {!detailLoading && !detailError && !connectorConfirm && (
              <div className="py-1 text-xs text-faint">登录后可查看完整内容。</div>
            )}
            {detail && <ConfirmationDetailView detail={detail.detail} />}
          </div>
        )}

        {/* 操作区：pending 且已注入鉴权动作才可操作；批准是危险色（写操作） */}
        {actionable && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button variant="danger" size="sm" disabled={deciding} onClick={() => decide("approve")}>
              确认执行
            </Button>
            <Button variant="secondary" size="sm" disabled={deciding} onClick={() => decide("deny")}>
              拒绝
            </Button>
            {deciding && <Spinner />}
          </div>
        )}
        {status === "pending" && !connectorConfirm && (
          <div className="mt-2 text-xs text-faint">（此会话中不可操作，请在网页端登录后确认）</div>
        )}
        {status === "expired" && (
          <div className="mt-2 text-xs text-faint">该确认已过期，如仍需执行请让助手重新发起。</div>
        )}
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
        {manualFollowUp && <div className="mt-2 text-xs text-success">{manualFollowUp}</div>}

        <div className="mt-2 text-[11px] text-faint">确认码 {shortId} · 批准后 10 分钟内有效</div>
      </div>
    </div>
  );
}

// ── OC_BODY_CARDS 分派入口 ──────────────────────────────────────────────────

/**
 * oc-connect 的 body 卡分派：输出含确认触发对象 → 确认卡；否则 null（researchToolCard
 * 兜底 GenericOcCard，list/读操作结果走折叠详细输出，不泄漏命令）。
 * key 用确认 id：同一条历史消息重渲时 state 保持，不同确认互不串态。
 */
export function connectorToolCard(tool: ToolLike): ReactNode | null {
  const trigger = parseOcConnectConfirmation(toolOutputText(tool));
  if (!trigger) return null;
  return <ConnectorConfirmCard key={trigger.id} trigger={trigger} />;
}
