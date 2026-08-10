import { Code2, Eye, MessageSquare, Trash2, TriangleAlert, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import {
  Badge,
  Button,
  IconButton,
  Input,
  Modal,
  Tabs,
  useConfirm,
  useToast,
} from "../../../components/ui";
import {
  type Column,
  DataTable,
  KeyValue,
  Pagination,
  SectionCard,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
} from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import {
  EMAIL_STATUS_META,
  INBOX_LEVEL_LABELS,
  INBOX_LEVEL_TONE,
  type InboxCategory,
  type InboxMessage,
  type MessageStatsBreakdown,
  type MessageStatsResp,
  type MessagesResp,
} from "./types";

const PAGE_SIZE = 50;
const CATEGORY_LABEL: Record<InboxCategory, string> = {
  user: "用户沟通",
  automation: "自动化",
  billing: "计费",
  operations: "运维",
  marketing: "营销",
};

function rate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** 邮件状态徽章：未开启邮件推送显 "—"，否则 status + sent/total（tooltip 展开明细）。 */
function EmailChip({ m }: { m: InboxMessage }) {
  if (!m.notify_email) return <span className="text-faint">—</span>;
  const s = m.email_summary ?? { total: 0, sent: 0, failed: 0, interrupted: 0, dropped: 0 };
  const meta = EMAIL_STATUS_META[m.email_send_status ?? "queued"] ?? {
    label: m.email_send_status ?? "queued",
    tone: "neutral" as const,
  };
  const tip = [
    `total=${s.total}`,
    `sent=${s.sent}`,
    s.failed > 0 ? `failed=${s.failed}` : null,
    s.interrupted > 0 ? `interrupted=${s.interrupted}` : null,
    s.dropped > 0 ? `dropped=${s.dropped}` : null,
  ]
    .filter(Boolean)
    .join(" / ");
  return (
    <Badge tone={meta.tone} title={tip}>
      {meta.label} {s.sent}/{s.total}
    </Badge>
  );
}

function AudienceBadge({ m }: { m: InboxMessage }) {
  return m.audience === "all" ? (
    <Badge tone="neutral">全员</Badge>
  ) : (
    <Badge tone="info">单发 #{m.user_id ?? ""}</Badge>
  );
}

/** 历史消息表：受众/级别/时间/触达 + 查看详情（Modal 看 Markdown 源码）+ 删除（硬删，二次确认）。 */
export function HistoryTable({ reloadKey }: { reloadKey: number }) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [data, setData] = useState<MessagesResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<InboxMessage | null>(null);
  const [detailMode, setDetailMode] = useState<"preview" | "source">("preview");
  const [category, setCategory] = useState<InboxCategory | "">("");
  const [sourceType, setSourceType] = useState("");
  const [stats, setStats] = useState<MessageStatsResp | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<Error | null>(null);

  const openDetail = (message: InboxMessage) => {
    setDetail(message);
    setDetailMode("preview");
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await adminGet<MessagesResp>("/messages", {
        limit: PAGE_SIZE,
        offset,
        category: category || undefined,
        source_type: sourceType || undefined,
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [offset, category, sourceType]);

  // offset / 外部 reloadKey（发送后）变化即重拉。
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    let alive = true;
    setStatsLoading(true);
    setStatsError(null);
    adminGet<MessageStatsResp>("/messages/stats", { days: 30 })
      .then((value) => { if (alive) setStats(value); })
      .catch((reason) => { if (alive) setStatsError(reason instanceof Error ? reason : new Error(String(reason))); })
      .finally(() => { if (alive) setStatsLoading(false); });
    return () => { alive = false; };
  }, [reloadKey]);

  const del = async (m: InboxMessage) => {
    const ok = await confirm({
      title: `删除站内信 #${m.id}？`,
      body: "所有用户的已读记录会一起清除；此操作不可恢复。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await adminSend("DELETE", `/messages/${encodeURIComponent(String(m.id))}`);
      toast(`已删除 #${m.id}`, "success");
      void load();
    } catch (e) {
      toast(apiErrorMessage(e, "删除失败"), "error");
    }
  };

  const columns: Column<InboxMessage>[] = [
    {
      key: "created_at",
      title: "时间",
      width: 96,
      render: (m) => <TimeAgo value={m.created_at} className="text-[12px] text-muted" />,
    },
    { key: "audience", title: "受众", width: 110, render: (m) => <AudienceBadge m={m} /> },
    {
      key: "level",
      title: "级别",
      width: 80,
      render: (m) => <Badge tone={INBOX_LEVEL_TONE[m.level]}>{INBOX_LEVEL_LABELS[m.level] ?? m.level}</Badge>,
    },
    {
      key: "category",
      title: "分类",
      width: 88,
      render: (m) => <Badge tone="neutral">{CATEGORY_LABEL[m.category]}</Badge>,
    },
    {
      key: "title",
      title: "标题",
      render: (m) => (
        <span className="line-clamp-1 max-w-[20rem] text-fg" title={m.title}>
          {m.title}
        </span>
      ),
    },
    {
      key: "expires_at",
      title: "过期",
      width: 96,
      render: (m) =>
        m.expires_at ? (
          <TimeAgo value={m.expires_at} className="text-[12px] text-muted" />
        ) : (
          <span className="text-faint">永不</span>
        ),
    },
    {
      key: "read",
      title: "站内已读",
      width: 110,
      align: "right",
      cellClassName: "tabular-nums text-muted",
      render: (m) => m.audience_snapshot_status === "captured"
        ? `${m.read_count} / ${m.recipients}`
        : <span className="text-faint">— · 历史无快照</span>,
    },
    {
      key: "snapshot",
      title: "受众快照",
      width: 100,
      render: (m) => m.audience_snapshot_status === "captured"
        ? <Badge tone="success">已固化</Badge>
        : <Badge tone="neutral">历史不可用</Badge>,
    },
    { key: "email", title: "邮件", width: 120, render: (m) => <EmailChip m={m} /> },
    {
      key: "actions",
      title: "操作",
      width: 96,
      align: "right",
      render: (m) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => openDetail(m)}>
            查看
          </Button>
          <IconButton size="sm" aria-label="删除" onClick={() => del(m)} className="text-danger">
            <Trash2 size={15} />
          </IconButton>
        </div>
      ),
    },
  ];

  const rows = data?.messages ?? [];
  const total = data?.total ?? 0;

  const breakdownColumns: Column<MessageStatsBreakdown>[] = [
    { key: "name", title: "来源 / 分类", render: (row) => <span className="font-mono text-[12px]">{row.source_type ?? (row.category ? CATEGORY_LABEL[row.category] : "未知")}</span> },
    { key: "messages", title: "消息", align: "right" },
    { key: "recipients", title: "收件", align: "right" },
    { key: "reads", title: "已读", align: "right" },
    { key: "read_rate", title: "已读率", align: "right", render: (row) => rate(row.read_rate) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title="30 天触达效果" hint="仅使用发送时不可变受众快照；历史缺失不猜测">
        {statsError ? (
          <p className="text-[13px] text-danger">加载失败：{apiErrorMessage(statsError, "统计加载失败")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <StatCardRow>
              <StatCard label="消息" value={stats?.read_funnel.messages ?? 0} icon={MessageSquare} tone="neutral" loading={statsLoading} />
              <StatCard label="发送收件" value={stats?.read_funnel.recipients ?? 0} icon={Users} tone="info" loading={statsLoading} />
              <StatCard label="已读" value={stats?.read_funnel.reads ?? 0} icon={Eye} tone="success" hint={rate(stats?.read_funnel.read_rate ?? null)} loading={statsLoading} />
              <StatCard label="后续行动" value="不可用" icon={TriangleAlert} tone="neutral" hint="尚无可靠 action 归因，不伪造转化" loading={statsLoading} />
            </StatCardRow>
            {stats && stats.snapshot_coverage.legacy_unavailable_messages > 0 && (
              <p className="text-[12px] text-faint">
                快照覆盖：{stats.snapshot_coverage.captured_messages} 条已固化；{stats.snapshot_coverage.legacy_unavailable_messages} 条历史消息不可计算收件/已读率。
              </p>
            )}
            {stats && (stats.recipient_load.over_20 > 0 || stats.recipient_load.over_100 > 0) && (
              <div className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] text-fg">
                高负荷提示：{stats.recipient_load.over_20} 位用户近30天收到超过20条，{stats.recipient_load.over_100} 位超过100条；p50 {stats.recipient_load.p50}、p90 {stats.recipient_load.p90}、最高 {stats.recipient_load.max}。仅透明提示，不自动硬频控。
              </div>
            )}
            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-2 text-[12px] font-semibold text-fg">按来源</p>
                <DataTable columns={breakdownColumns} rows={stats?.by_source ?? []} rowKey={(row) => `source:${row.source_type}`} loading={statsLoading} emptyTitle="暂无来源统计" />
              </div>
              <div className="min-w-0">
                <p className="mb-2 text-[12px] font-semibold text-fg">按分类</p>
                <DataTable columns={breakdownColumns} rows={stats?.by_category ?? []} rowKey={(row) => `category:${row.category}`} loading={statsLoading} emptyTitle="暂无分类统计" />
              </div>
            </div>
          </div>
        )}
      </SectionCard>
      <SectionCard
      title="历史消息"
      hint={loading ? "加载中…" : `共 ${total} 条`}
      bodyClassName="px-0 py-0"
    >
      {confirmEl}
      <div className="flex flex-wrap gap-3 border-b border-border px-4 py-3">
        <SelectFilter label="分类" value={category} options={[{ label: "全部分类", value: "" }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value: value as InboxCategory, label }))]} onChange={(value) => { setOffset(0); setCategory(value as InboxCategory | ""); }} />
        <Input
          aria-label="按消息来源筛选"
          value={sourceType}
          onChange={(event) => { setOffset(0); setSourceType(event.target.value); }}
          placeholder="来源，如 cron_delivery"
          className="w-full sm:w-56"
        />
      </div>
      {error ? (
        <div className="px-5 py-4">
          <p className="text-[13px] text-danger">加载失败：{apiErrorMessage(error, "加载失败")}</p>
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(m) => String(m.id)}
            loading={loading}
            className="rounded-none border-0"
            emptyTitle="暂无消息"
          />
          {total > PAGE_SIZE && (
            <div className="border-t border-border px-3">
              <Pagination
                offset={offset}
                limit={PAGE_SIZE}
                count={rows.length}
                total={total}
                onChange={setOffset}
              />
            </div>
          )}
        </>
      )}

      <Modal
        open={detail !== null}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail ? `站内信 #${detail.id}` : undefined}
        className="max-w-3xl"
      >
        {detail && (
          <div className="flex flex-col gap-3">
            <div className="divide-y divide-border">
              <KeyValue label="受众" value={<AudienceBadge m={detail} />} />
              <KeyValue
                label="级别"
                value={
                  <Badge tone={INBOX_LEVEL_TONE[detail.level]}>
                    {INBOX_LEVEL_LABELS[detail.level] ?? detail.level}
                  </Badge>
                }
              />
              <KeyValue label="创建时间" value={<TimeAgo value={detail.created_at} />} />
              <KeyValue
                label="过期"
                value={detail.expires_at ? <TimeAgo value={detail.expires_at} /> : "永不过期"}
              />
              <KeyValue
                label="站内已读 / 收件人"
                value={detail.audience_snapshot_status === "captured" ? `${detail.read_count} / ${detail.recipients}` : "历史无受众快照，无法计算"}
              />
              <KeyValue label="发送时受众快照" value={detail.audience_snapshot_status === "captured" ? "已固化" : "历史不可用"} />
              <KeyValue label="分类" value={CATEGORY_LABEL[detail.category]} />
              {detail.thread_key && (
                <KeyValue
                  label="线程"
                  value={`${detail.thread_key}（共 ${detail.thread_count} 条）`}
                />
              )}
              {detail.source_type && (
                <KeyValue
                  label="来源"
                  value={[detail.source_type, detail.source_id, detail.source_phase]
                    .filter(Boolean)
                    .join(" / ")}
                />
              )}
              {detail.notify_email && (
                <KeyValue label="邮件推送" value={<EmailChip m={detail} />} />
              )}
            </div>
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[14px] font-semibold text-fg">{detail.title}</p>
                <Tabs
                  value={detailMode}
                  onValueChange={(value) => setDetailMode(value as "preview" | "source")}
                  items={[
                    { value: "preview", label: <span className="inline-flex items-center gap-1"><Eye size={12} />预览</span> },
                    { value: "source", label: <span className="inline-flex items-center gap-1"><Code2 size={12} />源码</span> },
                  ]}
                  aria-label="正文显示方式"
                />
              </div>
              {detailMode === "preview" ? (
                <div className="max-h-[55vh] min-h-40 overflow-auto rounded-xl border border-border bg-surface px-4 py-4 text-[13px] text-fg">
                  <Markdown signMedia readOnly>{detail.body_md}</Markdown>
                </div>
              ) : (
                <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-code px-4 py-3 text-[12px] leading-relaxed text-fg">
                  {detail.body_md}
                </pre>
              )}
            </div>
          </div>
        )}
      </Modal>
      </SectionCard>
    </div>
  );
}
