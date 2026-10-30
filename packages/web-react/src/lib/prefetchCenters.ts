import { readNetworkInformation, shouldPrefetchCenters } from "./prefetchPolicy";
import { TASKBOARD_ENABLED } from "./taskboardFeature";

// UX 体验对冲（红线:优化不得降低体验）:懒加载省首屏,但慢网下首开中心会多一个
// loading 瞬间。首屏渲染完成后在浏览器空闲期预取这些懒块——Vite 对同一 specifier
// 的动态 import 去重,预取后 React.lazy 解析即命中,首开零延迟;弱网下预取失败静默,
// 行为退化为按需加载,不比没有预取更差。
export function prefetchLazyCentersOnIdle(): void {
  const prefetch = () => {
    // 省流量模式 / 2G 下不在后台下完全部中心(shell 审计 S-16);API 缺席的浏览器照常预取。
    if (!shouldPrefetchCenters(readNetworkInformation())) return;
    void import("../components/Landing").catch(() => {});
    void import("../components/SettingsCenter").catch(() => {});
    void import("../components/ManageCenter").catch(() => {});
    void import("../components/MarketplaceCenter").catch(() => {});
    void import("../components/OrgCenter").catch(() => {});
    void import("../components/TutorialCenter").catch(() => {});
    void import("../components/MediaTaskCenter").catch(() => {});
    // 全屏图片查看器(含圈选编辑/评论/调整大小)也是懒块:时间线里点图即开,预热后首开零延迟。
    void import("../components/ImageViewer").catch(() => {});
    if (TASKBOARD_ENABLED) {
      void import("../components/taskboard/TaskboardView").catch(() => {});
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prefetch, { timeout: 8000 });
  } else {
    setTimeout(prefetch, 3000);
  }
}

