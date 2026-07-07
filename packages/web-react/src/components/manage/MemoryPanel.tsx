import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { deriveMemoryTitle, joinMemoryEntries, splitMemoryEntries } from "../../lib/memoryText";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, PanelHeader } from "../ui";

type Target = "memory" | "user";
/**
 * 条目携带稳定身份(key)与基线原文(originalText):
 * - key：React key + 增删/重排后仍能对齐（不再用数组 index 判 dirty，unshift 不错位）;
 * - originalText：载入/保存时的原文，null 表示「新增未保存」→ 恒 dirty。
 * per-card dirty = text !== originalText。
 */
type Entry = { key: string; text: string; originalText: string | null };

/** 归一化用于条目去重比较（CRLF + 去首尾空白）。 */
const normEntry = (s: string) => String(s || "").replace(/\r\n/g, "\n").trim();

// 顺序有意:先共享的用户画像,后 per-agent 的核心记忆(与后端语义一致:
// user → 用户级共享文件,memory → per-agent 文件,见 storage/memoryStore.ts)。
const DOCS: { key: Target; label: string; hint: string; shared?: boolean }[] = [
  { key: "user", label: "用户画像", hint: "关于你的背景信息 · 所有智能体共享", shared: true },
  { key: "memory", label: "核心记忆", hint: "该智能体自己的观察与经验 · 按智能体独立保存" },
];

/**
 * 记忆中心：用户画像（user,**用户级共享** —— 换哪个智能体都认识你）+ 核心记忆
 *（memory,**按智能体独立** —— 各智能体自己的观察互不串扰）。每个文档是 "\n§\n"
 * 分隔的多条目,逐条卡片化编辑,保存时重新拼接为整段经容器代理写回
 *（GET/PUT /api/agents/:id/memory/:target）。智能体切换器只作用于核心记忆
 *（画像是共享文件,与所选智能体无关,不给切换器造成"画像也分身"的误导）。
 */
