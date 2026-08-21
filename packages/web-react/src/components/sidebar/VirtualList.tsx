import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
    const sync = () => setViewportH(el.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const offsets = itemOffsets(items);
  const total = offsets[items.length] ?? 0;
  const virtualize = items.length > threshold && viewportH > 0;

  let start = 0;
  let end = items.length;
  if (virtualize) {
    start = Math.max(0, findIndexAtOffset(offsets, scrollTop) - OVERSCAN);
    end = Math.min(
      items.length,
      findIndexAtOffset(offsets, scrollTop + viewportH) + 1 + OVERSCAN,
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
