import * as Dialog from "@radix-ui/react-dialog";
import { Bell, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiErrorMessage } from "../lib/api";
import type { AuthSession, InboxLevel, InboxMessage } from "../lib/types";
import { cn } from "../lib/utils";
import { Markdown } from "./Markdown";
import { Badge, Button, Spinner } from "./ui";

const LEVEL_META: Record<InboxLevel, { label: string; tone: "neutral" | "info" | "accent" | "warning" }> = {
  info: { label: "通知", tone: "neutral" },
  notice: { label: "公告", tone: "info" },
  promo: { label: "活动", tone: "accent" },
  warning: { label: "提醒", tone: "warning" },
};

/** 站内信时间：今天显示 HH:mm，否则 YYYY-MM-DD HH:mm（对齐 v3 inbox.js _fmtTime）。 */
function fmtInboxTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
}

/**
 * 站内信面板（v5 商业版）：系统通知 / 欢迎引导 / 公告 / 活动。
 *
 * 打开即拉列表（limit 50）并对**第一屏已加载**的未读逐条标已读（"可见即已读"，
 * 不调 read_all——避免把未加载的第 51+ 条也标掉，对齐 v3 inbox.js）；标记后回拉
 * 未读真值（refreshUnread）。"全部标记已读"按钮单独走 read_all。
 */
export function InboxDialog({
  open,
  auth,
  onClose,
  onUnreadChange,
}: {
  open: boolean;
  auth: AuthSession | null;
  onClose: () => void;
  /** 标记已读后回拉未读真值，刷新顶栏铃铛红点。 */
  onUnreadChange: () => void;
}) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  // 防止同一轮打开重复执行"可见即已读"。
  const autoReadDoneRef = useRef(false);

  const unread = messages.filter((m) => !m.read).length;

  // 打开：拉列表 + 可见即已读。关闭：复位。
  useEffect(() => {
    if (!open || !auth) {
      autoReadDoneRef.current = false;
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listInboxMessages(auth, { limit: 50 })
      .then(async (r) => {
        if (!alive) return;
        setMessages(r.messages);
        // 可见即已读：仅对已加载的未读逐条标记（不触碰未加载的更早消息）。
        if (!autoReadDoneRef.current) {
          autoReadDoneRef.current = true;
          const unreadIds = r.messages.filter((m) => !m.read).map((m) => m.id);
          if (unreadIds.length > 0) {
            await Promise.allSettled(unreadIds.map((id) => api.markInboxRead(auth, id)));
            if (alive) {
              const idSet = new Set(unreadIds);
              setMessages((cur) => cur.map((m) => (idSet.has(m.id) ? { ...m, read: true } : m)));
            }
            onUnreadChange();
          }
        }
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载站内信失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, auth, onUnreadChange]);

  const markAll = useCallback(async () => {
    if (!auth || markingAll) return;
    setMarkingAll(true);
    try {
      await api.markAllInboxRead(auth);
      setMessages((cur) => cur.map((m) => (m.read ? m : { ...m, read: true })));
      onUnreadChange();
    } catch (e) {
      setErr(apiErrorMessage(e, "标记失败"));
    } finally {
      setMarkingAll(false);
    }
  }, [auth, markingAll, onUnreadChange]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="flex items-center gap-2">
              <Dialog.Title className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                <Bell size={16} className="text-faint" /> 站内信
              </Dialog.Title>
              {unread > 0 && <Badge tone="danger">{unread} 未读</Badge>}
            </div>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {!auth ? (
              <p className="px-2 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
                <Spinner /> 加载中…
              </div>
            ) : err ? (
              <p className="px-2 py-10 text-center text-[13px] text-danger">{err}</p>
            ) : messages.length === 0 ? (
              <p className="px-2 py-16 text-center text-[13px] text-faint">暂无消息</p>
            ) : (
              <ul className="flex flex-col gap-1.5 py-1">
                {messages.map((m) => (
                  <InboxItem key={m.id} message={m} />
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={markAll}
              disabled={markingAll || unread === 0}
              className="text-muted"
            >
              {markingAll ? "标记中…" : "全部标记已读"}
            </Button>
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">
                关闭
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InboxItem({ message: m }: { message: InboxMessage }) {
  const meta = LEVEL_META[m.level] ?? LEVEL_META.info;
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5 transition-colors",
        m.read ? "border-transparent" : "border-border bg-hover/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("size-1.5 shrink-0 rounded-full bg-accent", m.read && "invisible")}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">{m.title}</span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{fmtInboxTime(m.created_at)}</span>
      </div>
      <div className="mt-1.5 pl-3.5 text-[13px] leading-relaxed text-muted">
        <Markdown>{m.body_md}</Markdown>
      </div>
    </li>
  );
}
