import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Theme } from "../hooks/useTheme";
import { useMdViewport } from "../hooks/useMdViewport";
import { api, apiErrorMessage } from "../lib/api";
import { BRAND } from "../lib/brand";
import {
  PRODUCT_CAPABILITIES,
  type ProductFeatureId,
  type SettingsDestinationSection,
} from "../lib/productCapabilities";
import {
  type AutoDreamFeatureView,
  type PrefsView,
  extractAutoDreamFeature,
  extractPrefs,
} from "../lib/modelPreferences";
import type { AuthSession, User } from "../lib/types";
import { cn } from "../lib/utils";
import { AccountTab } from "./settings/AccountTab";
import { FeedbackTab } from "./settings/FeedbackTab";
import { PreferencesTab } from "./settings/PreferencesTab";
import { SettingsRow } from "./settings/SettingsRow";
import { SubscriptionDialog } from "./settings/SubscriptionDialog";
import { UsageTab } from "./settings/UsageTab";
import { Avatar, Button, Modal, Spinner, Tabs } from "./ui";

export type SettingsSection = SettingsDestinationSection;

type SectionDef = { id: SettingsSection; label: string; featureId?: ProductFeatureId };

const PERSONAL: SectionDef[] = [
  { id: "account", label: "账户与计费", featureId: PRODUCT_CAPABILITIES.billing.id },
  { id: "usage", label: "用量", featureId: PRODUCT_CAPABILITIES.billing.id },
  { id: "preferences", label: "偏好", featureId: PRODUCT_CAPABILITIES.preferences.id },
  { id: "hotkeys", label: "快捷键" },
  { id: "feedback", label: "反馈", featureId: PRODUCT_CAPABILITIES.feedback.id },
  { id: "about", label: "关于" },
];

const WORKSPACE: SectionDef[] = [
  { id: "github", label: "GitHub" },
  { id: "plugins", label: "插件" },
];

const SECTIONS: SectionDef[] = [...PERSONAL, ...WORKSPACE];
const NAV_GROUPS: { label: string; items: SectionDef[] }[] = [
  { label: "个人", items: PERSONAL },
  { label: "工作区", items: WORKSPACE },
];

/**
 * 设置中心：近全屏 Dialog（与 ManageCenter 同壳）+ 桌面左导航 / 窄屏顶栏横滚 tabs。
 * 不是 `/settings` 路由。教程深链仍走 `openSettings(section)`。
 */
