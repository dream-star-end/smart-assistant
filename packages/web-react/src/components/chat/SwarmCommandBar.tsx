/**
 * Swarm 交互式指挥台操控栏（OCV5-833 · Clarvy Atelier）。
 *
 * 位于 SwarmBoardDrawer 底部：
 *   - 活跃态（`active === true`）：支持选择 `@coordinator` / `@<member>` / `@all` 发送协作指令
 *     （成功后触发轻量乐观回显 + Toast），支持对非 coordinator 存活成员发起二次确认「停止该成员」；
 *   - 终态（`active === false`）：收敛为只读归档条并提供「引用到主输入框继续追问」快捷动作，
 *     严禁渲染可发送指令框或红色停止按钮。
 */
import type { SwarmBoardPost, SwarmMemberSnapshot } from "@openclaude/protocol/browser";
import { AlertTriangle, Check, ChevronDown, Lock, OctagonX, Quote, Send, ShieldAlert } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import {
  type SwarmSteerSuccess,
  type SwarmTerminateSuccess,
  requestSwarmTerminate,
  sendSwarmSteer,
} from "../../lib/api/wave4Api";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  type ToastTone,
  useToast,
} from "../ui";

export function formatSwarmSteerToast(res: SwarmSteerSuccess): { message: string; tone: ToastTone } {
  if (res.wakeDelivery === "board_only_unwoken") {
    return {
      message: `已写入讨论板（#${res.seq}），未即时唤醒目标成员（将在其下次读板时可见）`,
      tone: "info",
    };
  }
  return {
    message: `已向 @${res.target} 发送指令（#${res.seq}）`,
    tone: "success",
  };
}

export function formatSwarmTerminateToast(res: SwarmTerminateSuccess): { message: string; tone: ToastTone } {
  if (res.status === "confirmed") {
    return { message: `已停止 @${res.memberName}`, tone: "success" };
  }
  if (res.status === "already_killed") {
    return { message: `@${res.memberName} 已停止`, tone: "info" };
  }
  if (res.wakeDelivery === "board_only_unwoken") {
    const seqSuffix = typeof res.noticeSeq === "number" ? `（#${res.noticeSeq}）` : "";
    return {
      message: `已写入停止 @${res.memberName} 请求${seqSuffix}，未即时唤醒协调者（将在其下次读板时可见）`,
      tone: "info",
    };
  }
  return { message: `已请求停止 @${res.memberName}`, tone: "info" };
}

export type SwarmCommandBarProps = {
  sessionId?: string | null;
  auth: AuthSession | null;
  members: readonly SwarmMemberSnapshot[];
  selectedMember?: string | null;
  selectedChannel?: string | null;
  active: boolean;
  onFollowUpToComposer?: () => void;
  onOptimisticSteer?: (post: SwarmBoardPost) => void;
};

