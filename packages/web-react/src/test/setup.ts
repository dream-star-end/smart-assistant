import { configure } from "@testing-library/react";

// waitFor/findBy 的失败截止线从 RTL 默认 1s 提到 5s —— 这是**真实时钟**,不是等待时长:
// 条件满足即刻返回,绿路径零成本;只在断言注定失败时才等满。1s 是按空闲开发机标定的默认值,
// CI 4 vCPU 上 vitest 多 fork 并行(整套 ~72s)存在 >1s 的调度饥饿窗口,曾把正确的测试
// 掐成 flaky(connectorCards/App 路由,2026-07-11 CI 实证)。此处是全套件截止线的单一权威,
// 禁止在单个用例里散装 {timeout}(时序竞态要修交互本身,如"等按钮 enabled 再点")。
configure({ asyncUtilTimeout: 5_000 });

// Vitest 全局测试基建。jsdom 不实现 window.matchMedia，而 useTheme 在挂载时即调用它，
// 缺失会让所有渲染 <App> 的用例在 effect 阶段抛 "matchMedia is not a function"。
// 这里提供一个最小、确定性的 matchMedia 桩（默认浅色、不匹配 dark），让前端套件可跑。
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom doesn't implement Element.scrollTo. App.tsx's autoscroll effect calls
// scrollRef.current.scrollTo({...}) on every message/stream update; without this
// shim that throws an uncaught exception and crashes every workspace render.
// Same class of environment gap as matchMedia above — a deterministic no-op.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}

// jsdom doesn't implement ResizeObserver; radix 浮层原语（DropdownMenu/Popover 的
// popper 定位）在挂载 Content 时即构造它，缺失会让所有"打开浮层"的用例直接抛错。
// 与上面 matchMedia 同类的环境缺口 —— 确定性 no-op 桩。
if (typeof window !== "undefined" && typeof window.ResizeObserver !== "function") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement Element.scrollIntoView; radix menu 聚焦首个 item 时调用。
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}
