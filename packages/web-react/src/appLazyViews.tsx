import { type ComponentProps, useState } from "react";
import { BootSplash } from "./components/BootSplash";
import { LazyBoundary } from "./components/ChunkErrorBoundary";
import { createRetryableLazy } from "./components/ui/retryableLazy";
import { readNetworkInformation, shouldPrefetchCenters } from "./lib/prefetchPolicy";
import { TASKBOARD_ENABLED } from "./lib/taskboardFeature";

// 首屏瘦身:营销首页 + 设置/管理/市场/组织/教程中心按需异步加载,移出 entry chunk。
// 命名导出 → default 适配。渲染点各自套 LazyBoundary（= chunk 加载失败兜底 + Suspense：
// 对话框仅在 open 时挂载 → 首屏零下载,首次打开拉块时短暂显 loading；解析后模块常驻,
// 再次打开无回退闪烁。发新版后旧标签页拉不到旧 chunk 时清缓存重建 lazy 并由 ChunkErrorBoundary 兜底）。
export const IdentityRecoveryNotice = createRetryableLazy(() => import("./components/AccountSwitchNotice").then((m) => ({ default: m.IdentityRecoveryNotice })));
export const AccountSwitchNotice = createRetryableLazy(() => import("./components/AccountSwitchNotice").then((m) => ({ default: m.AccountSwitchNotice })));
export const AuthGate = createRetryableLazy(() => import("./components/AuthGate").then((m) => ({ default: m.AuthGate })));
export const AgentGate = createRetryableLazy(() => import("./components/AgentGate").then((m) => ({ default: m.AgentGate })));
const RepoStatusBannerLazy = createRetryableLazy(() =>
  import("./components/github/RepoStatusBanner").then((m) => ({ default: m.RepoStatusBanner })),
);
const ErrorBannerLazy = createRetryableLazy(() =>
  import("./components/ErrorBanner").then((m) => ({ default: m.ErrorBanner })),
);
const UpdateBannerLazy = createRetryableLazy(() =>
  import("./components/UpdateBanner").then((m) => ({ default: m.UpdateBanner })),
);
const BackgroundTurnBannerLazy = createRetryableLazy(() =>
  import("./components/chat/BackgroundTurnBanner").then((m) => ({ default: m.BackgroundTurnBanner })),
);
const TurnCostReminderLazy = createRetryableLazy(() =>
  import("./components/chat/TurnCostReminder").then((m) => ({ default: m.TurnCostReminder })),
);
const PinnedHudStackLazy = createRetryableLazy(() =>
  import("./components/chat/PinnedHudStack").then((m) => ({ default: m.PinnedHudStack })),
);
const AppDialogsLazy = createRetryableLazy(() =>
  import("./components/AppDialogs").then((m) => ({ default: m.AppDialogs })),
);
export function RepoStatusBanner(props: ComponentProps<typeof RepoStatusBannerLazy>) {
  return <LazyBoundary fallback={null}><RepoStatusBannerLazy {...props} /></LazyBoundary>;
}
export function ErrorBanner(props: ComponentProps<typeof ErrorBannerLazy>) {
  return <LazyBoundary fallback={null}><ErrorBannerLazy {...props} /></LazyBoundary>;
}
export function UpdateBanner() {
  return <LazyBoundary fallback={null}><UpdateBannerLazy /></LazyBoundary>;
}
export function BackgroundTurnBanner(props: ComponentProps<typeof BackgroundTurnBannerLazy>) {
  return <LazyBoundary fallback={null}><BackgroundTurnBannerLazy {...props} /></LazyBoundary>;
}
export function TurnCostReminder(props: ComponentProps<typeof TurnCostReminderLazy>) {
  return <LazyBoundary fallback={null}><TurnCostReminderLazy {...props} /></LazyBoundary>;
}
export function PinnedHudStack(props: ComponentProps<typeof PinnedHudStackLazy>) {
  return <LazyBoundary fallback={null}><PinnedHudStackLazy {...props} /></LazyBoundary>;
}
export function AppDialogs(props: ComponentProps<typeof AppDialogsLazy>) {
  return <LazyBoundary fallback={null}><AppDialogsLazy {...props} /></LazyBoundary>;
}
export const Landing = createRetryableLazy(() => import("./components/Landing").then((m) => ({ default: m.Landing })));
export const DesktopEnrollPage = createRetryableLazy(() =>
  import("./components/DesktopEnrollPage").then((m) => ({ default: m.DesktopEnrollPage })),
);
export const TutorialCenter = createRetryableLazy(() =>
  import("./components/TutorialCenter").then((m) => ({ default: m.TutorialCenter })),
);
export const ContainerWebPreview = createRetryableLazy(() =>
  import("./components/ContainerWebPreview").then((m) => ({ default: m.ContainerWebPreview })),
);
// OCV5-593 媒体工作台:/studio 整页独立界面,只有进入时才下载。
export const StudioApp = createRetryableLazy(() => import("./components/studio/StudioApp").then((m) => ({ default: m.StudioApp })));
export const TaskboardView = createRetryableLazy(() =>
  import("./components/taskboard/TaskboardView").then((m) => ({ default: m.TaskboardView })),
);
export const SitesWorkspaceView = createRetryableLazy(() =>
  import("./components/sites/SitesWorkspaceView").then((m) => ({ default: m.SitesWorkspaceView })),
);
// 2026-09-17 首屏体量门(first-screen-budget)超限修复:下列对话框/编辑器都是「点开才需要」的
// 覆盖层,此前静态 import 把它们(连同 ImageViewer 三模式、ProjectAssetsPanel 等)钉在入口静态
// 闭包里。改 createRetryableLazy 后由渲染点的挂载闸(useMountedOnce / 条件挂载)控制首次下载。
export const InspectorPanel = createRetryableLazy(() =>
  import("./components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })),
);
export const InspectorPanelContent = createRetryableLazy(() =>
  import("./components/InspectorPanel").then((m) => ({ default: m.InspectorPanelContent })),
);
export const ImageAnnotationEditor = createRetryableLazy(() =>
  import("./components/ImageAnnotationEditor").then((m) => ({ default: m.ImageAnnotationEditor })),
);
// 项目主页(/p/<id>)是并列工作区,点开项目才需要;带着 ProjectAssetsPanel,不能进入口闭包。
export const ProjectHome = createRetryableLazy(() =>
  import("./components/project/ProjectHome").then((m) => ({ default: m.ProjectHome })),
);

// 同屏伴随快问小窗:按需加载,失败时清缓存并重建 lazy 工厂以便重试恢复。
export const QuickAskWindow = createRetryableLazy(() =>
  import("./components/chat/QuickAskWindow").then((m) => ({ default: m.QuickAskWindow })),
);

let lazyCentersPrefetchScheduled = false;

/** 测试辅助：重置懒块预取一次守卫。 */
export function _resetLazyCentersPrefetchForTest(): void {
  lazyCentersPrefetchScheduled = false;
}

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。确认登录后（或 demo 工作区）在浏览器空闲期预取这些懒块——Vite 对同一
// specifier 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;匿名访问首页
// （Landing / AuthGate）不调用本函数,避免额外拉取 8+ 个登录后中心大块;弱网下预取失败静默。
export function prefetchLazyCentersOnIdle(): () => void {
  if (lazyCentersPrefetchScheduled) return () => {};
  lazyCentersPrefetchScheduled = true;
  let fired = false;
  let cancelled = false;
  const prefetch = () => {
    if (cancelled || fired) return;
    fired = true;
    // 省流量模式 / 2G 下不在后台下完全部中心(shell 审计 S-16);API 缺席的浏览器照常预取。
    if (!shouldPrefetchCenters(readNetworkInformation())) return;
    void import("./components/AgentPicker").catch(() => {});
    void import("./components/SettingsCenter").catch(() => {});
    void import("./components/ManageCenter").catch(() => {});
    void import("./components/MarketplaceCenter").catch(() => {});
    void import("./components/OrgCenter").catch(() => {});
    void import("./components/TutorialCenter").catch(() => {});
    void import("./components/MediaTaskCenter").catch(() => {});
    // 全屏图片查看器(含圈选编辑/评论/调整大小)也是懒块:时间线里点图即开,预热后首开零延迟。
    void import("./components/ImageViewer").catch(() => {});
    void import("./components/chat/PinnedHudStack").catch(() => {});
    void import("./components/AppDialogs").catch(() => {});
    void import("./components/lazyModelSelectorPanel")
      .then((m) => m.preloadModelSelectorPanel())
      .catch(() => {});
    void import("./components/sites/SitesWorkspaceView").catch(() => {});
    if (TASKBOARD_ENABLED) {
      void import("./components/taskboard/TaskboardView").catch(() => {});
    }
  };
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(prefetch, { timeout: 8000 });
    return () => {
      cancelled = true;
      if (!fired) {
        lazyCentersPrefetchScheduled = false;
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
      }
    };
  }
  const timer = setTimeout(prefetch, 3000);
  return () => {
    cancelled = true;
    if (!fired) {
      lazyCentersPrefetchScheduled = false;
      clearTimeout(timer);
    }
  };
}

/** 全屏懒块加载态（营销首页 chunk 下载期）——与启动续期 splash 同视觉,不割裂。*/
export function SplashFallback() {
  return <BootSplash />;
}
/** 懒加载对话框的挂载闸:首次 open 之前不挂载(不下载 chunk);打开过一次后常驻返回 true,
 *  保持与原先「始终挂载、按 open 显隐」相同的状态保留/关闭语义。渲染期 setState 是 React
 *  认可的「由 props 派生状态」写法,只在 open 首次翻真时触发一次。 */
export function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  return mounted || open;
}

