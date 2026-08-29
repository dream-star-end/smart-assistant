import { useState } from "react";
import { adminSend, apiErrorMessage } from "../../lib/adminApi";
import { TimeAgo } from "../../components";
import { Badge, Button, Input, Switch, Textarea, useConfirm, useToast } from "../../../components/ui";
import type { SettingRow as Row } from "./types";

// 原生 <select> 复用 Input 视觉；enum editor 用它（jsdom 友好、表单语义直接）。
const FIELD_CLS =
  "h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-base md:text-sm text-fg outline-none transition-[border-color,box-shadow] duration-150 ease-standard focus:border-accent focus:ring-2 focus:ring-ring";

/** 类型/范围徽标文案：number→min..max，enum→枚举值，string_array→max=N 项，boolean→true/false。 */
function rangeHint(r: Row): string {
  const m = r.meta;
  switch (m.kind) {
    case "number":
      return `${m.min ?? "?"}..${m.max ?? "?"}`;
    case "enum":
      return (m.enumValues ?? []).join(" / ");
    case "string_array":
      return `max=${m.max ?? "?"} 项`;
    case "boolean":
      return "true / false";
    case "model":
      return `${m.options?.length ?? 0} 个可用模型`;
    default:
      return "JSON";
  }
}

/** 依 kind 计算 editor 初值：boolean→布尔，string_array→逐行文本，其余→字符串（未知 kind→JSON 文本）。 */
function initialDraft(r: Row): string | boolean {
  const m = r.meta;
  if (m.kind === "boolean") return r.value === true;
  if (m.kind === "string_array") {
    const items = Array.isArray(r.value) ? (r.value as unknown[]) : [];
    return items.map((x) => String(x)).join("\n");
  }
  if (m.kind === "number" || m.kind === "enum" || m.kind === "model") {
    return r.value == null ? "" : String(r.value);
  }
  // 未知 kind：回落等宽 JSON textarea
  return typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
}

type Converted = { ok: true; value: unknown } | { ok: false; msg: string };

type SettingRisk = "critical" | "high" | "normal";
const CRITICAL_KEYS = new Set([
  "maintenance_mode",
  "allow_registration",
  "alerts_enabled",
  "rate_limit_chat_per_min",
]);
const HIGH_KEYS = new Set([
  "idle_sweep_min",
  "onboarding_enabled",
  "onboarding_dry_run",
  "register_email_domain_blocklist",
  "phase6_account_uuid_enforce",
  "session_pin_mode",
]);

function settingRisk(key: string): SettingRisk {
  if (CRITICAL_KEYS.has(key)) return "critical";
  if (HIGH_KEYS.has(key)) return "high";
  return "normal";
}

const RISK_META: Record<SettingRisk, { label: string; tone: "danger" | "warning" | "neutral" }> = {
  critical: { label: "关键风险", tone: "danger" },
  high: { label: "高风险", tone: "warning" },
  normal: { label: "常规", tone: "neutral" },
};

