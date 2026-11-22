import { Check, Code2, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../../lib/utils";

/**
 * 审计 diff 工具 —— 与 vanilla admin.js `_shallowEq` / `_formatJsonValue` 语义等价。
 * 只做**顶层字段**对比,不递归深 diff(权威:renderAuditTab/openAuditDiffModal)。
 */

/**
 * 顶层浅比较。基本类型(string/number/boolean/null)走 `===`;对象/数组按
 * `JSON.stringify` 序列化比较(检测任意结构变化,但不逐字段展开)。
 */
export function shallowEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // 一方 null/undefined、另一方非空 → 判不等(=== 已排除两侧同为 null/undefined 的情况)
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  // 基本类型不等(=== 已处理相等)
  return false;
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "object" && value !== null) {
    return `${Object.keys(value).length} 字段`;
  }
  return typeof value;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 单值渲染(`_formatJsonValue`):
 *  - string / number / boolean → 等宽直显;
 *  - object / array → IDE 级 `.oc-code-shell` + `<pre>` JSON 块（`bare` 时输出纯 `<pre>`）；
 *  - null → `null` 胶囊；undefined(字段缺失)→ 占位破折号。
 */
export function FormatJsonValue({
  value,
  bare = false,
  tone = "neutral",
}: {
  value: unknown;
  bare?: boolean;
  tone?: "neutral" | "removed" | "added";
}): ReactNode {
  if (value === undefined) return <span className="font-mono text-meta text-faint">—</span>;
  if (value === null) {
    return (
      <span className="rounded bg-hover px-1.5 py-0.5 font-mono text-caption text-faint">null</span>
    );
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return (
      <span
        className={cn(
          "break-words font-mono text-meta tabular-nums",
          tone === "removed" && "text-danger",
          tone === "added" && "text-success",
          tone === "neutral" && "text-fg",
        )}
      >
        {String(value)}
      </span>
    );
  }

  const formatted = stringifyJson(value);
  if (bare) {
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-meta leading-relaxed text-fg tabular-nums">
        {formatted}
      </pre>
    );
  }

  return (
    <div className="oc-code-shell rounded-lg">
      <div className="oc-code-shell-header flex items-center justify-between gap-2 px-2.5 py-1.5 text-caption text-faint">
        <span className="font-mono font-medium uppercase tracking-wide">JSON</span>
        <span className="font-mono tabular-nums">{summarizeValue(value)}</span>
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-meta leading-relaxed text-fg tabular-nums">
        {formatted}
      </pre>
    </div>
  );
}

