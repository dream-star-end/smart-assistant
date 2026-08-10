import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Input, Modal, useConfirm, useToast } from "../../../components/ui";
import { type Column, DataTable, FilterBar, TimeAgo } from "../../components";
import { adminGet, adminSend } from "../../lib/adminApi";
import { SEVERITY_MIN_OPTIONS } from "./constants";
import { Field, NativeSelect } from "./formBits";
import { useReloadable } from "./useReloadable";
import type { EventMeta, Severity, SilenceRow } from "./types";
import { errText, toLocalDatetimeInput } from "./util";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function matcherSummary(m: SilenceRow["matcher"]): { text: string; empty: boolean } {
  const parts: string[] = [];
  if (m.event_type) parts.push(`event=${m.event_type}`);
  if (m.severity) parts.push(`severity=${m.severity}`);
  if (m.rule_id) parts.push(`rule=${m.rule_id}`);
  return { text: parts.join("  ·  "), empty: parts.length === 0 };
}

export function SilencesTab({
  events,
  requestedRule,
  onRequestHandled,
}: {
  events: EventMeta[];
  requestedRule?: string | null;
  onRequestHandled?: () => void;
}) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [creating, setCreating] = useState(() => !!requestedRule);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (requestedRule) setCreating(true);
  }, [requestedRule]);

  const { data, loading, error, reload } = useReloadable<{ rows: SilenceRow[] }>(() =>
    adminGet("/alerts/silences"),
  );
  const rows = data?.rows ?? [];

  const onDelete = async (s: SilenceRow) => {
    const ok = await confirm({
      title: `撤销静默 #${s.id}`,
      body: "被它压制的事件会立即恢复告警。",
      confirmText: "撤销",
      danger: true,
    });
    if (!ok) return;
    setDeleting((d) => new Set(d).add(s.id));
    try {
      await adminSend("DELETE", `/alerts/silences/${s.id}`);
      toast("已撤销", "success");
      reload();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setDeleting((d) => {
        const n = new Set(d);
        n.delete(s.id);
        return n;
      });
    }
  };

  const columns: Column<SilenceRow>[] = [
    {
      key: "active",
      title: "状态",
      width: 88,
      render: (s) =>
        s.active ? <Badge tone="warning">生效中</Badge> : <Badge tone="neutral">已结束</Badge>,
    },
    {
      key: "matcher",
      title: "匹配 matcher",
      render: (s) => {
        const m = matcherSummary(s.matcher);
        return m.empty ? (
          <Badge tone="danger">空 matcher</Badge>
        ) : (
          <span className="font-mono text-[12px]">{m.text}</span>
        );
      },
    },
    { key: "starts_at", title: "开始", width: 96, render: (s) => <TimeAgo value={s.starts_at} /> },
    {
      key: "ends_at",
      title: "结束 / 剩余",
      width: 110,
      render: (s) => <TimeAgo value={s.ends_at} />,
    },
    {
      key: "reason",
      title: "原因",
      render: (s) => (
        <span className="line-clamp-1 max-w-[260px]" title={s.reason}>
          {s.reason}
        </span>
      ),
    },
    {
      key: "created_by",
      title: "创建人",
      width: 80,
      render: (s) => <span className="font-mono text-[12px] text-faint">{s.created_by ?? "—"}</span>,
    },
    {
      key: "actions",
      title: "操作",
      width: 72,
      align: "right",
      render: (s) =>
        s.active ? (
          <Button variant="danger" size="sm" onClick={() => onDelete(s)} disabled={deleting.has(s.id)}>
            撤销
          </Button>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {confirmEl}
      <FilterBar className="justify-between">
        <p className="text-[13px] text-muted">matcher 三字段任选(AND 关系,命中则不发);窗口最长 7 天。</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} /> 刷新
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={15} /> 新建静默
          </Button>
        </div>
      </FilterBar>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
          加载静默失败: {errText(error)}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        loading={loading}
        emptyTitle="当前无静默"
        emptyHint="没有活跃的静默窗口,所有订阅事件正常告警。"
      />

      <CreateSilenceModal
        open={creating}
        onOpenChange={setCreating}
        events={events}
        onCreated={reload}
        initialRuleId={requestedRule ?? ""}
        onInitialRuleApplied={onRequestHandled}
      />
    </div>
  );
}

function CreateSilenceModal({
  open,
  onOpenChange,
  events,
  onCreated,
  initialRuleId,
  onInitialRuleApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: EventMeta[];
  onCreated: () => void;
  initialRuleId: string;
  onInitialRuleApplied?: () => void;
}) {
  const toast = useToast();
  const [eventType, setEventType] = useState("");
  const [severity, setSeverity] = useState("");
  const [ruleId, setRuleId] = useState(initialRuleId);
  const [endsAt, setEndsAt] = useState(() => toLocalDatetimeInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !initialRuleId) return;
    setRuleId(initialRuleId);
    onInitialRuleApplied?.();
  }, [initialRuleId, onInitialRuleApplied, open]);

  const reset = () => {
    setEventType("");
    setSeverity("");
    setRuleId("");
    setEndsAt(toLocalDatetimeInput(new Date(Date.now() + 60 * 60 * 1000)));
    setReason("");
  };

  const submit = async () => {
    const matcher: SilenceRow["matcher"] = {};
    if (eventType) matcher.event_type = eventType;
    if (severity) matcher.severity = severity as Severity;
    if (ruleId.trim()) matcher.rule_id = ruleId.trim();
    if (Object.keys(matcher).length === 0) return toast("至少填一个 matcher 字段", "error");
    if (!endsAt) return toast("结束时间必填", "error");
    const endsDate = new Date(endsAt);
    if (Number.isNaN(endsDate.getTime()) || endsDate.getTime() <= Date.now()) {
      return toast("结束时间必须晚于当前", "error");
    }
    if (endsDate.getTime() - Date.now() > SEVEN_DAYS_MS) return toast("窗口最长 7 天", "error");
    const r = reason.trim();
    if (!r) return toast("原因必填", "error");

    setSubmitting(true);
    try {
      await adminSend("POST", "/alerts/silences", {
        matcher,
        ends_at: endsDate.toISOString(),
        reason: r,
      });
      toast("已创建", "success");
      onCreated();
      onOpenChange(false);
      reset();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="新建静默"
      description="命中 matcher(AND)的事件在窗口内不发送。最长 7 天。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? "创建中…" : "创建"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="事件类型(可选)">
          <NativeSelect value={eventType} onChange={(e) => setEventType(e.target.value)}>
            <option value="">—</option>
            {events.map((e) => (
              <option key={e.event_type} value={e.event_type}>
                {e.event_type}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="严重度(可选)">
          <NativeSelect value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">—</option>
            {SEVERITY_MIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="rule_id(可选,用于静默 polled 规则)">
          <Input value={ruleId} maxLength={64} placeholder="如 account_pool.all_down" onChange={(e) => setRuleId(e.target.value)} />
        </Field>
        <Field label="结束时间">
          <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </Field>
        <Field label="原因(必填,1..200)">
          <Input value={reason} maxLength={200} placeholder="例如 周五例行演习" onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
