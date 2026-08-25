/**
 * delegate_tasks(并行 fan-out)聚合结果富卡。
 *
 * 数据源=前端解析 mcp-memory 的聚合文本(格式权威:mcp-memory/src/delegateFanout.ts
 * aggregateDelegateFanoutResults):
 *   首行 `并行委派 N 个子任务已全部返回:X 成功 / Y 失败。`
 *   每项 `### i. ✅/❌ {label} — {goal}` + 换行后的回传正文。
 * → 汇总徽标行 + 每子任务 mini 卡(agent 名 / goal / 成功失败徽标 / 结果预览折叠)。
 * 解析失败返回 null,调用方回退 <OutputBlock>。视觉紧凑度对齐 AgentGroupCard。
 */
import { CheckCircle2, Users, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui";
import { agentDisplayName } from "../chat/agentNames";

export interface FanoutItem {
  index: number;
  isError: boolean;
  label: string;
  goal: string;
  body: string;
}
export interface FanoutParse {
  total: number;
  ok: number;
  fail: number;
  items: FanoutItem[];
}

const HEADER_RE = /并行委派\s*(\d+)\s*个子任务已全部返回[::]\s*(\d+)\s*成功\s*\/\s*(\d+)\s*失败/;
// 单个子任务小节:`### 1. ✅ label — goal` 后接换行 + 正文(正文可多行)。
const SECTION_RE = /^###\s+(\d+)\.\s+(✅|❌)\s+([\s\S]*?)\s+—\s+([^\n]*)(?:\n([\s\S]*))?$/;

export function parseDelegateFanout(output?: string | null): FanoutParse | null {
  const text = String(output || "").trim();
  if (!text) return null;
  const items: FanoutItem[] = [];
  // 按小节头切块(lookahead 保留分隔行);首块可能是纯汇总头。
  for (const chunk of text.split(/\n(?=###\s+\d+\.\s)/)) {
    const m = SECTION_RE.exec(chunk.trim());
    if (!m) continue;
    items.push({
      index: Number(m[1]),
      isError: m[2] === "❌",
      label: m[3].trim(),
      goal: m[4].trim(),
      body: (m[5] || "").trim(),
    });
  }
  if (items.length === 0) return null;
  const header = HEADER_RE.exec(text);
  const ok = items.filter((it) => !it.isError).length;
  return {
    total: header ? Number(header[1]) : items.length,
    ok: header ? Number(header[2]) : ok,
    fail: header ? Number(header[3]) : items.length - ok,
    items,
  };
}

function FanoutItemCard({ item }: { item: FanoutItem }) {
  const name = agentDisplayName(item.label) || item.label || "子任务";
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5",
        item.isError ? "border-danger-soft bg-danger-soft/40" : "border-border bg-surface",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-px shrink-0">
          {item.isError ? (
            <XCircle size={14} aria-hidden="true" className="text-danger" />
          ) : (
            <CheckCircle2 size={14} aria-hidden="true" className="text-success" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-medium text-fg">{name}</span>
            <Badge tone={item.isError ? "danger" : "success"}>{item.isError ? "失败" : "完成"}</Badge>
          </div>
          {item.goal && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">{item.goal}</p>}
          {item.body && (
            <details className="mt-1">
              <summary className="cursor-pointer rounded text-[11.5px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">查看结果</summary>
              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
                {item.body}
              </pre>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

export function renderDelegateFanoutCard(output?: string | null): ReactNode | null {
  const parse = parseDelegateFanout(output);
  if (!parse) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
        <Users size={14} className="text-accent" />
        并行委派 {parse.total} 个子任务
        <Badge tone="success">{parse.ok} 成功</Badge>
        {parse.fail > 0 && <Badge tone="danger">{parse.fail} 失败</Badge>}
      </div>
      <ul className="flex flex-col gap-2">
        {parse.items.map((item) => (
          <FanoutItemCard key={item.index} item={item} />
        ))}
      </ul>
    </div>
  );
}
