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
  const renderedAgents = [...agents];
  for (const id of selected) {
    if (!renderedAgents.some((a) => a.id === id)) {
      renderedAgents.push({ id, slug: id, name: id, description: "", installed: false });
    }
  }
  const toggle = (id: string) => {
    if (!onChange || disabled) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const normalized = normalizeAgentScope([...next]);
    // Don't allow clearing the last visible assignment; fall back to main.
    onChange(normalized.length > 0 ? normalized : [...DEFAULT_SCOPE]);
  };
  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-fg">{title}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {renderedAgents.map((agent) => {
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
      </div>
    </div>
  );
}
