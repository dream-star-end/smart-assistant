import type { ReactNode } from "react";
import {
  CONTEXT_RAIL_MODULES,
  type ContextRailModuleId,
} from "../../lib/contextRail/modules";
import { Button } from "../ui";

/**
 * xl 右栏壳。只渲染注册表里 hasData 的模块；一个都没有就返回 null（不占宽）。
 * PR8 往 `CONTEXT_RAIL_MODULES` 加 id，并在 `renderers` 补节点即可，不必改本壳布局。
 */
export function ContextRail({
  renderers,
  onHide,
}: {
  renderers: Record<ContextRailModuleId, ReactNode>;
  onHide: () => void;
}) {
  const nodes: { id: ContextRailModuleId; node: ReactNode }[] = [];
  for (const mod of CONTEXT_RAIL_MODULES) {
    const node = renderers[mod.id];
    if (node == null || node === false) continue;
    nodes.push({ id: mod.id, node });
  }

  if (nodes.length === 0) return null;

  return (
    <aside
      data-testid="context-rail"
      aria-label="上下文"
      className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-l border-border bg-bg"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-meta font-medium text-faint">上下文</span>
        <Button size="sm" variant="ghost" onClick={onHide}>
          隐藏上下文
        </Button>
      </div>
      <div className="flex flex-col gap-3 px-3 pb-3">
        {nodes.map((row) => (
          <section key={row.id}>{row.node}</section>
        ))}
      </div>
    </aside>
  );
}
