import { Globe, Lock, PauseCircle, Server } from "lucide-react";
import type { UserSiteItem } from "../../lib/types";
import { cn } from "../../lib/utils";

/**
 * 站点列表/详情轻量静态预览缩略图（零 iframe 开销）：
 * 此前每个公开站点都在列表页挂载 `<iframe sandbox="allow-scripts">`，站点多时会并行拉起
 * 十几个第三方页面 JS 运行时，严重拖慢列表渲染并产生不可控外链请求。
 * 现改为纯语义 token 绘制的微型浏览器卡片（域名栏 + 标题首字徽章 + 状态/全栈标识）；
 * 需要交互浏览时直接从站点详情点击「实时编辑」或「访问」。
 */
function slugHueIndex(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h % 3;
}

const ACCENT_SURFACE_CLASSES = [
  "bg-accent-soft/50 text-accent",
  "bg-info-soft/60 text-info",
  "bg-success-soft/50 text-success",
] as const;

export function SitePreviewThumb({
  site,
  baseDomain,
  className,
}: {
  site: UserSiteItem;
  baseDomain: string;
  className?: string;
}) {
  const hostLabel =
    site.customDomain && site.customDomainStatus === "verified"
      ? site.customDomain
      : `${site.slug}.${baseDomain}`;
  const monogram = (site.title || site.slug || "S").trim().slice(0, 1).toUpperCase();
  const accentTone = ACCENT_SURFACE_CLASSES[slugHueIndex(site.slug)];

  return (
    <div
      data-testid="site-preview-thumb"
      className={cn(
        "relative flex aspect-[16/10] w-full flex-col overflow-hidden rounded-lg border border-border bg-bg-subtle",
        className,
      )}
    >
      {/* 微型浏览器顶栏 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/90 px-2 py-1">
        <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
          <span className="size-1.5 rounded-full bg-border-strong" />
          <span className="size-1.5 rounded-full bg-border-strong" />
          <span className="size-1.5 rounded-full bg-border-strong" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint" title={hostLabel}>
          {hostLabel}
        </span>
      </div>

      {/* 静态内容画布 */}
      {site.visibility === "public" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-2.5 text-center">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-7 items-center justify-center rounded-md text-caption font-semibold",
              accentTone,
            )}
          >
            {monogram}
          </span>
          <span className="inline-flex items-center gap-1 text-micro text-faint">
            {site.hasServerApi ? (
              <>
                <Server size={10} aria-hidden="true" />
                全栈站点
              </>
            ) : (
              <>
                <Globe size={10} aria-hidden="true" />
                在线公开
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-2 text-center">
          {site.visibility === "password" ? (
            <Lock size={15} className="text-faint" aria-hidden="true" />
          ) : (
            <PauseCircle size={15} className="text-faint" aria-hidden="true" />
          )}
          <span className="max-w-full truncate text-caption text-faint">
            {site.visibility === "password" ? "口令保护" : "已下线"}
          </span>
        </div>
      )}
    </div>
  );
}
