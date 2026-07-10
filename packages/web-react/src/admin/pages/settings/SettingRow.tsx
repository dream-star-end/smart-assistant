import { useState } from "react";
import { ApiError, adminSend } from "../../lib/adminApi";
import { TimeAgo } from "../../components";
import { Badge, Button, Input, Switch, Textarea, useToast } from "../../../components/ui";
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
  if (m.kind === "number" || m.kind === "enum") {
    return r.value == null ? "" : String(r.value);
  }
  // 未知 kind：回落等宽 JSON textarea
  return typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
}

type Converted = { ok: true; value: unknown } | { ok: false; msg: string };

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
  const [draft, setDraft] = useState<string | boolean>(() => initialDraft(row));
  // description 预填 r.description || meta.description（对齐 vanilla；保存即持久化该说明）
  const [desc, setDesc] = useState<string>(() => row.description ?? row.meta.description ?? "");
  const [saving, setSaving] = useState(false);

  const kind = row.meta.kind;
  const isDefault = row.is_default;

  const save = async () => {
    const c = convert(row, draft);
    if (!c.ok) {
      toast(c.msg, "error");
      return;
    }
    setSaving(true);
    try {
      await adminSend("PUT", `/settings/${encodeURIComponent(row.key)}`, {
        value: c.value,
        description: desc,
      });
      toast(`${row.key} 已保存`, "success");
      await onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String((e as Error)?.message ?? e), "error");
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
  } else if (kind === "enum") {
    editor = (
      <select
        aria-label={`${row.key} 取值`}
        className={FIELD_CLS}
        value={String(draft)}
        onChange={(e) => setDraft(e.target.value)}
      >
        {(row.meta.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
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
          </div>
          {row.meta.description && (
            <p className="mt-1.5 max-w-prose text-[12px] leading-relaxed text-muted">
              {row.meta.description}
            </p>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={save} disabled={saving} className="shrink-0">
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
    </div>
  );
}
