/**
 * PWA Service Worker 注册。
 *
 * 仅在「生产构建 + 安全上下文 + 浏览器支持」三条件同时满足时注册：
 *  - `import.meta.env.PROD`：dev(`vite`)下不注册，避免 SW 缓存与 HMR 打架/钉住旧模块；
 *    `vite preview` 跑的是生产构建(PROD=true)故可本地冒烟。
 *  - `window.isSecureContext`：https 或 localhost(localhost 亦为安全上下文)。
 *  - `'serviceWorker' in navigator`：老浏览器优雅降级为普通网页。
 *
 * `updateViaCache:'none'`：sw.js 脚本本身永不吃 HTTP 缓存，配合 gateway 对 sw.js 的
 * no-cache，确保新 SW 能被及时发现(sw.js 内 skipWaiting+clientsClaim 即时接管)。
 * 注册失败静默吞掉——PWA 是渐进增强，失败即退回普通网页，不影响主流程。
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      /* 注册失败：降级为普通网页 */
    });
  });
}
