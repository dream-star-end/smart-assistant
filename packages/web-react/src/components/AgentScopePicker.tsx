import { Badge, Button } from "./ui";
import type { MarketplaceMyAgent } from "../lib/types";

const DEFAULT_SCOPE = ["main"];

export function normalizeAgentScope(ids: readonly string[] | undefined): string[] {
  // undefined means a new/legacy install and keeps the main-Agent default. An
  // explicit [] is authoritative: dependency artifacts may remain dormant after
  // their last Agent is removed and must not be visually/reactively reactivated.
  const raw = ids === undefined ? DEFAULT_SCOPE : ids;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    const trimmed = String(id || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function agentScopeLabels(
  ids: readonly string[] | undefined,
  agents: readonly MarketplaceMyAgent[],
): string[] {
  const byId = new Map(agents.map((a) => [a.id, a.name || a.slug || a.id]));
  return normalizeAgentScope(ids).map((id) => byId.get(id) || id);
}

export function AgentScopeSummary({
  agentIds,
  agents,
}: {
  agentIds?: string[];
  agents: MarketplaceMyAgent[];
}) {
  const labels = agentScopeLabels(agentIds, agents);
  if (labels.length === 0) {
    return <Badge tone="neutral">能力库中 · 暂未启用</Badge>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <Badge key={label} tone="info">
          {label}
        </Badge>
      ))}
    </span>
  );
}

export function AgentScopePicker({
  agents,
  selectedIds,
  onChange,
  disabled,
  title = "适用智能体",
  hint = "至少选择一个；未选择时默认全能助手。",
}: {
  agents: MarketplaceMyAgent[];
  selectedIds: string[];
  onChange?: (ids: string[]) => void;
  disabled?: boolean;
  title?: string;
  hint?: string;
}) {
  const selected = new Set(normalizeAgentScope(selectedIds));
  // 选中但已不在列表里的 id(已卸载 / 脏数据):此前以原始 id + 🤖 伪装成可点选项混在真实智能体里
  // (C-13)。现在单列成灰色「已卸载」徽章,只给「移除」,不再暴露开发者 id 也不能被反复勾选。
  const knownIds = new Set(agents.map((a) => a.id));
  const orphanIds = [...selected].filter((id) => !knownIds.has(id));
  const commit = (next: Set<string>) => {
    const normalized = normalizeAgentScope([...next]);
    // Don't allow clearing the last visible assignment; fall back to main.
    onChange?.(normalized.length > 0 ? normalized : [...DEFAULT_SCOPE]);
  };
  const toggle = (id: string) => {
    if (!onChange || disabled) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit(next);
  };
  const removeOrphan = (id: string) => {
    if (!onChange || disabled) return;
    const next = new Set(selected);
    next.delete(id);
    commit(next);
  };
  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface/60 p-3">
      {/* 标题与提示在窄屏上下堆叠,不再把标题挤成两行(C-35)。 */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <div className="text-sm font-medium text-fg">{title}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {agents.map((agent) => {
          const active = selected.has(agent.id);
          return (
            <Button
              key={agent.id}
              size="sm"
              variant={active ? "accent" : "secondary"}
              disabled={disabled}
              onClick={() => toggle(agent.id)}
              aria-pressed={active}
            >
              <span>{agent.avatarEmoji || (agent.isDefault ? "✨" : "🤖")}</span>
              <span>{agent.name || agent.slug || agent.id}</span>
            </Button>
          );
        })}
        {orphanIds.map((id) => (
          <span
            key={id}
            data-testid="agent-scope-orphan"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-faint"
            title={`该智能体已卸载或不存在（${id}）`}
          >
            已卸载 · {orphanLabel(id)}
            {onChange && !disabled && (
              <button
                type="button"
                aria-label={`移除已卸载的智能体 ${orphanLabel(id)}`}
                className="ml-0.5 rounded px-1 text-faint hover:text-danger [@media(hover:none)]:min-h-11"
                onClick={() => removeOrphan(id)}
              >
                移除
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 已卸载智能体的展示名:只露 id 前 8 位,避免整串开发者标识泄漏到用户界面。 */
function orphanLabel(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