function diffValue(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

/** 保存前的 JS 类型转换 —— 与 vanilla saveSetting 逐条对齐；server 端仍做严格 zod 二次校验。 */
function convert(r: Row, draft: string | boolean): Converted {
  const key = r.key;
  switch (r.meta.kind) {
    case "boolean":
      return { ok: true, value: draft === true };
    case "number": {
      const s = String(draft);
      if (s.trim() === "") return { ok: false, msg: `${key}: 不能为空` };
      const n = Number(s);
      if (!Number.isFinite(n)) return { ok: false, msg: `${key}: 不是有效数字` };
      return { ok: true, value: n };
    }
    case "string_array": {
      // 换行/逗号分隔 → trim → lowercase → 去空；server zod 再逐项校验
      const arr = String(draft)
        .split(/[\n,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      return { ok: true, value: arr };
    }
    case "enum":
      return { ok: true, value: String(draft) };
    case "model":
      return String(draft).trim()
        ? { ok: true, value: String(draft) }
        : { ok: false, msg: `${key}: 请选择可用模型` };
    default: {
      // 未知 kind：等宽 Textarea + JSON.parse 校验
      try {
        return { ok: true, value: JSON.parse(String(draft)) };
      } catch {
        return { ok: false, msg: `${key}: JSON 解析失败` };
      }
    }
  }
}

/** 单条系统设置：editor（按 kind）+ 可编辑 description + 逐项保存；保存成功后触发整表重拉。 */
export function SettingRow({ row, onSaved }: { row: Row; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const initial = initialDraft(row);
  const initialDescription = row.description ?? row.meta.description ?? "";
  const [draft, setDraft] = useState<string | boolean>(initial);
  // description 预填 r.description || meta.description（对齐 vanilla；保存即持久化该说明）
  const [desc, setDesc] = useState<string>(initialDescription);
  const [saving, setSaving] = useState(false);

  const kind = row.meta.kind;
  const isDefault = row.is_default;
  const risk = settingRisk(row.key);
  const riskMeta = RISK_META[risk];
  const baseline = convert(row, initial);
  const dirty = isDefault || desc !== initialDescription || draft !== initial;

  const save = async () => {
    const c = convert(row, draft);
    if (!c.ok) {
      toast(c.msg, "error");
      return;
    }
    const ok = await confirm({
      title: risk === "critical" ? "确认关键设置变更？" : "确认保存设置？",
      body: (
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex items-center gap-2">
            <Badge tone={riskMeta.tone}>{riskMeta.label}</Badge>
            <span className="break-all font-mono text-fg">{row.key}</span>
          </div>
          <div className="grid gap-2 rounded-lg border border-border bg-hover p-3 sm:grid-cols-2">
            <div className="min-w-0"><div className="text-[11px] text-faint">当前值{isDefault ? "（继承默认）" : ""}</div><code className="mt-1 block break-all text-[12px] text-muted">{diffValue(baseline.ok ? baseline.value : row.value)}</code></div>
            <div className="min-w-0"><div className="text-[11px] text-faint">保存后</div><code className="mt-1 block break-all text-[12px] text-fg">{diffValue(c.value)}</code></div>
          </div>
          {desc !== initialDescription && (
            <div className="rounded-lg border border-border p-3 text-[12px] text-muted">
              说明：<span className="line-through">{initialDescription || "（空）"}</span> → <span className="text-fg">{desc || "（空）"}</span>
            </div>
          )}
          {risk === "critical" && <p className="font-medium text-danger">该设置可能立即影响用户访问、注册、限流或告警能力，请再次核对。</p>}
        </div>
      ),
      confirmText: "确认保存",
      danger: risk === "critical",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await adminSend("PUT", `/settings/${encodeURIComponent(row.key)}`, {
        value: c.value,
        description: desc,
      });
      toast(`${row.key} 已保存`, "success");
      await onSaved();
    } catch (e) {
      toast(apiErrorMessage(e, "保存失败"), "error");
    } finally {
      setSaving(false);
    }
  };

  let editor: React.ReactNode;
  if (kind === "boolean") {
    const on = draft === true;
    editor = (
      <div className="flex items-center gap-2.5">
        <Switch
          checked={on}
          onCheckedChange={(v) => setDraft(v)}
          aria-label={`${row.key} 开关`}
        />
        <span className="font-mono text-[13px] text-muted">{on ? "true" : "false"}</span>
      </div>
    );
  } else if (kind === "enum" || kind === "model") {
    const options = kind === "model"
      ? (row.meta.options ?? [])
      : (row.meta.enumValues ?? []).map((value) => ({ value, label: value }));
    const currentValue = String(draft);
    const currentModelUnavailable =
      kind === "model" && !options.some((option) => option.value === currentValue);
    editor = (
      <select
        aria-label={`${row.key} 取值`}
        className={FIELD_CLS}
        value={String(draft)}
        onChange={(e) => setDraft(e.target.value)}
      >
        {currentModelUnavailable && (
          <option value={currentValue}>当前模型不可用（{currentValue}）</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}（{option.value}）
          </option>
        ))}
      </select>
    );
  } else if (kind === "number") {
    editor = (
      <Input
        aria-label={`${row.key} 取值`}
        type="number"
        min={row.meta.min}
        max={row.meta.max}
        step={1}
        value={String(draft)}
        onChange={(e) => setDraft(e.target.value)}
        className="w-40"
      />
    );
  } else {
    // string_array 或未知 kind → 等宽 Textarea
    const count =
      kind === "string_array"
        ? String(draft).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).length
        : null;
    editor = (
      <div>
        <Textarea
          aria-label={`${row.key} 取值`}
          rows={6}
          className="font-mono text-[12.5px]"
          value={String(draft)}
          placeholder={kind === "string_array" ? "一行一个，例如：tempmail.com" : "JSON"}
          onChange={(e) => setDraft(e.target.value)}
        />
        {count !== null && (
          <div className="mt-1 text-[11px] text-faint">当前 {count} 项</div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={`setting-${row.key}`}
      className="flex flex-col gap-3 py-4 first:pt-1 last:pb-1"
    >
      {/* 头行：key + 类型/范围/继承徽标 + 保存 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-all font-mono text-[13px] font-semibold text-fg">{row.key}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{String(kind)}</Badge>
            <Badge tone={riskMeta.tone} title={`风险等级：${riskMeta.label}`}>{riskMeta.label}</Badge>
            <span className="font-mono text-[11px] text-faint">{rangeHint(row)}</span>
            {isDefault ? (
              <Badge tone="neutral" title="继承平台默认值，尚未持久化">
                默认
              </Badge>
            ) : (
              <Badge tone="info" title="已覆盖并持久化到 system_settings">
                已覆盖
              </Badge>
            )}
            {!isDefault && row.updated_at && (
              <TimeAgo value={row.updated_at} className="text-[11px] text-faint" />
            )}
            {!isDefault && row.updated_by && (
              <span className="font-mono text-[11px] text-faint">by #{row.updated_by}</span>
            )}
            <a
              href="#tab=audit"
              className="rounded text-[11px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              查看审计
            </a>
          </div>
          {row.meta.description && (
            <p className="mt-1.5 max-w-prose text-[12px] leading-relaxed text-muted">
              {row.meta.description}
            </p>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty} className="shrink-0">
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>

      {/* 编辑行：取值 editor + description */}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
        <div>{editor}</div>
        <div>
          <label
            htmlFor={`setting-desc-${row.key}`}
            className="mb-1 block text-[11px] text-faint"
          >
            说明 description
          </label>
          <Input
            id={`setting-desc-${row.key}`}
            value={desc}
            placeholder="可选说明（保存时一并持久化）"
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
      </div>
      {confirmEl}
    </div>
  );
}
