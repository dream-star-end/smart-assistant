/**
 * Swarm 交互式指挥台操控栏（OCV5-833 · Clarvy Atelier）。
 *
 * 位于 SwarmBoardDrawer 底部：
 *   - 支持选择目标 `@coordinator` / `@<member>` / `@all` 发送人工纠偏指令；
 *   - 支持对非 coordinator 存活成员发起二次确认的「请求终止」；
 *   - 对接 `POST /api/sessions/:id/swarm/command`，诚实清晰区分 `requested`、`confirmed` 与 `already_killed`。
 */
import type { SwarmMemberSnapshot } from "@openclaude/protocol/browser";
import { AlertTriangle, CheckCircle2, OctagonX, Send, ShieldAlert, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  type SwarmTerminateStatus,
  requestSwarmTerminate,
  sendSwarmSteer,
} from "../../lib/api/wave4Api";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, Spinner, useToast } from "../ui";

export type SwarmCommandBarProps = {
  sessionId?: string | null;
  auth: AuthSession | null;
  members: readonly SwarmMemberSnapshot[];
  selectedMember?: string | null;
  selectedChannel?: string | null;
  active: boolean;
};

type CommandFeedback =
  | { kind: "steer"; seq: number; target: string }
  | { kind: "terminate"; status: SwarmTerminateStatus; memberName: string; noticeSeq?: number }
  | { kind: "error"; message: string };

