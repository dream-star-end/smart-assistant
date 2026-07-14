import * as Dialog from "@radix-ui/react-dialog";
import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { api, apiErrorMessage } from "../lib/api";
import { BRAND } from "../lib/brand";
import {
  type AutoDreamFeatureView,
  type PrefsView,
  extractAutoDreamFeature,
  extractPrefs,
} from "../lib/modelPreferences";
import type { AuthSession, User } from "../lib/types";
import { AccountTab } from "./settings/AccountTab";
import { FeedbackTab } from "./settings/FeedbackTab";
import { PreferencesTab } from "./settings/PreferencesTab";
import { SubscriptionDialog } from "./settings/SubscriptionDialog";
import { UsageTab } from "./settings/UsageTab";
import { Avatar, Spinner, Tabs } from "./ui";

type Section = "account" | "usage" | "preferences" | "feedback" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "账户与计费" },
  { id: "usage", label: "用量" },
  { id: "preferences", label: "偏好" },
  { id: "feedback", label: "反馈" },
  { id: "about", label: "关于" },
];

/**
 * 设置中心（v5 商业版）：账户与计费 / 用量 / 偏好 / 反馈 / 关于五分区。
 * 数据全部走 v5 REST（/api/me · /api/me/preferences · /api/me/usage · /api/me/api-keys ·
 * /api/payment/*），各分区懒加载（仅在 open 且激活时拉），demo / 未登录态不发任何请求。
 *
 * 主题：useTheme 仍是 live 唯一权威源，经 props 与顶栏快捷开关共享；偏好分区切换时
 * 额外写穿一份到后端 preferences（跨端镜像，不反向覆盖 live）。
 * 大数（credits / token / cost）全程字符串，绝不数值化（见 lib/utils 大数格式化）。
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
}: {
  open: boolean;
  auth: AuthSession | null;
  user: User | null;
  theme: Theme;
  /** demo 离线预览：不渲染需要网络的分区内容。 */
  demo?: boolean;
  onClose: () => void;
  onSetTheme: (t: Theme) => void;
  /** 充值到账后刷新顶栏 / 账户余额（App 重拉 /api/me）。 */
  onRefreshMe?: () => void;
  /** 偏好首次加载/保存后的完整快照；让 App 的对话默认值立即同步。 */
  onPreferencesChange?: (prefs: PrefsView, patch?: Record<string, unknown>) => void;
}) {
  const [section, setSection] = useState<Section>("account");
  const [subOpen, setSubOpen] = useState(false);
  const [ledgerReload, setLedgerReload] = useState(0);

  // preferences 集中持有：偏好分区首次激活时拉一次，patch 后用返回快照刷新。
  const [prefs, setPrefs] = useState<PrefsView | null>(null);
  const [autoDream, setAutoDream] = useState<AutoDreamFeatureView | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsErr, setPrefsErr] = useState<string | null>(null);

  // 关闭面板：复位分区与瞬态（避免重开残留）。
  useEffect(() => {
    if (!open) {
      setSection("account");
      setSubOpen(false);
    }
  }, [open]);

  // 偏好分区懒加载 prefs。
  // 注意：依赖数组**绝不能含 prefsLoading**——effect 自身 setPrefsLoading(true) 会改它，
  // 触发 cleanup(alive=false) 再重跑，使 fetch 回来时 alive 已 false、setPrefs/finally 被跳过
  // → 永久"加载偏好…"转圈（后端其实 200）。prefs!=null 守卫挡住成功后的回跑。
  useEffect(() => {
    if (!open || demo || !auth || section !== "preferences" || prefs != null) {
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
  }, [open, demo, auth, section, prefs, onPreferencesChange]);

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

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-fg">设置</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 pb-3">
            <div className="no-scrollbar overflow-x-auto">
              <Tabs
                aria-label="设置分区"
                value={section}
                onValueChange={(v) => setSection(v as Section)}
                items={SECTIONS.map((s) => ({ value: s.id, label: s.label }))}
                className="min-w-max [&_[role=tab]]:px-3"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : (
              <>
                {section === "account" && (
                  <AccountTab
                    auth={auth}
                    user={user}
                    onManageSub={() => setSubOpen(true)}
                    reloadKey={ledgerReload}
                    onRefreshMe={onRefreshMe}
                  />
                )}

                {section === "usage" && <UsageTab auth={auth} />}

                {section === "preferences" &&
                  (prefsLoading || !prefs ? (
                    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
                      {prefsErr ? (
                        <span className="text-danger">{prefsErr}</span>
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
                      onPatch={patchPref}
                      onUpgrade={() => setSubOpen(true)}
                    />
                  ))}

                {section === "feedback" && <FeedbackTab auth={auth} />}

                {section === "about" && <AboutSection />}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {auth && (
        <SubscriptionDialog
          open={subOpen}
          auth={auth}
          onClose={() => setSubOpen(false)}
          onPaid={onPaid}
        />
      )}
    </Dialog.Root>
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
          <div className="text-[16px] font-semibold text-fg">{BRAND.name}</div>
          <div className="text-[12.5px] text-faint">{BRAND.slogan}</div>
        </div>
      </div>
      <p className="mt-4 text-[13.5px] leading-relaxed text-muted">{BRAND.intro}</p>
      <dl className="mt-4 flex flex-col gap-2 text-[12.5px]">
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
