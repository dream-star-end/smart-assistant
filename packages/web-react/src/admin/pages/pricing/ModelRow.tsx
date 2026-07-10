import { useState } from "react";
import { Badge, Button, Input, Switch, useToast } from "../../../components/ui";
import { SelectFilter } from "../../components";
import { fmtCompactNum, fmtDateTime, usageLine } from "./helpers";
import {
  type Inflight,
  type ModelRowData,
  PRICE_FIELDS,
  type PriceField,
  VISIBILITY_OPTIONS,
} from "./types";

export type PriceChange = { field: PriceField; label: string; from: string; to: string };

function InflightBadge({ fl, startedAt }: { fl: Inflight | null; startedAt: string | null }) {
  if (!fl) {
    return (
      <Badge tone="neutral" title="该模型暂无并发记录">
        —
      </Badge>
    );
  }
  const cur = Number(fl.current ?? 0);
  const peakTitle =
    `峰值自 egress 启动累计,重启归零${startedAt ? `(启动于 ${fmtDateTime(startedAt)})` : ""}` +
    (fl.peak_at ? `;峰值出现于 ${fmtDateTime(fl.peak_at)}` : "");
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={cur > 0 ? "success" : "neutral"}>{cur}</Badge>
      <span className="text-[11px] text-faint" title={peakTitle}>
        峰值 {fl.peak ?? 0}
      </span>
    </span>
  );
}

/**
 * 模型行内编辑行。draft 全程 live(与 vanilla 一致,无独立「编辑态」)。
 * 30s 并发轮询只改 inflight prop → 本行重渲染但 draft 不丢(组件不被父 remount)。
 * 保存成功后由父按 nonce remount 本行 → draft 复位为最新权威值。
 */
export function ModelRow({
  model,
  inflight,
  startedAt,
  onSavePricing,
  onToggleEnabled,
  onOpenExtra,
}: {
  model: ModelRowData;
  inflight: Inflight | null;
  startedAt: string | null;
  onSavePricing: (patch: Record<string, unknown>, changes: PriceChange[]) => Promise<void>;
  onToggleEnabled: (next: boolean) => Promise<void>;
  onOpenExtra: () => void;
}) {
  const toast = useToast();
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(PRICE_FIELDS.map(([f]) => [f, String(model[f] ?? 0)])),
  );
  const [multiplier, setMultiplier] = useState(String(model.multiplier ?? ""));
  const [displayName, setDisplayName] = useState(model.display_name ?? "");
  const [visibility, setVisibility] = useState(model.visibility);
  const [effort, setEffort] = useState(model.default_effort ?? "");
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const effApplicable = model.effort.applicable !== false;
  const allowed = model.effort.allowed ?? [];
  const effValues =
    model.default_effort && !allowed.includes(model.default_effort)
      ? [...allowed, model.default_effort]
      : allowed;

  const buildAndSave = async () => {
    const patch: Record<string, unknown> = {};
    const changes: PriceChange[] = [];
    for (const [f, label] of PRICE_FIELDS) {
      const raw = (prices[f] ?? "").trim();
      if (!/^\d{1,12}$/.test(raw)) {
        toast(`${label}必须是非负整数(分/Mtok)`, "error");
        return;
      }
      const from = String(model[f] ?? "0");
      if (raw !== from) {
        patch[f] = Number(raw);
        changes.push({ field: f, label, from, to: raw });
      }
    }
    const mult = multiplier.trim();
    if (!/^\d+(\.\d{1,3})?$/.test(mult)) {
      toast("multiplier 格式不对(如 2.000)", "error");
      return;
    }
    if (mult !== String(model.multiplier ?? "")) patch.multiplier = mult;
    const dn = displayName.trim();
    if (dn === "") {
      if (String(model.display_name ?? "").trim() !== "") {
        toast("显示名不能为空,已保留原值", "info");
      }
    } else if (dn !== String(model.display_name ?? "").trim()) {
      patch.display_name = dn;
    }
    if (visibility && visibility !== model.visibility) patch.visibility = visibility;
    if (effApplicable) {
      const effVal = effort === "" ? null : effort;
      if (effVal !== (model.default_effort ?? null)) patch.default_effort = effVal;
    }
    if (Object.keys(patch).length === 0) {
      toast("没有改动", "info");
      return;
    }
    // 乐观并发:GET 拿到的整数版本号原样回传(价格列后端强制,其余选发亦无害)。
    patch.if_match_lock_version = model.lock_version;
    setSaving(true);
    try {
      await onSavePricing(patch, changes);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (next: boolean) => {
    setToggling(true);
    try {
      await onToggleEnabled(next);
    } finally {
      setToggling(false);
    }
  };

  const cellInput =
    "h-8 w-full min-w-[5.5rem] text-[13px] tabular-nums";

  return (
    <tr className="border-b border-border/60 last:border-0">
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-fg">{model.model_id}</td>
      <td className="px-3 py-2">
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={120}
          placeholder="—"
          className="h-8 w-full min-w-[8rem] text-[13px]"
        />
      </td>
      <td className="px-3 py-2">
        <span className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-[11px] text-muted">
          {model.provider.id || "—"}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <InflightBadge fl={inflight} startedAt={startedAt} />
      </td>
      <td
        className="whitespace-nowrap px-3 py-2 text-[12px] text-muted"
        title={
          model.usage
            ? `7d: ${usageLine(model.usage.d7)}\ncache_read: 24h ${fmtCompactNum(model.usage.d1.cache_read_tokens)} · 7d ${fmtCompactNum(model.usage.d7.cache_read_tokens)}`
            : undefined
        }
      >
        {model.usage ? usageLine(model.usage.d1) : "—"}
      </td>
      {PRICE_FIELDS.map(([f]) => (
        <td key={f} className="px-3 py-2">
          <Input
            type="number"
            min={0}
            step={1}
            value={prices[f] ?? ""}
            onChange={(e) => setPrices((p) => ({ ...p, [f]: e.target.value }))}
            className={cellInput}
          />
        </td>
      ))}
      <td className="px-3 py-2">
        <Input
          value={multiplier}
          onChange={(e) => setMultiplier(e.target.value)}
          className="h-8 w-full min-w-[4.5rem] text-[13px] tabular-nums"
        />
      </td>
      <td className="px-3 py-2">
        {effApplicable ? (
          <SelectFilter
            value={effort}
            options={[
              { label: "未设", value: "" },
              ...effValues.map((v) => ({ label: v, value: v })),
            ]}
            onChange={setEffort}
          />
        ) : (
          <Badge tone="neutral" title="该模型不支持档位">
            不适用
          </Badge>
        )}
      </td>
      <td className="px-3 py-2">
        <SelectFilter
          value={visibility}
          options={VISIBILITY_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
          onChange={setVisibility}
        />
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <span className="inline-flex items-center gap-2">
          <Switch
            checked={model.enabled}
            disabled={toggling}
            onCheckedChange={handleToggle}
            aria-label={model.enabled ? "点击下线" : "点击上线"}
          />
          <span className={`text-[12px] ${model.enabled ? "text-success" : "text-faint"}`}>
            {model.enabled ? "上线中" : "已下线"}
          </span>
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <span className="inline-flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenExtra}
            title={`extra_system_prompt 行为补丁${model.extra_system_prompt ? "(已设置)" : ""}`}
          >
            {model.extra_system_prompt ? "补丁 ●" : "补丁"}
          </Button>
          <Button variant="secondary" size="sm" onClick={buildAndSave} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </span>
      </td>
    </tr>
  );
}
