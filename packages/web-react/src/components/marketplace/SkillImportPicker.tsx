import { ChevronDown, FileCode2, Loader2, Search } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import type { SkillSummary } from "../../lib/types";
import { Button, Input } from "../ui";

/** Optional import, not a second catalogue competing with the publishing form. */
export function SkillImportPicker({ skills, importing, onSelect }: {
  skills: SkillSummary[];
  importing: string | null;
  onSelect: (skill: SkillSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return skills.filter((skill) =>
      [skill.name, skill.description, ...(skill.tags ?? [])]
        .filter(Boolean).join(" ").toLocaleLowerCase().includes(q),
    );
  }, [skills, query]);

  return (
    <div className="marketplace-import-picker w-full min-w-0">
      <Button
        variant="secondary"
        className="flex w-full min-w-0 justify-start gap-2.5"
        aria-label="选择已有技能"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md" aria-hidden="true">
          <FileCode2 size={13} strokeWidth={1.85} />
        </span>
        <span>选择已有技能</span>
        <span className="oc-badge-craft ml-auto rounded-full bg-hover px-2 py-0.5 text-caption font-medium tabular-nums text-muted">
          {skills.length} 项
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.85}
          aria-hidden="true"
          className={open ? "rotate-180 transition-transform duration-150" : "transition-transform duration-150"}
        />
      </Button>
      {open && (
        <div id={id} className="marketplace-import-body oc-surface-card mt-2 min-w-0 rounded-xl p-3">
          <div className="group relative">
            <Search
              size={15}
              strokeWidth={1.8}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint transition-colors duration-150 group-focus-within:text-accent"
            />
            <Input
              type="search"
              aria-label="搜索我的技能"
              placeholder="按名称、说明或标签搜索"
              className="pl-9"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(50);
                if (list.current) list.current.scrollTop = 0;
              }}
            />
          </div>
          <p className="my-2 text-caption tabular-nums text-muted" role="status">
            {matches.length ? `找到 ${matches.length} 项技能，选择后填入下方表单` : "没有找到匹配的技能"}
          </p>
          <div
            ref={list}
            className="marketplace-import-list oc-surface-recessed flex max-h-60 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain rounded-lg p-1.5 [scrollbar-gutter:stable]"
            aria-busy={importing !== null}
          >
            {matches.slice(0, limit).map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                className="oc-btn-tactile flex min-h-11 w-full min-w-0 shrink-0 items-start gap-2.5 rounded-md border border-transparent p-2.5 text-left outline-none enabled:hover:border-border/80 enabled:hover:bg-surface enabled:hover:shadow-soft focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait disabled:opacity-50"
                aria-label={`导入 ${skill.name}`}
                aria-describedby={skill.description ? `${id}-desc-${index}` : undefined}
                disabled={importing !== null}
                onClick={() => onSelect(skill)}
              >
                <span
                  aria-hidden="true"
                  className={
                    importing === skill.name
                      ? "oc-icon-badge oc-icon-badge-accent mt-0.5 size-7 rounded-md"
                      : "oc-icon-badge mt-0.5 size-7 rounded-md"
                  }
                >
                  {importing === skill.name
                    ? <Loader2 size={14} strokeWidth={1.85} className="animate-spin" />
                    : <FileCode2 size={14} strokeWidth={1.85} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-meta font-semibold tracking-tight text-fg" title={skill.name}>
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span
                      id={`${id}-desc-${index}`}
                      className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-muted [overflow-wrap:anywhere]"
                      title={skill.description}
                    >
                      {skill.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
            {matches.length > limit && (
              <Button variant="ghost" size="sm" onClick={() => setLimit((value) => value + 50)}>
                显示更多（已显示 {limit} / {matches.length}）
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
