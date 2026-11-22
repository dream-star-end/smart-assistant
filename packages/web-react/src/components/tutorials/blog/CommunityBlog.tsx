import {
  ArrowLeft,
  Eye,
  Flame,
  Inbox,
  Link2,
  Search,
  SquarePen,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tutorialHref } from "../../../hooks/useAppRoute";
import { api, apiErrorMessage } from "../../../lib/api";
import type {
  AuthSession,
  CommunityTutorialCategory,
  CommunityTutorialDetail,
  CommunityTutorialSummary,
} from "../../../lib/types";
import { cn } from "../../../lib/utils";
import { Alert, Button, ListSkeleton, useToast } from "../../ui";
import { BlogArticleFooter, BlogAvatar, BlogChips, BlogCover, BlogProse, type BlogImageSource } from "./BlogArticle";
import { BlogEditor, type BlogEditTarget } from "./BlogEditor";
import { BlogMine } from "./BlogMine";
import {
  BLOG_CATEGORIES,
  type BlogDraft,
  blogLongDate,
  blogReadMinutes,
  blogShortDate,
  blogViewCount,
} from "./blogLib";


const PUBLIC_SOURCE: BlogImageSource = { kind: "public" };

type BlogView =
  | { kind: "list" }
  | { kind: "editor"; seed?: BlogDraft; nonce?: number; editing?: BlogEditTarget }
  | { kind: "mine" };

/** 从对话里的经验分享卡打开子视图（App → TutorialCenter → 这里）；nonce 变化执行一次。 */
export type BlogViewRequest = { kind: "editor"; seed: BlogDraft; nonce: number } | { kind: "mine"; nonce: number };

/**
 * 「经验分享」(OCV5-577):列表 / 详情 / 写一篇 / 我的投稿。详情 id 由宿主镜像到
 * `?panel=help&tab=blog&community=<id>`;其余子视图只是组件内状态。
 */
