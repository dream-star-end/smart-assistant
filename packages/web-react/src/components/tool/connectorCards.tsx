/**
 * oc-connect（应用连接器 CLI）的专属工具卡，重点是**写操作确认卡**（human-in-the-loop，
 * 安全关键）。
 *
 * ── P0#1 防伪造（本模块的安全核心）─────────────────────────────────────────────
 * CLI 的 stdout 经模型可读。它在需要确认时只吐**不透明 id**：
 *   `{"oc_connect":{"type":"confirmation_required","id":"<uuid>"}}`
 * 本模块解析**只取 id**（其余字段即便被模型 echo 出来也一律忽略、绝不展示）。确认卡挂载后
 * **强制**调 `GET /api/connectors/confirmations/:id`（服务端解密 ledger 里的真实参数），
 * provider/action/summary/detail/status/expiresAt **全部以服务端响应为准**渲染。
 * 这样堵死攻击路径：模型先真实发起高危写操作拿到 id，再 echo「同 id 但摘要无害」的伪造 JSON——
 * 因为展示锚定在服务端而非 CLI 输出，用户看到的永远是这个 id 对应的真实操作，「展示什么」与
 * 「批准后执行什么」由同一 id 决定、不可分叉。拉取失败/id 不符 → 禁用批准（宁可不放行）。
 *
 * 机制对齐（不发明并行机制）：
 *  - 分派：researchCards.OC_BODY_CARDS 注册 `oc-connect`（键受 OcCli 编译期约束）；
 *    解析不出确认对象 → 返回 null，由 researchToolCard 兜底 GenericOcCard（绝不泄漏命令）。
 *  - 鉴权动作（详情 GET / approve / deny）：经 ToolCardActionsContext.connectorConfirm
 *    注入（App 绑定 authRef），无 provider → 降级纯展示（无凭据 → 无可信内容可展示）。
 *  - 决策后替用户发一条消息：ChatInteractionContext.sendUserText（```options 选择卡同机制）；
 *    无 provider → 卡上显示「请回复助手继续」降级文案。
 *
 * 状态注意：卡片状态是**服务端拉取 + 决策后本地回写**；组件重挂载（切会话回看历史）后重新
 * 拉取服务端权威详情，点击操作时后端 CAS 是唯一权威（重复 approve 会被 4xx 拒绝并回显）。
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
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  type ConnectorConfirmTrigger,
  type ConnectorConfirmationDetail,
  confirmActionLabel,
  confirmStatusLabel,
  confirmStatusTone,
  connectorErrorText,
  connectorIcon,
  isConfirmExpired,
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
 * 配对提取其对象值 → JSON.parse → 校验 type + id。解析失败/缺 id/非 confirmation_required
 * → null（调用方回落通用卡）。纯函数，绝不抛异常。
 *
 * **只取 id**（P0#1）：CLI 输出可被模型伪造，provider/action/summary 等即便存在也一律忽略——
 * 展示权威在服务端 `GET /api/connectors/confirmations/:id`，不信 CLI 输出里的任何内容字段。
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
      v.id
    ) {
      // 只锚定 id;其余字段不读、不展示（服务端 GET 才是唯一展示权威）。
      return { type: "confirmation_required", id: v.id };
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
  userId: "微博用户 ID",
  postId: "微博 ID",
  commentId: "评论 ID",
  liked: "点赞状态",
  favorited: "收藏状态",
  irreversible: "不可撤销",
  warning: "风险提示",
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

/**
 * 是否为明确的删除/不可逆类写操作(M4):服务端 detail 标了 irreversible,或
 * action(原始 op 名 + 中文标签)命中删除语义词。判断不了 → false(用 accent,不吓人)。
 */
