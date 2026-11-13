import { lazy, useState } from "react";
import { BootSplash } from "./components/BootSplash";
import { readNetworkInformation, shouldPrefetchCenters } from "./lib/prefetchPolicy";
import { TASKBOARD_ENABLED } from "./lib/taskboardFeature";

// 首屏瘦身:营销首页 + 设置/管理/市场/组织/教程中心按需异步加载,移出 entry chunk。
// 命名导出 → default 适配。渲染点各自套 LazyBoundary（= chunk 加载失败兜底 + Suspense：
// 对话框仅在 open 时挂载 → 首屏零下载,首次打开拉块时短暂显 loading；React.lazy 解析后模块
// 常驻,再次打开无回退闪烁。发新版后旧标签页拉不到旧 chunk 时由 ChunkErrorBoundary 兜底,
// 提示刷新而非白屏——见 components/ChunkErrorBoundary）。
export const IdentityRecoveryNotice = lazy(() => import("./components/AccountSwitchNotice").then((m) => ({ default: m.IdentityRecoveryNotice })));
export const AccountSwitchNotice = lazy(() => import("./components/AccountSwitchNotice").then((m) => ({ default: m.AccountSwitchNotice })));
export const AuthGate = lazy(() => import("./components/AuthGate").then((m) => ({ default: m.AuthGate })));
export const Landing = lazy(() => import("./components/Landing").then((m) => ({ default: m.Landing })));
export const DesktopEnrollPage = lazy(() =>
  import("./components/DesktopEnrollPage").then((m) => ({ default: m.DesktopEnrollPage })),
);
export const TutorialCenter = lazy(() =>
  import("./components/TutorialCenter").then((m) => ({ default: m.TutorialCenter })),
);
export const ContainerWebPreview = lazy(() =>
  import("./components/ContainerWebPreview").then((m) => ({ default: m.ContainerWebPreview })),
);
// OCV5-593 媒体工作台:/studio 整页独立界面,只有进入时才下载。
export const StudioApp = lazy(() => import("./components/studio/StudioApp").then((m) => ({ default: m.StudioApp })));
export const TaskboardView = lazy(() =>
  import("./components/taskboard/TaskboardView").then((m) => ({ default: m.TaskboardView })),
);
// 2026-09-17 首屏体量门(first-screen-budget)超限修复:下列对话框/编辑器都是「点开才需要」的
// 覆盖层,此前静态 import 把它们(连同 ImageViewer 三模式、ProjectAssetsPanel 等)钉在入口静态
// 闭包里。改 React.lazy 后由渲染点的挂载闸(useMountedOnce / 条件挂载)控制首次下载;打开过
// 一次即常驻,状态保留与关闭语义与原先「始终挂载、按 open 显隐」一致。
// 详情面板沿用 paneInline / paneSheetOpen 的打开条件，首次打开时才下载。
export const InspectorPanel = lazy(() =>
  import("./components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })),
);
export const InspectorPanelContent = lazy(() =>
  import("./components/InspectorPanel").then((m) => ({ default: m.InspectorPanelContent })),
);
export const ImageAnnotationEditor = lazy(() =>
  import("./components/ImageAnnotationEditor").then((m) => ({ default: m.ImageAnnotationEditor })),
);
// 项目主页(/p/<id>)是并列工作区,点开项目才需要;带着 ProjectAssetsPanel,不能进入口闭包。
export const ProjectHome = lazy(() =>
  import("./components/project/ProjectHome").then((m) => ({ default: m.ProjectHome })),
);

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。首屏渲染完成后在浏览器空闲期预取这些懒块——Vite 对同一 specifier
// 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;弱网下预取失败静默,
// 行为退化为按需加载,不比没有预取更差。
export function prefetchLazyCentersOnIdle(): void {
  const prefetch = () => {
    // 省流量模式 / 2G 下不在后台下完全部中心(shell 审计 S-16);API 缺席的浏览器照常预取。
    if (!shouldPrefetchCenters(readNetworkInformation())) return;
    void import("./components/AgentPicker").catch(() => {});
    void import("./components/Landing").catch(() => {});
    void import("./components/SettingsCenter").catch(() => {});
    void import("./components/ManageCenter").catch(() => {});
    void import("./components/MarketplaceCenter").catch(() => {});
    void import("./components/OrgCenter").catch(() => {});
    void import("./components/TutorialCenter").catch(() => {});
    void import("./components/MediaTaskCenter").catch(() => {});
    // 全屏图片查看器(含圈选编辑/评论/调整大小)也是懒块:时间线里点图即开,预热后首开零延迟。
    void import("./components/ImageViewer").catch(() => {});
    if (TASKBOARD_ENABLED) {
      void import("./components/taskboard/TaskboardView").catch(() => {});
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prefetch, { timeout: 8000 });
  } else {
    setTimeout(prefetch, 3000);
  }
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

