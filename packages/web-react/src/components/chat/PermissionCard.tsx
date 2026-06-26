/**
 * 权限卡（Aurora 全新设计）。
 *  - 状态展示：⏳ 等待审批 / ✓ 已允许 / ✗ 已拒绝（含 server settled reason）。
 *  - 审批 modal：普通工具 allow/deny；AskUserQuestion 走专用答题（单选/多选/其他/预览），
 *    提交把 `{ answers, annotations }` 经 updatedInput 回送（gateway 白名单校验）。
 *  - 全部经 props.onRespond（= useChatSocket.respondPermission，已绑 sessId）。
 */
import { Check, HelpCircle, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
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

function asAskUserQuestion(msg: ChatMessage): AqQuestion[] | null {
  if (msg.toolName !== "AskUserQuestion") return null;
  const input = msg.inputJson as AqInput | null | undefined;
  if (!input || !Array.isArray(input.questions)) return null;
  const qs = input.questions.filter((q) => q && typeof q.question === "string" && q.question.length > 0);
  return qs.length > 0 ? qs : null;
}

export function PermissionCard({
  msg,
  onRespond,
}: {
  msg: ChatMessage;
  onRespond: PermissionRespond;
}) {
  const questions = useMemo(() => asAskUserQuestion(msg), [msg]);
  const resolved = !!msg._resolved;
  const behavior = msg._behavior;
  const [open, setOpen] = useState(false);

  // 待审批 → 挂载即自动弹审批框（agent 此刻被阻塞，等用户决策）。
  useEffect(() => {
    if (!resolved) setOpen(true);
  }, [resolved]);

  const statusIcon = !resolved ? "⏳" : behavior === "allow" ? "✓" : "✗";
  const statusText = !resolved
    ? questions
      ? "等待回答…"
      : "等待审批…"
    : behavior === "allow"
      ? questions
        ? "已提交"
        : "已允许"
      : questions
        ? "已跳过"
        : "已拒绝";
  const tone = !resolved ? "neutral" : behavior === "allow" ? "allow" : "deny";

  return (
    <div
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
          {questions ? "用户问答" : "权限请求"}
        </span>
        {!questions && (
          <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[12px] text-muted">
            {msg.toolName || "unknown"}
          </code>
        )}
        <span className="ml-auto flex items-center gap-2 text-[12px] text-muted">
          <span aria-hidden>{statusIcon}</span>
          {statusText}
        </span>
      </div>

      {/* 待审批：内联快捷 + 打开审批框 */}
      {!resolved && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2">
          <Button size="sm" variant="accent" shape="pill" onClick={() => setOpen(true)}>
            {questions ? "回答" : "审批"}
          </Button>
          {!questions && (
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
      {resolved && !questions && msg.inputPreview && (
        <div className="border-t border-border px-3.5 py-2 text-[12px] text-muted break-all">
          {msg.inputPreview.slice(0, 200)}
        </div>
      )}
      {resolved && msg._settledReason && msg._settledReason !== "remote" && (
        <div className="border-t border-border px-3.5 py-1.5 text-[11px] text-faint">
          {settledReasonLabel(msg._settledReason)}
        </div>
      )}

      {/* 审批 modal */}
      {!resolved &&
        (questions ? (
          <AskUserQuestionModal
            open={open}
            onOpenChange={setOpen}
            requestId={msg.requestId!}
            questions={questions}
            inputJson={(msg.inputJson as AqInput) ?? { questions }}
            onRespond={onRespond}
          />
        ) : (
          <GenericPermissionModal
            open={open}
            onOpenChange={setOpen}
            requestId={msg.requestId!}
            toolName={msg.toolName || "unknown"}
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
  inputPreview,
  onRespond,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  requestId: string;
  toolName: string;
  inputPreview?: string;
  onRespond: PermissionRespond;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
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
      <div className="space-y-2">
        <code className="inline-block rounded bg-hover px-2 py-1 font-mono text-sm text-fg">
          {toolName}
        </code>
        {inputPreview && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 text-[12px] text-muted">
            {inputPreview}
          </pre>
        )}
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
              <div className="grid gap-1.5">
                {safeOptions.map((opt) => {
                  const sel = qs.selected.includes(opt.label);
                  return (
                    <button
                      type="button"
                      key={opt.label}
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
                  <button
                    type="button"
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
                  maxLength={2000}
                  value={qs.other}
                  autoFocus
                  onChange={(e) => setQ(q.question, { other: e.target.value })}
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