export function isDestructiveConfirmation(detail: ConnectorConfirmationDetail | null): boolean {
  if (!detail) return false;
  const d = detail.detail;
  if (d && typeof d === "object" && !Array.isArray(d) && (d as Record<string, unknown>).irreversible === true) {
    return true;
  }
  const text = `${detail.action} ${confirmActionLabel(detail.action, detail.provider)}`;
  return /delete|remove|destroy|purge|drop|revoke|uninstall|删除|清空|销毁|撤销|移除|下架/i.test(text);
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

export function ConnectorConfirmCard({
  trigger,
  embedded = false,
}: {
  trigger: ConnectorConfirmTrigger;
  embedded?: boolean;
}) {
  const { connectorConfirm } = useToolCardActions();
  const { sendUserText } = useChatInteraction();
  // 服务端权威详情（GET /api/connectors/confirmations/:id）：挂载即强制拉取，是**唯一**
  // 展示来源。CLI 只给了 id，别无可信内容。
  const [detail, setDetail] = useState<ConnectorConfirmationDetail | null>(null);
  // 初始拉取态：有鉴权注入才拉（无注入=demo/未登录 → 无凭据可拉，降级纯提示）。
  const [loading, setLoading] = useState<boolean>(() => !!connectorConfirm);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 决策后本地回写的状态（覆盖服务端拉取的 detail.status）；null=以服务端 detail.status 为准。
  const [decidedStatus, setDecidedStatus] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 决策成功但无 sendUserText 注入时的降级提示（"请回复助手继续"）。 */
  const [manualFollowUp, setManualFollowUp] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // ── 挂载即拉取服务端权威详情 ────────────────────────────────────────────────
  // provider/action/summary/detail/status/expiresAt 全部以服务端响应为准。拉取进行中显示
  // loading、失败显示错误并禁用批准——宁可不放行，也不拿本地/CLI 的不可信内容当展示。
  useEffect(() => {
    if (!connectorConfirm) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    connectorConfirm
      .getDetail(trigger.id)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e) => {
        if (alive) {
          setLoadError(
            e instanceof ApiError && e.code ? connectorErrorText(e.code) : "加载确认详情失败，请重试",
          );
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connectorConfirm, trigger.id]);

  const shortId = trigger.id.slice(0, 8);
  // 服务端返回的 id 与卡片 id 不一致（不该发生）→ 视为无法核验，禁用一切操作。
  const unverified = detail !== null && detail.id !== trigger.id;
  const Icon = connectorIcon(detail?.provider ?? "");
  const actionLabel = detail ? confirmActionLabel(detail.action, detail.provider) : "";
  // 展示状态：决策回写 > 服务端 status；服务端说 pending 但时钟已过期 → 按 expired 显示（防御）。
  const rawStatus = decidedStatus ?? detail?.status ?? null;
  const expiredByClock = detail ? isConfirmExpired(detail.expiresAt) : false;
  const status =
    rawStatus === "pending" && expiredByClock ? "expired" : rawStatus;
  // 只有：已注入鉴权 + 拉取成功 + id 相符 + 服务端 status==='pending' + 未在决策中 → 才允许点。
  const actionable =
    !!connectorConfirm && !loading && !loadError && !unverified && status === "pending" && !deciding;
  // 操作按钮行的可见性：pending 期（含加载/错误/不符时以禁用态呈现，给「不可操作」的确定信号），
  // 终态（approved/expired/denied…）与无鉴权注入 → 不渲染按钮行。
  const showButtons =
    !!connectorConfirm && (loading || !!loadError || unverified || status === "pending");

  const decide = useCallback(
    (decision: "approve" | "deny") => {
      if (!connectorConfirm || deciding) return;
      setDeciding(true);
      setError(null);
      connectorConfirm
        .decide(trigger.id, decision)
        .then((r) => {
          setDecidedStatus(r.status);
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
          // 后端 CAS 拒绝（已过期/已被处理等）→ 以服务端为准刷新详情与状态（best-effort）。
          connectorConfirm
            .getDetail(trigger.id)
            .then((d) => {
              setDetail(d);
              setDecidedStatus(null);
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
    <div
      className={cn(
        "rounded-lg",
        embedded ? "bg-warning-soft/60" : "mt-1.5 border border-warning/40 bg-surface",
      )}
    >
      {/* 头部：盾牌警示 + 动作中文名（服务端）+ 状态徽标 */}
      <div className={cn("flex min-h-10 items-center gap-2 px-3 py-2", !embedded && "border-b border-border")}>
        <span className="text-warning">
          <ShieldAlert className="size-4" />
        </span>
        <span className="font-medium text-sm text-fg">
          写操作待确认{actionLabel ? ` · ${actionLabel}` : ""}
        </span>
        <span className="ml-auto">
          {loading ? (
            <Spinner />
          ) : loadError || unverified ? (
            <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger">
              <AlertTriangle className="size-2.5" />
              无法核验
            </span>
          ) : status ? (
            <StatusBadge status={status} />
          ) : null}
        </span>
      </div>

      <div className="px-3 py-2">
        {/* 主体：一切展示以服务端权威为准；拉取中/失败/不符/无凭据各自降级，绝不展示 CLI 内容 */}
        {loading ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-faint">
            <Spinner /> 正在核验此操作…
          </div>
        ) : loadError ? (
          <div className="py-1 text-[13px] text-danger">{loadError}</div>
        ) : unverified ? (
          <div className="py-1 text-[13px] text-danger">无法核验此确认，请勿在此操作。</div>
        ) : detail ? (
          <>
            {/* 摘要：服务端解密后铸造，非 CLI 输出 */}
            <div className="flex items-start gap-2">
              <span className="mt-0.5 text-accent">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1 break-words text-[13px] leading-snug text-fg">
                {detail.summary}
              </div>
            </div>

            {/* 查看完整内容：展开已拉取的服务端结构化详情（React 文本渲染，外部内容当纯文本） */}
            <button
              type="button"
              onClick={() => setDetailOpen((o) => !o)}
              className="mt-2 inline-flex items-center gap-1 text-[12px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {detailOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              查看完整内容
            </button>
            {detailOpen && (
              <div className="mt-1.5 rounded-md border border-border px-2.5 py-2">
                <ConfirmationDetailView detail={detail.detail} />
              </div>
            )}
          </>
        ) : (
          <div className="py-1 text-[13px] text-faint">此写操作需在网页端登录后核验并确认。</div>
        )}

        {/* 操作区：只有拉取成功且服务端 status==='pending' 才可点。批准默认 accent
            (与 PermissionCard「允许」一致);仅明确是删除/不可逆操作时用 danger(M4)。 */}
        {showButtons && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              variant={isDestructiveConfirmation(detail) ? "danger" : "accent"}
              size="sm"
              disabled={!actionable}
              onClick={() => decide("approve")}
            >
              确认执行
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!actionable}
              onClick={() => decide("deny")}
            >
              拒绝
            </Button>
            {deciding && <Spinner />}
          </div>
        )}
        {!connectorConfirm && (
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
export function connectorToolCard(
  tool: ToolLike,
  options: { embedded?: boolean } = {},
): ReactNode | null {
  const trigger = parseOcConnectConfirmation(toolOutputText(tool));
  if (!trigger) return null;
  return <ConnectorConfirmCard key={trigger.id} trigger={trigger} embedded={options.embedded} />;
}
