import { AlertTriangle, ArrowRight, Save, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { adminSend, apiErrorMessage } from "../../lib/adminApi";
import { TimeAgo } from "../../components";
import { Badge, Button, Input, Switch, Textarea, useConfirm, useToast } from "../../../components/ui";
import type { SettingRow as Row } from "./types";

// 原生 <select> 复用 Input 视觉；enum editor 用它（jsdom 友好、表单语义直接）。
const FIELD_CLS =
  "oc-field-control h-10 w-full rounded-lg border border-border px-3.5 text-base md:text-sm text-fg outline-none";

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
  const edited = desc !== initialDescription || draft !== initial;
  const dirty = isDefault || edited;
  const previewConverted = edited ? convert(row, draft) : null;

  const save = async () => {
    const c = convert(row, draft);
    if (!c.ok) {
      toast(c.msg, "error");
      return;
    }
    const ok = await confirm({
      title: risk === "critical" ? "确认关键设置变更？" : "确认保存设置？",
      body: (
        <div className="flex flex-col gap-3 text-body">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={riskMeta.tone}>{riskMeta.label}</Badge>
            <span className="break-all font-mono font-medium text-fg">{row.key}</span>
          </div>
          <div className="oc-surface-recessed grid gap-3 rounded-xl p-3 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-caption font-medium text-faint">
                当前值{isDefault ? "（继承默认）" : ""}
              </div>
              <code className="mt-1 block break-all font-mono text-meta text-muted">
                {diffValue(baseline.ok ? baseline.value : row.value)}
              </code>
            </div>
            <div className="min-w-0 border-t border-border/70 pt-2 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
              <div className="text-caption font-medium text-accent">保存后</div>
              <code className="mt-1 block break-all font-mono text-meta font-semibold text-fg">
                {diffValue(c.value)}
              </code>
            </div>
          </div>
          {desc !== initialDescription && (
            <div className="oc-surface-recessed rounded-xl p-3 text-meta text-muted">
              说明：<span className="line-through">{initialDescription || "（空）"}</span> →{" "}
              <span className="text-fg">{desc || "（空）"}</span>
            </div>
          )}
          {risk === "critical" && (
            <div className="oc-callout oc-callout-danger flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-meta font-medium text-danger">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <p>该设置可能立即影响用户访问、注册、限流或告警能力，请再次核对。</p>
            </div>
          )}
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
      <div className="oc-surface-recessed inline-flex items-center gap-3 rounded-xl px-3.5 py-2">
        <Switch
          checked={on}
          onCheckedChange={(v) => setDraft(v)}
          aria-label={`${row.key} 开关`}
        />
        <span className="font-mono text-body font-medium text-fg">{on ? "true" : "false"}</span>
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
        className="w-44 font-mono tabular-nums"
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
          className="font-mono text-meta"
          value={String(draft)}
          placeholder={kind === "string_array" ? "一行一个，例如：tempmail.com" : "JSON"}
          onChange={(e) => setDraft(e.target.value)}
        />
        {count !== null && (
          <div className="mt-1.5 text-caption tabular-nums text-faint">当前 {count} 项</div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={`setting-${row.key}`}
      className="flex flex-col gap-3.5 py-5 first:pt-1 last:pb-1"
    >
      {/* 头行：key + 类型/范围/继承徽标 + 保存 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-section font-semibold tracking-tight text-fg">
              {row.key}
            </span>
            <Badge tone={riskMeta.tone} title={`风险等级：${riskMeta.label}`}>
              {riskMeta.label}
            </Badge>
            {isDefault ? (
              <Badge tone="neutral" title="继承平台默认值，尚未持久化">
                默认
              </Badge>
            ) : (
              <Badge tone="info" title="已覆盖并持久化到 system_settings">
                已覆盖
              </Badge>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{String(kind)}</Badge>
            <span className="oc-surface-recessed rounded-md px-2 py-0.5 font-mono text-caption text-muted">
              {rangeHint(row)}
            </span>
            {!isDefault && row.updated_at && (
              <TimeAgo value={row.updated_at} className="text-caption tabular-nums text-faint" />
            )}
            {!isDefault && row.updated_by && (
              <span className="font-mono text-caption text-faint">by #{row.updated_by}</span>
            )}
            <a
              href="#tab=audit"
              className="rounded text-caption font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              查看审计
            </a>
          </div>
          {row.meta.description && (
            <p className="mt-2 max-w-prose text-meta leading-relaxed text-muted">
              {row.meta.description}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={save}
          disabled={saving || !dirty}
          className="oc-btn-tactile shrink-0 gap-1.5"
        >
          <Save size={13.5} />
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>

      {/* 编辑行：取值 editor + description */}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
        <div className="flex flex-col gap-2">
          <div>{editor}</div>
          <div className="oc-surface-recessed flex flex-wrap items-center gap-2 rounded-lg px-3 py-1.5 text-caption">
            <span className="font-medium text-faint">
              {isDefault ? "默认基线" : "已存当前值"}
            </span>
            <code className="max-w-full truncate font-mono text-muted">
              {diffValue(baseline.ok ? baseline.value : row.value)}
            </code>
          </div>
        </div>
        <div>
          <label
            htmlFor={`setting-desc-${row.key}`}
            className="mb-1.5 block text-caption font-medium text-faint"
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

      {edited && (
        <div className="oc-callout oc-callout-warning flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2 text-caption text-fg">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <AlertTriangle size={14} className="shrink-0 text-warning" />
            <span className="font-medium">未保存变更预览：</span>
            {draft !== initial && (
              <span className="inline-flex min-w-0 items-center gap-1.5 font-mono">
                <span className="max-w-[14rem] truncate text-muted">
                  {diffValue(baseline.ok ? baseline.value : row.value)}
                </span>
                <ArrowRight size={12} className="shrink-0 text-faint" />
                <span className="max-w-[14rem] truncate font-semibold text-fg">
                  {previewConverted?.ok ? diffValue(previewConverted.value) : "待修正输入"}
                </span>
              </span>
            )}
            {desc !== initialDescription && (
              <span className="text-muted">（说明已修改）</span>
            )}
          </div>
          <span className="text-micro text-faint">点击右上角「保存」写入并记录审计</span>
        </div>
      )}
      {confirmEl}
    </div>
  );
}
