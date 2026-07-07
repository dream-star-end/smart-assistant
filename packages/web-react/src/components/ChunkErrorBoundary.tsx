import { Component, Suspense, type ReactNode } from "react";

/**
 * 识别「动态 import 失败」错误:典型场景=SPA 长开的旧标签页,前端发了新版后 index.html 的
 * chunk 哈希已变,旧标签页按内存里的旧哈希去取块 → 404 / fetch 失败。各浏览器/打包器的
 * 报错文案不同(ChunkLoadError / Failed to fetch dynamically imported module / …),这里
 * 宽松匹配一组已知形态。
 */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
  return /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|dynamically imported module|Unable to preload CSS/i.test(
    msg,
  );
}

type Props = { children: ReactNode };
type State = { failed: boolean; stale: boolean };

/**
 * 懒加载中心(Landing / Settings / Manage / Marketplace / Org)的加载失败兜底。
 *
 * 修复 P0 真 bug:这些中心用 React.lazy 动态加载,渲染点原本只包 Suspense、顶层无 error
 * boundary。SPA 旧标签页 → 发新版 → 旧 chunk 被新哈希取代 → 点这些中心 → lazy import
 * reject → Suspense 把错误重抛且无人接住 → 整个 App 白屏。
 *
 * 捕获后给出**可恢复出口**而非白屏:
 *  - stale-chunk(发版换哈希)→「已发布新版本」+ 一键刷新(location.reload 强制重取新 index.html);
 *  - 其它渲染错误 → 通用「加载出错」+ 刷新(同样给出口,好过白屏)。
 *
 * 这些中心是**条件挂载**(open 时才 mount,关闭即卸载),故关闭再打开会重建本边界、自动重置
 * failed 态,无需手动 reset;而唯一的恢复动作(整页刷新)本就会把边界连同页面一起重置。
 */
export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, stale: false };

  static getDerivedStateFromError(err: unknown): State {
    return { failed: true, stale: isChunkLoadError(err) };
  }

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 px-6 backdrop-blur-sm">
        <div role="alert" className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-[15px] font-medium text-fg">
            {this.state.stale ? "已发布新版本" : "此页面加载出错"}
          </p>
          <p className="text-[13px] leading-relaxed text-muted">
            {this.state.stale
              ? "页面已更新，刷新后即可继续使用。"
              : "刷新页面通常即可恢复。"}
          </p>
          <button
            type="button"
            onClick={this.reload}
            className="mt-1 rounded-full bg-primary px-5 py-2 text-[13px] font-medium text-primary-fg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            刷新
          </button>
        </div>
      </div>
    );
  }
}

/**
 * chunk 边界 + Suspense 的组合封装:替换懒加载中心渲染点原本裸用的 <Suspense fallback>。
 * `fallback` 是**加载中**(chunk 下载期)的占位;加载**失败**由 ChunkErrorBoundary 接管。
 */
export function LazyBoundary({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}
