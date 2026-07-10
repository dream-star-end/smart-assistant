// 系统设置行 —— 与后端 GET /api/admin/settings 的 rows[] 形状对齐（零新增路由）。
// 权威语义见 vanilla admin.js renderSettingsTab / _renderSettingRow / saveSetting。

/** 后端已知的 editor 类型；未知值回落等宽 JSON Textarea（保存前 JSON.parse 校验）。 */
export type SettingKind = "boolean" | "enum" | "number" | "string_array";

export type SettingMeta = {
  kind: SettingKind | string;
  enumValues?: string[];
  min?: number;
  max?: number;
  description?: string;
};

export type SettingRow = {
  key: string;
  value: unknown;
  /** true = 未持久化，继承平台默认值；false = 已覆盖并写入 system_settings。 */
  is_default: boolean;
  description?: string | null;
  updated_at?: string | null;
  meta: SettingMeta;
};

export type SettingsResponse = { rows: SettingRow[] };
