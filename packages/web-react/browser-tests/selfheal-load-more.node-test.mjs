import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { buildHarnessPage, exactSwap, serveHarnessPage } from "./harness-page.mjs";

// INC-20261009-SELFHEAL-LOAD-MORE-400 in a real browser: the real selfheal page grows its incident
// limit by 50 per 「加载更多」. The backend caps the limit at 200 and answers 400 above it, which
// broke the whole list on the third click. The page must stop at the cap and keep its list.
// OC_SELFHEAL_LIMIT_RED=1 bundles the page with the pre-fix cap of 300 (1f55ee33f).
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const red = process.env.OC_SELFHEAL_LIMIT_RED === "1";

test("INC-20261009-SELFHEAL-LOAD-MORE-400: load more stops at the backend cap and the list stays up", { timeout: 240000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-selfheal-more-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  const swapped = { count: 0 };
  await buildHarnessPage({ harness: "selfheal-load-more-harness.tsx", assetDir,
    plugins: red ? [exactSwap("selfheal-cap-300", /[\\/]admin[\\/]pages[\\/]selfheal[\\/]index\.tsx$/,
      "const MAX_LIMIT = 200;", "const MAX_LIMIT = 300;", swapped)] : [] });
  assert.equal(swapped.count, red ? 1 : 0);
  const server = await serveHarnessPage(assetDir);
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(server.url);
  await page.getByText("服务不可用", { exact: true }).first().waitFor({ timeout: 20000 });
  for (let i = 0; i < 6; i += 1) {
    const more = page.getByRole("button", { name: "加载更多", exact: true });
    if (!(await more.isVisible())) break;
    const before = await page.evaluate(() => window.__selfhealProbe.limits.length);
    await more.click();
    await page.waitForFunction((n) => window.__selfhealProbe.limits.length > n, before, { timeout: 10000 });
    await page.waitForTimeout(500);
  }
  const probe = await page.evaluate(() => structuredClone(window.__selfhealProbe));
  const body = await page.locator("body").innerText();
  console.log("SELFHEAL_LOAD_MORE_RECEIPT", JSON.stringify({ red, swapped: swapped.count, limits: probe.limits, rejected: probe.rejected }));
  assert.equal(probe.rejected, 0, "the page never asks for more than the backend allows");
  assert.equal(Math.max(...probe.limits), 200, "the list grows up to the cap");
  assert.equal(await page.getByRole("button", { name: "加载更多", exact: true }).count(), 0, "no 「加载更多」 at the cap");
  assert.ok(body.includes("服务不可用"), "the incident list is still shown");
  assert.doesNotMatch(body, /limit must be/, "no backend error surfaced");
});
