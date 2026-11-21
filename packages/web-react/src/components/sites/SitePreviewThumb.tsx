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
  "oc-icon-badge oc-icon-badge-accent",
  "oc-icon-badge oc-icon-badge-info",
  "oc-icon-badge oc-icon-badge-success",
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
        "oc-surface-recessed relative flex aspect-[16/10] w-full flex-col overflow-hidden rounded-lg",
        className,
      )}
    >
      {/* 微型浏览器顶栏 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/95 px-2.5 py-1.5">
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
          <span className="size-1.5 rounded-full bg-border-strong" />
          <span className="size-1.5 rounded-full bg-border-strong" />
          <span className="size-1.5 rounded-full bg-border-strong" />
        </span>
        <span
          className="min-w-0 flex-1 truncate rounded bg-bg/70 px-1.5 py-0.5 font-mono text-micro text-faint"
          title={hostLabel}
        >
          {hostLabel}
        </span>
      </div>

      {/* 静态内容画布 */}
      {site.visibility === "public" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-2.5 text-center">
          <span
            aria-hidden="true"
            className={cn(
              "size-8 rounded-lg text-section font-semibold",
              accentTone,
            )}
          >
            {monogram}
          </span>
          <span className="oc-badge-craft inline-flex items-center gap-1 rounded-full bg-surface/90 px-2 py-0.5 text-micro font-medium text-muted">
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
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-2 text-center">
          <span className="oc-icon-badge size-8 rounded-lg" aria-hidden="true">
            {site.visibility === "password" ? (
              <Lock size={14} className="text-muted" />
            ) : (
              <PauseCircle size={14} className="text-muted" />
            )}
          </span>
          <span className="max-w-full truncate text-caption font-medium text-faint">
            {site.visibility === "password" ? "口令保护" : "已下线"}
          </span>
        </div>
      )}
    </div>
  );
}
