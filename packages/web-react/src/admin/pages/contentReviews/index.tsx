import { Scale, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, useToast } from "../../../components/ui";
import { PageHeader, SectionCard } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";

interface ReviewRow {
  id: number;
  createdAt: number;
  userId: string;
  sessionKey: string;
  excerpt: string;
  choice: string;
  confidence: number | null;
  thresholdMet: boolean;
  bannedAt: number | null;
}

interface AppealRow {
  id: string;
  userId: string;
  statement: string;
  excerpt: string;
}

export default function ContentReviewsPage() {
  const toast = useToast();
  const [items, setItems] = useState<ReviewRow[]>([]);
  const [appeals, setAppeals] = useState<AppealRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [data, pending] = await Promise.all([
      adminGet<{ items: ReviewRow[] }>("/api/admin/content-reviews"),
      adminGet<{ items: AppealRow[] }>("/api/admin/content-appeals"),
    ]);
    setItems(data.items);
    setAppeals(pending.items);
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => toast(apiErrorMessage(err, "请求失败"), "error"));
  }, [load, toast]);

  async function notify(id: number) {
    setBusy(`review:${id}`);
    try {
      const result = await adminSend<{ accountBanned?: boolean }>(
        "POST",
        `/api/admin/content-reviews/${id}/notify`,
      );
      toast(result.accountBanned ? "已记次并封禁账号" : "已发送站内信并记一次违规", "success");
      await load();
    } catch (err) {
      toast(apiErrorMessage(err, "请求失败"), "error");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, approve: boolean) {
    setBusy(`appeal:${id}`);
    try {
      await adminSend("POST", `/api/admin/content-appeals/${id}/${approve ? "approve" : "reject"}`);
      toast(approve ? "已通过申诉，这一次不再计入" : "已驳回申诉", "success");
      await load();
    } catch (err) {
      toast(apiErrorMessage(err, "请求失败"), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ShieldCheck}
        title="内容记录"
        desc="发消息前记录，不拦截。确认后发站内信并记一次。申诉通过就减掉这一次，累计 3 次封禁账号。"
      />
      <SectionCard
        title="最近记录"
        hint={`共 ${items.length} 条记录`}
        icon={ShieldAlert}
        iconTone="warning"
        bodyClassName="px-0 py-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-sidebar/75 dark:bg-elevated/75">
              <tr className="border-b border-border text-left text-caption font-semibold uppercase tracking-wide text-faint">
                <th className="whitespace-nowrap px-4 py-2.5">时间</th>
                <th className="whitespace-nowrap px-4 py-2.5">判定</th>
                <th className="px-4 py-2.5">摘录</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {items.map((row) => (
                <tr key={row.id} className="align-top transition-colors hover:bg-hover/60">
                  <td className="whitespace-nowrap px-4 py-3 text-meta tabular-nums text-muted">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Badge
                      tone={row.thresholdMet ? "danger" : "neutral"}
                      className="tabular-nums"
                    >
                      {row.choice}
                      {row.confidence != null ? ` ${row.confidence.toFixed(2)}` : ""}
                      {row.thresholdMet ? " · 达阈值" : ""}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="oc-surface-recessed max-w-xl rounded-lg px-3 py-2 text-body leading-relaxed text-fg">
                      {row.excerpt}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {row.bannedAt ? (
                      <Badge tone="neutral">已通知</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant={row.thresholdMet ? "danger" : "secondary"}
                        disabled={busy === `review:${row.id}` || !row.thresholdMet}
                        onClick={() => notify(row.id)}
                      >
                        发送违规说明
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-body text-muted" colSpan={4}>
                    还没有记录。开关打开后，新的用户消息才会出现在这里。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <SectionCard
        title="待审申诉"
        hint={`共 ${appeals.length} 条待审`}
        icon={Scale}
        iconTone="info"
        bodyClassName="px-0 py-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            {appeals.length > 0 && (
              <thead className="bg-sidebar/75 dark:bg-elevated/75">
                <tr className="border-b border-border text-left text-caption font-semibold uppercase tracking-wide text-faint">
                  <th className="whitespace-nowrap px-4 py-2.5">用户</th>
                  <th className="px-4 py-2.5">摘录</th>
                  <th className="px-4 py-2.5">申诉说明</th>
                  <th className="px-4 py-2.5 text-right">操作</th>
                </tr>
              </thead>
            )}
            <tbody className="divide-y divide-border/60">
              {appeals.map((row) => (
                <tr key={row.id} className="align-top transition-colors hover:bg-hover/60">
                  <td className="whitespace-nowrap px-4 py-3">
                    <Badge tone="info" className="tabular-nums">用户 {row.userId}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="oc-surface-recessed rounded-lg px-3 py-2 text-body leading-relaxed text-fg">
                      {row.excerpt}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="oc-callout oc-callout-info rounded-lg px-3 py-2 text-body leading-relaxed text-muted">
                      {row.statement}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy === `appeal:${row.id}`}
                        onClick={() => decide(row.id, true)}
                      >
                        通过
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === `appeal:${row.id}`}
                        onClick={() => decide(row.id, false)}
                      >
                        驳回
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {appeals.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-center text-body text-muted">没有待审申诉。</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
