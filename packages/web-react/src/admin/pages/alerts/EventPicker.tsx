import { useMemo } from "react";
import { Button } from "../../../components/ui";
import { groupLabel, orderedGroups } from "./constants";
import type { EventMeta } from "./types";

/**
 * 订阅事件多选(按分组分区的复选框栅格)。受控:`value` = 已勾选 event_type 列表。
 *
 * 语义(与后端一致):空数组 = 订阅全部;非空 = 白名单。父组件在提交时决定「全勾折叠成
 * 空数组」——避免目录日后扩展了旧白名单漏收新事件(对齐 vanilla 编辑逻辑)。本组件只管勾选。
 */
export function EventPicker({
  events,
  value,
  onChange,
}: {
  events: EventMeta[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const grouped = useMemo(() => {
    const byGroup: Record<string, EventMeta[]> = {};
    for (const e of events) {
      (byGroup[e.group] ??= []).push(e);
    }
    return byGroup;
  }, [events]);

  const selected = useMemo(() => new Set(value), [value]);
  const allTypes = useMemo(() => events.map((e) => e.event_type), [events]);

  const toggle = (evType: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(evType);
    else next.delete(evType);
    onChange(Array.from(next));
  };

  if (events.length === 0) {
    return <div className="text-[12px] text-faint">事件目录未加载。</div>;
  }

  const allChecked = selected.size === allTypes.length && allTypes.length > 0;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="secondary" size="sm" onClick={() => onChange([...allTypes])}>
          全选
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onChange([])}>
          全不选
        </Button>
        <span className="text-[12px] text-faint">
          {selected.size === 0 || allChecked ? "全部订阅" : `已选 ${selected.size} / ${allTypes.length}`}
        </span>
      </div>
      <div className="max-h-[240px] space-y-3 overflow-y-auto p-3">
        {orderedGroups(Object.keys(grouped)).map((g) => (
          <fieldset key={g} className="rounded-md border border-border/70 px-3 py-2">
            <legend className="px-1 text-[11.5px] font-medium text-faint">{groupLabel(g)}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {grouped[g].map((e) => (
                <label
                  key={e.event_type}
                  className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-fg"
                  title={e.description}
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-accent"
                    checked={selected.has(e.event_type)}
                    onChange={(ev) => toggle(e.event_type, ev.target.checked)}
                  />
                  <span className="font-mono">{e.event_type}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

/** 提交时把「全勾」折叠成 `[]`(全部订阅);其余原样。 */
export function collapseEventTypes(selected: string[], allTypes: string[]): string[] {
  if (allTypes.length > 0 && selected.length === allTypes.length) return [];
  return selected;
}
