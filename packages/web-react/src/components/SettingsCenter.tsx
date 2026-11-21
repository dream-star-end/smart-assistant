import { DEFAULT_PROMPT_PRIVACY_SUPPORT, parsePromptPrivacySupport, type PromptPrivacySupport } from '@openclaude/protocol/browser'
import {
  AlertCircle,
  ArrowUpRight,
  Lock,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { useMdViewport } from "../hooks/useMdViewport";
import { api, apiErrorMessage } from "../lib/api";
import { appUpdate } from "../lib/appUpdate";
import { BRAND } from "../lib/brand";
import { filedIcp } from "../lib/legal";
import {
  PRODUCT_CAPABILITIES,
  type ProductFeatureId,
  type SettingsDestinationSection,
} from "../lib/productCapabilities";
import { applyIntelligentUiSnapshot } from "../lib/intelligentUi";
import { type PrefsView, extractPrefs } from "../lib/modelPreferences";
import type { AuthSession, User } from "../lib/types";
import { cn } from "../lib/utils";
import { AccountTab } from "./settings/AccountTab";
import { ApiAccessTab } from "./settings/ApiAccessTab";
import { FeedbackTab } from "./settings/FeedbackTab";
import { BuiltinHotkeysTable, PreferencesTab } from "./settings/PreferencesTab";
import { SubscriptionDialog } from "./settings/SubscriptionDialog";
import { UsageTab } from "./settings/UsageTab";
import { Avatar, Button, Modal, SectionNav, Spinner, Tabs } from "./ui";

export type SettingsSection = SettingsDestinationSection;

type SectionDef = {
  id: SettingsSection;
  label: string;
  /** 窄屏宫格列宽只有 ~80px，长标签在这里会被省略号截断（审计 SET-12），给它一个短名。 */
  narrowLabel?: string;
  featureId?: ProductFeatureId;
  /** 仅 admin 可见(API key 管理面当前 admin-only rollout)。 */
  adminOnly?: boolean;
};

const PERSONAL: SectionDef[] = [
  {
    id: "account",
    label: "账户与计费",
    narrowLabel: "账户",
    featureId: PRODUCT_CAPABILITIES.billing.id,
  },
  { id: "usage", label: "用量", featureId: PRODUCT_CAPABILITIES.billing.id },
  { id: "api-access", label: "API 接入", adminOnly: true },
  { id: "preferences", label: "偏好", featureId: PRODUCT_CAPABILITIES.preferences.id },
  { id: "hotkeys", label: "快捷键" },
  { id: "feedback", label: "反馈", featureId: PRODUCT_CAPABILITIES.feedback.id },
  { id: "about", label: "关于" },
];

function isAdminUser(user: User | null): boolean {
  return user?.role === "admin" || user?.roles.includes("admin") === true;
}

/** 按角色过滤后的分区清单(admin-only 分区对普通用户不渲染、不可深链)。 */
function useVisibleSections(user: User | null) {
  const admin = isAdminUser(user);
  return useMemo(() => {
    const keep = (s: SectionDef) => !s.adminOnly || admin;
    const personal = PERSONAL.filter(keep);
    return {
      sections: personal,
      groups: [{ label: "个人", items: personal }],
    };
  }, [admin]);
}

/**
 * 设置中心：近全屏 Dialog（与 ManageCenter 同壳）+ 桌面左导航 / 窄屏顶栏横滚 tabs。
 * 不是 `/settings` 路由。教程深链仍走 `openSettings(section)`。
 */
export function SettingsCenter({
  activeSessionId,
  open,
  auth,
  user,
  theme,
  demo,
  onClose,
  onSetTheme,
  onRefreshMe,
  onPreferencesChange,
  onOpenProjectSettings,
  feedbackContext,
  initialSection = "account",
  subscribeOpenSignal = 0,
  preferencesRevision = 0,
}: {
  activeSessionId?: string;
  preferencesRevision?: number;
  open: boolean;
  auth: AuthSession | null;
  user: User | null;
  theme: Theme;
  demo?: boolean;
  onClose: () => void;
  onSetTheme: (t: Theme) => void;
  onRefreshMe?: () => void;
  onPreferencesChange?: (prefs: PrefsView, patch?: Record<string, unknown>) => void;
  /** 保留给 App 装配；GitHub/插件已从设置分区移除，教程深链走 openRepo/openManage。 */
  onOpenManage?: () => void;
  onOpenRepo?: () => void;
  /** 用量页 facade 未绑定：关设置后打开当前聊天项目设置。 */
  onOpenProjectSettings?: () => void;
  feedbackContext?: { sessionId: string | null; requestId: string | null };
  initialSection?: SettingsSection;
  /** Increment to programmatically open SubscriptionDialog on the account tab. */
  subscribeOpenSignal?: number;
}) {
  const desktop = useMdViewport();
  const { sections, groups } = useVisibleSections(user);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [subOpen, setSubOpen] = useState(false);
  const lastSubscribeSignal = useRef(0);
  const [ledgerReload, setLedgerReload] = useState(0);

  const [prefs, setPrefs] = useState<PrefsView | null>(null);
  const [prefsEpoch, setPrefsEpoch] = useState<number | null>(null);
  const [privacySupport, setPrivacySupport] = useState<PromptPrivacySupport>({ ...DEFAULT_PROMPT_PRIVACY_SUPPORT });
  const currentEpoch = auth?.snapshot().epoch ?? null;
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsErr, setPrefsErr] = useState<string | null>(null);
  const [prefsReloadTick, setPrefsReloadTick] = useState(0);

  // 只有偏好页真的读 prefs;快捷键是静态表,不该被偏好接口的加载 / 失败挡住(审计 SET-02)。
  const needsPreferences = section === "preferences";

  useEffect(() => {
    if (open) {
      // 深链到本角色不可见的分区(如普通用户 → api-access)→ 回落账户页。
      setSection(sections.some((s) => s.id === initialSection) ? initialSection : "account");
      if (subscribeOpenSignal > 0 && subscribeOpenSignal !== lastSubscribeSignal.current) {
        lastSubscribeSignal.current = subscribeOpenSignal;
        setSubOpen(true);
      }
    } else {
      setSection("account");
      setSubOpen(false);
      setPrivacySupport({ ...DEFAULT_PROMPT_PRIVACY_SUPPORT });
    }
  }, [open, initialSection, subscribeOpenSignal, sections]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: prefsReloadTick 是显式重试触发器。
  useEffect(() => {
    if (!open || demo || !auth || !needsPreferences) {
      return;
    }
    let alive = true;
    const requestEpoch = auth.snapshot().epoch;
    setPrivacySupport({ ...DEFAULT_PROMPT_PRIVACY_SUPPORT });
    setPrefsLoading(true);
    setPrefsErr(null);
    api
      .getPreferences(auth)
      .then((snap) => {
        if (!alive || auth.snapshot().epoch !== requestEpoch) return;
        const next = extractPrefs(snap);
        setPrefs(next);
        setPrefsEpoch(requestEpoch);
        setPrivacySupport(parsePromptPrivacySupport((snap as { features?: { prompt_privacy?: unknown } }).features?.prompt_privacy) ?? { ...DEFAULT_PROMPT_PRIVACY_SUPPORT });
        applyIntelligentUiSnapshot(snap);
        onPreferencesChange?.(next);
      })
      .catch((e) => {
        if (alive) setPrefsErr(apiErrorMessage(e, "加载偏好失败"));
      })
      .finally(() => {
        if (alive) setPrefsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, demo, auth, needsPreferences, onPreferencesChange, prefsReloadTick, preferencesRevision]);

  const patchPref = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!auth) return;
      const requestEpoch = auth.snapshot().epoch;
      const snap = await api.patchPreferences(auth, patch);
      if (auth.snapshot().epoch !== requestEpoch) throw new Error("登录身份已改变，请重新查看设置。");
      const next = extractPrefs(snap);
      setPrefs(next);
      setPrefsEpoch(requestEpoch);
      setPrivacySupport(parsePromptPrivacySupport((snap as { features?: { prompt_privacy?: unknown } }).features?.prompt_privacy) ?? { ...DEFAULT_PROMPT_PRIVACY_SUPPORT });
      applyIntelligentUiSnapshot(snap);
      onPreferencesChange?.(next, patch);
    },
    [auth, onPreferencesChange],
  );

  const onPaid = useCallback(() => {
    onRefreshMe?.();
    setLedgerReload((n) => n + 1);
  }, [onRefreshMe]);

  const leaveTo = useCallback(
    (next?: () => void) => {
      onClose();
      next?.();
    },
    [onClose],
  );

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={
          <span className="inline-flex items-center gap-2.5">
            <span className="oc-icon-badge oc-icon-badge-accent size-7 rounded-lg" aria-hidden="true">
              <SlidersHorizontal size={14} strokeWidth={1.9} />
            </span>
            <span className="text-title font-semibold tracking-tight text-fg">设置</span>
          </span>
        }
        size="xl"
        fixedHeight
        mobile="center"
        className="oc-surface-popover bg-surface"
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      >
        <div className={cn("flex min-h-0 min-w-0 flex-1", desktop ? "flex-row" : "flex-col")}>
          {desktop ? (
            <SectionNav
              aria-label="设置分区"
              idBase="settings-nav"
              panelIdBase="settings-panel"
              value={section}
              onChange={setSection}
              groups={groups}
              className="bg-sidebar/60"
            />
          ) : (
            <div className="oc-surface-glass shrink-0 border-x-0 border-t-0 border-b border-border/80 px-4 py-3 shadow-none">
              <Tabs
                aria-label="设置分区"
                idBase="settings"
                layout="grid"
                value={section}
                onValueChange={(v) => setSection(v as SettingsSection)}
                items={sections.map((s) => ({
                  value: s.id,
                  label: s.narrowLabel ?? s.label,
                  featureId: s.featureId,
                }))}
                // 三列宫格放 7 个分区(admin 多一个「API 接入」)会在第三行剩一个孤项;
                // 超过 6 项时改四列(4+3),6 项保持 3+3(审计 SET-12)。
                className={cn(
                  "oc-surface-recessed [&_[role=tab]]:px-3",
                  sections.length > 6 && "grid-cols-4",
                )}
              />
            </div>
          )}

          <div
            role="tabpanel"
            id={`settings-panel-${section}`}
            aria-labelledby={desktop ? `settings-nav-${section}` : `settings-tab-${section}`}
            tabIndex={0}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
          >
            <SettingsPanel
              activeSessionId={activeSessionId}
              section={section}
              auth={auth}
              user={user}
              theme={theme}
              prefs={prefsEpoch === currentEpoch ? prefs : null}
              privacySupport={prefsEpoch === currentEpoch ? privacySupport : { ...DEFAULT_PROMPT_PRIVACY_SUPPORT }}
              prefsLoading={prefsLoading}
              prefsErr={prefsErr}
              onRetryPrefs={() => setPrefsReloadTick((tick) => tick + 1)}
              onSetTheme={onSetTheme}
              onPatch={patchPref}
              onManageSub={() => setSubOpen(true)}
              ledgerReload={ledgerReload}
              onRefreshMe={onRefreshMe}
              feedbackContext={feedbackContext}
              onOpenProjectSettings={
                onOpenProjectSettings ? () => leaveTo(onOpenProjectSettings) : undefined
              }
            />
          </div>
        </div>
      </Modal>

      {auth && (
        <SubscriptionDialog
          open={subOpen}
          auth={auth}
          onClose={() => setSubOpen(false)}
          onPaid={onPaid}
        />
      )}
    </>
  );
}