export function SettingsCenter({
  open,
  auth,
  user,
  theme,
  demo,
  onClose,
  onSetTheme,
  onRefreshMe,
  onPreferencesChange,
  onOpenMemory,
  onOpenManage,
  onOpenRepo,
  feedbackContext,
  initialSection = "account",
}: {
  open: boolean;
  auth: AuthSession | null;
  user: User | null;
  theme: Theme;
  demo?: boolean;
  onClose: () => void;
  onSetTheme: (t: Theme) => void;
  onRefreshMe?: () => void;
  onPreferencesChange?: (prefs: PrefsView, patch?: Record<string, unknown>) => void;
  onOpenMemory: () => void;
  /** 插件深链：先关设置再打开管理中心 connectors。 */
  onOpenManage?: () => void;
  /** GitHub 深链：先关设置再打开对话区绑定。 */
  onOpenRepo?: () => void;
  feedbackContext?: { sessionId: string | null; requestId: string | null };
  initialSection?: SettingsSection;
}) {
  const desktop = useMdViewport();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [subOpen, setSubOpen] = useState(false);
  const [ledgerReload, setLedgerReload] = useState(0);

  const [prefs, setPrefs] = useState<PrefsView | null>(null);
  const [autoDream, setAutoDream] = useState<AutoDreamFeatureView | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsErr, setPrefsErr] = useState<string | null>(null);
  const [prefsReloadTick, setPrefsReloadTick] = useState(0);

  const needsPreferences = section === "preferences" || section === "hotkeys";

  useEffect(() => {
    if (open) {
      setSection(initialSection);
    } else {
      setSection("account");
      setSubOpen(false);
    }
  }, [open, initialSection]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: prefsReloadTick 是显式重试触发器。
  useEffect(() => {
    if (!open || demo || !auth || !needsPreferences || prefs != null) {
      return;
    }
    let alive = true;
    setPrefsLoading(true);
    setPrefsErr(null);
    api
      .getPreferences(auth)
      .then((snap) => {
        if (!alive) return;
        const next = extractPrefs(snap);
        setPrefs(next);
        setAutoDream(extractAutoDreamFeature(snap));
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
  }, [open, demo, auth, needsPreferences, prefs, onPreferencesChange, prefsReloadTick]);

  const patchPref = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!auth) return;
      const snap = await api.patchPreferences(auth, patch);
      const next = extractPrefs(snap);
      setPrefs(next);
      setAutoDream(extractAutoDreamFeature(snap));
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
        title={<span className="text-title font-semibold text-fg">设置</span>}
        size="xl"
        fixedHeight
        mobile="center"
        className="bg-surface"
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      >
        <div
          className={cn("flex min-h-0 min-w-0 flex-1", desktop ? "flex-row" : "flex-col")}
        >
          {desktop ? (
            <VerticalNav value={section} onChange={setSection} />
          ) : (
            <div className="shrink-0 border-b border-border px-4 py-3">
              <Tabs
                aria-label="设置分区"
                idBase="settings"
                value={section}
                onValueChange={(v) => setSection(v as SettingsSection)}
                items={SECTIONS.map((s) => ({
                  value: s.id,
                  label: s.label,
                  featureId: s.featureId,
                }))}
                className="[&_[role=tab]]:px-3"
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
              section={section}
              auth={auth}
              user={user}
              theme={theme}
              prefs={prefs}
              autoDream={autoDream}
              prefsLoading={prefsLoading}
              prefsErr={prefsErr}
              onRetryPrefs={() => setPrefsReloadTick((tick) => tick + 1)}
              onSetTheme={onSetTheme}
              onPatch={patchPref}
              onUpgrade={() => setSubOpen(true)}
              onOpenMemory={() => leaveTo(onOpenMemory)}
              onManageSub={() => setSubOpen(true)}
              ledgerReload={ledgerReload}
              onRefreshMe={onRefreshMe}
              feedbackContext={feedbackContext}
              onOpenManage={onOpenManage ? () => leaveTo(onOpenManage) : undefined}
              onOpenRepo={onOpenRepo ? () => leaveTo(onOpenRepo) : undefined}
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

function VerticalNav({
  value,
  onChange,
}: {
  value: SettingsSection;
  onChange: (section: SettingsSection) => void;
}) {
  const ids = SECTIONS.map((s) => s.id);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = ids.indexOf(value);
    if (index < 0) return;
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % ids.length;
    else if (event.key === "ArrowUp") next = (index - 1 + ids.length) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(ids[next]!);
    refs.current[next]?.focus();
  };

  return (
    <nav
      role="tablist"
      aria-label="设置分区"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className="flex w-[168px] shrink-0 flex-col overflow-y-auto border-r border-border p-2"
    >
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="px-2.5 pb-1 pt-3 text-meta font-medium uppercase tracking-wide text-faint">
            {group.label}
          </div>
          {group.items.map((it) => {
            const selected = it.id === value;
            const index = ids.indexOf(it.id);
            return (
              <button
                key={it.id}
                ref={(el) => {
                  refs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`settings-nav-${it.id}`}
                aria-controls={selected ? `settings-panel-${it.id}` : undefined}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-product-feature={it.featureId}
                onClick={() => onChange(it.id)}
                className={cn(
                  "flex w-full rounded-md px-2.5 py-1.5 text-left text-body outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function SettingsPanel({
  section,
  auth,
  user,
  theme,
  prefs,
  autoDream,
  prefsLoading,
  prefsErr,
  onRetryPrefs,
  onSetTheme,
  onPatch,
  onUpgrade,
  onOpenMemory,
  onManageSub,
  ledgerReload,
  onRefreshMe,
  feedbackContext,
  onOpenManage,
  onOpenRepo,
}: {
  section: SettingsSection;
  auth: AuthSession | null;
  user: User | null;
  theme: Theme;
  prefs: PrefsView | null;
  autoDream: AutoDreamFeatureView | null;
  prefsLoading: boolean;
  prefsErr: string | null;
  onRetryPrefs: () => void;
  onSetTheme: (t: Theme) => void;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onUpgrade: () => void;
  onOpenMemory: () => void;
  onManageSub: () => void;
  ledgerReload: number;
  onRefreshMe?: () => void;
  feedbackContext?: { sessionId: string | null; requestId: string | null };
  onOpenManage?: () => void;
  onOpenRepo?: () => void;
}) {
  if (!auth) {
    return <p className="px-5 py-10 text-center text-body text-faint">请先登录。</p>;
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
        <UsageTab auth={auth} />
      </div>
    );
  }

  if (section === "preferences" || section === "hotkeys") {
    return (
      <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.preferences.id}>
        {prefsLoading || !prefs ? (
          <div className="flex items-center justify-center gap-2 py-16 text-body text-faint">
            {prefsErr ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <span className="text-danger">{prefsErr}</span>
                <Button size="sm" variant="secondary" onClick={onRetryPrefs}>
                  重试
                </Button>
              </div>
            ) : (
              <>
                <Spinner /> 加载偏好…
              </>
            )}
          </div>
        ) : (
          <PreferencesTab
            auth={auth}
            prefs={prefs}
            autoDream={autoDream}
            theme={theme}
            onSetTheme={onSetTheme}
            onPatch={onPatch}
            onUpgrade={onUpgrade}
            onOpenMemory={onOpenMemory}
            canManageApiKeys={user?.role === "admin" || user?.roles.includes("admin") === true}
            pane={section === "hotkeys" ? "hotkeys" : "preferences"}
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
          <p className="px-5 py-10 text-center text-body text-faint">正在加载账号信息…</p>
        )}
      </div>
    );
  }

  if (section === "about") return <AboutSection />;

  if (section === "github") {
    return (
      <div className="px-5 py-5">
        <SettingsRow
          title="GitHub 仓库"
          description="在当前对话输入区绑定或更换仓库。设置页不维护 live 分支，只提供入口。"
          action={
            <Button size="sm" variant="secondary" onClick={onOpenRepo} disabled={!onOpenRepo}>
              绑定/更换仓库
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="px-5 py-5">
      <SettingsRow
        title="插件与连接器"
        description="浏览器和外部账号仍在管理中心编辑，这里只提供入口。"
        action={
          <Button size="sm" variant="secondary" onClick={onOpenManage} disabled={!onOpenManage}>
            打开插件
          </Button>
        }
      />
    </div>
  );
}

function AboutSection() {
  return (
    <div className="px-5 py-5">
      <div className="flex items-center gap-3">
        <Avatar tone="brand" size="lg" shape="square" className="shadow-sm">
          <Sparkles size={22} />
        </Avatar>
        <div>
          <div className="text-title font-semibold text-fg">{BRAND.name}</div>
          <div className="text-caption text-faint">
            {BRAND.nameEn} · {BRAND.slogan}
          </div>
        </div>
      </div>
      <p className="mt-4 text-body leading-relaxed text-muted">{BRAND.intro}</p>
      <dl className="mt-4 flex flex-col gap-2 text-caption">
        <div className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-faint">运营主体</dt>
          <dd className="truncate text-fg">{BRAND.company}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-faint">备案</dt>
          <dd className="truncate text-fg">{BRAND.icp}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="shrink-0 text-faint">客户端</dt>
          <dd className="truncate text-fg">
            {BRAND.name} Web · © {BRAND.year}
          </dd>
        </div>
      </dl>
    </div>
  );
}
