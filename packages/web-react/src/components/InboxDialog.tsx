import {
  BarChart3,
  Bell,
  BellOff,
  CheckCheck,
  ChevronDown,
  ImageIcon,
  Inbox,
  type LucideIcon,
  Megaphone,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../lib/api";
import { INBOX_LEVEL_META, type InboxLevelTone } from "../lib/inboxLevels";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { AuthSession, InboxLevel, InboxMessage } from "../lib/types";
import { cn } from "../lib/utils";
import { Markdown } from "./Markdown";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Sheet,
  Skeleton,
  Spinner,
  Tabs,
} from "./ui";

/** 每页拉取条数。列表滚到底靠「加载更多」翻页（返回条数 == LIMIT 视为可能还有）。 */
const LIMIT = 30;

type InboxTab = "all" | "unread";

const TAB_ITEMS = [
  { value: "all", label: "全部", featureId: PRODUCT_CAPABILITIES.inbox.id },
  { value: "unread", label: "未读", featureId: PRODUCT_CAPABILITIES.inbox.id },
];

/** 级别 → lucide 图标（label/tone 权威在 lib/inboxLevels，本表只补图标，UI 层持有）。 */
const LEVEL_ICON: Record<InboxLevel, LucideIcon> = {
  info: Bell,
  notice: Megaphone,
  promo: Sparkles,
  warning: TriangleAlert,
};

/** 级别 tone → 图标圆形容器的 soft 底色 + 前景色。 */
const LEVEL_ICON_CLASS: Record<InboxLevelTone, string> = {
  neutral: "bg-hover text-muted",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent",
  warning: "bg-warning-soft text-warning",
};

/**
 * 把 Markdown 正文压成纯文本摘要（列表两行预览用）。剥离标题/强调/列表/引用标记、
 * 图片与链接语法、行内代码与代码围栏、以及 HTML 注释（含正文里 `<!-- ob:xxx -->`
 * 防重发 marker，绝不能漏进摘要），折叠空白后截断到 ~120 字。
 */
