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

export default function ContentReviewsPage() {
  const toast = useToast();
  const [items, setItems] = useState<ReviewRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const data = await adminGet<{ items: ReviewRow[] }>("/api/admin/content-reviews");
    setItems(data.items);
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => toast(apiErrorMessage(err), "error"));
  }, [load, toast]);

  async function ban(id: number) {
    setBusy(id);
    try {
      await adminSend("POST", `/api/admin/content-reviews/${id}/ban`);
      toast("已封禁该会话，之后的新消息不会再执行", "success");
      await load();
    } catch (err) {
      toast(apiErrorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="内容记录" desc="发消息前记录，不拦截。只有高置信违规会告警。封禁由你点一下才生效。" />
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
                  {row.thresholdMet ? " · 已告警" : ""}
                </td>
                <td className="pr-3">{row.excerpt}</td>
                <td>
                  {row.bannedAt ? (
                    "已封禁"
                  ) : (
                    <Button disabled={busy === row.id || !row.sessionKey} onClick={() => ban(row.id)}>
                      封禁会话
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
    </div>
  );
}
