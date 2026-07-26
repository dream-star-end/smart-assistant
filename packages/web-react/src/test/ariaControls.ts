import { expect } from "vitest";

/**
 * 通用无障碍不变量:文档里任何带 `aria-controls` 的控件,其 IDREF 都必须能解析到真实节点。
 *
 * 为什么值得单独守门:悬空 IDREF 在 DOM 上看不出任何异常 —— typecheck、快照、视觉回归
 * 全都是绿的,只有读屏会静默失败(JAWS 的「跳到被控元素」什么也不做,NVDA 读不出关联)。
 * 仓内既有约定见 SkillsPanel/DetailModal:**面板没挂载就不落 aria-controls**,
 * 本函数是这条约定的机器验收。
 *
 * 默认扫整个 document(而非 render 返回的 container):Radix 的弹层走 portal,
 * 挂在 body 上而不在 container 里。
 */
export function expectAriaControlsResolvable(root: ParentNode = document.body): void {
  const dangling = Array.from(root.querySelectorAll("[aria-controls]")).flatMap((el) =>
    (el.getAttribute("aria-controls") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((id) => document.getElementById(id) === null)
      .map((id) => {
        const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? "";
        return `<${el.tagName.toLowerCase()} ${el.getAttribute("role") ?? ""} "${name}"> → #${id}`;
      }),
  );
  expect(dangling, "aria-controls 指向了不存在的节点").toEqual([]);
}
