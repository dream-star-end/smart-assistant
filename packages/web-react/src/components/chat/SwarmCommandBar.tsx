/**
 * Swarm 交互式指挥台操控栏（OCV5-833 · Clarvy Atelier）。
 *
 * 位于 SwarmBoardDrawer 底部：
 *   - 支持选择目标 `@coordinator` / `@<member>` / `@all` 发送协作消息或指令；
 *   - 支持对非 coordinator 存活成员发起二次确认的「停止该成员」；
 *   - 操作结果统一由 Toast 轻反馈，不重复占位内联反馈条。
 */
import type { SwarmMemberSnapshot } from "@openclaude/protocol/browser";
import { AlertTriangle, Check, ChevronDown, OctagonX, Send, ShieldAlert } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import { requestSwarmTerminate, sendSwarmSteer } from "../../lib/api/wave4Api";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  useToast,
} from "../ui";

export type SwarmCommandBarProps = {
  sessionId?: string | null;
  auth: AuthSession | null;
  members: readonly SwarmMemberSnapshot[];
  selectedMember?: string | null;
  selectedChannel?: string | null;
  active: boolean;
};

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
    try {
      const res = await sendSwarmSteer(auth, sessionId, {
        target,
        message: trimmed,
        channel: selectedChannel || "main",
      });
      setMessage("");
      toast(`已向 @${res.target} 发送指令（#${res.seq}）`, "success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "发送指令失败，请稍后重试";
      toast(msg, "error");
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
      if (res.status === "confirmed") {
        toast(`已停止 @${res.memberName}`, "success");
      } else if (res.status === "already_killed") {
        toast(`@${res.memberName} 已停止`, "info");
      } else {
        toast(`已请求停止 @${res.memberName}`, "info");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "停止成员失败，请稍后重试";
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
              确认停止
            </Button>
          </div>
        </div>
      )}

      {/* 主操控输入行：紧凑流式布局 + DropdownMenu 精致成员选择胶囊 */}
      <div className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap sm:gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="选择发送目标"
              data-testid="swarm-command-target"
              data-target-value={currentOpt?.value ?? target}
              className="oc-btn-tactile oc-btn-secondary-craft oc-spring-press inline-flex h-9 max-w-[11rem] shrink-0 items-center gap-1 rounded-full px-2.5 text-caption font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-10 md:h-8"
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
            canDispatch
              ? active
                ? `向 @${target} 发送消息或指令…`
                : `向 @${target} 补充说明（当前协作已结束）`
              : "仅在在线会话中支持发送指令"
          }
          className="oc-field-control h-9 min-w-[9rem] flex-1 rounded-lg border border-border-control bg-surface px-3 text-base text-fg outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:h-8 md:text-sm"
        />

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:ml-0">
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={!canDispatch || !message.trim() || sending}
            data-testid="swarm-command-send"
            onClick={() => void handleSendSteer()}
            className="oc-spring-press h-9 md:h-8"
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
              className={cn("oc-spring-press h-9 text-danger md:h-8", confirmKill && "ring-2 ring-ring")}
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