export function SwarmCommandBar({
  sessionId,
  auth,
  members,
  selectedMember,
  selectedChannel,
  active,
  onFollowUpToComposer,
  onOptimisticSteer,
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

  // 点击左侧花名册成员时自动联动操控栏目标
  useEffect(() => {
    if (!selectedMember) return;
    const hit = targetOptions.find((opt) => opt.value.toLowerCase() === selectedMember.toLowerCase());
    if (hit) {
      setTarget(hit.value);
      setConfirmKill(false);
    }
  }, [selectedMember, targetOptions]);

  // 蜂群转入终态时立即收起任何未完成的停止确认态
  useEffect(() => {
    if (!active && confirmKill) {
      setConfirmKill(false);
      setKillReason("");
    }
  }, [active, confirmKill]);

  // 终态收敛为只读归档提示条，严禁渲染发送框或危险停止按钮
  if (!active) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface/80 px-3.5 py-2.5"
        data-testid="swarm-command-bar"
        data-swarm-readonly="true"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 text-caption text-muted">
          <Lock size={12} aria-hidden className="shrink-0 text-faint" />
          <span className="truncate">本次蜂群协作已结束，讨论板为只读归档</span>
        </span>
        {onFollowUpToComposer && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="swarm-readonly-followup-btn"
            onClick={onFollowUpToComposer}
            className="oc-spring-press min-h-11 shrink-0 sm:min-h-8"
          >
            <Quote size={12} aria-hidden />
            引用到主输入框继续追问
          </Button>
        )}
      </div>
    );
  }

  const currentOpt = targetOptions.find((o) => o.value === target) ?? targetOptions[0];
  const canTerminateTarget = Boolean(
    currentOpt && !currentOpt.isCoordinator && currentOpt.value !== "all" && !currentOpt.killed,
  );
  const canDispatch = Boolean(auth && sessionId);

  const handleSendSteer = async () => {
    const trimmed = message.trim();
    if (!trimmed || sending || !canDispatch || !auth || !sessionId) return;
    setSending(true);
    try {
      const res = await sendSwarmSteer(auth, sessionId, {
        target,
        message: trimmed,
        channel: selectedChannel || "main",
      });
      setMessage("");
      onOptimisticSteer?.({
        seq: res.seq,
        agent: res.agent || "user",
        text: res.text || `[steer] @${res.target} ${trimmed}`,
        channel: res.channel || selectedChannel || "main",
        time: res.time || new Date().toISOString(),
        mentions: res.mentions?.length ? res.mentions : [res.target],
      });
      const feedback = formatSwarmSteerToast(res);
      toast(feedback.message, feedback.tone);
    } catch (err: unknown) {
      toast(apiErrorMessage(err, "发送指令失败，请稍后重试"), "error");
    } finally {
      setSending(false);
    }
  };

  const handleConfirmTerminate = async () => {
    if (!canTerminateTarget || killing || !canDispatch || !auth || !sessionId) return;
    setKilling(true);
    try {
      const res = await requestSwarmTerminate(auth, sessionId, {
        memberName: target,
        reason: killReason.trim() || undefined,
      });
      setConfirmKill(false);
      setKillReason("");
      const feedback = formatSwarmTerminateToast(res);
      toast(feedback.message, feedback.tone);
    } catch (err: unknown) {
      toast(apiErrorMessage(err, "停止成员失败，请稍后重试"), "error");
    } finally {
      setKilling(false);
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void handleSendSteer();
    }
  };

  return (
    <div
      className="border-t border-border bg-surface px-3.5 py-2.5"
      data-testid="swarm-command-bar"
    >
      {/* 二次确认停止成员 */}
      {confirmKill && canTerminateTarget && (
        <div
          data-testid="swarm-terminate-confirm"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-warning-soft px-3 py-2"
        >
          <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-warning">
            <ShieldAlert size={13} aria-hidden />
            确认停止 @{target}？
          </span>
          <input
            type="text"
            value={killReason}
            onChange={(e) => setKillReason(e.target.value)}
            placeholder="可选：填写停止原因"
            aria-label="停止原因"
            data-testid="swarm-terminate-reason"
            className="oc-field-control h-9 min-w-0 flex-1 rounded-lg border border-border-control bg-surface px-2.5 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:h-8 md:text-sm"
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
              className="min-h-11 sm:min-h-8"
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
              className="min-h-11 sm:min-h-8"
            >
              {killing ? <Spinner size={11} /> : <OctagonX size={12} aria-hidden />}
              确认停止
            </Button>
          </div>
        </div>
      )}

      {/* 主操控输入行：768px 窄屏自然换行，lg+ 单行排布 */}
      <div className="flex flex-wrap items-center gap-1.5 lg:flex-nowrap lg:gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="选择发送目标"
              data-testid="swarm-command-target"
              data-target-value={currentOpt?.value ?? target}
              className="oc-btn-tactile oc-btn-secondary-craft oc-spring-press inline-flex min-h-11 min-w-11 max-w-[11rem] shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-caption font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:min-w-0 md:h-8"
            >
              <span className="truncate font-mono">@{currentOpt?.value ?? target}</span>
              <ChevronDown size={12} strokeWidth={1.85} aria-hidden className="shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="max-h-[min(45dvh,16rem)] min-w-[12.5rem] overflow-y-auto">
            {targetOptions.map((opt) => {
              const selected = opt.value === target;
              return (
                <DropdownMenuItem
                  key={opt.value}
                  data-testid={`swarm-command-target-option-${opt.value}`}
                  onSelect={() => {
                    setTarget(opt.value);
                    setConfirmKill(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-meta">{opt.label}</span>
                  {selected && <Check size={13} strokeWidth={2.25} aria-hidden className="shrink-0 text-accent" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onInputKeyDown}
          disabled={!canDispatch || sending}
          aria-label="指令内容"
          data-testid="swarm-command-input"
          placeholder={
            canDispatch ? `向 @${target} 发送消息或指令…` : "仅在在线会话中支持发送指令"
          }
          className="oc-field-control min-h-11 min-w-[9rem] flex-1 rounded-lg border border-border-control bg-surface px-3 text-base text-fg outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-h-9 md:h-8 md:text-sm"
        />

        <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:ml-0">
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={!canDispatch || !message.trim() || sending}
            data-testid="swarm-command-send"
            onClick={() => void handleSendSteer()}
            className="oc-spring-press min-h-11 min-w-11 sm:min-h-9 sm:min-w-0 md:h-8"
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
              title={`停止 @${target}`}
              className={cn(
                "oc-spring-press min-h-11 min-w-11 text-danger sm:min-h-9 sm:min-w-0 md:h-8",
                confirmKill && "ring-2 ring-ring",
              )}
            >
              <AlertTriangle size={12} aria-hidden />
              停止该成员
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default SwarmCommandBar;
