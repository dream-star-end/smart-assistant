import { Code2, Eye, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "../../../components/Markdown";
import {
  Badge,
  Button,
  IconButton,
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
  TimeAgo,
} from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import {
  EMAIL_STATUS_META,
  INBOX_LEVEL_LABELS,
  INBOX_LEVEL_TONE,
  type InboxCategory,
  type InboxMessage,
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
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [offset, category]);

  // offset / 外部 reloadKey（发送后）变化即重拉。
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

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
      render: (m) => `${m.read_count} / ${m.recipients}`,
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

  return (
    <SectionCard
      title="历史消息"
      hint={loading ? "加载中…" : `共 ${total} 条`}
      bodyClassName="px-0 py-0"
    >
      {confirmEl}
      <div className="border-b border-border px-4 py-3">
        <SelectFilter
          label="分类"
          value={category}
          options={[
            { label: "全部分类", value: "" },
            ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({
              value: value as InboxCategory,
              label,
            })),
          ]}
          onChange={(value) => {
            setOffset(0);
            setCategory(value as InboxCategory | "");
          }}
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
                value={`${detail.read_count} / ${detail.recipients}`}
              />
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
  );
}
