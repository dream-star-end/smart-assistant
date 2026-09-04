/**
 * 权限卡（Aurora 全新设计）。
 *  - 状态展示：等待审批 / 已允许 / 已拒绝（lucide 图标 + 文案,含 server settled reason）。
 *  - 工具展示走 resolveToolMeta(中文标签 + 图标),常见工具做结构化参数摘要
 *    (Bash→命令、文件类→路径、浏览器→URL/动作),其余回落可折叠的格式化 JSON。
 *  - 审批 modal：普通工具 allow/deny；AskUserQuestion 走专用答题（单选/多选/其他/预览），
 *    提交把 `{ answers, annotations }` 经 updatedInput 回送（gateway 白名单校验）。
 *    ExitPlanMode 走计划确认框（markdown 计划书 + 按此执行/继续规划），不能无决策关掉。
 *    modal 窄屏均为贴底 sheet(mobile="sheet")。
 *  - 全部经 props.onRespond（= useChatSocket.respondPermission，已绑 sessId）。
 */
import { Check, Clock, HelpCircle, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { asStr } from "../tool/format";
import { resolveToolMeta, toolSummary } from "../tool/meta";
import { Button, Modal } from "../ui";

export type PermissionRespond = (p: {
  requestId: string;
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}) => void;

// ── AskUserQuestion wire 形态（inputJson.questions） ──
type AqOption = { label: string; description?: string; preview?: string };
type AqQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: AqOption[];
};
type AqInput = { questions: AqQuestion[] };

const OTHER = "__other__";

/** 服务端 pending permission 的权威存活上界，镜像 gateway 的
 *  `Gateway.PENDING_PERMISSION_TTL_MS`（packages/gateway/src/server.ts）。
 *
 *  gateway 每 60s 跑 `_sweepStalePendingPermissions()`，超过该 TTL 的 pending 一律 force-deny
 *  并广播 `outbound.permission_settled{reason:'timeout'}`；断开连接走 `'disconnect'`，容器没了
 *  走 `'crashed'`。也就是说**超过这个时长的未决卡，服务端侧一定已经不在等了**。
 *
 *  两处数值必须一致，由 PermissionCard.test.tsx 的契约断言直接读 server.ts 源码锁定
 *  （前端改不动 gateway 常量：那是容器内源码面 / runtime release 轴，见 V5_DEV_PLAYBOOK §4.1）。
 *
 *  ⚠️ TTL 只用来决定「是否过期」：过期卡不再自动弹框。活跃提问在时钟偏差误判时
 *  仍保留手动「回答」入口（fail-safe）。历史/已结束会话里的过期卡改为只读「已过期」。
 *
 *  Detached Cursor `ask_user` cards (`requestId` 以 `ask-user:` 开头,或
 *  `_detachedAskUser`) 的过期上界是 24 小时（或消息上的 `_askUserExpiresAt`）。
 *  自动弹窗不再用这条 TTL 当「是不是当前活跃提问」的判据 —— 历史未决卡滚进视口
 *  不得再弹。 */
export const PENDING_PERMISSION_TTL_MS = 30 * 60_000;
export const DETACHED_ASK_USER_TTL_MS = 24 * 60 * 60_000;

function isDetachedAskUserCard(msg: ChatMessage): boolean {
  return (
    msg._detachedAskUser === true ||
    (typeof msg.requestId === "string" && msg.requestId.startsWith("ask-user:"))
  );
}

/** Page-session memory of requestIds the user dismissed without answering.
 *  Live prompts must re-open after a timeline remount (CCB still waits);
 *  only an explicit close without allow/deny suppresses the next auto-open.
 *  ExitPlanMode never enters this set — the engine cannot proceed until the
 *  user picks 按此计划执行 / 继续规划. Refresh clears the set. */
const dismissedPermissionRequestIds = new Set<string>();

export function resetPermissionAutoOpenMemory(): void {
  dismissedPermissionRequestIds.clear();
}

function rememberDismissedPermissionRequest(requestId: string | undefined): void {
  if (requestId) dismissedPermissionRequestIds.add(requestId);
}

export function isExitPlanModeTool(toolName: string | undefined): boolean {
  return toolName === "ExitPlanMode";
}

