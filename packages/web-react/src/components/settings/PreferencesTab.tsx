import { Monitor, Moon, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Theme } from "../../hooks/useTheme";
import { api, apiErrorMessage } from "../../lib/api";
import type { AuthSession, PublicModel } from "../../lib/types";
import {
  initialModelFromPreferences,
  type PreferenceEffort,
  type PrefsView,
} from "../../lib/modelPreferences";
import { cn } from "../../lib/utils";
import { Alert, Input, Switch } from "../ui";
import { ApiKeysSection } from "./ApiKeysSection";
import { EFFORT_OPTIONS } from "./labels";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

/** UI 主题枚举 ↔ 后端 preferences 枚举（system ↔ auto）。 */
const uiToServerTheme = (t: Theme): "light" | "dark" | "auto" => (t === "system" ? "auto" : t);

// 微信两开关(wechat_show_tool_calls / wechat_proactive_push)在 v5 通道下是死开关:
// v5 作为控制面 follower 硬关 wechat broker(index.ts controlPlaneEnabled 恒 false),
// binding/inbound/outbound/proactive 全链缺席,推送尝试被 master 404 静默回退 webchat。
// 在 v5 微信通道接通前(roadmap P1.2 专项决策)不渲染这两个开关,避免 UI 承诺做不到的事。
// 偏好字段本身保留(preferences.ts allowlist),将来通道接通再放回渲染。
const NOTIF_FIELDS: { key: keyof PrefsView; label: string; hint?: string }[] = [
  { key: "notify_email", label: "邮件通知" },
  { key: "notify_telegram", label: "Telegram 通知" },
];

const MAX_HOTKEYS = 32;

/**
 * 偏好 Tab：外观主题（接 useTheme，写穿到 preferences）+ 默认模型 + 思考深度 +
 * 通知开关 + 快捷键，最后嵌 API Key 自管。prefs 状态由 SettingsCenter 集中持有，
 * 本组件受控（onPatch 返回后由父刷新快照）。
 *
 * 主题权威源仍是 useTheme（live + localStorage）；这里只在用户切换时写穿一份到
 * 后端 preferences（供跨端 / 未来登录态水合用），不在加载时反向覆盖 live 主题，
 * 避免与顶栏快捷开关互相打架。
 */
