/**
 * OCV5-422 慢网首屏:入口样式表不再挡首次绘制(纯函数,构建插件 glue 见 vite.config.ts 的 nonBlockingEntryCss())。
 *
 * why:构建注入的 `<link rel="stylesheet" href="/assets/styles-*.css">` 在 head 里是渲染阻塞的。实测 40KB/s +
 * 1.5s 延迟下它 30 秒以上才下完,这之前浏览器什么都不画 —— 白屏,index.html 里的内联占位(.oc-boot)和
 * 「网络较慢」提示也画不出来。
 *
 * 做法:
 * - 入口样式表 link 改成 `rel=preload as=style`:预加载扫描器照常最先发起、优先级不变,但不阻塞绘制;
 * - 紧跟一段内联脚本,用同一 URL 插入真正的 stylesheet(脚本插入的样式表不阻塞渲染,命中预加载不重复下载),
 *   全部加载结束(成功或失败)时兑现 `window.__ocCss`;
 * - main.tsx 等 `__ocCss` 兑现后才挂载 React(waitForEntryStyles):内联占位一直顶到样式到位,不会出现
 *   一帧没有样式的界面。样式表加载失败也照常挂载,与以前阻塞样式表 404 时的表现相同。
 * dev(vite serve)由 JS 注入样式、没有这些 link,`__ocCss` 不存在,直接挂载。
 */

export const CSS_READY_GLOBAL = "__ocCss";

const STYLESHEET_LINK = /<link rel="stylesheet"( crossorigin)? href="([^"]+\.css)"\s*\/?>/g;

export type DeferredStylesheets = { html: string; hrefs: string[] };

export function deferEntryStylesheets(html: string): DeferredStylesheets {
  const links: { href: string; crossorigin: boolean }[] = [];
  let out = "";
  let cursor = 0;
  for (const match of html.matchAll(STYLESHEET_LINK)) {
    const cross = match[1] ?? "";
    const href = match[2]!;
    links.push({ href, crossorigin: cross !== "" });
    out += `${html.slice(cursor, match.index)}<link rel="preload" as="style"${cross} href="${href}">`;
    cursor = match.index! + match[0].length;
  }
  if (links.length === 0) return { html, hrefs: [] };
  // 加载脚本紧跟最后一个样式表 link:插入的 stylesheet 在 head 末尾,与原 link 一样排在内联 <style> 之后。
  out += `\n    <script>${loaderScript(links)}</script>${html.slice(cursor)}`;
  return { html: out, hrefs: links.map((link) => link.href) };
}

function loaderScript(links: { href: string; crossorigin: boolean }[]): string {
  const list = JSON.stringify(links.map((link) => [link.href, link.crossorigin ? 1 : 0]));
  // ES5、无依赖:它在 head 里同步执行,早于任何模块脚本。
  return [
    `(function(){var d=document;window.${CSS_READY_GLOBAL}=Promise.all(${list}.map(function(e){`,
    'return new Promise(function(done){var l=d.createElement("link");l.rel="stylesheet";',
    'if(e[1])l.crossOrigin="anonymous";l.onload=function(){done(true)};l.onerror=function(){done(false)};',
    "l.href=e[0];d.head.appendChild(l)})}))})();",
  ].join("");
}

/** 等入口样式表就绪(或加载失败)。没有 `__ocCss`(dev、测试)时立即兑现。 */
export function waitForEntryStyles(target: object = globalThis): Promise<void> {
  const pending = (target as Record<string, unknown>)[CSS_READY_GLOBAL];
  if (!pending || typeof (pending as Promise<unknown>).then !== "function") return Promise.resolve();
  return Promise.resolve(pending as Promise<unknown>).then(
    () => undefined,
    () => undefined,
  );
}
