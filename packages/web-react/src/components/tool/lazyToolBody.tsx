/**
 * OCV5-310: 工具卡展开体(bodies.tsx 及其拖入的文献/连接器/技能/发布/记忆等专属卡)只在
 * 「点开」后才渲染,移出入口静态闭包(first-screen-budget,见 vite.config.ts)。
 *
 * - 首屏空闲时预取(preloadToolBody),正常使用里点开前早已就绪,不出加载态;
 * - 模块已就绪时 lazy 工厂返回**同步 thenable**,React 当场解析、不挂起 —— 渲染路径始终是
 *   同一个 <Suspense><Lazy/></Suspense>,就绪前后不会因换元素类型而重挂、丢展开态;
 * - 需要同步断言展开体的测试文件用 loadBeforeAll(preloadToolBody)(src/test/moduleLoad.ts)先取好;
 *   不再放进全局 setup,其余几百个文件不必每个都付这次加载(OCV5-376)。
 */
import { lazy, Suspense, type ComponentProps } from "react";

type BodiesModule = typeof import("./bodies");
type ToolBodyProps = ComponentProps<BodiesModule["ToolBody"]>;

let loaded: BodiesModule | null = null;
let pending: Promise<BodiesModule> | null = null;

export function preloadToolBody(): Promise<BodiesModule> {
  pending ??= import("./bodies").then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      // 取失败(离线、发版后旧 chunk 已删)不留在缓存里:下一次点开重新取,
      // 而不是此后每次都拿到同一个失败。
      pending = null;
      throw error;
    },
  );
  return pending;
}

const LazyToolBody = lazy(() => {
  const ready = loaded;
  if (ready) {
    const sync = {
      then(resolve: (value: { default: BodiesModule["ToolBody"] }) => void) {
        resolve({ default: ready.ToolBody });
      },
    };
    return sync as unknown as Promise<{ default: BodiesModule["ToolBody"] }>;
  }
  return preloadToolBody().then((module) => ({ default: module.ToolBody }));
});

// 空闲预取只是提速;失败时静默,真正点开时再取并由 Suspense / ChunkErrorBoundary 处理。
function prefetchWhenIdle(): void {
  preloadToolBody().catch(() => {});
}

if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (idle) idle(prefetchWhenIdle);
  else window.setTimeout(prefetchWhenIdle, 1500);
}

export function ToolBody(props: ToolBodyProps) {
  return (
    <Suspense fallback={<div className="py-1 text-caption text-faint">加载中…</div>}>
      <LazyToolBody {...props} />
    </Suspense>
  );
}
