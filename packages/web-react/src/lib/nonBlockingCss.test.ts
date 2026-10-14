import { describe, expect, test } from "vitest";
import { CSS_READY_GLOBAL, deferEntryStylesheets, waitForEntryStyles } from "./nonBlockingCss";

// OCV5-422: 入口样式表不挡首次绘制;React 等样式就绪再挂载。
const BUILT = `<!doctype html>
<html><head>
    <style>.oc-boot{position:fixed}</style>
    <script type="module" crossorigin src="/assets/main-AAAA.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/react-vendor-BBBB.js">
    <link rel="stylesheet" crossorigin href="/assets/styles-CCCC.css">
  <meta name="oc-build" content="x">
  </head><body><div id="root"></div></body></html>`;

describe("deferEntryStylesheets", () => {
  test("入口样式表变成预加载,紧跟一段插入真正样式表的脚本;其它标签不动", () => {
    const { html, hrefs } = deferEntryStylesheets(BUILT);
    expect(hrefs).toEqual(["/assets/styles-CCCC.css"]);
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).toContain('<link rel="preload" as="style" crossorigin href="/assets/styles-CCCC.css">');
    expect(html).toContain('<link rel="modulepreload" crossorigin href="/assets/react-vendor-BBBB.js">');
    expect(html).toContain('<script type="module" crossorigin src="/assets/main-AAAA.js"></script>');
    const preloadAt = html.indexOf('rel="preload"');
    const scriptAt = html.indexOf(`window.${CSS_READY_GLOBAL}=`);
    expect(scriptAt).toBeGreaterThan(preloadAt);
    expect(scriptAt).toBeLessThan(html.indexOf("</head>"));
    expect(html).toContain('l.crossOrigin="anonymous"');
  });

  test("加载脚本在浏览器里插入同一 URL 的 stylesheet,load / error 都兑现 __ocCss", async () => {
    const { html } = deferEntryStylesheets(BUILT);
    const source = /<script>(\(function\(\)\{var d=document;[\s\S]*?)<\/script>/.exec(html)![1]!;
    const before = document.head.querySelectorAll('link[rel="stylesheet"]').length;
    new Function(source)();
    const links = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].slice(before);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/assets/styles-CCCC.css"]);
    expect(links[0]!.crossOrigin).toBe("anonymous");
    let settled = false;
    const ready = waitForEntryStyles(window).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    links[0]!.dispatchEvent(new Event("error"));
    await ready;
    expect(settled).toBe(true);
    links[0]!.remove();
    delete (window as unknown as Record<string, unknown>)[CSS_READY_GLOBAL];
  });

  test("多个入口样式表都等;没有样式表 link 时原样返回(dev)", () => {
    const two = BUILT.replace(
      '<link rel="stylesheet" crossorigin href="/assets/styles-CCCC.css">',
      '<link rel="stylesheet" href="/assets/a.css">\n    <link rel="stylesheet" crossorigin href="/assets/b.css">',
    );
    const { html, hrefs } = deferEntryStylesheets(two);
    expect(hrefs).toEqual(["/assets/a.css", "/assets/b.css"]);
    expect(html).toContain('<link rel="preload" as="style" href="/assets/a.css">');
    expect(html.match(new RegExp(`window\\.${CSS_READY_GLOBAL}=`, "g"))).toHaveLength(1);
    const dev = "<html><head></head><body></body></html>";
    expect(deferEntryStylesheets(dev)).toEqual({ html: dev, hrefs: [] });
  });
});

describe("waitForEntryStyles", () => {
  test("没有 __ocCss 时立即兑现;被拒绝也照常兑现(样式失败仍要挂载)", async () => {
    await expect(waitForEntryStyles({})).resolves.toBeUndefined();
    await expect(waitForEntryStyles({ [CSS_READY_GLOBAL]: Promise.reject(new Error("x")) })).resolves.toBeUndefined();
  });
});
