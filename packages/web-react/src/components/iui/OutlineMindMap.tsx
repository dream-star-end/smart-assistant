import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { OutlineNode, OutlineSpec } from "./schema";
import { Inline } from "./shell";

function countDesc(node: OutlineNode): number {
  return node.children.reduce((n, c) => n + 1 + countDesc(c), 0);
}

function MindSubtree({
  nodes,
  path,
  depth,
  folded,
  onToggle,
}: {
  nodes: OutlineNode[];
  path: string;
  depth: number;
  folded: Set<string>;
  onToggle: (p: string) => void;
}) {
  return (
    <ul className={cn("oc-iui-mind-children", depth > 1 && "is-deep")}>
      {nodes.map((node, j) => {
        const p = `${path}${j}.`;
        const hasKids = node.children.length > 0;
        const isFolded = folded.has(p);
        return (
          <li key={`${j}:${node.title}`} className="oc-iui-mind-node">
            <div className="oc-iui-mind-node-row">
              {hasKids ? (
                <button
                  type="button"
                  className="oc-iui-mind-toggle"
                  aria-expanded={!isFolded}
                  aria-label={`${isFolded ? "展开" : "收起"} ${node.title}`}
                  onClick={() => onToggle(p)}
                >
                  <ChevronRight size={13} aria-hidden className={cn(!isFolded && "is-open")} />
                </button>
              ) : (
                <span className="oc-iui-mind-bullet" aria-hidden />
              )}
              <div className="oc-iui-mind-node-card">
                <span className="oc-iui-mind-item">
                  <Inline text={node.title} />
                  {hasKids && isFolded && (
                    <span className="oc-iui-mind-count">+{countDesc(node)}</span>
                  )}
                </span>
                {node.detail && (
                  <span className="oc-iui-mind-sub">
                    <Inline text={node.detail} />
                  </span>
                )}
              </div>
            </div>
            {hasKids && !isFolded && (
              <MindSubtree nodes={node.children} path={p} depth={depth + 1} folded={folded} onToggle={onToggle} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 水平树状思维导图:支持最多 4 层递进展开/收起与多色彩分支连接线。 */
export function OutlineMindMap({ spec }: { spec: OutlineSpec }) {
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggle = (p: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <div className="oc-iui-mind-wrap">
      <div className="oc-iui-mind">
        <div className="oc-iui-mind-root">
          <span>{spec.title ?? "主题"}</span>
        </div>
        <svg className="oc-iui-mind-trunk-svg" viewBox="0 0 36 80" preserveAspectRatio="none" aria-hidden="true">
          <path d="M 0,40 C 18,40 18,16 36,16" />
          <path d="M 0,40 L 36,40" />
          <path d="M 0,40 C 18,40 18,64 36,64" />
        </svg>
        <div className="oc-iui-mind-branches" data-count={spec.items.length}>
          {spec.items.map((b, i) => {
            const branchPath = `${i}.`;
            const hasKids = b.children.length > 0;
            const branchFolded = folded.has(branchPath);
            return (
              <section key={`${i}:${b.title}`} className={cn("oc-iui-mind-branch", `is-tone-${i % 6}`)} aria-label={b.title}>
                <div className="oc-iui-mind-branch-head">
                  <h5 className="oc-iui-mind-head">
                    <Inline text={b.title} />
                  </h5>
                  {hasKids && (
                    <button
                      type="button"
                      className="oc-iui-mind-branch-fold"
                      aria-expanded={!branchFolded}
                      aria-label={`${branchFolded ? "展开" : "收起"}分支 ${b.title}`}
                      onClick={() => toggle(branchPath)}
                    >
                      {branchFolded ? `+${countDesc(b)}` : "▾"}
                    </button>
                  )}
                </div>
                {b.detail && (
                  <p className="oc-iui-mind-detail">
                    <Inline text={b.detail} />
                  </p>
                )}
                {hasKids && !branchFolded && (
                  <MindSubtree nodes={b.children} path={branchPath} depth={2} folded={folded} onToggle={toggle} />
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