function SettingsPanel({
  activeSessionId,
  section,
  auth,
  user,
  theme,
  prefs,
  prefsLoading,
  privacySupport,
  prefsErr,
  onRetryPrefs,
  onSetTheme,
  onPatch,
  onManageSub,
  ledgerReload,
  onRefreshMe,
  feedbackContext,
  onOpenProjectSettings,
}: {
  activeSessionId?: string;
  section: SettingsSection;
  auth: AuthSession | null;
  user: User | null;
  theme: Theme;
  prefs: PrefsView | null;
  prefsLoading: boolean;
  privacySupport: PromptPrivacySupport;
  prefsErr: string | null;
  onRetryPrefs: () => void;
  onSetTheme: (t: Theme) => void;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onManageSub: () => void;
  ledgerReload: number;
  onRefreshMe?: () => void;
  feedbackContext?: { sessionId: string | null; requestId: string | null };
  onOpenProjectSettings?: () => void;
}) {
  if (!auth) {
    return (
      <div className="px-5 py-10">
        <div className="oc-surface-card mx-auto flex max-w-sm flex-col items-center gap-2.5 rounded-2xl px-6 py-8 text-center">
          <span className="oc-icon-badge size-10 rounded-xl" aria-hidden="true">
            <Lock size={17} strokeWidth={1.8} />
          </span>
          <p className="text-body text-muted">请先登录。</p>
        </div>
      </div>
    );
  }

  if (section === "account") {
    return (
      <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.billing.id}>
        <AccountTab
          auth={auth}
          user={user}
          onManageSub={onManageSub}
          reloadKey={ledgerReload}
          onRefreshMe={onRefreshMe}
        />
      </div>
    );
  }

  if (section === "usage") {
    return (
      <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.billing.id}>
        <UsageTab auth={auth} onOpenProjectSettings={onOpenProjectSettings} />
      </div>
    );
  }

  if (section === "api-access") {
    // 分区清单已按角色过滤;这里再兜底一次(角色变更竞态 / 直接改 state)。
    if (!isAdminUser(user)) {
      return (
        <div className="px-5 py-10">
          <div className="oc-callout oc-callout-warning mx-auto flex max-w-sm items-center gap-3 rounded-2xl px-5 py-4">
            <span className="oc-icon-badge oc-icon-badge-warning size-8 shrink-0 rounded-lg" aria-hidden="true">
              <Lock size={15} strokeWidth={1.8} />
            </span>
            <p className="text-body text-muted">该功能暂未对你开放。</p>
          </div>
        </div>
      );
    }
    return <ApiAccessTab auth={auth} />;
  }

  // 快捷键是内置只读表,不依赖 prefs,直接渲染(审计 SET-02)。
  if (section === "hotkeys") return <BuiltinHotkeysTable />;

  if (section === "preferences") {
    return (
      <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.preferences.id}>
        {prefsLoading || !prefs ? (
          <div className="flex items-center justify-center px-5 py-14">
            {prefsErr ? (
              <div className="oc-callout oc-callout-danger flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl px-5 py-5 text-center">
                <span className="oc-icon-badge oc-icon-badge-danger size-9 rounded-xl" aria-hidden="true">
                  <AlertCircle size={17} strokeWidth={1.8} />
                </span>
                <span className="text-body font-medium text-danger">{prefsErr}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="oc-btn-tactile oc-btn-secondary-craft"
                  onClick={onRetryPrefs}
                >
                  重试
                </Button>
              </div>
            ) : (
              <div className="oc-surface-card inline-flex items-center gap-2.5 rounded-full px-4 py-2 text-body text-muted">
                <Spinner /> 加载偏好…
              </div>
            )}
          </div>
        ) : (
          <PreferencesTab
            activeSessionId={activeSessionId}
            privacySupport={privacySupport}
            auth={auth}
            prefs={prefs}
            theme={theme}
            onSetTheme={onSetTheme}
            onPatch={onPatch}
          />
        )}
      </div>
    );
  }

  if (section === "feedback") {
    return (
      <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.feedback.id}>
        {user ? (
          <FeedbackTab auth={auth} userId={user.id} context={feedbackContext} />
        ) : (
          <div className="flex justify-center px-5 py-12">
            <div className="oc-surface-card inline-flex items-center gap-2 rounded-full px-4 py-2 text-body text-muted">
              <Spinner /> 正在加载账号信息…
            </div>
          </div>
        )}
      </div>
    );
  }

  if (section === "about") return <AboutSection />;

  // 未知分区（含已删的 github/plugins）回落账户页。
  return (
    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.billing.id}>
      <AccountTab
        auth={auth}
        user={user}
        onManageSub={onManageSub}
        reloadKey={ledgerReload}
        onRefreshMe={onRefreshMe}
      />
    </div>
  );
}