export function stripMarkdownSummary(md: string, max = 120): string {
  const text = (md || "")
    // HTML 注释（含 <!-- ob:xxx --> 防重发 marker）
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 代码围栏 ``` ... ```
    .replace(/```[\s\S]*?```/g, " ")
    // 图片 ![alt](url)（先于链接处理，避免残留前导 !）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // 链接 [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 行内代码 `code` → code
    .replace(/`([^`]*)`/g, "$1")
    // 行首标题 #、引用 >
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    // 列表项标记 -, *, +, 1.
    .replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, "")
    // 强调/删除线标记 * _ ~
    .replace(/[*_~]/g, "")
    // 残留的行内 HTML 标签
    .replace(/<[^>]+>/g, " ")
    // 折叠所有空白
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 绝对时间（title 悬浮用）：YYYY-MM-DD HH:mm。 */
function fmtAbsTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 相对时间：刚刚 / x 分钟前 / 今天 HH:mm / 昨天 HH:mm / 更早 YYYY-MM-DD HH:mm。
 * （仓内 utils.relativeTime 走「x 小时前/x 天前」语义，与本处「今天/昨天 HH:mm」不同，故独立实现。）
 */
function fmtRelativeTime(iso: string): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - t) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff <= 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `昨天 ${hm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

/**
 * 站内信通知抽屉（v5 商业版）：右侧侧滑面板。全部 / 未读两 Tab，紧凑列表 + 单开手风琴。
 *
 * 行为要点：
 * - 打开**不再**批量标已读；仅在展开某条未读时对该条单独标已读（乐观置读 + 通知顶栏刷新
 *   红点，失败静默不打断阅读）。
 * - 「未读」Tab 里点开变已读的条目留在当前列表（样式转已读），切 Tab / 重新拉取才消失，
 *   避免正在阅读的条目瞬间消失。
 * - 分页靠「加载更多」（offset 翻页）；返回条数 == LIMIT 视为可能还有下一页。
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
  /** 标记已读后通知父层回拉未读真值，刷新顶栏铃铛红点。 */
  onUnreadChange: () => void;
}) {
  const [tab, setTab] = useState<InboxTab>("all");
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [moreErr, setMoreErr] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 重试计数：递增以强制首屏拉取 effect 重跑。
  const [reloadTick, setReloadTick] = useState(0);

  // 关闭时复位到初始 Tab / 收起态，下次打开是干净状态。
  useEffect(() => {
    if (!open) {
      setTab("all");
      setExpandedId(null);
    }
  }, [open]);

  // 首屏 / 切 Tab / 重试：拉第一页（unread_only 跟随 Tab）。
  useEffect(() => {
    if (!open || !auth) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    setMoreErr(false);
    setExpandedId(null);
    api
      .listInboxMessages(auth, { limit: LIMIT, unreadOnly: tab === "unread" })
      .then((r) => {
        if (!alive) return;
        setMessages(r.messages);
        setUnreadCount(r.unread_count);
        setHasMore(r.messages.length === LIMIT);
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
  }, [open, auth, tab, reloadTick]);

  const loadMore = useCallback(async () => {
    if (!auth || loadingMore) return;
    setLoadingMore(true);
    setMoreErr(false);
    try {
      // 未读 Tab 的 offset 用「已加载且仍未读」条数：本地点开转已读的条目已不在
      // 服务端未读列表里，按 messages.length 翻页会跳过等量的未读消息。
      const offset =
        tab === "unread"
          ? messages.filter((m) => !m.read).length
          : messages.length;
      const r = await api.listInboxMessages(auth, {
        limit: LIMIT,
        offset,
        unreadOnly: tab === "unread",
      });
      setMessages((cur) => [...cur, ...r.messages]);
      setUnreadCount(r.unread_count);
      setHasMore(r.messages.length === LIMIT);
    } catch {
      // 追加失败不炸整列表：保留已加载内容，按钮位就地转「重试」。
      setMoreErr(true);
    } finally {
      setLoadingMore(false);
    }
  }, [auth, loadingMore, messages.length, tab]);

  // 展开某条：单开手风琴；展开的是未读则单条标已读（乐观 + 成功后通知父层刷新红点）。
  const toggle = useCallback(
    (m: InboxMessage) => {
      const willExpand = expandedId !== m.id;
      setExpandedId(willExpand ? m.id : null);
      if (!willExpand || m.read || !auth) return;
      // 乐观置读（未读条目仍留在列表，样式转已读）。
      setMessages((cur) =>
        cur.map((x) => (x.id === m.id ? { ...x, read: true } : x)),
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      api
        .markInboxRead(auth, m.id)
        .then(() => onUnreadChange())
        // 失败不打断阅读：红点真值由下次轮询/重新拉取自然纠正。
        .catch(() => {});
    },
    [expandedId, auth, onUnreadChange],
  );

  const markAll = useCallback(async () => {
    if (!auth || markingAll || unreadCount === 0) return;
    setMarkingAll(true);
    try {
      await api.markAllInboxRead(auth);
      setMessages((cur) => cur.map((m) => (m.read ? m : { ...m, read: true })));
      setUnreadCount(0);
      onUnreadChange();
    } catch {
      // 全部已读失败：保持列表，红点不变，用户可再次点击重试。
    } finally {
      setMarkingAll(false);
    }
  }, [auth, markingAll, unreadCount, onUnreadChange]);

  const retry = useCallback(() => setReloadTick((n) => n + 1), []);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      side="right"
      srTitle="站内信"
      className="w-[100vw] max-w-[100vw] bg-surface sm:w-[44rem] sm:max-w-[44rem]"
    >
      {/* 头部：铃铛 + 标题 + 未读数 + 全部已读 + 关闭 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Bell size={17} className="shrink-0 text-muted" />
        <span className="text-[15px] font-semibold text-fg">站内信</span>
        {unreadCount > 0 && <Badge tone="danger">{unreadCount}</Badge>}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={markAll}
            disabled={markingAll || unreadCount === 0}
            className="gap-1.5 text-muted"
          >
            <CheckCheck size={15} />
            全部已读
          </Button>
          <IconButton variant="muted" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
      </div>

      {/* Tabs：全部 / 未读（切换重拉，unread_only 跟随） */}
      <div className="border-b border-border px-4 py-2.5">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as InboxTab)}
          items={TAB_ITEMS}
          aria-label="站内信筛选"
        />
      </div>

      {/* 列表区 */}
      <div
        data-product-feature={PRODUCT_CAPABILITIES.inbox.id}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
      >
        {!auth ? (
          <EmptyState
            icon={Bell}
            title="请先登录"
            hint="登录后可查看你的站内信。"
          />
        ) : loading ? (
          <SkeletonRows />
        ) : err ? (
          <div className="flex flex-col items-center gap-3 px-5 py-14 text-center">
            <p className="text-[13px] text-danger">{err}</p>
            <Button variant="secondary" size="sm" onClick={retry}>
              重试
            </Button>
          </div>
        ) : messages.length === 0 ? (
          tab === "unread" ? (
            <EmptyState
              icon={BellOff}
              title="没有未读消息"
              hint="你已读完所有消息。"
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="暂无消息"
              hint="有新的通知、公告或活动会显示在这里。"
            />
          )
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {messages.map((m) => (
                <InboxItem
                  key={m.id}
                  message={m}
                  expanded={expandedId === m.id}
                  onToggle={() => toggle(m)}
                />
              ))}
            </ul>
            {moreErr ? (
              <div className="px-2 py-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMore}
                  className="text-danger"
                >
                  加载失败，点击重试
                </Button>
              </div>
            ) : hasMore ? (
              <div className="px-2 py-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="gap-1.5 text-muted"
                >
                  {loadingMore ? (
                    <>
                      <Spinner size={14} /> 加载中…
                    </>
                  ) : (
                    "加载更多"
                  )}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

/** 单条卡片：摘要态轻扫，点击后在卡内展开只读 Markdown / 图片 / 图表。 */
function InboxItem({
  message: m,
  expanded,
  onToggle,
}: {
  message: InboxMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = INBOX_LEVEL_META[m.level] ?? INBOX_LEVEL_META.info;
  const Icon = LEVEL_ICON[m.level] ?? Bell;
  const summary = useMemo(() => stripMarkdownSummary(m.body_md), [m.body_md]);
  const hasImage = useMemo(
    () => /!\[[^\]]*\]\([^)]*\)|\/api\/inbox-assets\//i.test(m.body_md),
    [m.body_md],
  );
  const hasChart = useMemo(
    () => /```(?:chart|mermaid)\b/i.test(m.body_md),
    [m.body_md],
  );

  return (
    <li
      className={cn(
        "relative overflow-hidden rounded-xl border bg-elevated shadow-soft transition-[border-color,box-shadow]",
        expanded
          ? "border-border-strong shadow-float"
          : "border-border hover:border-border-strong",
        !m.read && "border-l-2 border-l-accent",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full gap-3.5 px-3.5 py-3.5 text-left outline-none transition-colors hover:bg-hover/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4",
          expanded && "bg-hover/60",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl",
            LEVEL_ICON_CLASS[meta.tone],
          )}
          title={meta.label}
        >
          <Icon size={17} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-start gap-2">
            {!m.read && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-accent"
                aria-hidden
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[14px] leading-5 text-fg",
                m.read ? "font-medium" : "font-semibold",
              )}
            >
              {m.title}
            </span>
            <span
              className="shrink-0 pt-0.5 text-[11px] tabular-nums text-faint"
              title={fmtAbsTime(m.created_at)}
            >
              {fmtRelativeTime(m.created_at)}
            </span>
          </span>
          {!expanded && summary && (
            <span className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
              {summary}
            </span>
          )}
          <span className="mt-2 flex min-h-5 flex-wrap items-center gap-1.5">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {hasImage && (
              <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                <ImageIcon size={12} /> 图片
              </span>
            )}
            {hasChart && (
              <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                <BarChart3 size={12} /> 图表
              </span>
            )}
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden
          className={cn(
            "mt-1 shrink-0 text-faint transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="min-w-0 overflow-hidden border-t border-border bg-surface px-4 py-4 text-[13px] leading-relaxed text-fg sm:px-5">
          <Markdown signMedia readOnly>
            {m.body_md}
          </Markdown>
        </div>
      )}
    </li>
  );
}

/** 首屏加载骨架：4 张卡片，形状对齐真实摘要态。 */
function SkeletonRows() {
  return (
    <ul className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="flex gap-3 rounded-xl border border-border bg-elevated px-4 py-4"
        >
          <Skeleton className="size-9 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="mt-2 h-3 w-full" />
            <Skeleton className="mt-1.5 h-3 w-3/4" />
            <Skeleton className="mt-2.5 h-5 w-14 rounded-full" />
          </div>
        </li>
      ))}
    </ul>
  );
}
