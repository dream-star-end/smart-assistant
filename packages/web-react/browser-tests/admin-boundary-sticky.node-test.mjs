import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { buildHarnessPage, exactSwap, serveHarnessPage } from "./harness-page.mjs";

// INC-20261009-ADMIN-BOUNDARY-STICKY in a real browser: the real AdminShell, registry and hash
// router. One page (users) throws during render. The shell must confine that to its tab: after
// leaving that tab (Back, deep link) the full-screen 「此页面加载出错」 is gone and the other pages render.
// OC_ADMIN_BOUNDARY_RED=1 bundles AdminShell without the key={tab} on the boundary (596687a5a).
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const red = process.env.OC_ADMIN_BOUNDARY_RED === "1";
const ERROR = "此页面加载出错";

function brokenUsersPage(counter) {
  return { name: "users-page-throws", setup(b) {
    b.onLoad({ filter: /[\\/]admin[\\/]pages[\\/]users[\\/]index\.tsx$/ }, () => {
      counter.count += 1;
      return { contents: 'export default function BrokenUsersPage() { throw new Error("users page render failed (fixture)"); }\n', loader: "tsx" };
    });
  } };
}

test("INC-20261009-ADMIN-BOUNDARY-STICKY: one crashed admin page does not lock the other tabs", { timeout: 240000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-admin-boundary-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  const broken = { count: 0 };
  const swapped = { count: 0 };
  await buildHarnessPage({ harness: "admin-boundary-harness.tsx", assetDir, plugins: [brokenUsersPage(broken),
    ...(red ? [exactSwap("boundary-without-tab-key", /[\\/]admin[\\/]AdminShell\.tsx$/,
      "<LazyBoundary key={tab} fallback={<PageSkeleton />}>", "<LazyBoundary fallback={<PageSkeleton />}>", swapped)] : [])] });
  assert.equal(broken.count, 1, "the users page module is the throwing fixture");
  assert.equal(swapped.count, red ? 1 : 0);
  const server = await serveHarnessPage(assetDir);
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const main = page.locator("main");
  // The crash overlay covers the sidebar and offers only 「刷新」: without reloading, the user leaves
  // the crashed tab with the browser Back button or through an admin deep link (hash navigation).
  await page.goto(`${server.url}#tab=dashboard`);
  await page.waitForTimeout(1500);
  assert.equal(await main.getByText(ERROR, { exact: true }).count(), 0, "the dashboard renders before the crash");
  await page.getByRole("button", { name: "用户", exact: true }).first().click();
  await main.getByText(ERROR, { exact: true }).waitFor({ timeout: 20000 });
  const visits = [];
  const visit = async (how, go) => {
    await go();
    await page.waitForTimeout(1500);
    visits.push({ how, hash: await page.evaluate(() => location.hash), errors: await main.getByText(ERROR, { exact: true }).count() });
  };
  await visit("back", () => page.goBack());
  await visit("deep link alerts", () => page.evaluate(() => { location.hash = "#tab=alerts"; }));
  await visit("deep link selfheal", () => page.evaluate(() => { location.hash = "#tab=selfheal"; }));
  // The crash stays confined to its own tab: going back there shows it again.
  await page.evaluate(() => { location.hash = "#tab=users"; });
  await main.getByText(ERROR, { exact: true }).waitFor({ timeout: 10000 });
  console.log("ADMIN_BOUNDARY_RECEIPT", JSON.stringify({ red, swapped: swapped.count, visits }));
  for (const v of visits) assert.equal(v.errors, 0, `${v.how} (${v.hash}) is not locked by the users page crash`);
  assert.deepEqual(visits.map((v) => v.hash), ["#tab=dashboard", "#tab=alerts", "#tab=selfheal"]);
});
