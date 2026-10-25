import { CalendarClock, Clock3, CodeXml, FileText, type LucideIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";
import type { AuthSession, CommunityTutorialCategory, CommunityTutorialSummary } from "../../../lib/types";
import { cn } from "../../../lib/utils";
import { ZoomableImage } from "../../chat/media";
import { Markdown } from "../../Markdown";
import { BLOG_PLACEHOLDER_GRADIENT, blogAvatar, blogCategoryLabel } from "./blogLib";

const CATEGORY_ICON: Record<CommunityTutorialCategory, LucideIcon> = {
  coding: CodeXml,
  research: FileText,
  general: CalendarClock,
};


/**
 * 图片来源:公开文章走 /api/tutorial-embeds(只有已发布的引用可读);作者预览 / 管理员复核
 * 未发布的稿件时带 Bearer 读 /api/tutorials/images,转 object URL(<img> 带不上 Authorization)。
 * 编辑器里刚上传的图还没有服务端 URL 时,用本地压缩结果的 object URL(localUrls)。
 */
export type BlogImageSource =
  | { kind: "public" }
  | { kind: "private"; auth: AuthSession; localUrls?: ReadonlyMap<string, string> };

export function blogImageUrl(sha: string): string {
  return `/api/tutorial-embeds/${sha}`;
}

function usePrivateImageUrl(source: BlogImageSource, sha: string | null): { url: string | null; failed: boolean } {
  const local = source.kind === "private" && sha ? source.localUrls?.get(sha) ?? null : null;
  const auth = source.kind === "private" ? source.auth : null;
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!auth || local || !sha) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, failed: false });
    api
      .fetchTutorialImage(auth, sha)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, failed: true });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [auth, sha, local]);
  if (!sha) return { url: null, failed: false };
  if (source.kind === "public") return { url: blogImageUrl(sha), failed: false };
  if (local) return { url: local, failed: false };
  return state;
}

export function BlogImage({
  sha,
  alt,
  source,
}: {
  sha: string;
  alt: string;
  source: BlogImageSource;
}) {
  const { url, failed } = usePrivateImageUrl(source, sha);
  return (
    // Markdown 把图片放在 <p> 里:用 span 而不是 figure,避免非法嵌套。
    <span className="blog-figure">
      {url ? (
        <ZoomableImage
          src={url}
          alt={alt}
          imgClassName="blog-figure-img"
          thumbWidth={null}
          referrerPolicy="no-referrer"
          loading="lazy"
          readOnly
        />
      ) : (
        <span className="blog-figure-ph">{failed ? "图片加载失败" : "图片加载中…"}</span>
      )}
      {alt && <span className="blog-figcaption">{alt}</span>}
    </span>
  );
}

/** 正文渲染:发布后的详情与编辑器预览共用,保证「预览即发布效果」。 */
export function BlogProse({
  markdown,
  source,
  pending,
}: {
  markdown: string;
  source: BlogImageSource;
  /** 编辑器里正在上传的图:占位 → 进度。键是 Markdown 里的占位 token。 */
  pending?: ReadonlyMap<string, number>;
}) {
  const renderImage = useCallback(
    (sha: string, image: { alt: string }) => <BlogImage sha={sha} alt={image.alt} source={source} />,
    [source],
  );
  // 上传中的占位符 `![上传中 xx%](uploading:<id>)` 不是合法图片,渲染成骨架块。
  const parts = splitUploading(markdown);
  return (
    <div className="blog-prose">
      {parts.map((part) =>
        part.kind === "text" ? (
          <Markdown key={`t${part.at}`} readOnly tutorialImage={renderImage}>
            {part.text}
          </Markdown>
        ) : (
          <div key={part.id} className="blog-figure">
            <span className="blog-figure-ph">图片上传中 {pending?.get(part.id) ?? 0}%</span>
          </div>
        ),
      )}
    </div>
  );
}

const UPLOADING_RE = /!\[[^\]\n]*\]\(uploading:([a-z0-9-]+)\)/g;

export function uploadingToken(id: string, name: string): string {
  return `![正在上传 ${name.replace(/[[\]\n]/g, " ")}](uploading:${id})`;
}

type ProsePart = { kind: "text"; text: string; at: number } | { kind: "uploading"; id: string };

function splitUploading(markdown: string): ProsePart[] {
  const out: ProsePart[] = [];
  let last = 0;
  for (const match of markdown.matchAll(UPLOADING_RE)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ kind: "text", text: markdown.slice(last, start), at: last });
    out.push({ kind: "uploading", id: match[1]! });
    last = start + match[0].length;
  }
  if (last < markdown.length || out.length === 0) out.push({ kind: "text", text: markdown.slice(last), at: last });
  return out;
}

export function BlogChips({
  category,
  minutes,
  approx = false,
  children,
}: {
  category: CommunityTutorialCategory;
  minutes: number;
  approx?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="blog-chip blog-chip-accent">{blogCategoryLabel(category)}</span>
      <span className="blog-chip">
        <Clock3 size={12} aria-hidden />
        {approx ? `约 ${minutes} 分钟` : `${minutes} 分钟读完`}
      </span>
      {children}
    </div>
  );
}

export function BlogAvatar({ name, size = 22 }: { name: string; size?: number }) {
  const avatar = blogAvatar(name);
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: avatar.color, fontSize: Math.round(size * 0.45) }}
    >
      {avatar.initial}
    </span>
  );
}

const PUBLIC: BlogImageSource = { kind: "public" };

export function BlogCover({
  item,
  className,
  showChip = true,
  source = PUBLIC,
}: {
  item: Pick<CommunityTutorialSummary, "category" | "coverSha">;
  className?: string;
  showChip?: boolean;
  /** 未发布稿件(我的投稿)的封面要带 Bearer 读。 */
  source?: BlogImageSource;
}) {
  const Icon = CATEGORY_ICON[item.category] ?? FileText;
  const { url } = usePrivateImageUrl(source, item.coverSha ?? null);
  return (
    <div
      className={cn("blog-cover", className)}
      style={url ? { backgroundImage: `url(${url})` } : { background: BLOG_PLACEHOLDER_GRADIENT[item.category] }}
    >
      {showChip && <span className="blog-chip">{blogCategoryLabel(item.category)}</span>}
      {!url && <Icon size={36} strokeWidth={1.4} aria-hidden />}
    </div>
  );
}

