import { type FocusEvent, type RefObject, useEffect, useState } from "react";

/**
 * 弹层原语共用的两条键盘可达性兜底(a11y 走查 t-762 shell#7 / shell#8)。
 *
 * 1. `revealFocusedElement`:Radix FocusScope 在 Tab 回绕到首尾元素时用 `focus({ preventScroll: true })`,
 *    抽屉/弹层整体可滚时,滚出视口的 header 按钮会"拿到焦点却看不见"(MediaTaskCenter 实测:
 *    「刷新」rect.y = −432)。挂在 Content 的 onFocusCapture 上,只在目标越出 Content 可视矩形时
 *    `scrollIntoView({ block: "nearest" })` —— 已可见的目标零副作用,不会引起列表跳动。
 * 2. `useScrollBodyTabbable`:正文滚动区里没有任何可聚焦元素时(协议全文、只读说明),Firefox / Safari
 *    与 Chrome<130 无法用键盘滚动它。只在「确实溢出 且 没有可聚焦子孙」时给 tabIndex=0,
 *    避免给每个弹层多加一个无意义的 Tab 停靠点。
 */
export function revealFocusedElement(e: FocusEvent<HTMLElement>): void {
  const target = e.target;
  const container = e.currentTarget;
  if (!(target instanceof HTMLElement) || target === container) return;
  if (typeof target.scrollIntoView !== "function") return;
  const t = target.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  if (t.height === 0 && t.width === 0) return;
  if (t.top < c.top || t.bottom > c.bottom || t.left < c.left || t.right > c.right) {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export function useScrollBodyTabbable(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [tabbable, setTabbable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) {
      setTabbable(false);
      return;
    }
    const update = () => {
      const overflows = el.scrollHeight > el.clientHeight + 1;
      setTabbable(overflows && !el.querySelector(FOCUSABLE_SELECTOR));
    };
    update();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    const mo = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
    mo?.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "tabindex", "href"] });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref, active]);
  return tabbable;
}
