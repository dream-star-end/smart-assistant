/**
 * 同花顺插件（ths）的过程区工具卡（OCV5-383）：Agent 用 `ths … --ui` 时，CLI 输出本身就是 ```ui 块，
 * 这里把它们直接渲染成行情卡 / K 线 / 分时 / 股票列表（只读）—— 过程区看到的就是 CLI 的真实输出，
 * 与回答里原样转贴的组件同源。不带 --ui 的 JSON 输出返回 null，由通用 oc 卡兜底。
 *
 * IuiBlock 在 Markdown 懒块里：这里同样懒加载，不把智能 UI 组件拉进首屏。
 */
import { Suspense, lazy } from "react";
import type { ToolLike } from "./format";

const IuiBlock = lazy(() => import("../iui/IuiBlock").then((m) => ({ default: m.IuiBlock })));

const FENCE_RE = /```ui\n([\s\S]*?)\n```/g;

/** CLI 输出里的 ```ui 块（最多 6 个；超长输出只看前 200KB）。 */
export function thsUiBlocks(output: string | null | undefined): string[] {
  if (!output) return [];
  return [...output.slice(0, 200_000).matchAll(FENCE_RE)].map((m) => m[1]!).slice(0, 6);
}

export function ThsToolCard({ tool }: { tool: ToolLike }) {
  const text =
    typeof tool.output === "string" && tool.output.trim()
      ? tool.output
      : typeof tool.bashTail?.tail === "string"
        ? tool.bashTail.tail
        : null;
  const blocks = thsUiBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="ths-tool-card">
      <Suspense fallback={<div className="h-24 animate-pulse rounded-lg bg-hover" aria-hidden />}>
        {blocks.map((code, i) => (
          <IuiBlock key={`${i}:${code.length}`} code={code} readOnly />
        ))}
      </Suspense>
    </div>
  );
}
