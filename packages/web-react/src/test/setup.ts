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
