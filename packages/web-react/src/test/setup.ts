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
