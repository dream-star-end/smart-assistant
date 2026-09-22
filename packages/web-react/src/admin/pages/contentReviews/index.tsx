import { useCallback, useEffect, useState } from "react";
import { Button, useToast } from "../../../components/ui";
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
    load().catch((err: unknown) => toast(apiErrorMessage(err), "error"));
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
      toast(apiErrorMessage(err), "error");
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
      toast(apiErrorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="内容记录"
        desc="发消息前记录，不拦截。确认后发站内信并记一次。申诉通过就减掉这一次，累计 3 次封禁账号。"
      />
      <SectionCard title="最近记录">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">时间</th>
              <th>判定</th>
              <th>摘录</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id} className="border-t border-border align-top">
                <td className="py-2 pr-3 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="pr-3">
                  {row.choice}
                  {row.confidence != null ? ` ${row.confidence.toFixed(2)}` : ""}
                  {row.thresholdMet ? " · 达阈值" : ""}
                </td>
                <td className="pr-3">{row.excerpt}</td>
                <td>
                  {row.bannedAt ? (
                    "已通知"
                  ) : (
                    <Button
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
                <td className="py-4 text-muted-foreground" colSpan={4}>
                  还没有记录。开关打开后，新的用户消息才会出现在这里。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </SectionCard>
      <SectionCard title="待审申诉">
        <table className="w-full text-sm">
          <tbody>
            {appeals.map((row) => (
              <tr key={row.id} className="border-t border-border align-top">
                <td className="py-2 pr-3">用户 {row.userId}</td>
                <td className="pr-3">{row.excerpt}</td>
                <td className="pr-3">{row.statement}</td>
                <td className="whitespace-nowrap">
                  <Button disabled={busy === `appeal:${row.id}`} onClick={() => decide(row.id, true)}>
                    通过
                  </Button>
                  <Button disabled={busy === `appeal:${row.id}`} onClick={() => decide(row.id, false)}>
                    驳回
                  </Button>
                </td>
              </tr>
            ))}
            {appeals.length === 0 ? (
              <tr>
                <td className="py-4 text-muted-foreground">没有待审申诉。</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}
