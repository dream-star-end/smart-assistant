import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const { createFailureUiServer } = await tsImport("./delegate-failure-api.fixture.ts", import.meta.url);

test("durable failure UI: actual Chromium + original HTTP handler/SQLite, not native/model authorization", { timeout: 180_000 }, async t => {
  const cssDir = mkdtempSync(join(tmpdir(), "delegate-browser-css-"));
  let browser, api;
  const selected = process.env.OC_D15_BROWSER_GROUP;
  const journey = async (name, fn) => {
    if (!selected || name.startsWith(selected)) await t.test(name, fn);
  };
  try {
    const negative = process.env.OC_D15_BROWSER_NEGATIVE === "skip-ack";
    const plugins = negative ? [{ name: "virtual-original-ack-removal", setup(builder) {
      builder.onLoad({ filter: /delegateFailureController\.ts$/ }, args => {
        const code = readFileSync(args.path, "utf8"), anchor = "await delegateFailureApi.acknowledge(this.auth, row, signal.signal);";
        assert.ok(code.includes(anchor));
        return { contents: code.replace(anchor, "/* negative: no server ACK */"), loader: "ts" };
      });
    } }] : [];
    const bundle = async entry => (await build({ entryPoints: [join(HERE, entry)], bundle: true, write: false, format: "iife", jsx: "automatic",
      plugins, loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
      alias: { "node:crypto": join(HERE, "stubs/node-crypto.js") },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' }, logLevel: "error" })).outputFiles[0].text;
    const [focused, app] = await Promise.all([bundle("delegate-failure-harness.tsx"), bundle("goal-start-harness.tsx")]);
    await viteBuild({ root: join(HERE, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
      build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false, rollupOptions: { input: join(HERE, "preview-styles.ts"), output: { entryFileNames: "styles.js", assetFileNames: "[name][extname]" } } } });
    const cssName = readdirSync(cssDir).find(n => n.endsWith(".css")); assert.ok(cssName);
    const css = readFileSync(join(cssDir, cssName), "utf8");
    api = await createFailureUiServer(path => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body><div id="root"></div><script>${path === "/focused" ? focused : app}</script></body></html>`);
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    const external = [];
    const isolate = async context => {
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin === api.url) return route.continue();
        external.push(route.request().url()); return route.abort();
      });
      return context;
    };
    const context = await isolate(await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 1000 } }));
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const retryResponses = []; page.on("response", r => { if (r.url().endsWith("/retry")) void r.text().then(body => retryResponses.push({ status: r.status(), body }), () => retryResponses.push({ status: r.status(), body: "<interrupted>" })); });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(api.url + "/focused");
    const badge = page.getByRole("button", { name: /后台任务 .*失败/ });
    await badge.filter({ hasText: "51 失败" }).waitFor();
    await badge.click();
    const dialog = page.getByRole("dialog", { name: "后台任务失败收件箱" });
    const rows = dialog.locator("li[data-job-id]");
    await rows.first().waitFor();

    await journey("51 old failures survive runtime TTL and fresh DB; page boundaries do not ACK", async () => {
      assert.equal(await rows.count(), 50); assert.equal(api.count("alice"), 51);
      await dialog.getByRole("button", { name: "下一页", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll("li[data-job-id]").length === 1);
      await dialog.getByRole("button", { name: "上一页", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll("li[data-job-id]").length === 50);
      assert.equal(api.ackCalls.length, 0); assert.equal((await page.textContent("body")).includes("PRIVATE_RAW_SECRET_DETAIL"), false);
    });

    if (!negative) await journey("failed server ACK keeps row and visible error", async () => {
      api.failNextAck();
      const id = await rows.first().getAttribute("data-job-id");
      await rows.first().getByRole("button", { name: "知道了", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(await dialog.locator(`li[data-job-id="${id}"]`).count(), 1);
      assert.equal(api.count("alice"), 51);
    });

    await journey("explicit ACK reaches original SQLite; browser reload and DB reopen do not resurrect it", async () => {
      const id = await rows.first().getAttribute("data-job-id"), before = api.ackCalls.length;
      await rows.first().getByRole("button", { name: "知道了", exact: true }).click();
      await dialog.getByRole("button", { name: "刷新", exact: true }).waitFor();
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === "确认中…"));
      assert.equal(api.count("alice"), 50, "real persisted ACK must reduce source inbox count, not just local DOM");
      assert.equal(api.ackCalls.length, before + 1);
      api.reopen(); await page.reload();
      await badge.filter({ hasText: "50 失败" }).waitFor(); await badge.click(); await rows.first().waitFor();
      assert.equal(await dialog.locator(`li[data-job-id="${id}"]`).count(), 0);
    });
    if (negative) return;

    await journey("accepted response loss + busy hint: explicit deterministic intent replay has one persisted target, never ACK", async () => {
      const id = await rows.first().getAttribute("data-job-id");
      const source = dialog.locator(`li[data-job-id="${id}"]`), ackCount = api.ackCalls.length, originalCount = api.count("alice");
      api.dropNextRetry(); await source.getByRole("button", { name: "继续原子会话", exact: true }).click();
      await source.getByRole("alert").waitFor();
      await page.waitForFunction(id => [...document.querySelectorAll(`li[data-job-id="${id}"] button`)].some(b => b.textContent === "继续原子会话" && b.disabled), id);
      assert.equal(await source.getByRole("button", { name: "继续原子会话", exact: true }).isDisabled(), true);
      await source.getByRole("button", { name: "确认上次继续", exact: true }).click();
      await page.getByRole("button", { name: "确认并重发同一请求", exact: true }).click();
      await source.getByText(/已受理，等待执行/).waitFor().catch(async error => {
        t.diagnostic(JSON.stringify({ source: await source.textContent(), retryResponses, actions: api.retrySnapshot() })); throw error;
      });
      assert.equal(api.retryKeys.length, 2); assert.equal(api.retryKeys[0].actionId, api.retryKeys[1].actionId);
      assert.equal(api.retryTargets(), 1); assert.equal(api.ackCalls.length, ackCount); assert.equal(api.count("alice"), originalCount);
      api.finishRetry();
      await source.getByRole("button", { name: "确认上次继续", exact: true }).click();
      await page.getByRole("button", { name: "确认并重发同一请求", exact: true }).click();
      await source.getByText(/本次继续已结束，结果以原会话为准/).waitFor();
      assert.equal(api.retryTargets(), 1); assert.equal(api.count("alice"), originalCount + 1);
    });

    await journey("same mounted auth object switches account without showing A rows or counts", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "切换 B", exact: true }).click();
      await badge.filter({ hasText: "3 失败" }).waitFor(); await badge.click(); await rows.first().waitFor();
      assert.equal(await rows.count(), 3);
      for (const id of api.ids.alice) assert.equal(await dialog.locator(`li[data-job-id="${id}"]`).count(), 0);
      await rows.first().getByRole("button", { name: "查看原会话", exact: true }).click();
      assert.equal(await page.getByTestId("parent").textContent(), "session-bob");
      assert.equal(api.count("bob"), 3);
    });

    await journey("real production CSS mobile sheet stays in viewport, focus returns to badge", async () => {
      await page.setViewportSize({ width: 375, height: 812 }); await badge.click();
      const box = await dialog.boundingBox(); assert.ok(box && box.x >= -1 && box.x + box.width <= 376 && box.y >= -1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      assert.equal(await badge.evaluate(el => document.activeElement === el), true);
      assert.equal(await page.getByRole("button", { name: "停止本轮", exact: true }).count(), 0);
    });

    await journey("actual App with no active session still mounts authenticated failure footer", async () => {
      const appContext = await isolate(await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 1000 } }));
      const appPage = await appContext.newPage(); appPage.setDefaultTimeout(20_000);
      await appPage.addInitScript(() => { window.WebSocket = undefined; localStorage.setItem("oc_auth_hint", "1"); });
      const expectedCount = api.count("alice");
      const appErrors = []; appPage.on("pageerror", e => appErrors.push(e.message));
      await appPage.goto(api.url);
      await appPage.getByTestId("delegate-failure-footer").getByRole("button", { name: new RegExp(`${expectedCount} 失败`) }).waitFor().catch(async error => {
        t.diagnostic(JSON.stringify({ body: (await appPage.textContent("body")).slice(0, 5000), appErrors })); throw error;
      });
      await appPage.getByTestId("delegate-failure-footer").getByRole("button", { name: new RegExp(`${expectedCount} 失败`) }).click();
      await appPage.getByRole("dialog", { name: "后台任务失败收件箱" }).waitFor();
      await appContext.close();
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], "no request may escape private loopback fixture");
    t.diagnostic("real HTTP + original SQLite projection/ACK/action replay; native eligibility, principal auth and lifecycle are fixture seams; no production/master/model claim");
  } finally { if (api) t.diagnostic(JSON.stringify({ retryRequests: api.retryKeys.length, retryTargets: api.retryTargets(), ackRequests: api.ackCalls.length, alice: api.count("alice"), bob: api.count("bob") })); await browser?.close(); await api?.close(); rmSync(cssDir, { recursive: true, force: true }); }
});
