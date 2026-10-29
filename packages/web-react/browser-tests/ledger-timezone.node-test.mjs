// #1237 / INC-20261029-LEDGER-TZ-LABEL: the tester's Chrome ran in US Pacific time, so the ledger
// row written 2026-10-29 11:12 CST rendered as "10月28日 20:12" and looked like yesterday, and chat
// debits showed "其他 · cost=53". Real AccountTab in Chromium with timezoneId America/Los_Angeles.
// RED: OC_LEDGER_TZ_RED=1 drops the Asia/Shanghai pin from labels.ts at bundle time (no product edit).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { exactSwap } from "./harness-page.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const labelsPath = fileURLToPath(new URL("../src/components/settings/labels.ts", import.meta.url));
const RED = process.env.OC_LEDGER_TZ_RED === "1";

const ROW = {
  id: "26673", delta: "-53", balance_after: "198338", reason: "chat",
  ref_type: "usage_record", ref_id: "28950", memo: "cost=53",
  model_name: "GPT-6.1-Sol", session_title: "office-1029pm",
  created_at: "2026-10-29T03:12:24.566Z", // 11:12 Asia/Shanghai, 10-28 20:12 America/Los_Angeles
};
const zero = { input_tokens: "0", output_tokens: "0", cache_read_tokens: "0", cache_write_tokens: "0" };
const USAGE = {
  summary: { ...zero, requests_total: "0", billed_credits: "0", debited_credits: "0" },
  legacy_unattributed: { ...zero, requests: "0", billed_credits: "0" },
  savings: { savings_credits: "0", savings_is_estimate: false, savings_unavailable: false, savings_rows_skipped: 0 },
  cache: { hit_rate: null },
  sessions: { rows: [], limit: 20, offset: 0, has_more: false },
  ledger: { rows: [ROW], next_before: null },
  cutoff_started_at: null,
};
const REPORT = {
  window: "30d", summary: { ...zero, requests: "0", credits: "0" }, trend: [], models: [],
  ledger: { trend: [], by_reason: [] },
};

async function bundleHarness() {
  const source = await readFile(labelsPath, "utf8");
  const swaps = { count: 0 };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./ledger-timezone-harness.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
    alias: {
      "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)),
      "@openclaude/protocol/browser": fileURLToPath(new URL("../../protocol/src/browser.ts", import.meta.url)),
      "@openclaude/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)),
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    plugins: RED
      ? [exactSwap("ledger-tz-red", /[\\/]settings[\\/]labels\.ts$/, '  timeZone: "Asia/Shanghai",\n', "", swaps)]
      : [],
    logLevel: "error",
  });
  assert.equal(swaps.count, RED ? 1 : 0, "RED swaps exactly the Asia/Shanghai pin, never a product edit");
  assert.equal(await readFile(labelsPath, "utf8"), source, "product source unchanged by bundling");
  return bundle.outputFiles[0].text;
}

describe("#1237 ledger row in a US-Pacific Chromium (real AccountTab)", { timeout: 90_000 }, () => {
  let browser, server, origin, bundled;
  before(async () => {
    bundled = await bundleHarness();
    server = createServer((req, res) => {
      if (req.url !== "/") { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><div id="root"></div>');
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = "http://127.0.0.1:" + server.address().port;
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  });
  after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });

  test("today's 11:12 CST chat debit shows as Beijing time with model · session, never cost=<n>", async () => {
    const context = await browser.newContext({ timezoneId: "America/Los_Angeles", serviceWorkers: "block" });
    const pageErrors = [];
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === "/") { await route.continue(); return; }
        if (url.origin !== origin) { await route.abort("blockedbyclient"); return; }
        const body = url.pathname === "/api/me/usage" ? USAGE
          : url.pathname === "/api/me/usage/report" ? REPORT : null;
        await route.fulfill(body
          ? { status: 200, contentType: "application/json", body: JSON.stringify(body) }
          : { status: 404, contentType: "application/json", body: '{"error":{"code":"NOT_FOUND"}}' });
      });
      await page.goto(origin);
      await page.addScriptTag({ content: bundled });
      // The browser really is in US Pacific time (the tester's condition).
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "America/Los_Angeles");
      assert.equal(await page.evaluate((iso) => new Date(iso).getDate(), ROW.created_at), 28);

      const row = page.locator("li", { hasText: "GPT-6.1-Sol · office-1029pm" });
      await row.waitFor();
      const text = (await row.textContent()) ?? "";
      assert.match(text, /对话扣费/);
      assert.doesNotMatch(text, /其他|cost=/);
      await page.getByText("对话结束后结算入账，时间为北京时间", { exact: true }).waitFor();
      assert.deepEqual(pageErrors, [], "no Chromium pageerror");
      // Final assertion in both modes: RED (browser-local time) renders 10月28日 20:12 here.
      assert.match(text, /10月29日 11:12/, "ledger time must be Beijing time, not the browser's US-Pacific date");
    } finally {
      await context.close();
    }
  });
});
