/**
 * Intelligent UI 视觉类组件:图片卡片列表、图片拼贴、色板、彩色方块网格。
 * 图片统一走 shell 的 Media(https 或容器文件,失败显示图标色块)。
 */
import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { CardsSpec, GallerySpec, SwatchesSpec, TilesSpec } from "./schema";
import { Frame, Glyph, Inline, Media } from "./shell";
import { specToMarkdown } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean };

// ── 卡片列表 ──────────────────────────────────────────────────────────

export function CardsBlock({ spec, notes, streaming, nested }: BlockProps<CardsSpec>) {
  return (
    <Frame
      kind="cards"
      title={spec.title}
      subtitle={spec.subtitle}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec)}
    >
      {/* 网格列数跟着条数走:能被 3 整除用 3 列(宽屏),否则 2 列,不留孤零零的一格。 */}
      <ul className={cn("oc-iui-cards", spec.layout === "grid" ? "is-grid" : "is-list", spec.layout === "grid" && spec.items.length % 3 === 0 && "is-cols-3")}>
        {spec.items.map((it, i) => {
          const body = (
            <>
              <Media
                src={it.image}
                alt={it.title}
                icon={it.icon}
                fallbackText={it.title}
                className={cn("oc-iui-card-media", !it.image && `is-tone-${i % 6}`)}
              />
              <span className="oc-iui-card-text">
                <span className="oc-iui-card-title">
                  <Inline text={it.title} />
                  {it.url && <ArrowUpRight size={14} aria-hidden className="oc-iui-card-link" />}
                </span>
                {it.subtitle && <span className="oc-iui-card-sub">{it.subtitle}</span>}
                {it.body && (
                  <span className="oc-iui-card-body">
                    <Inline text={it.body} />
                  </span>
                )}
                {(it.tags.length > 0 || it.meta) && (
                  <span className="oc-iui-card-tags">
                    {it.meta && <span className="oc-iui-card-meta">{it.meta}</span>}
                    {it.tags.map((t) => (
                      <span key={t} className="oc-iui-chip">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={`${i}:${it.title}`} className="oc-iui-card-item">
              {it.url ? (
                <a className="oc-iui-card-inner is-link" href={it.url} target="_blank" rel="noreferrer">
                  {body}
                </a>
              ) : (
                <div className="oc-iui-card-inner">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

// ── 图片拼贴 ──────────────────────────────────────────────────────────

export function GalleryBlock({ spec, notes, streaming, nested }: BlockProps<GallerySpec>) {
  const shown = spec.images.slice(0, 3);
  const extra = spec.images.length - shown.length;
  return (
    <Frame
      kind="gallery"
      title={spec.title}
      subtitle={spec.subtitle}
      note={spec.caption}
      notes={notes}
      streaming={streaming}
      nested={nested}
      bare={!spec.title}
      copyText={() => specToMarkdown(spec)}
    >
      <div className="oc-iui-gallery" data-count={shown.length}>
        {shown.map((im, i) => (
          <figure key={`${i}:${im.src}`} className="oc-iui-gallery-item">
            <Media src={im.src} alt={im.caption ?? `图片 ${i + 1}`} />
            {i === shown.length - 1 && extra > 0 && <span className="oc-iui-gallery-more">+{extra}</span>}
            {im.caption && shown.length === 1 && <figcaption className="oc-iui-gallery-caption">{im.caption}</figcaption>}
          </figure>
        ))}
      </div>
    </Frame>
  );
}

// ── 色板 ──────────────────────────────────────────────────────────────

export function SwatchesBlock({ spec, notes, streaming, nested }: BlockProps<SwatchesSpec>) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <Frame
      kind="swatches"
      title={spec.title}
      subtitle={spec.subtitle}
      notes={notes}
      streaming={streaming}
      nested={nested}
      bare={!spec.title}
      copyText={() => specToMarkdown(spec)}
    >
      <ul className="oc-iui-swatches">
        {spec.colors.map((c, i) => (
          <li key={`${i}:${c.hex}`}>
            <button
              type="button"
              className="oc-iui-swatch-btn"
              aria-label={`${c.name ?? c.hex},复制色值 ${c.hex}`}
              title={`复制 ${c.hex}`}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(c.hex);
                  setCopied(c.hex);
                  setTimeout(() => setCopied(null), 1400);
                } catch {
                  /* 剪贴板不可用 */
                }
              }}
            >
              <span className="oc-iui-swatch-dot" style={{ background: c.hex }}>
                {copied === c.hex && <Check size={16} strokeWidth={3} aria-hidden />}
              </span>
              <span className="oc-iui-swatch-name">{c.name ?? c.hex}</span>
              <span className="oc-iui-swatch-hex">{c.hex}</span>
            </button>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

// ── 彩色方块网格 ──────────────────────────────────────────────────────

export function TilesBlock({ spec, notes, streaming, nested }: BlockProps<TilesSpec>) {
  return (
    <Frame
      kind="tiles"
      title={spec.title}
      subtitle={spec.subtitle}
      note={spec.caption}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec)}
    >
      <ul className="oc-iui-tiles" style={{ gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))` }}>
        {spec.items.map((t, i) => (
          <li key={`${i}:${t.title}`} className={`oc-iui-tile is-${t.tone}`} style={t.span > 1 ? { gridColumn: `span ${t.span}` } : undefined}>
            <span className="oc-iui-tile-icon">
              <Glyph icon={t.icon} fallback={t.title} size={22} />
            </span>
            <span className="oc-iui-tile-title">
              <Inline text={t.title} />
            </span>
            {t.subtitle && <span className="oc-iui-tile-sub">{t.subtitle}</span>}
          </li>
        ))}
      </ul>
    </Frame>
  );
}
