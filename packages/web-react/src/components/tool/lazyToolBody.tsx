/**
 * OCV5-310: 工具卡展开体(bodies.tsx 及其拖入的文献/连接器/技能/发布/记忆等专属卡)只在
 * 「点开」后才渲染,移出入口静态闭包(first-screen-budget,见 vite.config.ts)。
 *
 * - 首屏空闲时预取(preloadToolBody),正常使用里点开前早已就绪,不出加载态;
 * - 模块已就绪时 lazy 工厂返回**同步 thenable**,React 当场解析、不挂起 —— 渲染路径始终是
 *   同一个 <Suspense><Lazy/></Suspense>,就绪前后不会因换元素类型而重挂、丢展开态;
 * - 测试基建(src/test/setup.ts)启动即 await 预取,套件里照旧同步渲染。
 */
import { lazy, Suspense, type ComponentProps } from "react";

type BodiesModule = typeof import("./bodies");
type ToolBodyProps = ComponentProps<BodiesModule["ToolBody"]>;

let loaded: BodiesModule | null = null;
let pending: Promise<BodiesModule> | null = null;

export function preloadToolBody(): Promise<BodiesModule> {
  pending ??= import("./bodies").then((module) => {
    loaded = module;
    return module;
  });
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

if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (idle) idle(() => void preloadToolBody());
  else window.setTimeout(() => void preloadToolBody(), 1500);
}

export function ToolBody(props: ToolBodyProps) {
  return (
    <Suspense fallback={<div className="py-1 text-caption text-faint">加载中…</div>}>
      <LazyToolBody {...props} />
    </Suspense>
  );
}
