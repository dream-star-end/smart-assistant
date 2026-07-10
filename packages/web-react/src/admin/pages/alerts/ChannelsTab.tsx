import {
  Bot,
  MessageSquare,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Badge, Button, EmptyState, Switch, useConfirm, useToast } from "../../../components/ui";
import { SectionCard, TimeAgo } from "../../components";
import { ApiError, adminGet, adminSend } from "../../lib/adminApi";
import { CreateChannelWizard, EditChannelModal } from "./channelModals";
import { CHANNEL_TYPE_LABEL, SEVERITY_TONE, activationBadge, friendlyTestError } from "./constants";
import { useReloadable } from "./useReloadable";
import type { AlertChannel, ChannelType, EventMeta } from "./types";
import { errText } from "./util";

const TYPE_ICON: Record<ChannelType, LucideIcon> = {
  ilink_wechat: QrCode,
  telegram: Send,
  wecom_bot: MessageSquare,
  wecom_aibot: Bot,
};

export function ChannelsTab({ events }: { events: EventMeta[] }) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const { data, loading, error, reload } = useReloadable<{ rows: AlertChannel[] }>(() =>
    adminGet("/alerts/channels"),
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<AlertChannel | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const rows = data?.rows ?? [];

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy((s) => new Set(s).add(id));
    try {
      await fn();
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const onToggle = (c: AlertChannel, next: boolean) =>
    withBusy(c.id, async () => {
      try {
        await adminSend("PATCH", `/alerts/channels/${c.id}`, { enabled: next });
        toast(`通道已${next ? "启用" : "停用"}`, "success");
        reload();
      } catch (e) {
        toast(errText(e), "error");
      }
    });

  const onTest = (c: AlertChannel) =>
    withBusy(c.id, async () => {
      try {
        await adminSend("POST", `/alerts/channels/${c.id}/test`, {});
        toast("测试已入队,数秒后检查目标通道 / 事件流", "success");
      } catch (e) {
        const friendly = e instanceof ApiError ? friendlyTestError(e) : null;
        toast(friendly || errText(e), "error");
      }
    });

  const onRebind = (c: AlertChannel) =>
    withBusy(c.id, async () => {
      try {
        const r = await adminSend<{ outcome?: string; next_step?: string }>(
          "POST",
          `/alerts/channels/${c.id}/rebind`,
          {},
        );
        if (r?.outcome === "reactivated") {
          toast(r.next_step || "通道已重置为 pending,请用微信给机器人发一条消息触发激活", "success");
        } else if (r?.outcome === "already_active") {
          toast("通道已是 active,无需重新激活", "info");
        } else if (r?.outcome === "already_pending") {
          toast("通道已是 pending,worker 将在下轮 tick 尝试 long-poll", "info");
        } else {
          toast("重新激活请求已处理", "info");
        }
        reload();
      } catch (e) {
        toast(errText(e), "error");
      }
    });

  const onDelete = async (c: AlertChannel) => {
    const ok = await confirm({
      title: `删除告警通道 #${c.id}`,
      body: `确认删除「${c.label}」?此操作会立刻停止发送;历史投递记录会保留。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await withBusy(c.id, async () => {
      try {
        await adminSend("DELETE", `/alerts/channels/${c.id}`);
        toast("已删除", "success");
        reload();
      } catch (e) {
        toast(errText(e), "error");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {confirmEl}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-muted">
          微信 iLink / Telegram / 企业微信群机器人 / 企业微信智能机器人 —— 只发给绑定了的超管。
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} /> 刷新
          </Button>
          <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>
            <Plus size={15} /> 新建通道
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
          加载通道失败: {errText(error)}
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <SectionCard title="暂无通道">
          <EmptyState
            icon={QrCode}
            title="还没有告警通道"
            hint="点右上「新建通道」绑定微信 / Telegram / 企业微信,开始接收系统告警。"
            action={
              <Button variant="primary" size="sm" onClick={() => setWizardOpen(true)}>
                <Plus size={15} /> 新建通道
              </Button>
            }
          />
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(loading && rows.length === 0 ? Array.from({ length: 2 }) : rows).map((row, i) => {
          const c = row as AlertChannel | undefined;
          if (!c) {
            return (
              <div key={`sk-${i}`} className="h-40 animate-pulse rounded-xl border border-border bg-surface" />
            );
          }
          return (
            <ChannelCard
              key={c.id}
              channel={c}
              busy={busy.has(c.id)}
              onToggle={(v) => onToggle(c, v)}
              onTest={() => onTest(c)}
              onEdit={() => setEditing(c)}
              onRebind={() => onRebind(c)}
              onDelete={() => onDelete(c)}
            />
          );
        })}
      </div>

      <CreateChannelWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        events={events}
        onCreated={reload}
      />
      <EditChannelModal
        channel={editing}
        events={events}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={reload}
      />
    </div>
  );
}

function ChannelCard({
  channel: c,
  busy,
  onToggle,
  onTest,
  onEdit,
  onRebind,
  onDelete,
}: {
  channel: AlertChannel;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onRebind: () => void;
  onDelete: () => void;
}) {
  const Icon = TYPE_ICON[c.channel_type];
  const act = activationBadge(c);
  const subCount = c.event_types.length;
  const showRebind = c.activation_status === "error" && c.channel_type === "ilink_wechat";
  const aibotUnbound = c.channel_type === "wecom_aibot" && !c.aibot_bound;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover text-muted">
            <Icon size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-medium text-fg" title={c.label}>
                {c.label}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint">#{c.id}</span>
            </div>
            <span className="text-[12px] text-faint">{CHANNEL_TYPE_LABEL[c.channel_type]}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11.5px] text-faint">{c.enabled ? "启用" : "停用"}</span>
          <Switch checked={c.enabled} disabled={busy} onCheckedChange={onToggle} aria-label="启用/停用" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={act.tone} title={act.title}>
          {act.text}
        </Badge>
        <Badge tone={SEVERITY_TONE[c.severity_min]}>≥ {c.severity_min}</Badge>
        <Badge tone={subCount === 0 ? "success" : "neutral"}>
          {subCount === 0 ? "订阅全部" : `订阅 ${subCount} 种`}
        </Badge>
      </div>

      {aibotUnbound && act.tone !== "danger" && (
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-[12px] text-warning">
          尚未绑定推送会话 —— 请在企业微信里<strong>给该机器人发一条消息</strong>完成绑定。
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-[12px] text-faint">
        <span>
          最近发送:{c.last_send_at ? <TimeAgo value={c.last_send_at} /> : "—"}
        </span>
      </div>
      {c.last_error && (
        <p className="truncate text-[12px] text-danger" title={c.last_error}>
          最近错误:{c.last_error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
        <Button variant="secondary" size="sm" onClick={onTest} disabled={busy}>
          测试送达
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
          编辑
        </Button>
        {showRebind && (
          <Button variant="secondary" size="sm" onClick={onRebind} disabled={busy} title="把 error 推回 pending,worker 重新 long-poll(不重新扫码)">
            重新激活
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={onDelete} disabled={busy} className="ml-auto">
          删除
        </Button>
      </div>
    </div>
  );
}