/** CCB injects `plan` via normalizeToolInput before can_use_tool. */
export function extractExitPlanMarkdown(input: Record<string, unknown> | null | undefined): string {
  if (!input) return "";
  const plan = input.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan : "";
}

/** Prefer the server-carried absolute expiry; fall back to ts + role TTL for
 *  old rows that never received `_askUserExpiresAt`. */
export function permissionHasExpired(msg: ChatMessage, now = Date.now()): boolean {
  const expiresAt = msg._askUserExpiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return now >= expiresAt;
  }
  if (!Number.isFinite(msg.ts)) return false;
  // Blocking prompts (detached ask_user, ExitPlanMode) are not subject to the
  // 30-minute idle TTL on the server either (gateway `BLOCKING_USER_INPUT_TOOLS`).
  const ttlMs = isDetachedAskUserCard(msg) || isExitPlanModeTool(msg.toolName)
    ? DETACHED_ASK_USER_TTL_MS
    : PENDING_PERMISSION_TTL_MS;
  return now - msg.ts > ttlMs;
}

/** A prompt the runtime is (as far as this browser can tell) still blocked on:
 *  unresolved, no durable response in flight, and inside the server TTL.
 *  MessageRenderer uses it to decide whether an unresolved card in the current
 *  segment may be treated as live even when `sending` is false — the
 *  INC-20260904 case where the turn belongs to a master-authored `m-recover-*`
 *  row this tab never adopted, so `_sendingInFlight` stayed false while the
 *  engine sat in waitingForUserInput. */
export function isAwaitingPermissionPrompt(msg: ChatMessage, now = Date.now()): boolean {
  if (msg.role !== "permission") return false;
  if (msg._resolved === true || msg._controlPending === true) return false;
  return !permissionHasExpired(msg, now);
}

function asAskUserQuestion(msg: ChatMessage): AqQuestion[] | null {
  if (msg.toolName !== "AskUserQuestion") return null;
  const input = msg.inputJson as AqInput | null | undefined;
  if (!input || !Array.isArray(input.questions)) return null;
  const qs = input.questions.filter((q) => q && typeof q.question === "string" && q.question.length > 0);
  return qs.length > 0 ? qs : null;
}