/** 构建号来自 index.html 的 `<meta name="oc-build">`(FeedbackTab 同源);缺失时不显示该行。 */
function currentBuildId(): string | null {
  if (typeof document === "undefined") return null;
  const value = document.querySelector<HTMLMetaElement>('meta[name="oc-build"]')?.content.trim();
  return value || null;
}

const SERVER_BUILD_META_RE =
  /<meta\s+(?:[^>]*?\s)?name=["']oc-build["'][^>]*?\scontent=["']([^"']+)["']|<meta\s+(?:[^>]*?\s)?content=["']([^"']+)["'][^>]*?\sname=["']oc-build["']/i;

/**
 * 读服务端当前 index.html 里的同一枚 `<meta name="oc-build">`。版本握手本身是 bridge 在
 * WS 建连时单向下发的(lib/appUpdate),前端没有「问一下现在是哪个版本」的主动入口;关于页
 * 的「检查更新」就用这一招补上:no-store 拉一次入口 HTML,把 meta 抠出来比对。导出供单测。
 */
export async function fetchServerBuild(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl("/", { cache: "no-store", headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = SERVER_BUILD_META_RE.exec(html);
  const value = (m?.[1] ?? m?.[2] ?? "").trim();
  return value || null;
}

type UpdateCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; build: string }
  | { kind: "unknown" }
  | { kind: "failed" };

/**
 * 关于页「检查更新」:长驻标签页(尤其移动端 webview)手里可能是几小时前的旧 bundle,自动软刷
 * 只在安全点发生、横幅又只在自动刷失败后出现,用户此前没有任何主动的出口(审计 SET-42 遗留项)。
 * 发现新版本时的「立即刷新」走 appUpdate.reloadNow(),与更新横幅同一条路(停掉 governor 定时器,
 * 不动自动 reload 预算)。
 */
function UpdateCheckRow({ clientBuild }: { clientBuild: string }) {
  const [state, setState] = useState<UpdateCheck>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function check() {
    setState({ kind: "checking" });
    try {
      const server = await fetchServerBuild();
      if (!alive.current) return;
      if (!server) setState({ kind: "unknown" });
      else if (server === clientBuild) setState({ kind: "latest" });
      else setState({ kind: "available", build: server });
    } catch {
      if (alive.current) setState({ kind: "failed" });
    }
  }

  const message =
    state.kind === "checking"
      ? "正在检查…"
      : state.kind === "latest"
        ? "已是最新版本"
        : state.kind === "available"
          ? `发现新版本 ${state.build}，刷新页面即可更新`
          : state.kind === "unknown"
            ? "暂时读不到服务端版本，请稍后再试"
            : state.kind === "failed"
              ? "检查失败，请检查网络后重试"
              : null;

  return (
    <div
      className={cn(
        "oc-callout mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 text-caption",
        state.kind === "available" && "oc-callout-info",
        state.kind === "latest" && "oc-callout-success",
        state.kind === "failed" && "oc-callout-warning",
      )}
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="oc-btn-tactile oc-btn-secondary-craft"
        onClick={() => void check()}
        disabled={state.kind === "checking"}
      >
        <RefreshCw
          size={13}
          strokeWidth={1.9}
          className={state.kind === "checking" ? "animate-spin" : undefined}
          aria-hidden="true"
        />
        检查更新
      </Button>
      {/* live region 常驻:只在有消息时才挂载的话,首次点「检查更新」时区域与文字同帧出现,
          NVDA / VoiceOver 可能收不到这第一句播报(QA t-1028 §6 #2)。这里始终渲染、只切文本。 */}
      <output className="break-all text-muted" aria-live="polite" data-testid="about-update-status">
        {message}
      </output>
      {state.kind === "available" && (
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="oc-btn-tactile oc-btn-primary-craft ml-auto"
          onClick={() => appUpdate.reloadNow()}
        >
          立即刷新
        </Button>
      )}
    </div>
  );
}

function AboutSection() {
  const build = currentBuildId();
  return (
    <div className="mx-auto max-w-xl px-5 py-5">
      <div className="oc-surface-card rounded-2xl p-5">
        <div className="flex items-center gap-3.5">
          <Avatar tone="brand" size="lg" shape="square" className="oc-icon-badge oc-icon-badge-accent shadow-soft">
            <Sparkles size={21} />
          </Avatar>
          <div className="min-w-0">
            <div className="text-title font-semibold tracking-tight text-fg">{BRAND.name}</div>
            <div className="mt-0.5 text-caption text-faint">
              {BRAND.nameEn} · {BRAND.slogan}
            </div>
          </div>
        </div>
        <p className="mt-4 text-body leading-relaxed text-muted">{BRAND.intro}</p>
      </div>

      <div className="oc-surface-card mt-4 overflow-hidden rounded-2xl">
        <dl className="divide-y divide-border/70 text-caption">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <dt className="shrink-0 text-faint">运营主体</dt>
            <dd className="truncate font-medium text-fg">{BRAND.company}</dd>
          </div>
          {/* 占位文案不上「备案」栏;运营在 brand.ts 填入真实备案号后自动出现。判据与 landing 页脚 /
              法务页同源:lib/legal.ts filedIcp()(真实备案号必含一串数字,就位才返回),不再各写一份。 */}
          {filedIcp(BRAND.icp) && (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="shrink-0 text-faint">备案</dt>
              <dd className="truncate text-fg">{filedIcp(BRAND.icp)}</dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <dt className="shrink-0 text-faint">客户端</dt>
            <dd className="truncate text-fg">
              {BRAND.name} Web · © {BRAND.year}
            </dd>
          </div>
          {/* 反馈排障要对齐构建号,关于页是用户最容易找到它的地方(审计 SET-42)。 */}
          {build && (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="shrink-0 text-faint">版本</dt>
              <dd className="oc-kbd truncate font-mono text-fg" data-testid="about-build">
                {build}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* 没有构建号(dev / meta 缺失)时版本握手本身就是 inert 的,检查更新也没有比对对象,不渲染。 */}
      {build && <UpdateCheckRow clientBuild={build} />}

      {/* 法务入口:与落地页同一套 /terms、/privacy 路由(LegalPage),新标签打开不打断当前会话。 */}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border/80 pt-4 text-caption">
        <a
          href="/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="oc-btn-tactile inline-flex items-center gap-1 rounded-lg border border-border/70 bg-surface px-3 py-1.5 text-muted transition-colors hover:border-border-strong hover:bg-hover hover:text-fg"
        >
          用户协议
          <ArrowUpRight size={12} strokeWidth={1.8} className="text-faint" aria-hidden="true" />
        </a>
        <a
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="oc-btn-tactile inline-flex items-center gap-1 rounded-lg border border-border/70 bg-surface px-3 py-1.5 text-muted transition-colors hover:border-border-strong hover:bg-hover hover:text-fg"
        >
          隐私政策
          <ArrowUpRight size={12} strokeWidth={1.8} className="text-faint" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
