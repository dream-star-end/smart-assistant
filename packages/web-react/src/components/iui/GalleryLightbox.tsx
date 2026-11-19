import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";
import { Media } from "./shell";

export function GalleryLightbox({
  images,
  index,
  title,
  onClose,
  onChange,
}: {
  images: { src: string; caption?: string }[];
  index: number;
  title?: string;
  onClose: () => void;
  onChange: (idx: number) => void;
}) {
  const total = images.length;
  const cur = ((index % total) + total) % total;
  const current = images[cur];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && total > 1) onChange((cur - 1 + total) % total);
      else if (e.key === "ArrowRight" && total > 1) onChange((cur + 1) % total);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cur, total, onClose, onChange]);

  if (!current) return null;

  const content = (
    <div
      className="oc-iui-lightbox"
      // biome-ignore lint/a11y/useSemanticElements: portal overlay styled as div without native dialog UA layout
      role="dialog"
      aria-modal="true"
      aria-label={title ? `${title} · 图片预览` : "图片预览"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="oc-iui-lightbox-bar">
        <span className="oc-iui-lightbox-counter">
          {cur + 1} / {total}
        </span>
        <button type="button" className="oc-iui-lightbox-close" aria-label="关闭预览" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="oc-iui-lightbox-stage">
        {total > 1 && (
          <button
            type="button"
            className="oc-iui-lightbox-nav is-prev"
            aria-label="上一张"
            onClick={() => onChange((cur - 1 + total) % total)}
          >
            <ChevronLeft size={20} aria-hidden />
          </button>
        )}
        <figure className="oc-iui-lightbox-figure">
          <Media src={current.src} alt={current.caption ?? `图片 ${cur + 1}`} className="oc-iui-lightbox-img" />
          {current.caption && <figcaption className="oc-iui-lightbox-cap">{current.caption}</figcaption>}
        </figure>
        {total > 1 && (
          <button
            type="button"
            className="oc-iui-lightbox-nav is-next"
            aria-label="下一张"
            onClick={() => onChange((cur + 1) % total)}
          >
            <ChevronRight size={20} aria-hidden />
          </button>
        )}
      </div>
      {total > 1 && (
        <div className="oc-iui-lightbox-thumbs" role="tablist" aria-label="缩略图导航">
          {images.map((im, i) => (
            <button
              key={`${i}:${im.src}`}
              type="button"
              role="tab"
              aria-selected={i === cur}
              aria-label={`查看第 ${i + 1} 张`}
              className={cn("oc-iui-lightbox-thumb", i === cur && "is-active")}
              onClick={() => onChange(i)}
            >
              <Media src={im.src} alt={im.caption ?? `缩略图 ${i + 1}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}