/** 消息上的 inputJson 收窄为对象(结构化摘要用);非对象 → null。 */
function permissionInput(msg: ChatMessage): Record<string, unknown> | null {
  const v = msg.inputJson;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 权限请求参数的结构化摘要(F5):常见工具展示语义字段(命令/路径/URL/内容),
 * 其余回落**可折叠**的格式化 JSON —— 不再直接 dump 原始参数。卡片与审批 modal 共用。
 */
function PermissionInputSummary({
  toolName,
  input,
  inputPreview,
}: {
  toolName: string;
  input: Record<string, unknown> | null;
  inputPreview?: string;
}) {
  const command = asStr(input?.command);
  const filePath = asStr(input?.file_path) || asStr(input?.path) || asStr(input?.notebook_path);
  const url = asStr(input?.url);
  const prompt = asStr(input?.prompt) || asStr(input?.query) || asStr(input?.text);
  // MCP/其余工具:meta 层的紧凑摘要(浏览器→URL/动作、媒体→prompt 等)。
  const metaSummary = toolSummary(toolName, input);
  const rows: { label: string; value: string }[] = [];
  if (filePath) rows.push({ label: "文件", value: filePath });
  if (url && !command) rows.push({ label: "地址", value: url });
  if (!command && !filePath && !url && prompt) rows.push({ label: "内容", value: prompt.slice(0, 400) });
  if (rows.length === 0 && !command && metaSummary) rows.push({ label: "操作", value: metaSummary });
  const hasStructured = !!command || rows.length > 0;
  let json = "";
  if (input) {
    try {
      json = JSON.stringify(input, null, 2);
    } catch {
      json = inputPreview ?? "";
    }
  } else {
    json = inputPreview ?? "";
  }
  if (json.length > 4000) json = `${json.slice(0, 4000)}\n…`;
  return (
    <div className="space-y-2">
      {command && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[12px] text-fg">
          <span className="text-success">$ </span>
          {command.slice(0, 2000)}
        </pre>
      )}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1 text-[12.5px]">
          {rows.map((row) => (
            <div key={row.label} className="flex gap-2">
              <dt className="shrink-0 font-medium text-faint">{row.label}</dt>
              <dd className="min-w-0 break-all font-mono text-muted">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {json && json !== "{}" && (
        <details open={!hasStructured}>
          <summary className="cursor-pointer rounded text-[11.5px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            查看完整参数
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[12px] text-muted">
            {json}
          </pre>
        </details>
      )}
    </div>
  );
}

export function PermissionCard({
  msg,
  onRespond,
  readOnly = false,
  livePrompt = true,
}: {
  msg: ChatMessage;
  onRespond: PermissionRespond;
  /** 管理端会话查看等只读 surface：保留历史状态，但绝不弹框或提供审批动作。 */
  readOnly?: boolean;
  /** 当前会话、当前 in-flight turn 里待回答的活提问。历史/已结束会话必须传 false：
   *  只展示记录，绝不自动弹。默认 true 只为单卡单测保持「活卡挂载即弹」语义；
   *  列表层（MessageRenderer）始终传入 `inActiveTurn && sending`。 */
  livePrompt?: boolean;
}) {
  const questions = useMemo(() => asAskUserQuestion(msg), [msg]);
  const resolved = !!msg._resolved;
  const pending = msg._controlPending === true;
  const behavior = msg._behavior;
  const [open, setOpen] = useState(false);
  const isExitPlan = isExitPlanModeTool(msg.toolName);
  const input = permissionInput(msg);
  const planMarkdown = isExitPlan ? extractExitPlanMarkdown(input) : "";

  const expired = !resolved && permissionHasExpired(msg);
  const canAnswer = !resolved && !pending && !readOnly && (!expired || livePrompt);

  // 自动弹窗：仅活提问。时间线重挂会丢掉 useState(open)，必须再弹，
  // 否则 CCB waitingForUserInput 会卡死而用户看不到确认框。
  // 用户主动关掉（问答/普通权限）才记入 dismissed 集，阻止下一次自动弹。
  useEffect(() => {
    if (!livePrompt || resolved || pending || readOnly || expired) return;
    const requestId = msg.requestId;
    if (!requestId) return;
    if (!isExitPlan && dismissedPermissionRequestIds.has(requestId)) return;
    setOpen(true);
  }, [resolved, pending, readOnly, expired, livePrompt, isExitPlan, msg.requestId]);

  const handleDismissableOpenChange = (next: boolean) => {
    if (!next) rememberDismissedPermissionRequest(msg.requestId);
    setOpen(next);
  };

  // 状态图标(M7):lucide 替代 emoji。等待→Clock / 已允许→Check / 已拒绝→X。
  const StatusIcon = !resolved ? Clock : behavior === "allow" ? Check : X;
  const statusIconCls = !resolved ? "text-muted" : behavior === "allow" ? "text-success" : "text-danger";
  const statusText = !resolved
    ? pending
      ? "正在提交…"
      : expired
        ? "已过期"
        : questions
          ? "等待回答…"
          : isExitPlan
            ? "等待确认计划…"
            : "等待审批…"
    : behavior === "allow"
      ? questions
        ? "已提交"
        : isExitPlan
          ? "已确认计划"
          : "已允许"
      : questions
        ? "已跳过"
        : isExitPlan
          ? "继续规划"
          : "已拒绝";
  const tone = !resolved ? "neutral" : behavior === "allow" ? "allow" : "deny";

  // 工具中文标签 + 图标(F5):resolveToolMeta 单一权威;无 toolName → 「未知工具」。
  const meta = msg.toolName ? resolveToolMeta(msg.toolName, input) : null;
  const toolLabel = meta ? meta.label : "未知工具";
  const ToolIcon = meta?.icon ?? null;

  return (
    <div
      data-testid="permission-card"
      className={cn(
        "rounded-lg border bg-surface animate-in",
        tone === "allow" && "border-success/40",
        tone === "deny" && "border-danger/40",
        tone === "neutral" && "border-accent/40",
      )}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          {questions ? <HelpCircle size={14} /> : <ShieldCheck size={14} />}
        </span>
        <span className="text-[13px] font-medium text-fg">
          {questions ? "用户问答" : isExitPlan ? "退出计划模式" : "权限请求"}
        </span>
        {!questions && (
          <span className="inline-flex min-w-0 items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-[12px] text-muted">
            {ToolIcon && <ToolIcon size={12} aria-hidden="true" className="shrink-0" />}
            <span className="truncate">{toolLabel}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
          <StatusIcon size={13} aria-hidden="true" className={statusIconCls} />
          {statusText}
        </span>
      </div>

      {/* 待审批：内联快捷 + 打开审批框。历史未答卡不自动弹，但保留这颗显式按钮。 */}
      {canAnswer && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2">
          <Button size="sm" variant="accent" shape="pill" onClick={() => setOpen(true)}>
            {questions ? "回答" : isExitPlan ? "审阅计划" : "审批"}
          </Button>
          {!questions && !isExitPlan && (
            <Button
              size="sm"
              variant="ghost"
              shape="pill"
              onClick={() => onRespond({ requestId: msg.requestId!, behavior: "deny" })}
            >
              拒绝
            </Button>
          )}
        </div>
      )}
      {!resolved && readOnly && (
        <div className="border-t border-border px-3.5 py-2 text-[11.5px] text-faint">
          只读查看 · 需由用户在原会话中处理
        </div>
      )}
      {!resolved && !readOnly && expired && !livePrompt && (
        <div className="border-t border-border px-3.5 py-2 text-[11.5px] text-faint">
          提问已过期，无法再作答
        </div>
      )}

      {!resolved && isExitPlan && planMarkdown && (
        <div
          data-testid="exit-plan-preview"
          className="max-h-28 overflow-hidden border-t border-border px-3.5 py-2 text-[12.5px] text-muted"
        >
          <Markdown>{planMarkdown}</Markdown>
        </div>
      )}

      {/* 已解析：AskUserQuestion 展示问答摘要；普通展示 inputPreview */}
      {resolved && questions && behavior === "allow" && (
        <div className="space-y-1.5 border-t border-border px-3.5 py-2.5">
          {questions.map((q, i) => (
            <div key={i} className="text-[13px]">
              <div className="text-muted">{q.question}</div>
              <div className="text-fg">→ {msg._answers?.[q.question] || "（未回答）"}</div>
            </div>
          ))}
        </div>
      )}
      {resolved && !questions && isExitPlan && planMarkdown && (
        <div
          data-testid="exit-plan-markdown"
          className="max-h-64 overflow-auto border-t border-border px-3.5 py-2"
        >
          <Markdown>{planMarkdown}</Markdown>
        </div>
      )}
      {resolved && !questions && !isExitPlan && (input || msg.inputPreview) && (
        <div className="border-t border-border px-3.5 py-2">
          <PermissionInputSummary
            toolName={msg.toolName || ""}
            input={input}
            inputPreview={msg.inputPreview}
          />
        </div>
      )}
      {resolved && msg._settledReason && msg._settledReason !== "remote" && (
        <div className="border-t border-border px-3.5 py-1.5 text-[11px] text-faint">
          {settledReasonLabel(msg._settledReason)}
        </div>
      )}

      {/* 审批 modal */}
      {canAnswer &&
        (questions ? (
          <AskUserQuestionModal
            open={open}
            onOpenChange={handleDismissableOpenChange}
            requestId={msg.requestId!}
            questions={questions}
            inputJson={(msg.inputJson as AqInput) ?? { questions }}
            onRespond={onRespond}
          />
        ) : isExitPlan ? (
          <ExitPlanModeModal
            open={open}
            onOpenChange={setOpen}
            requestId={msg.requestId!}
            plan={planMarkdown}
            planFilePath={asStr(input?.planFilePath)}
            onRespond={onRespond}
          />
        ) : (
          <GenericPermissionModal
            open={open}
            onOpenChange={handleDismissableOpenChange}
            requestId={msg.requestId!}
            toolName={msg.toolName || ""}
            toolLabel={toolLabel}
            toolIcon={ToolIcon}
            input={input}
            inputPreview={msg.inputPreview}
            onRespond={onRespond}
          />
        ))}
    </div>
  );
}

function settledReasonLabel(reason: string): string {
  switch (reason) {
    case "timeout":
      return "审批超时，已自动拒绝";
    case "disconnect":
      return "连接断开，已自动拒绝";
    case "crashed":
      return "进程异常，已自动拒绝";
    case "user_stop":
      return "本轮已停止，提问已关闭";
    case "already_settled":
      return "请求已处理";
    default:
      return reason;
  }
}

// ═══════════════ 普通权限审批框 ═══════════════
function GenericPermissionModal({
  open,
  onOpenChange,
  requestId,
  toolName,
  toolLabel,
  toolIcon: ToolIcon,
  input,
  inputPreview,
  onRespond,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  requestId: string;
  toolName: string;
  toolLabel: string;
  toolIcon: ReturnType<typeof resolveToolMeta>["icon"] | null;
  input: Record<string, unknown> | null;
  inputPreview?: string;
  onRespond: PermissionRespond;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      mobile="sheet"
      title="工具权限请求"
      description="智能体请求执行以下工具，请确认是否允许。"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onRespond({ requestId, behavior: "deny" });
              onOpenChange(false);
            }}
          >
            拒绝
          </Button>
          <Button
            variant="accent"
            onClick={() => {
              onRespond({ requestId, behavior: "allow" });
              onOpenChange(false);
            }}
          >
            允许
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        <div className="inline-flex items-center gap-1.5 rounded bg-hover px-2 py-1 text-sm text-fg">
          {ToolIcon && <ToolIcon size={14} aria-hidden="true" className="shrink-0 text-muted" />}
          {toolLabel}
        </div>
        <PermissionInputSummary toolName={toolName} input={input} inputPreview={inputPreview} />
      </div>
    </Modal>
  );
}

// ═══════════════ ExitPlanMode 计划确认框 ═══════════════
function ExitPlanModeModal({
  open,
  onOpenChange,
  requestId,
  plan,
  planFilePath,
  onRespond,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  requestId: string;
  plan: string;
  planFilePath?: string;
  onRespond: PermissionRespond;
}) {
  const decide = (behavior: "allow" | "deny") => {
    onRespond({
      requestId,
      behavior,
      ...(behavior === "deny" ? { message: "User rejected the plan" } : {}),
    });
    onOpenChange(false);
  };
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
      }}
      mobile="sheet"
      size="lg"
      fixedHeight
      hideClose
      onEscapeKeyDown={(event) => event.preventDefault()}
      title="退出计划模式"
      description="请审阅计划后再决定是否开始执行。关掉窗口不会取消等待。"
      footer={
        <>
          <Button variant="ghost" onClick={() => decide("deny")}>
            继续规划
          </Button>
          <Button variant="accent" onClick={() => decide("allow")}>
            按此计划执行
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {plan ? (
          <div
            data-testid="exit-plan-markdown"
            className="max-h-[min(56dvh,28rem)] overflow-auto rounded-md border border-border bg-surface px-3 py-2"
          >
            <Markdown>{plan}</Markdown>
          </div>
        ) : (
          <p data-testid="exit-plan-missing" className="text-sm text-muted">
            计划文件已写好，但这次审批请求没有带上正文。批准后模型会按计划文件执行。
          </p>
        )}
        {planFilePath ? (
          <p className="truncate font-mono text-[11px] text-faint">{planFilePath}</p>
        ) : null}
      </div>
    </Modal>
  );
}