export function PreferencesTab({
  auth,
  prefs,
  theme,
  onSetTheme,
  onPatch,
}: {
  auth: AuthSession;
  prefs: PrefsView;
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  /** 透传 patch 到后端（null 删除该字段）；父组件用返回快照刷新 prefs。 */
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getPublicModels(auth)
      .then((m) => {
        if (alive) setModels(m);
      })
      .catch(() => {
        /* 模型列表拉取失败不致命：default_model 退化为只读展示当前值 */
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  async function patch(p: Record<string, unknown>) {
    setErr(null);
    try {
      await onPatch(p);
    } catch (e) {
      setErr(apiErrorMessage(e, "保存失败"));
    }
  }

  function changeTheme(t: Theme) {
    onSetTheme(t); // live 权威：立即切换
    void patch({ theme: uiToServerTheme(t) }); // 写穿后端（best-effort）
  }

  const effortModelId = initialModelFromPreferences(models, prefs);
  const effortModel = models.find((m) => m.id === effortModelId);
  const supportedEfforts = effortModel?.supported_efforts ?? [];
  const effortOptions = EFFORT_OPTIONS.filter((o) => supportedEfforts.includes(o.value));
  const selectedEffort: PreferenceEffort | "" =
    prefs.default_effort && supportedEfforts.includes(prefs.default_effort)
      ? prefs.default_effort
      : "";

  return (
    <div className="flex flex-col">
      {err && (
        <div className="px-5 pt-3">
          <Alert tone="danger" className="text-[12.5px]">
            {err}
          </Alert>
        </div>
      )}

      {/* 外观主题 */}
      <div className="px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          外观主题
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => changeTheme(o.value)}
              aria-pressed={theme === o.value}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                theme === o.value
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <o.icon size={18} />
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* 默认模型 + 思考深度 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          对话默认
        </div>
        <label className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-[13.5px] text-fg">默认模型</span>
          <Select
            value={prefs.default_model ?? ""}
            onChange={(v) => patch({ default_model: v === "" ? null : v })}
          >
            <option value="">跟随智能体默认</option>
            {/* 当前值不在可选列表里时（如已下架）仍补一条，避免显示错位 */}
            {prefs.default_model && !models.some((m) => m.id === prefs.default_model) && (
              <option value={prefs.default_model}>{prefs.default_model}</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center justify-between gap-3 py-1.5">
          <span className="text-[13.5px] text-fg">思考深度</span>
          <Select
            value={selectedEffort}
            onChange={(v) => patch({ default_effort: v === "" ? null : v })}
            disabled={models.length > 0 && effortOptions.length === 0}
          >
            <option value="">
              {models.length > 0 && effortOptions.length === 0 ? "当前模型不支持" : "跟随模型默认"}
            </option>
            {effortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {/* 通知 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">通知</div>
        {NOTIF_FIELDS.map((f) => (
          <label key={String(f.key)} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block text-[13.5px] text-fg">{f.label}</span>
              {f.hint && <span className="block text-[11.5px] text-faint">{f.hint}</span>}
            </span>
            <Switch
              checked={prefs[f.key] === true}
              onCheckedChange={(c) => patch({ [f.key]: c })}
            />
          </label>
        ))}
      </div>

      {/* 快捷键 */}
      <HotkeysEditor hotkeys={prefs.hotkeys ?? {}} onPatch={patch} />

      {/* API Key 自管（admin-only rollout 命中 403 时整段隐藏） */}
      <ApiKeysSection auth={auth} />
    </div>
  );
}

/** 自定义快捷键（hotkeys: 动作名 → 按键，最多 32 条，键/值 ≤ 64 字符）。 */
function HotkeysEditor({
  hotkeys,
  onPatch,
}: {
  hotkeys: Record<string, string>;
  onPatch: (p: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [combo, setCombo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const entries = Object.entries(hotkeys);

  async function add() {
    const k = name.trim();
    const v = combo.trim();
    setErr(null);
    if (!k || !v) return;
    if (k.length > 64 || v.length > 64) {
      setErr("名称与按键均需 ≤ 64 字符。");
      return;
    }
    if (!(k in hotkeys) && entries.length >= MAX_HOTKEYS) {
      setErr(`最多 ${MAX_HOTKEYS} 个快捷键。`);
      return;
    }
    await onPatch({ hotkeys: { ...hotkeys, [k]: v } });
    setName("");
    setCombo("");
  }

  async function remove(k: string) {
    const next = { ...hotkeys };
    delete next[k];
    // 删空 → 整字段删除（null）；否则提交剩余全集（hotkeys 在顶层是单 key，整体替换）
    await onPatch({ hotkeys: entries.length === 1 ? null : next });
  }

  return (
    <div className="border-t border-border px-5 py-4">
      <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        自定义快捷键
      </div>
      {err && (
        <Alert tone="warning" className="mb-2 text-[12.5px]">
          {err}
        </Alert>
      )}
      {entries.length === 0 ? (
        <p className="pb-2 text-[12.5px] text-faint">还没有自定义快捷键。</p>
      ) : (
        <ul className="mb-2 flex flex-col gap-1">
          {entries.map(([k, v]) => (
            <li key={k} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-hover">
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{k}</span>
              <kbd className="rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[11.5px] text-muted">
                {v}
              </kbd>
              <button
                onClick={() => remove(k)}
                aria-label={`删除 ${k}`}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint outline-none hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="动作名"
          maxLength={64}
          className="h-auto bg-bg px-3 py-2 text-[13px]"
        />
        <Input
          value={combo}
          onChange={(e) => setCombo(e.target.value)}
          placeholder="如 Ctrl+K"
          maxLength={64}
          className="h-auto bg-bg px-3 py-2 text-[13px]"
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button
          onClick={add}
          disabled={!name.trim() || !combo.trim()}
          className="shrink-0 rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          添加
        </button>
      </div>
    </div>
  );
}

function modelLabel(m: PublicModel): string {
  const raw = (m as Record<string, unknown>).label ?? (m as Record<string, unknown>).name;
  return typeof raw === "string" && raw.length > 0 ? raw : m.id;
}

/** 轻量原生 select（无 Select 原语；统一 token 化样式，可访问）。 */
function Select({
  value,
  onChange,
  children,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[55%] rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </select>
  );
}
