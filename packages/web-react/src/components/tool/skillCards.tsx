/**
 * 技能工具(skill_list / skill_search / skill_view)的富卡渲染层。
 *
 * 数据源=前端解析 mcp-memory 拼装的现网文本(方案 B,见 toolcard-ux 设计):
 *   - skill_list  : `You have N skill(s):` + `## 分组` + 每技能 `### name\n描述\ntags: a, b`
 *   - skill_search: `Found N ... skill(s) for "q"` + `### name [source: user, score: 3]` + 同上;
 *                   无命中=`No matching skills found for "q"...`
 *   - skill_view  : `[source: xxx]` + frontmatter(name/description/version/tags)+ markdown 正文
 * 解析失败一律返回 null,调用方(MemoryBody)回退 <OutputBlock> —— 仓内铁律:失败回退,
 * 绝不裸 JSON 也不丢信息。
 */
import { Sparkles } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge, Button } from "../ui";

// ── 解析(纯函数,可单测)──────────────────────────────────────────────────

export type SkillSource = "platform" | "user";
export interface SkillEntry {
  name: string;
  description: string;
  tags: string[];
  source?: SkillSource;
}
export interface SkillListParse {
  declaredCount?: number;
  entries: SkillEntry[];
}
export interface SkillViewParse {
  source?: string;
  name?: string;
  description?: string;
  version?: string;
  tags: string[];
  body: string;
}

const LIST_HEADER_RE = /You have\s+(\d+)\s+skill\(s\)/;
const SEARCH_HEADER_RE = /Found\s+(\d+)\s+(?:relevant|matching)\s+skill\(s\)/;

function groupSourceOf(title: string): SkillSource | undefined {
  const t = title.toLowerCase();
  if (/platform|baseline|read-only|内置|平台/.test(t)) return "platform";
  if (/user|created|我的|用户/.test(t)) return "user";
  return undefined;
}

/** `name` 或 `name [source: user, score: 3]` → 名称 + 内联来源(搜索结果带 source 前缀)。 */
function parseSkillHeader(raw: string): { name: string; source?: SkillSource } {
  const m = /^(.*?)\s*\[source:\s*([^,\]]+)/.exec(raw);
  if (m) {
    const src = m[2].trim().toLowerCase();
    return { name: m[1].trim(), source: src === "platform" ? "platform" : src === "user" ? "user" : undefined };
  }
  return { name: raw.trim() };
}

