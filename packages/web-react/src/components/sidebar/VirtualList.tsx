import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PRODUCT_CAPABILITIES } from "../../lib/productCapabilities";
import { VIRTUALIZE_THRESHOLD } from "./constants";
import { type FlatItem, findIndexAtOffset, itemOffsets } from "./flattenItems";

const OVERSCAN = 6;

export function VirtualList({
  items,
  renderItem,
  onEndReached,
  threshold = VIRTUALIZE_THRESHOLD,
  className,
}: {
  items: FlatItem[];
  renderItem: (item: FlatItem) => ReactNode;
  onEndReached?: () => void;
  threshold?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const endOnceRef = useRef(false);

  useEffect(() => {
    endOnceRef.current = false;
  }, [items.length]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      setViewportH(el.clientHeight);
      setScrollTop(el.scrollTop);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const offsets = useMemo(() => itemOffsets(items), [items]);
  const total = offsets[items.length] ?? 0;
  // A CSS-hidden desktop sidebar has height zero on phones. Keep its DOM
  // bounded while hidden; ResizeObserver restores the measured window on reveal.
  const virtualize = items.length > threshold;
  const windowH = viewportH > 0 ? viewportH : 600;
  const windowTop = Math.min(scrollTop, Math.max(0, total - windowH));

  let start = 0;
  let end = items.length;
  if (virtualize) {
    start = Math.max(0, findIndexAtOffset(offsets, windowTop) - OVERSCAN);
    end = Math.min(
      items.length,
      findIndexAtOffset(offsets, windowTop + windowH) + 1 + OVERSCAN,
    );
  }
  const paddingTop = virtualize ? offsets[start] ?? 0 : 0;
  const paddingBottom = virtualize ? total - (offsets[end] ?? total) : 0;
  const visible = items.slice(start, end);

  const maybeLoadMore = (top: number, h: number) => {
    if (!onEndReached || items.length === 0) return;
    if (top + h >= total - 80) {
      if (!endOnceRef.current) {
        endOnceRef.current = true;
        onEndReached();
      }
    } else {
      endOnceRef.current = false;
    }
  };

  return (
    <div
      ref={ref}
      data-sidebar-list
      data-product-feature={PRODUCT_CAPABILITIES.sessions.id}
      data-virtualized={virtualize ? "true" : "false"}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        maybeLoadMore(el.scrollTop, el.clientHeight);
      }}
    >
      <div style={{ paddingTop, paddingBottom }}>
        {visible.map((item) => (
          <div key={item.key} data-flat-kind={item.kind} style={{ height: item.height }}>
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