export function MemoryPanel({
  auth,
  agentId,
  agents,
}: {
  auth: AuthSession;
  /** 初始选中（当前对话 agent）。 */
  agentId: string;
  agents: { id: string; name: string }[];
}) {
  const [selected, setSelected] = useState(agentId);
  // 选中项必须在可选列表内（agent 刚被卸载时回落到列表首项/传入项）。
  const effective = agents.some((a) => a.id === selected) ? selected : agentId;
  const showPicker = agents.length > 1;
  return (
    <div className="flex flex-col">
      <PanelHeader title="记忆" hint="这些内容会注入智能体的长期上下文，让它越用越懂你。" />
      {DOCS.map((d) => (
        <div key={d.key} className="border-t border-border">
          <MemoryDoc
            key={`${d.shared ? "shared" : effective}:${d.key}`}
            auth={auth}
            agentId={effective}
            target={d.key}
            meta={d}
            picker={
              !d.shared && showPicker ? (
                <label className="flex items-center gap-1.5 text-[12px] text-faint">
                  智能体
                  <select
                    value={effective}
                    onChange={(e) => setSelected(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-[12.5px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}

function MemoryDoc({
  auth,
  agentId,
  target,
  meta,
  picker,
}: {
  auth: AuthSession;
  agentId: string;
  target: Target;
  meta: { label: string; hint: string };
  /** 核心记忆分区的智能体切换器(共享的用户画像不传)。 */
  picker?: React.ReactNode;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  // baseline = 最近一次已知的服务端权威态（text + 乐观锁 version），冲突并入后刷新。
  const [baseline, setBaseline] = useState<{ text: string; version: string }>({ text: "", version: "" });
  const [limit, setLimit] = useState(0); // 字符预算（来自 GET）；0 = 未知则不强制。
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // 冲突并入提示（info，非报错）。
  const nextKey = useRef(0);

  // 从整段文本切成携带稳定 key 的条目；originalText=原文 → 已保存态（不 dirty）。
  const toEntries = useCallback(
    (text: string): Entry[] =>
      splitMemoryEntries(text).map((t) => ({ key: `e${nextKey.current++}`, text: t, originalText: t })),
    [],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    setNotice(null);
    api
      .getMemory(auth, agentId, target)
      .then((d) => {
        if (!alive) return;
        const text = d.text || "";
        setEntries(toEntries(text));
        setBaseline({ text, version: d.version ?? "" });
        setLimit(typeof d.limit === "number" ? d.limit : 0);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载记忆失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, target, toEntries]);

  const current = joinMemoryEntries(entries.map((e) => e.text));
  const baselineJoined = joinMemoryEntries(splitMemoryEntries(baseline.text));
  const dirty = current !== baselineJoined;
  const nonEmpty = entries.filter((e) => e.text.trim()).length;
  const overLimit = limit > 0 && current.length > limit;

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      const text = joinMemoryEntries(entries.map((e) => e.text));
      const res = await api.putMemory(auth, agentId, target, text, baseline.version || undefined);
      if (res.ok) {
        setBaseline({ text, version: res.version });
        setEntries(toEntries(text)); // 规范化：去空条目 + originalText 归位 = 全部已保存。
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
        return;
      }
      // 版本冲突：条目级并入服务端新增内容，不自动保存，等用户确认后再存。
      const conflict = res.conflict;
      const baseSet = new Set(
        splitMemoryEntries(baseline.text).map(normEntry).filter(Boolean),
      );
      const serverAdded = splitMemoryEntries(conflict.text).filter(
        (t) => normEntry(t) && !baseSet.has(normEntry(t)),
      );
      const localSet = new Set(entries.map((e) => normEntry(e.text)).filter(Boolean));
      const toAppend = serverAdded.filter((t) => !localSet.has(normEntry(t)));
      if (toAppend.length > 0) {
        setEntries((es) => [
          ...es,
          ...toAppend.map((t) => ({ key: `e${nextKey.current++}`, text: t, originalText: t })),
        ]);
        setNotice(`智能体在你编辑期间更新了记忆，已并入 ${toAppend.length} 条新增内容，请确认后重新保存`);
      } else {
        setNotice("智能体在你编辑期间修改了记忆，已刷新基线，重新保存将以你的版本为准");
      }
      // 无论有无并入，都把基线刷新到服务端最新态（下次 PUT 带新 version 才能写入）。
      setBaseline({ text: conflict.text, version: conflict.version });
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }, [auth, agentId, target, entries, baseline.text, baseline.version, toEntries]);

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium text-fg">{meta.label}</span>
        <span className="flex items-center gap-2.5">
          <span className="text-[11.5px] text-faint">{meta.hint}</span>
          {picker}
        </span>
      </div>
      {err && (
        <Alert tone="danger" className="mt-2 text-[12.5px]">
          {err}
        </Alert>
      )}
      {notice && (
        <Alert tone="info" className="mt-2 text-[12.5px]">
          {notice}
        </Alert>
      )}
      {loading ? (
        <div className="mt-2 flex items-center gap-2 py-6 text-[13px] text-faint">
          <Loader2 size={14} className="animate-spin" /> 加载中…
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11.5px] text-faint">{nonEmpty} 条</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                setEntries((es) => [
                  { key: `e${nextKey.current++}`, text: "", originalText: null },
                  ...es,
                ])
              }
            >
              <Plus size={14} /> 新增条目
            </Button>
          </div>
          {entries.length === 0 ? (
            <p className="py-4 text-center text-[12.5px] text-faint">
              暂无{meta.label}，点「新增条目」手写补充。
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2.5">
              {entries.map((entry, index) => (
                <MemoryEntryCard
                  key={entry.key}
                  entry={entry}
                  index={index}
                  saving={saving}
                  dirty={entry.text !== entry.originalText}
                  onChange={(text) =>
                    setEntries((es) => es.map((x) => (x.key === entry.key ? { ...x, text } : x)))
                  }
                  onDelete={() => setEntries((es) => es.filter((x) => x.key !== entry.key))}
                />
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={!dirty || saving || overLimit}
              title={
                overLimit
                  ? `已超出字符预算（${current.length}/${limit}），请精简后再保存`
                  : undefined
              }
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
            <span className={cn("text-[11.5px]", overLimit ? "font-medium text-danger" : "text-faint")}>
              {current.length}
              {limit > 0 ? `/${limit}` : ""} 字符
            </span>
          </div>
        </>
      )}
    </div>
  );
}
function MemoryEntryCard({
  entry,
  index,
  saving,
  dirty,
  onChange,
  onDelete,
}: {
  entry: Entry;
  index: number;
  saving: boolean;
  dirty: boolean;
  onChange: (text: string) => void;
  onDelete: () => void;
}) {
  const title = deriveMemoryTitle(entry.text, `记忆 ${index + 1}`);
  const chars = entry.text.replace(/\r\n/g, "\n").trim().length;
  return (
    <li className="rounded-2xl border border-border bg-elevated px-3.5 py-3 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge tone="accent">#{index + 1}</Badge>
            <span className="min-w-0 truncate text-[13px] font-semibold text-fg">{title}</span>
            {dirty && <Badge tone="warning">未保存</Badge>}
          </div>
          <p className="mt-0.5 text-[11.5px] text-faint">{chars} 字符</p>
        </div>
        <button
          onClick={onDelete}
          disabled={saving}
          aria-label="删除条目"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        value={entry.text}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(6, Math.max(3, entry.text.split("\n").length + 1))}
        placeholder="一条记忆…"
        className="mt-2 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
    </li>
  );
}
