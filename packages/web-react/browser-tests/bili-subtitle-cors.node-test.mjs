// INC-20261013-BILI-SUBTITLE-CDN-CORS: the bili-account worker's subtitle read, run in real Chromium.
// hdslb serves subtitle files with `Access-Control-Allow-Origin: *`; the browser refuses that for a
// credentialed fetch, so the worker must read the CDN file with credentials 'omit' while the
// api.bilibili.com reads keep the session. No network: every host is answered by page routes.
// Negative control: OC_BILI_SUBTITLE_CORS_RED=1 puts back the credentialed CDN read; this test goes red.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { chromium } = createRequire(import.meta.url)("playwright-core");

function workerActions() {
  const file = readFileSync(new URL("../../commercial/src/plugins/biliAccountWorkerSource.ts", import.meta.url), "utf8");
  const head = "export const BILI_ACCOUNT_WORKER_SOURCE = String.raw`";
  let src = file.slice(file.indexOf(head) + head.length, file.lastIndexOf("`"));
  if (process.env.OC_BILI_SUBTITLE_CORS_RED) {
    assert.ok(src.includes("apiGet(page, subtitleUrl, 'omit')"));
    src = src.replace("apiGet(page, subtitleUrl, 'omit')", "apiGet(page, subtitleUrl)");
  }
  const start = src.indexOf("function filteredState");
  const end = src.indexOf("async function finishAction");
  assert.ok(start > 0 && end > start);
  return new Function(
    `'use strict';
     const MAX_API_TEXT = 900 * 1024;
     const SUBTITLE_HOSTS = new Set(['aisubtitle.hdslb.com', 'i0.hdslb.com']);
     const RISK_CODES = new Set([-352, -412, -799]);
     const createHash = () => ({ update() { return { digest() { return 'x' } } } });
     ${src.slice(start, end)}
     return { actionRead };`,
  )();
}

const SITE = "https://www.bilibili.com";
const json = (body, headers) => ({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });

test("bili-account subtitle reads the hdslb CDN without cookies (real Chromium)", { timeout: 120_000 }, async () => {
  const { actionRead } = workerActions();
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: "SESSDATA", value: "fixture", domain: ".bilibili.com", path: "/", secure: true, httpOnly: true, sameSite: "None" }]);
    const cdnCookies = [];
    // api.bilibili.com answers like the real site: exact origin + credentials allowed.
    const api = { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Credentials": "true" };
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE) return route.fulfill({ status: 200, contentType: "text/plain", body: "User-agent: *\n" });
      if (url.pathname === "/x/web-interface/nav") return route.fulfill(json({ code: 0, data: { isLogin: true, mid: 12345 } }, api));
      if (url.pathname === "/x/player/pagelist") return route.fulfill(json({ code: 0, data: [{ cid: 111 }] }, api));
      if (url.pathname === "/x/player/v2") {
        return route.fulfill(json({ code: 0, data: { subtitle: { subtitles: [{ lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/a.json?auth_key=x" }] } } }, api));
      }
      if (url.hostname === "aisubtitle.hdslb.com") {
        cdnCookies.push(route.request().headers().cookie ?? "");
        // What the live CDN sends (probed 2026-10-13): wildcard origin.
        return route.fulfill(json({ body: [{ from: 1, to: 2, content: "第一句" }, { from: 2, to: 3, content: "第二句" }] }, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true" }));
      }
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(`${SITE}/robots.txt`);

    const out = await actionRead(page, { actionId: "subtitle", params: { bvid: "BV1xx411c7mD" } });
    assert.equal(out.lang, "ai-zh");
    assert.deepEqual(out.lines.map((line) => line.text), ["第一句", "第二句"]);
    assert.deepEqual(cdnCookies, [""], "the CDN read carries no cookie");
  } finally {
    await browser.close();
  }
});