export function SwarmCommandBar({
  sessionId,
  auth,
  members,
  selectedMember,
  selectedChannel,
  active,
}: SwarmCommandBarProps) {
  const toast = useToast();

  const targetOptions = useMemo(() => {
    const out: Array<{ value: string; label: string; isCoordinator: boolean; killed: boolean }> = [];
    const seen = new Set<string>();
    const push = (value: string, label: string, isCoordinator: boolean, killed: boolean) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ value, label, isCoordinator, killed });
    };

    const coord = members.find((m) => m.role === "coordinator" || m.name.toLowerCase() === "coordinator");
    push(coord?.name ?? "coordinator", `@${coord?.name ?? "coordinator"} (协调者)`, true, false);
    for (const m of members) {
      if (m.status === "killed") continue;
      push(m.name, `@${m.name}`, m.role === "coordinator" || m.name.toLowerCase() === "coordinator", false);
    }
    push("all", "@all (全体广播)", true, false);
    return out;
  }, [members]);

  const [target, setTarget] = useState<string>("coordinator");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killReason, setKillReason] = useState("");
  const [killing, setKilling] = useState(false);
  const [feedback, setFeedback] = useState<CommandFeedback | null>(null);

  // 点击左侧花名册成员时自动联动操控栏目标
  useEffect(() => {
    if (!selectedMember) return;
    const hit = targetOptions.find((opt) => opt.value.toLowerCase() === selectedMember.toLowerCase());
    if (hit) {
      setTarget(hit.value);
      setConfirmKill(false);
    }
  }, [selectedMember, targetOptions]);

  const currentOpt = targetOptions.find((o) => o.value === target) ?? targetOptions[0];
  const canTerminateTarget = Boolean(
    currentOpt && !currentOpt.isCoordinator && currentOpt.value !== "all" && !currentOpt.killed,
  );
  const canDispatch = Boolean(auth && sessionId);

  const handleSendSteer = async () => {
    const trimmed = message.trim();
    if (!trimmed || sending || !canDispatch || !auth || !sessionId) return;
    setSending(true);
    setFeedback(null);
    try {
      const res = await sendSwarmSteer(auth, sessionId, {
        target,
        message: trimmed,
        channel: selectedChannel || "main",
      });
      setMessage("");
      setFeedback({ kind: "steer", seq: res.seq, target: res.target });
      toast(`已向 @${res.target} 注入人工纠偏指令（#${res.seq}）`, "success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "发送纠偏指令失败，请稍后重试";
      setFeedback({ kind: "error", message: msg });
      toast(msg, "error");
    } finally {
      setSending(false);
    }
  };

  const handleConfirmTerminate = async () => {
    if (!canTerminateTarget || killing || !canDispatch || !auth || !sessionId) return;
    setKilling(true);
    setFeedback(null);
    try {
      const res = await requestSwarmTerminate(auth, sessionId, {
        memberName: target,
        reason: killReason.trim() || undefined,
      });
      setConfirmKill(false);
      setKillReason("");
      setFeedback({
        kind: "terminate",
        status: res.status,
        memberName: res.memberName,
        noticeSeq: res.noticeSeq,
      });
      if (res.status === "confirmed") {
        toast(`执行器已确认终止 @${res.memberName}`, "success");
      } else if (res.status === "already_killed") {
        toast(`@${res.memberName} 已处于终止状态`, "info");
      } else {
        toast(`已向 @coordinator 提交终止 @${res.memberName} 的控制请求（待确认）`, "info");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "提交终止请求失败";
      setFeedback({ kind: "error", message: msg });
      toast(msg, "error");
    } finally {
      setKilling(false);
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSendSteer();
    }
  };

  return (
    <div
      className="border-t border-border bg-surface px-3.5 py-2.5"
      data-testid="swarm-command-bar"
    >
      {/* 状态反馈条（清晰区分 steer / requested / confirmed / already_killed / error） */}
      {feedback && (
        <div className="mb-2" data-testid="swarm-command-feedback">
          {feedback.kind === "error" ? (
            <Alert tone="danger">{feedback.message}</Alert>
          ) : feedback.kind === "steer" ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-caption text-fg">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 size={13} className="shrink-0 text-success" aria-hidden />
                已向 <strong className="font-mono">@{feedback.target}</strong> 注入纠偏指令（#{feedback.seq}）
              </span>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => setFeedback(null)}
                className="text-faint hover:text-fg"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <div
              data-terminate-status={feedback.status}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-caption text-fg"
            >
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {feedback.status === "confirmed" ? (
                  <>
                    <Badge tone="success" size="sm">已确认终止</Badge>
                    <span>权威执行器已确认停止 @{feedback.memberName}</span>
                  </>
                ) : feedback.status === "already_killed" ? (
                  <>
                    <Badge tone="neutral" size="sm">已终止</Badge>
                    <span>@{feedback.memberName} 此前已完成回收</span>
                  </>
                ) : (
                  <>
                    <Badge tone="warning" size="sm">已提交请求</Badge>
                    <span>
                      已向 @coordinator 发送终止 @{feedback.memberName} 请求
                      {feedback.noticeSeq ? `（#${feedback.noticeSeq}）` : ""}，等待执行器确认回收
                    </span>
                  </>
                )}
              </span>
              <button
                type="button"
                aria-label="关闭状态反馈"
                onClick={() => setFeedback(null)}
                className="text-faint hover:text-fg"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* 二次确认单点终止条 */}
      {confirmKill && canTerminateTarget && (
        <div
          data-testid="swarm-terminate-confirm"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-warning-soft px-3 py-2"
        >
          <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-warning">
            <ShieldAlert size={13} aria-hidden />
            确认请求终止 @{target}？
          </span>
          <input
            type="text"
            value={killReason}
            onChange={(e) => setKillReason(e.target.value)}
            placeholder="可选：填写终止原因（将发送给 @coordinator）"
            aria-label="终止原因"
            data-testid="swarm-terminate-reason"
            className="oc-field-control h-8 min-w-0 flex-1 rounded-lg border border-border-control bg-surface px-2.5 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:text-sm"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={killing}
              onClick={() => {
                setConfirmKill(false);
                setKillReason("");
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={killing || !canDispatch}
              data-testid="swarm-terminate-confirm-btn"
              onClick={() => void handleConfirmTerminate()}
            >
              {killing ? <Spinner size={11} /> : <OctagonX size={12} aria-hidden />}
              确认请求终止
            </Button>
          </div>
        </div>
      )}

      {/* 主操控输入行 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="选择纠偏目标成员"
          data-testid="swarm-command-target"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setConfirmKill(false);
          }}
          className="oc-field-control h-9 max-w-40 shrink-0 rounded-lg border border-border-control bg-surface px-2 text-base font-medium text-fg outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:text-sm"
        >
          {targetOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onInputKeyDown}
          disabled={!canDispatch || sending}
          aria-label="人工纠偏指令内容"
          data-testid="swarm-command-input"
          placeholder={
            canDispatch
              ? active
                ? `向 @${target} 发送人工纠偏指令…`
                : `向 @${target} 补充指令（当前蜂群未运行）`
              : "仅在在线登录会话中支持实时下发蜂群控制指令"
          }
          className="oc-field-control h-9 min-w-0 flex-1 rounded-lg border border-border-control bg-surface px-3 text-base text-fg outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:h-8 md:text-sm"
        />

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={!canDispatch || !message.trim() || sending}
            data-testid="swarm-command-send"
            onClick={() => void handleSendSteer()}
            className="h-9 md:h-8"
          >
            {sending ? <Spinner size={12} /> : <Send size={12} aria-hidden />}
            发送指令
          </Button>

          {canTerminateTarget && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!canDispatch || killing}
              data-testid="swarm-terminate-trigger"
              onClick={() => setConfirmKill((v) => !v)}
              title={`向 @coordinator 请求单点终止 @${target}`}
              className={cn("h-9 text-danger md:h-8", confirmKill && "ring-2 ring-ring")}
            >
              <AlertTriangle size={12} aria-hidden />
              请求终止
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default SwarmCommandBar;