// ═══════════════ AskUserQuestion 答题框 ═══════════════
type QState = { selected: string[]; other: string };

function AskUserQuestionModal({
  open,
  onOpenChange,
  requestId,
  questions,
  inputJson,
  onRespond,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  requestId: string;
  questions: AqQuestion[];
  inputJson: AqInput;
  onRespond: PermissionRespond;
}) {
  const [state, setState] = useState<Record<string, QState>>(() => {
    const init: Record<string, QState> = {};
    for (const q of questions) init[q.question] = { selected: [], other: "" };
    return init;
  });
  const [error, setError] = useState<number | null>(null);

  const setQ = (qtext: string, next: Partial<QState>) =>
    setState((s) => ({ ...s, [qtext]: { ...s[qtext], ...next } }));

  const toggle = (q: AqQuestion, label: string) => {
    const cur = state[q.question];
    if (q.multiSelect) {
      const has = cur.selected.includes(label);
      setQ(q.question, { selected: has ? cur.selected.filter((l) => l !== label) : [...cur.selected, label] });
    } else {
      setQ(q.question, { selected: [label], other: label === OTHER ? cur.other : "" });
    }
  };

  const submit = () => {
    const answers: Record<string, string> = {};
    const annotations: Record<string, { preview: string }> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qs = state[q.question];
      if (qs.selected.length === 0) {
        setError(i);
        return;
      }
      if (q.multiSelect) {
        answers[q.question] = qs.selected.join(", ");
      } else {
        const only = qs.selected[0];
        if (only === OTHER) {
          const text = qs.other.trim();
          if (!text) {
            setError(i);
            return;
          }
          answers[q.question] = text;
        } else {
          answers[q.question] = only;
          const opt = (q.options ?? []).find((o) => o && o.label !== OTHER && o.label === only);
          if (opt?.preview) annotations[q.question] = { preview: opt.preview };
        }
      }
    }
    onRespond({
      requestId,
      behavior: "allow",
      updatedInput: {
        ...inputJson,
        answers,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
    });
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      mobile="sheet"
      title="用户问答"
      description={questions.length > 1 ? `共 ${questions.length} 题` : "请回答以下问题"}
      className="max-w-xl"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onRespond({ requestId, behavior: "deny", message: "User skipped" });
              onOpenChange(false);
            }}
          >
            跳过
          </Button>
          <Button variant="accent" onClick={submit}>
            提交
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {questions.map((q, idx) => {
          const qs = state[q.question];
          const hasPreview = !q.multiSelect && (q.options ?? []).some((o) => !!o.preview);
          const safeOptions = (q.options ?? []).filter((o) => o && o.label !== OTHER);
          const showOther = !hasPreview && !q.multiSelect;
          const preview = qs.selected[0]
            ? safeOptions.find((o) => o.label === qs.selected[0])?.preview
            : undefined;
          return (
            <section
              key={idx}
              className={cn("space-y-2", error === idx && "rounded-lg ring-2 ring-danger ring-offset-2 ring-offset-elevated")}
            >
              {q.header && <div className="text-[11px] font-medium uppercase tracking-wide text-faint">{q.header}</div>}
              <div className="text-[14px] font-medium text-fg">{q.question}</div>
              <div
                className="grid gap-1.5"
                role={q.multiSelect ? "group" : "radiogroup"}
                aria-label={q.question}
              >
                {safeOptions.map((opt) => {
                  const sel = qs.selected.includes(opt.label);
                  return (
                    <button
                      type="button"
                      key={opt.label}
                      role={q.multiSelect ? "checkbox" : "radio"}
                      aria-checked={sel}
                      onClick={() => toggle(q, opt.label)}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                        sel ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-hover",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                          sel ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
                          q.multiSelect ? "rounded-[5px]" : "rounded-full",
                        )}
                      >
                        {sel && <Check size={11} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] text-fg">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-[12px] text-muted">{opt.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {showOther && (
                  // biome-ignore lint/a11y/useSemanticElements: 富样式选项卡沿用 button,按 WAI-ARIA radio 模式补语义(M12)
                  <button
                    type="button"
                    role="radio"
                    aria-checked={qs.selected.includes(OTHER)}
                    onClick={() => toggle(q, OTHER)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      qs.selected.includes(OTHER)
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:bg-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        qs.selected.includes(OTHER) ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
                      )}
                    >
                      {qs.selected.includes(OTHER) && <Check size={11} />}
                    </span>
                    <span className="text-[13.5px] text-fg">其他（自行输入）</span>
                  </button>
                )}
              </div>
              {showOther && qs.selected.includes(OTHER) && (
                <input
                  type="text"
                  value={qs.other}
                  autoFocus
                  onChange={(e) => setQ(q.question, { other: e.target.value })}
                  // placeholder 不构成可访问名(探针 label=null),读屏需要显式名字。
                  aria-label="其他答案"
                  placeholder="输入你的答案…"
                  className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13.5px] text-fg outline-none focus-visible:border-accent"
                />
              )}
              {hasPreview && preview && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 text-[12px] text-muted">
                  {preview}
                </pre>
              )}
              {error === idx && <div className="text-[12px] text-danger">请先回答此题</div>}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