/** IDE 级 JSON 载荷外壳：微凹标题条 + 字段计数 + 一键复制 + 等宽滚动内容区。 */
export function PayloadShell({
  title,
  value,
  meta,
  className,
}: {
  title: string;
  value: unknown;
  meta?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const isStructured = typeof value === "object" && value !== null;
  const rawText =
    value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : stringifyJson(value);

  const handleCopy = async () => {
    if (!rawText) return;
    try {
      await navigator.clipboard?.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // 忽略剪贴板不可用环境（如无权限 / JSDOM）
    }
  };

  return (
    <div className={cn("oc-code-shell", className)}>
      <div className="oc-code-shell-header flex items-center justify-between gap-2 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Code2 size={14} className="shrink-0 text-faint" aria-hidden="true" />
          <span className="truncate font-mono text-meta font-semibold text-fg">{title}</span>
          {isStructured && (
            <span className="oc-badge-craft rounded-full bg-hover px-2 py-0.5 font-mono text-caption text-muted tabular-nums">
              {summarizeValue(value)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {meta}
          {rawText && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={`复制 ${title}`}
              title={`复制 ${title}`}
              className="oc-icon-btn-tactile inline-flex items-center gap-1 rounded-md px-2 py-1 text-caption font-medium text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {copied ? (
                <>
                  <Check size={12.5} className="text-success" />
                  <span className="text-success">已复制</span>
                </>
              ) : (
                <>
                  <Copy size={12.5} />
                  <span>复制</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
      {isStructured ? (
        <FormatJsonValue value={value} bare />
      ) : (
        <div className="px-3.5 py-3">
          <FormatJsonValue value={value} bare />
        </div>
      )}
    </div>
  );
}

export interface DiffRow {
  key: string;
  before: unknown;
  after: unknown;
  /** shallowEq 判不等 → 变更字段,行需高亮。 */
  changed: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 合并 before/after 的顶层 key 并排序,逐 key 生成对比行。
 * 若两侧都不是普通对象(如 before=null / after=数组 / 基本类型),回落成单行「值」整体对比。
 */
export function buildDiffRows(before: unknown, after: unknown): DiffRow[] {
  const bRec = isRecord(before);
  const aRec = isRecord(after);
  if (!bRec && !aRec) {
    return [{ key: "值", before, after, changed: !shallowEq(before, after) }];
  }
  const keys = new Set<string>();
  if (bRec) for (const k of Object.keys(before)) keys.add(k);
  if (aRec) for (const k of Object.keys(after)) keys.add(k);
  return [...keys].sort().map((k) => {
    const bv = bRec ? (before as Record<string, unknown>)[k] : undefined;
    const av = aRec ? (after as Record<string, unknown>)[k] : undefined;
    return { key: k, before: bv, after: av, changed: !shallowEq(bv, av) };
  });
}

/** IDE 级并排字段变更对比区：微凹标题条 + 增删语义色层次 + 变更行高亮。 */
export function DiffTable({ rows }: { rows: DiffRow[] }) {
  const changedCount = rows.filter((r) => r.changed).length;

  return (
    <div className="oc-code-shell">
      <div className="oc-code-shell-header flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Code2 size={14} className="shrink-0 text-faint" aria-hidden="true" />
          <span className="font-mono text-meta font-semibold text-fg">字段变更对比</span>
          <span className="oc-badge-craft rounded-full bg-hover px-2 py-0.5 font-mono text-caption text-muted tabular-nums">
            共 {rows.length} 项
          </span>
          <span
            className={cn(
              "oc-badge-craft rounded-full px-2 py-0.5 font-mono text-caption tabular-nums",
              changedCount > 0 ? "bg-warning-soft text-warning" : "bg-hover text-faint",
            )}
          >
            {changedCount > 0 ? `${changedCount} 项变更` : "无变更"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-caption">
          <span className="oc-badge-craft rounded-full bg-danger-soft px-2 py-0.5 text-danger">
            − 变更前
          </span>
          <span className="oc-badge-craft rounded-full bg-success-soft px-2 py-0.5 text-success">
            + 变更后
          </span>
        </div>
      </div>

      <div className="overflow-x-auto bg-surface">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-sidebar/70 dark:bg-elevated/70">
              <th className="w-32 whitespace-nowrap px-3.5 py-2 text-left text-caption font-semibold uppercase tracking-wide text-faint">
                字段
              </th>
              <th className="px-3.5 py-2 text-left text-caption font-semibold uppercase tracking-wide text-danger">
                变更前
              </th>
              <th className="px-3.5 py-2 text-left text-caption font-semibold uppercase tracking-wide text-success">
                变更后
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.key}
                data-testid={`diff-row-${d.key}`}
                data-changed={String(d.changed)}
                className={
                  d.changed
                    ? "border-b border-border/60 bg-warning-soft last:border-0"
                    : "border-b border-border/60 last:border-0 hover:bg-hover/40"
                }
              >
                <td className="px-3.5 py-2.5 align-top font-mono text-meta break-all">
                  <div className="flex items-start gap-1.5">
                    {d.changed && (
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning"
                      />
                    )}
                    <span className={d.changed ? "font-semibold text-fg" : "text-muted"}>
                      {d.key}
                    </span>
                  </div>
                </td>
                <td className="px-3.5 py-2.5 align-top text-body text-fg">
                  {d.changed && d.before !== undefined ? (
                    <div className="flex items-start gap-1.5 rounded-md border border-danger/25 bg-danger-soft px-2 py-1">
                      <span
                        aria-hidden="true"
                        className="select-none font-mono text-meta font-semibold text-danger"
                      >
                        −
                      </span>
                      <div className="min-w-0 flex-1">
                        <FormatJsonValue value={d.before} tone="removed" />
                      </div>
                    </div>
                  ) : (
                    <FormatJsonValue value={d.before} />
                  )}
                </td>
                <td className="px-3.5 py-2.5 align-top text-body text-fg">
                  {d.changed && d.after !== undefined ? (
                    <div className="flex items-start gap-1.5 rounded-md border border-success/25 bg-success-soft px-2 py-1">
                      <span
                        aria-hidden="true"
                        className="select-none font-mono text-meta font-semibold text-success"
                      >
                        +
                      </span>
                      <div className="min-w-0 flex-1">
                        <FormatJsonValue value={d.after} tone="added" />
                      </div>
                    </div>
                  ) : (
                    <FormatJsonValue value={d.after} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