/** 解析 skill_list / skill_search 命中列表文本 → 技能条目;非技能列表形态返回 null。 */
export function parseSkillList(output?: string | null): SkillListParse | null {
  const text = String(output || "").trim();
  if (!text) return null;
  const listH = LIST_HEADER_RE.exec(text);
  const searchH = SEARCH_HEADER_RE.exec(text);
  // 既无 skill 头也无任何 `### ` 条目 → 不是技能列表,交回退。
  if (!listH && !searchH && !/^###\s+/m.test(text)) return null;
  const declaredCount = listH ? Number(listH[1]) : searchH ? Number(searchH[1]) : undefined;

  const entries: SkillEntry[] = [];
  let groupSource: SkillSource | undefined;
  let cur: SkillEntry | null = null;
  const flush = () => {
    if (cur) {
      cur.description = cur.description.trim();
      entries.push(cur);
      cur = null;
    }
  };
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (t.startsWith("## ")) {
      // 分组标题(仅 list 模式有):切换后续技能的来源归属。
      flush();
      groupSource = groupSourceOf(t.slice(3));
      continue;
    }
    const h = /^###\s+(.+)$/.exec(t);
    if (h) {
      flush();
      const { name, source } = parseSkillHeader(h[1]);
      cur = { name, description: "", tags: [], source: source ?? groupSource };
      continue;
    }
    if (!cur) continue; // 头部说明 / 尾部提示行(Use `skill_view`… / Next: …)——不在任何条目内,忽略。
    if (!t) {
      flush();
      continue;
    }
    const tagsM = /^tags:\s*(.+)$/i.exec(t);
    if (tagsM) {
      cur.tags = tagsM[1].split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (/^(related_skills|matched):/i.test(t)) continue; // 搜索附带的召回元信息,不展示。
    cur.description = cur.description ? `${cur.description} ${t}` : t;
  }
  flush();
  if (entries.length === 0) return null;
  return { declaredCount, entries };
}

function frontmatterField(block: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block);
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function frontmatterTags(block: string): string[] {
  const arr = /^tags:\s*\[(.*?)\]\s*$/m.exec(block);
  if (arr) return arr[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const inline = /^tags:\s*(.+)$/m.exec(block);
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 解析 skill_view 文本 → 头部元信息 + 正文;既无来源也无 name 视为非技能视图,返回 null。 */
export function parseSkillView(output?: string | null): SkillViewParse | null {
  const text = String(output || "");
  if (!text.trim()) return null;
  let rest = text;
  let source: string | undefined;
  const srcM = /^\s*\[source:\s*([^\]]+)\]\s*/.exec(rest);
  if (srcM) {
    source = srcM[1].trim();
    rest = rest.slice(srcM[0].length);
  }
  let name: string | undefined;
  let description: string | undefined;
  let version: string | undefined;
  let tags: string[] = [];
  let body = rest;
  const fm = /^\s*---\n([\s\S]*?)\n---\n?/.exec(rest);
  if (fm) {
    body = rest.slice(fm[0].length);
    name = frontmatterField(fm[1], "name");
    description = frontmatterField(fm[1], "description");
    version = frontmatterField(fm[1], "version");
    tags = frontmatterTags(fm[1]);
  }
  body = body.trim();
  // 头卡至少要有来源或名称才算技能视图(否则可能是 skill not found 之类错误文本 → 回退)。
  if (!source && !name) return null;
  return { source, name, description, version, tags, body };
}

// ── 展示 ──────────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source?: SkillSource }) {
  if (!source) return null;
  return source === "platform" ? <Badge tone="neutral">平台</Badge> : <Badge tone="accent">我的</Badge>;
}

function SkillCard({ entry }: { entry: SkillEntry }) {
  return (
    <li className="rounded-xl border border-border bg-elevated px-3 py-2.5 shadow-soft">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 max-w-full truncate font-mono text-[13px] font-semibold text-fg">{entry.name}</span>
            <SourceBadge source={entry.source} />
          </div>
          {entry.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">{entry.description}</p>}
          {entry.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.tags.slice(0, 6).map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

const SECTION_LABEL: Record<SkillSource | "other", string> = {
  platform: "平台内置技能",
  user: "我的技能",
  other: "技能",
};

function groupBySource(entries: SkillEntry[]): { key: SkillSource | "other"; entries: SkillEntry[] }[] {
  const order: (SkillSource | "other")[] = [];
  const map = new Map<SkillSource | "other", SkillEntry[]>();
  for (const e of entries) {
    const key = e.source ?? "other";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(e);
  }
  return order.map((key) => ({ key, entries: map.get(key)! }));
}

/** 技能多时(>8)默认折叠前 8,预算按分组顺序分配。 */
const SKILL_COLLAPSE_LIMIT = 8;

function SkillListInner({ parse, mode }: { parse: SkillListParse; mode: "list" | "search" }) {
  const [expanded, setExpanded] = useState(false);
  const total = parse.entries.length;
  const collapsible = total > SKILL_COLLAPSE_LIMIT;
  const grouped = mode === "list";

  const sections = grouped ? groupBySource(parse.entries) : [{ key: "other" as const, entries: parse.entries }];
  let budget = collapsible && !expanded ? SKILL_COLLAPSE_LIMIT : Number.POSITIVE_INFINITY;
  const visible = sections
    .map((sec) => {
      const take = sec.entries.slice(0, budget);
      budget -= take.length;
      return { ...sec, entries: take };
    })
    .filter((sec) => sec.entries.length > 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
        <Sparkles size={14} className="text-accent" />
        {mode === "search"
          ? `找到 ${parse.declaredCount ?? total} 个相关技能`
          : `共有 ${parse.declaredCount ?? total} 个技能`}
      </div>
      {visible.map((sec) => (
        <div key={sec.key} className="flex flex-col gap-2">
          {grouped && <div className="text-[11.5px] font-medium text-faint">{SECTION_LABEL[sec.key]}</div>}
          <ul className="flex flex-col gap-2">
            {sec.entries.map((entry) => (
              <SkillCard key={entry.name} entry={entry} />
            ))}
          </ul>
        </div>
      ))}
      {collapsible && !expanded && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(true)}>
          展开全部 {total} 个
        </Button>
      )}
    </div>
  );
}

function SkillSearchEmpty({ query }: { query?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-elevated px-3 py-4 text-center">
      <Sparkles size={18} className="mx-auto text-faint" />
      <div className="mt-1 text-[13px] font-medium text-fg">没有找到匹配技能</div>
      {query && <p className="mt-0.5 text-[12px] text-faint">关键词:{query}</p>}
      <p className="mt-0.5 text-[12px] text-faint">换个说法再搜,或让智能体列出全部可用技能。</p>
    </div>
  );
}

function SkillViewInner({ v }: { v: SkillViewParse }) {
  const source = v.source?.toLowerCase();
  const sourceBadge: SkillSource | undefined = source === "platform" ? "platform" : source === "user" ? "user" : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-elevated p-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-[13px] font-semibold text-fg">{v.name || "(未命名技能)"}</span>
            {v.version && <Badge tone="neutral">v{v.version.replace(/^v/i, "")}</Badge>}
            <SourceBadge source={sourceBadge} />
          </div>
          {v.description && <p className="mt-0.5 text-[12px] leading-snug text-muted">{v.description}</p>}
          {v.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {v.tags.slice(0, 8).map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
      {v.body && (
        <details>
          <summary className="cursor-pointer rounded text-[11.5px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">查看技能正文</summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
            {v.body}
          </pre>
        </details>
      )}
    </div>
  );
}

// ── 渲染入口(返回 null → 调用方回退 OutputBlock)──────────────────────────

export function renderSkillListCard(output?: string | null): ReactNode | null {
  const parse = parseSkillList(output);
  if (!parse) return null;
  return <SkillListInner parse={parse} mode="list" />;
}

export function renderSkillSearchCard(output?: string | null, query?: string): ReactNode | null {
  const text = String(output || "").trim();
  if (!text) return null;
  if (/^No matching skills found/i.test(text)) return <SkillSearchEmpty query={query} />;
  const parse = parseSkillList(text);
  if (!parse) return null;
  return <SkillListInner parse={parse} mode="search" />;
}

export function renderSkillViewCard(output?: string | null): ReactNode | null {
  const v = parseSkillView(output);
  if (!v) return null;
  return <SkillViewInner v={v} />;
}