export function CommunityBlog({
  auth,
  userId = null,
  onRequireLogin,
  detailId = null,
  onDetailIdChange,
  request = null,
}: {
  auth?: AuthSession | null;
  /** 登录用户 id；编辑器本地草稿按账号隔离。未登录不进编辑器。 */
  userId?: string | null;
  onRequireLogin?: () => void;
  detailId?: string | null;
  onDetailIdChange?: (id: string | null) => void;
  request?: BlogViewRequest | null;
}) {
  const [view, setView] = useState<BlogView>(() =>
    request && auth ? (request.kind === "editor" ? { kind: "editor", seed: request.seed, nonce: request.nonce } : { kind: "mine" }) : { kind: "list" },
  );
  const handledRequest = useRef(request && auth ? request.nonce : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按 nonce 执行一次；auth / 回调变化不重放请求
  useEffect(() => {
    if (!request || handledRequest.current === request.nonce) return;
    handledRequest.current = request.nonce;
    if (!auth) {
      onRequireLogin?.();
      return;
    }
    onDetailIdChange?.(null);
    setView(request.kind === "editor" ? { kind: "editor", seed: request.seed, nonce: request.nonce } : { kind: "mine" });
  }, [request?.nonce]);
  const [aiReview, setAiReview] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getPublicConfig()
      .then((config) => {
        if (!cancelled) setAiReview(config.featureCommunityBlogAiReview === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const needAuth = (next: BlogView) => {
    if (!auth || (next.kind === "editor" && !userId)) {
      onRequireLogin?.();
      return;
    }
    onDetailIdChange?.(null);
    setView(next);
  };
  const openDetail = (id: string) => {
    setView({ kind: "list" });
    onDetailIdChange?.(id);
  };
  const backToList = () => {
    setView({ kind: "list" });
    onDetailIdChange?.(null);
  };

  if (view.kind === "editor" && auth && userId) {
    return (
      <BlogEditor
        key={view.editing ? `edit:${view.editing.id}` : (view.nonce ?? 0)}
        auth={auth}
        userId={userId}
        seed={view.seed}
        editing={view.editing}
        aiReview={aiReview}
        onBack={view.editing ? () => setView({ kind: "mine" }) : backToList}
        onSubmitted={() => setView({ kind: "mine" })}
      />
    );
  }
  if (view.kind === "mine" && auth) {
    return (
      <BlogMine
        auth={auth}
        onBack={backToList}
        onWrite={(seed) => setView({ kind: "editor", seed })}
        onEdit={(seed, editing) => setView({ kind: "editor", seed, editing })}
        onOpen={openDetail}
      />
    );
  }
  if (detailId) {
    return (
      <BlogDetail
        id={detailId}
        onBack={backToList}
        onOpen={openDetail}
        onWrite={() => needAuth({ kind: "editor" })}
      />
    );
  }
  return (
    <BlogList
      auth={auth ?? null}
      onOpen={openDetail}
      onWrite={() => needAuth({ kind: "editor" })}
      onMine={() => needAuth({ kind: "mine" })}
    />
  );
}

function BlogMeta({ item }: { item: CommunityTutorialSummary & { viewCount?: number | null } }) {
  const views = blogViewCount(item);
  const shortDate = blogShortDate(item.publishedAt);
  return (
    <div className="oc-meta flex flex-wrap items-center gap-y-1 text-meta text-faint">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <BlogAvatar name={item.authorName} />
        <span>{item.authorName}</span>
      </span>
      {shortDate && <span className="whitespace-nowrap">{shortDate}</span>}
      <span className="whitespace-nowrap">{item.readMinutes ?? 1} 分钟读完</span>
      {views !== null && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Eye size={12} aria-hidden />
          {views} 次阅读
        </span>
      )}
    </div>
  );
}

function BlogCard({
  item,
  featured,
  onOpen,
}: {
  item: CommunityTutorialSummary;
  featured: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "oc-surface-card oc-surface-card-hover group flex flex-col overflow-hidden rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        featured && "md:col-span-2 md:flex-row",
      )}
    >
      <BlogCover item={item} className={featured ? "md:aspect-auto md:min-h-64 md:flex-[1.15]" : undefined} />
      <div className={cn("flex flex-1 flex-col gap-2 p-4 sm:p-5", featured && "md:justify-center md:p-6")}>
        {featured && (
          <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-accent">
            <Flame size={14} aria-hidden /> 本周精选
          </span>
        )}
        <h3
          className={cn(
            "m-0 font-semibold leading-snug text-fg transition-colors group-hover:text-accent",
            featured ? "text-title md:text-lg" : "text-title",
          )}
        >
          {item.title}
        </h3>
        <p className={cn("m-0 text-body leading-relaxed text-muted", featured ? "line-clamp-2 md:line-clamp-3" : "line-clamp-2")}>
          {item.summary}
        </p>
        <div className="mt-auto pt-1.5">
          <BlogMeta item={item} />
        </div>
      </div>
    </button>
  );
}

function BlogList({
  auth,
  onOpen,
  onWrite,
  onMine,
}: {
  auth: AuthSession | null;
  onOpen: (id: string) => void;
  onWrite: () => void;
  onMine: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<{ query: string; category: CommunityTutorialCategory | "" }>({
    query: "",
    category: "",
  });
  const [items, setItems] = useState<CommunityTutorialSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mineSummary, setMineSummary] = useState<{ pending: number; rejected: number }>({ pending: 0, rejected: 0 });

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.listCommunityTutorials({
          cursor,
          query: filters.query,
          category: filters.category || null,
          kind: "markdown",
        });
        const rows = Array.isArray(page?.tutorials) ? page.tutorials : [];
        setItems((current) => (cursor ? [...current, ...rows] : rows));
        setNextCursor(page?.nextCursor ?? null);
        if (!cursor) setTotal(typeof page?.total === "number" ? page.total : null);
      } catch (cause) {
        setError(apiErrorMessage(cause, "加载经验分享失败"));
      } finally {
        setLoading(false);
        setLoadedOnce(true);
      }
    },
    [filters],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  // 搜索框停顿 300ms 再查,不用额外的「筛选」按钮。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.query === query.trim() ? current : { ...current, query: query.trim() }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!auth) {
      setMineSummary({ pending: 0, rejected: 0 });
      return;
    }
    let cancelled = false;
    api
      .listMyCommunityTutorials(auth, null)
      .then((page) => {
        if (cancelled) return;
        const rows = Array.isArray(page?.tutorials) ? page.tutorials : [];
        let pending = 0;
        let rejected = 0;
        for (const item of rows) {
          if (item.kind === "snapshot") continue;
          if (item.status === "pending" || item.edit?.status === "pending") pending += 1;
          else if (item.status === "rejected" || item.edit?.status === "rejected") rejected += 1;
        }
        setMineSummary({ pending, rejected });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const featureFirst = !filters.query && !filters.category && items.length >= 3;
  const shownTotal = total ?? items.length;
  const attentionMine = mineSummary.pending + mineSummary.rejected;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-4 sm:px-6 sm:pt-5">
      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h2 className="m-0 text-title font-semibold tracking-tight text-fg sm:text-lg">经验分享</h2>
          <span className="text-meta text-faint">已发布 {shownTotal} 篇 · 真实实践与可复用步骤</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" shape="pill" className="max-sm:min-h-11 max-sm:flex-1" onClick={onMine}>
            <Inbox size={15} aria-hidden /> 我的投稿
            {attentionMine > 0 && (
              <span
                className={cn(
                  "blog-chip h-5 min-w-5 justify-center px-1.5 tabular-nums",
                  mineSummary.rejected > 0 ? "blog-chip-bad" : "blog-chip-warn",
                )}
                aria-label={
                  mineSummary.rejected > 0 && mineSummary.pending > 0
                    ? `${mineSummary.pending} 篇待审，${mineSummary.rejected} 篇未通过`
                    : mineSummary.rejected > 0
                      ? `${mineSummary.rejected} 篇未通过`
                      : `${mineSummary.pending} 篇待审`
                }
              >
                {attentionMine}
              </span>
            )}
          </Button>
          <Button variant="accent" shape="pill" className="max-sm:min-h-11 max-sm:flex-1" onClick={onWrite}>
            <SquarePen size={15} aria-hidden /> 写一篇经验
          </Button>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <label className="flex min-h-11 min-w-full flex-1 items-center gap-2 rounded-full border border-border-control bg-surface px-3.5 text-faint transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-ring sm:min-h-10 sm:min-w-56">
          <Search size={15} aria-hidden />
          <span className="sr-only">搜索经验分享</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、摘要或作者"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-body"
          />
        </label>
        <fieldset className="no-scrollbar m-0 flex w-full min-w-0 gap-1.5 overflow-x-auto border-0 p-0 sm:w-auto" aria-label="分类">
          {[{ value: "" as const, label: "全部" }, ...BLOG_CATEGORIES].map((option) => (
            <button
              key={option.value || "all"}
              type="button"
              aria-pressed={filters.category === option.value}
              onClick={() => setFilters((current) => ({ ...current, category: option.value }))}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-body font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9 sm:px-3.5",
                filters.category === option.value
                  ? "border-primary bg-primary text-primary-fg"
                  : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg",
              )}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>

      {error ? (
        <Alert tone="danger">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="secondary" size="sm" loading={loading} onClick={() => void load(null)}>
              重试
            </Button>
          </div>
        </Alert>
      ) : loading && items.length === 0 ? (
        <ListSkeleton variant="card" rows={3} />
      ) : items.length === 0 && loadedOnce ? (
        <div className="oc-surface-card rounded-xl border-dashed p-10 text-center">
          <SquarePen size={28} className="mx-auto text-faint" aria-hidden />
          <p className="mt-3 text-body font-medium text-fg">
            {filters.query || filters.category ? "没有找到匹配的经验" : "还没有人分享经验"}
          </p>
          <p className="mt-1 text-meta text-faint">把你用得顺手的做法写下来，帮到下一个人。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3 md:gap-4">
          {items.map((item, index) => (
            <BlogCard key={item.id} item={item} featured={featureFirst && index === 0} onOpen={() => onOpen(item.id)} />
          ))}
        </div>
      )}
      {nextCursor && !error && (
        <div className="mt-6 flex justify-center">
          <Button variant="secondary" shape="pill" className="max-sm:min-h-11" loading={loading} onClick={() => void load(nextCursor)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}

/** 详情页打开期间加 noindex(quick tunnel 域名随机,不进搜索引擎),离开时还原。 */
function useNoIndex(): void {
  useEffect(() => {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previous = meta?.getAttribute("content") ?? null;
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "robots";
      document.head.appendChild(meta);
    }
    meta.content = "noindex";
    return () => {
      if (created) meta?.remove();
      else if (previous !== null) meta?.setAttribute("content", previous);
    };
  }, []);
}

export function blogShareUrl(id: string): string {
  return `${window.location.origin}${tutorialHref(window.location, null, null, id, { tab: "blog" })}`;
}

function BlogDetail({
  id,
  onBack,
  onOpen,
  onWrite,
}: {
  id: string;
  onBack: () => void;
  onOpen: (id: string) => void;
  onWrite: () => void;
}) {
  useNoIndex();
  const toast = useToast();
  const [item, setItem] = useState<CommunityTutorialDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<CommunityTutorialSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);
    api
      .getCommunityTutorial(id)
      .then((detail) => {
        if (!cancelled) setItem(detail);
      })
      .catch((cause) => {
        if (!cancelled) setError(apiErrorMessage(cause, "这篇经验不存在或已下线"));
      });
    api
      .listCommunityTutorials({ kind: "markdown", limit: 3 })
      .then((page) => {
        const rows = Array.isArray(page?.tutorials) ? page.tutorials : [];
        if (!cancelled) setMore(rows.filter((entry) => entry.id !== id).slice(0, 2));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  const copyLink = () => {
    void navigator.clipboard
      ?.writeText(blogShareUrl(id))
      .then(() => toast("链接已复制", "success"))
      .catch(() => toast("复制失败，请手动复制地址栏链接", "error"));
  };
  const minutes = useMemo(() => item?.readMinutes ?? blogReadMinutes(item?.bodyMarkdown ?? ""), [item]);
  const views = blogViewCount(item as (CommunityTutorialDetail & { viewCount?: number | null }) | null);

  return (
    <article className="mx-auto w-full max-w-3xl px-4 pb-12 pt-4 sm:px-6 sm:pb-16 sm:pt-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-5 inline-flex min-h-11 items-center gap-1.5 rounded-md text-body text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
      >
        <ArrowLeft size={15} aria-hidden /> 经验分享
      </button>
      {error ? (
        <Alert tone="danger">{error}</Alert>
      ) : !item ? (
        <ListSkeleton rows={4} />
      ) : (
        <>
          <BlogChips category={item.category} minutes={minutes} />
          <h1 className="my-3 text-xl font-bold leading-snug tracking-tight text-fg sm:text-2xl">{item.title}</h1>
          <p className="mb-5 text-base leading-relaxed text-muted">{item.summary}</p>
          <div className="mb-7 flex flex-wrap items-center justify-between gap-3 border-y border-border py-3.5">
            <div className="flex items-center gap-2.5 text-section">
              <BlogAvatar name={item.authorName} size={34} />
              <div>
                <b className="font-semibold text-fg">{item.authorName}</b>
                <div className="oc-meta flex flex-wrap items-center gap-y-0.5 text-meta text-faint">
                  <span className="whitespace-nowrap">{blogLongDate(item.publishedAt)}发布</span>
                  {views !== null && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <Eye size={12} aria-hidden />
                      {views} 次阅读
                    </span>
                  )}
                </div>
              </div>
            </div>
            <Button variant="secondary" size="sm" shape="pill" className="max-sm:min-h-11" onClick={copyLink}>
              <Link2 size={14} aria-hidden /> 复制链接
            </Button>
          </div>
          <BlogProse markdown={item.bodyMarkdown} source={PUBLIC_SOURCE} />
          <BlogArticleFooter onCopyLink={copyLink} onWrite={onWrite} />
          {more.length > 0 && (
            <section>
              <h2 className="mb-3 mt-8 text-section font-semibold text-fg">更多经验</h2>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {more.map((entry) => {
                  const entryViews = blogViewCount(entry as CommunityTutorialSummary & { viewCount?: number | null });
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => onOpen(entry.id)}
                      className="oc-surface-card oc-surface-card-hover flex items-center gap-3 rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <BlogCover item={entry} showChip={false} className="!aspect-auto h-14 w-21 shrink-0 rounded-md [&_svg]:size-5" />
                      <div className="min-w-0">
                        <b className="line-clamp-2 block text-section font-medium leading-snug text-fg">{entry.title}</b>
                        <div className="oc-meta mt-1 flex flex-wrap items-center gap-y-0.5 text-meta text-faint">
                          <span className="whitespace-nowrap">{entry.authorName}</span>
                          <span className="whitespace-nowrap">{entry.readMinutes ?? 1} 分钟</span>
                          {entryViews !== null && <span className="whitespace-nowrap">{entryViews} 次阅读</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </article>
  );
}
