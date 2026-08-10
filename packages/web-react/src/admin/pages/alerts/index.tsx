import { AlertTriangle, BookOpen, Check, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Tabs, useToast } from "../../../components/ui";
import { PageHeader, SectionCard, TimeAgo } from "../../components";
import { adminGet, adminSend } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { ChannelsTab } from "./ChannelsTab";
import { OutboxTab } from "./OutboxTab";
import { RulesCoverageTab } from "./RulesCoverageTab";
import { SilencesTab } from "./SilencesTab";
import { useReloadable } from "./useReloadable";
import type { EventMeta, RuleClassification, RuleStateRow } from "./types";
import { errText } from "./util";

const TAB_ITEMS = [
  { value: "channels", label: "通道" },
  { value: "outbox", label: "事件流" },
  { value: "rules", label: "规则与覆盖" },
  { value: "silences", label: "静默" },
];

/**
 * 告警中心 —— 四区(通道 / 事件流 / 规则与覆盖 / 静默)。
 *
 * 事件目录(EVENT_META)在页面级只拉一次,通道订阅多选、outbox/静默过滤下拉复用它;
 * 目录加载失败不致命(退化成空目录,订阅 UI 空,其它区照常)。各子区首载 + 手动刷新
 * (对齐旧 vanilla,无 30s 自动轮询)。
 */
export default function AlertsPage() {
  const meta = getAdminPage("alerts");
  const [tab, setTab] = useState("channels");
  const [silenceRule, setSilenceRule] = useState<string | null>(null);

  // 事件目录:非致命,失败回退空数组。
  const eventsQ = useReloadable<{ rows: EventMeta[] }>(() =>
    adminGet<{ rows: EventMeta[] }>("/alerts/events").catch(() => ({ rows: [] as EventMeta[] })),
  );
  const events = eventsQ.data?.rows ?? [];
  const ruleStatesQ = useReloadable<{ rows: RuleStateRow[] }>(
    () => adminGet("/alerts/rule-states"),
    [],
    { intervalMs: 15_000 },
  );

  const openSilence = (ruleId: string) => {
    setSilenceRule(ruleId);
    setTab("silences");
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <AlertActionQueue
        query={ruleStatesQ}
        onOpenRules={() => setTab("rules")}
        onSilence={openSilence}
      />
      <Tabs value={tab} onValueChange={setTab} items={TAB_ITEMS} aria-label="告警中心分区" />

      {tab === "channels" && <ChannelsTab events={events} />}
      {tab === "outbox" && <OutboxTab events={events} />}
      {tab === "rules" && <RulesCoverageTab ruleStatesQ={ruleStatesQ} />}
      {tab === "silences" && (
        <SilencesTab
          events={events}
          requestedRule={silenceRule}
          onRequestHandled={() => setSilenceRule(null)}
        />
      )}
    </div>
  );
}

function classificationOf(row: RuleStateRow): RuleClassification {
  return row.classification;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeRunbookHref(payload: Record<string, unknown>): string | null {
  const raw = payloadString(payload, "runbook_url") ?? payloadString(payload, "runbook");
  if (!raw) return null;
  return raw.startsWith("https://") || raw.startsWith("/") ? raw : null;
}

function incidentIdOf(payload: Record<string, unknown>): string | null {
  const value = payload.incident_id;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function AlertActionQueue({
  query,
  onOpenRules,
  onSilence,
}: {
  query: ReturnType<typeof useReloadable<{ rows: RuleStateRow[] }>>;
  onOpenRules: () => void;
  onSilence: (ruleId: string) => void;
}) {
  const toast = useToast();
  const rows = query.data?.rows ?? [];
  const counts = useMemo(() => {
    const initial: Record<RuleClassification, number> = { firing: 0, recovered: 0, stale: 0, healthy: 0 };
    for (const row of rows) initial[classificationOf(row)]++;
    return initial;
  }, [rows]);
  const firing = rows
    .filter((row) => classificationOf(row) === "firing")
    .sort((a, b) => Number(a.acked) - Number(b.acked));

  const ack = async (row: RuleStateRow) => {
    try {
      await adminSend("POST", `/alerts/rules/${encodeURIComponent(row.rule_id)}/ack`);
      toast("已确认", "success");
      query.reload();
    } catch (error) {
      toast(errText(error), "error");
      query.reload();
    }
  };

  return (
    <SectionCard
      title="当前行动队列"
      hint={`firing ${counts.firing} · recovered ${counts.recovered} · stale ${counts.stale}`}
      action={<Button variant="secondary" size="sm" onClick={onOpenRules}>查看全部规则</Button>}
    >
      {query.error ? (
        <div className="flex items-center gap-2 text-[13px] text-danger"><AlertTriangle size={15} />加载行动队列失败：{errText(query.error)}</div>
      ) : query.loading && !query.data ? (
        <div className="h-20 animate-pulse rounded-lg bg-hover" />
      ) : firing.length === 0 ? (
        <div className="flex items-center gap-2 text-[13px] text-muted"><Check size={15} className="text-success" />当前没有 firing 告警。</div>
      ) : (
        <ul className="divide-y divide-border">
          {firing.map((row) => {
            const runbook = safeRunbookHref(row.last_payload ?? {});
            const incidentId = incidentIdOf(row.last_payload ?? {});
            return (
              <li key={row.rule_id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={row.acked ? "warning" : "danger"}>{row.acked ? "ACKED" : "FIRING"}</Badge>
                    <span className="break-all font-mono text-[12.5px] text-fg">{row.rule_id}</span>
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                    <Clock3 size={12} />持续时间 {row.last_transition_at ? <TimeAgo value={row.last_transition_at} /> : "未知"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!row.acked && <Button variant="secondary" size="sm" onClick={() => void ack(row)}>确认</Button>}
                  <Button variant="secondary" size="sm" onClick={() => onSilence(row.rule_id)}>静默</Button>
                  {runbook && <a href={runbook} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium text-accent outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"><BookOpen size={13} />runbook</a>}
                  {incidentId && <a href={`#tab=selfheal&incident_id=${encodeURIComponent(incidentId)}`} className="inline-flex h-8 items-center rounded-md px-2.5 text-[12px] font-medium text-accent outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">事故 #{incidentId}</a>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
