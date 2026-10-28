/**
 * 错误卡懒加载入口(W3 FE-errors)。错误卡要按错误码查 protocol 错误目录,目录约 7KB gzip,
 * 放进首屏会超 first-screen-budget(vite.config.ts)。做法同 tool/lazyToolBody:
 * - 首屏空闲时预取,真出错时早已就绪,不出加载态;
 * - 模块就绪后 lazy 工厂返回同步 thenable,React 当场解析、不挂起;
 * - 用例在 src/test/setup.ts 里先取好(块很小),渲染即同步出卡。
 */
import { lazy, Suspense } from "react";
import type { TurnErrorNoticeProps } from "./TurnErrorNotice";

type NoticeModule = typeof import("./TurnErrorNotice");

let loaded: NoticeModule | null = null;
let pending: Promise<NoticeModule> | null = null;

export function preloadTurnErrorNotice(): Promise<NoticeModule> {
  pending ??= import("./TurnErrorNotice").then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      // 取失败(离线、发版后旧 chunk 已删)不缓存:下一张错误卡重新取。
      pending = null;
      throw error;
    },
  );
  return pending;
}

const LazyTurnErrorNotice = lazy(() => {
  const ready = loaded;
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: 模块已就绪时给 React.lazy 的同步 thenable(同 lazyToolBody),当场解析不挂起。
      then(resolve: (value: { default: NoticeModule["TurnErrorNotice"] }) => void) {
        resolve({ default: ready.TurnErrorNotice });
      },
    };
    return sync as unknown as Promise<{ default: NoticeModule["TurnErrorNotice"] }>;
  }
  return preloadTurnErrorNotice().then((module) => ({ default: module.TurnErrorNotice }));
});

function prefetchWhenIdle(): void {
  preloadTurnErrorNotice().catch(() => {});
}

if (typeof window !== "undefined") {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (idle) idle(prefetchWhenIdle);
  else window.setTimeout(prefetchWhenIdle, 1500);
}

export function ErrorNotice(props: TurnErrorNoticeProps) {
  return (
    <Suspense fallback={null}>
      <LazyTurnErrorNotice {...props} />
    </Suspense>
  );
}
