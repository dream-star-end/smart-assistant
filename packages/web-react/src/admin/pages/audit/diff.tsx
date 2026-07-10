import type { ReactNode } from "react";

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

/**
 * 单值渲染(`_formatJsonValue`):
 *  - string / number / boolean → 直显;
 *  - object / array → 等宽 `<pre>` + `JSON.stringify(v, null, 2)`;
 *  - null → `null`;undefined(字段缺失)→ 占位破折号。
 */
export function FormatJsonValue({ value }: { value: unknown }): ReactNode {
  if (value === undefined) return <span className="text-faint">—</span>;
  if (value === null) return <span className="text-faint">null</span>;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return <span className="break-words tabular-nums">{String(value)}</span>;
  }
  return (
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-hover px-2 py-1.5 font-mono text-[12px] leading-relaxed text-fg">
      {JSON.stringify(value, null, 2)}
    </pre>
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
