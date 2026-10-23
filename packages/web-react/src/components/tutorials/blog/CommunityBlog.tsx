import {
  ArrowLeft,
  Flame,
  Inbox,
  Link2,
  Search,
  ShieldCheck,
  SquarePen,
  Users,
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
import { BlogAvatar, BlogChips, BlogCover, BlogProse, type BlogImageSource } from "./BlogArticle";
import { BlogEditor, type BlogEditTarget } from "./BlogEditor";
import { BlogMine } from "./BlogMine";
import {
  BLOG_CATEGORIES,
  type BlogDraft,
  blogLongDate,
  blogReadMinutes,
  blogShortDate,
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
  onRequireLogin,
  detailId = null,
  onDetailIdChange,
  request = null,
}: {
  auth?: AuthSession | null;
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
    if (!auth) {
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

  if (view.kind === "editor" && auth) {
    return (
      <BlogEditor
        key={view.editing ? `edit:${view.editing.id}` : (view.nonce ?? 0)}
        auth={auth}
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

function BlogMeta({ item }: { item: CommunityTutorialSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-meta text-faint">
      <BlogAvatar name={item.authorName} />
      <span>{item.authorName}</span>
      <span aria-hidden className="size-[3px] rounded-full bg-current opacity-60" />
      <span>{blogShortDate(item.publishedAt)}</span>
      <span aria-hidden className="size-[3px] rounded-full bg-current opacity-60" />
      <span>{item.readMinutes ?? 1} 分钟读完</span>
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
        "group flex flex-col overflow-hidden rounded-[20px] border border-border bg-surface text-left outline-none transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring",
        featured && "md:col-span-2 md:flex-row",
      )}
    >
      <BlogCover item={item} className={featured ? "md:aspect-auto md:min-h-[260px] md:flex-[1.15]" : undefined} />
      <div className={cn("flex flex-1 flex-col gap-2 p-[16px_18px_18px]", featured && "md:justify-center md:p-[26px]")}>
        {featured && (
          <span className="flex items-center gap-1.5 text-meta font-bold text-accent">
            <Flame size={15} aria-hidden /> 本周精选
          </span>
        )}
        <h3 className={cn("m-0 font-bold leading-[1.45] text-fg group-hover:text-accent", featured ? "text-[16px] md:text-[21px]" : "text-[16px]")}>
          {item.title}
        </h3>
        <p className={cn("m-0 text-[13px] leading-[1.6] text-muted", featured ? "line-clamp-2 md:line-clamp-3 md:text-[14px]" : "line-clamp-2")}>
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
  const [pendingMine, setPendingMine] = useState(0);

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
        setItems((current) => (cursor ? [...current, ...page.tutorials] : page.tutorials));
        setNextCursor(page.nextCursor);
        if (!cursor) setTotal(typeof page.total === "number" ? page.total : null);
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
    if (!auth) return;
    let cancelled = false;
    api
      .listMyCommunityTutorials(auth, null)
      .then((page) => {
        if (!cancelled)
          setPendingMine(page.tutorials.filter((item) => item.kind !== "snapshot" && item.status === "pending").length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const featureFirst = !filters.query && !filters.category && items.length >= 3;
  const shownTotal = total ?? items.length;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pb-12 pt-5 sm:px-6 sm:pt-7">
      <div className="mb-4 flex flex-col items-stretch gap-3.5 sm:mb-[22px] sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div>
          <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-accent">
            <Users size={15} aria-hidden /> 社区经验 · 已发布 {shownTotal} 篇
          </p>
          <h1 className="mb-1.5 mt-2 text-[25px] font-bold leading-[1.2] tracking-[-0.01em] text-fg sm:text-[32px]">
            别人怎么用好它，
            <br />
            一看就会。
          </h1>
          <p className="m-0 text-[14px] text-muted">来自真实用户的实践经验：具体的场景、可复用的步骤、踩过的坑。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" shape="pill" className="max-sm:flex-1" onClick={onMine}>
            <Inbox size={15} /> 我的投稿
            {pendingMine > 0 && (
              <span className="blog-chip blog-chip-warn h-[18px]">{pendingMine}</span>
            )}
          </Button>
          <Button variant="accent" shape="pill" className="shadow-[0_4px_14px_#5a3fee38] max-sm:flex-1" onClick={onWrite}>
            <SquarePen size={15} /> 写一篇经验
          </Button>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <label className="flex h-10 min-w-full flex-1 items-center gap-2 rounded-full border border-border-strong bg-surface px-3.5 text-faint focus-within:ring-2 focus-within:ring-ring sm:min-w-[220px]">
          <Search size={15} aria-hidden />
          <span className="sr-only">搜索经验分享</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、摘要或作者"
            className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint"
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
                "inline-flex h-[34px] shrink-0 items-center rounded-full border px-3.5 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filters.category === option.value
                  ? "border-primary bg-primary text-primary-fg"
                  : "border-border bg-surface text-muted hover:text-fg",
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
        <div className="rounded-[20px] border border-dashed border-border p-10 text-center">
          <SquarePen size={28} className="mx-auto text-faint" />
          <p className="mt-3 text-body font-medium text-fg">
            {filters.query || filters.category ? "没有找到匹配的经验" : "还没有人分享经验"}
          </p>
          <p className="mt-1 text-meta text-faint">把你用得顺手的做法写下来，帮到下一个人。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3 md:gap-[18px]">
          {items.map((item, index) => (
            <BlogCard key={item.id} item={item} featured={featureFirst && index === 0} onOpen={() => onOpen(item.id)} />
          ))}
        </div>
      )}
      {nextCursor && !error && (
        <div className="mt-6 flex justify-center">
          <Button variant="secondary" shape="pill" loading={loading} onClick={() => void load(nextCursor)}>
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
        if (!cancelled) setMore(page.tutorials.filter((entry) => entry.id !== id).slice(0, 2));
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

  return (
    <article className="mx-auto w-full max-w-[760px] px-4 pb-12 pt-[18px] sm:px-6 sm:pb-16 sm:pt-[26px]">
      <button
        type="button"
        onClick={onBack}
        className="mb-[22px] inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
      >
        <ArrowLeft size={15} /> 经验分享
      </button>
      {error ? (
        <Alert tone="danger">{error}</Alert>
      ) : !item ? (
        <ListSkeleton rows={4} />
      ) : (
        <>
          <BlogChips category={item.category} minutes={minutes} />
          <h1 className="my-3 text-[24px] font-bold leading-[1.3] tracking-[-0.01em] text-fg sm:text-[30px]">{item.title}</h1>
          <p className="mb-[18px] text-[16px] leading-[1.7] text-muted">{item.summary}</p>
          <div className="mb-7 flex flex-wrap items-center justify-between gap-3 border-y border-border py-3.5">
            <div className="flex items-center gap-2.5 text-[13.5px]">
              <BlogAvatar name={item.authorName} size={34} />
              <div>
                <b className="text-fg">{item.authorName}</b>
                <div className="text-meta text-faint">{blogLongDate(item.publishedAt)}发布</div>
              </div>
            </div>
            <Button variant="secondary" size="sm" shape="pill" onClick={copyLink}>
              <Link2 size={14} /> 复制链接
            </Button>
          </div>
          <BlogProse markdown={item.bodyMarkdown} source={PUBLIC_SOURCE} />
          <div className="mt-9 flex flex-col items-stretch justify-between gap-3 rounded-[18px] border border-border bg-surface p-[18px] sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 text-[12.5px] text-faint">
              <ShieldCheck size={15} aria-hidden /> 本文已通过内容审核 · 观点仅代表作者
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" shape="pill" onClick={copyLink}>
                <Link2 size={14} /> 复制链接
              </Button>
              <Button variant="accent" size="sm" shape="pill" onClick={onWrite}>
                <SquarePen size={14} /> 我也写一篇
              </Button>
            </div>
          </div>
          {more.length > 0 && (
            <section>
              <h2 className="mb-3 mt-[34px] text-[14px] font-bold text-fg">更多经验</h2>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {more.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onOpen(entry.id)}
                    className="flex items-center gap-3 rounded-[20px] border border-border bg-surface p-3 text-left outline-none hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <BlogCover item={entry} showChip={false} className="!aspect-auto h-14 w-[84px] shrink-0 rounded-[10px] [&_svg]:size-5" />
                    <div className="min-w-0">
                      <b className="line-clamp-2 block text-[13.5px] leading-[1.45] text-fg">{entry.title}</b>
                      <div className="mt-1 text-meta text-faint">
                        {entry.authorName} · {entry.readMinutes ?? 1} 分钟
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </article>
  );
}
