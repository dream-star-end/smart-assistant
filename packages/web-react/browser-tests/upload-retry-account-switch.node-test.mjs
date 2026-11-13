import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
import { buildHarnessPage, exactSwap, serveHarnessPage } from "./harness-page.mjs";

// INC-20261009-UPLOAD-RETRY-ACCOUNT-SWITCH in a real browser: account A attaches a file in the real
// Composer while the container is cold (503 + Retry-After). During the backoff the user logs out
// and account B logs in. The retry must never send A's file with B's token into B's volume.
// OC_UPLOAD_RETRY_RED=1 bundles api.ts without the epoch pin of 10f10992b (negative control).
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const red = process.env.OC_UPLOAD_RETRY_RED === "1";
const PIN = "      if (a.snapshot().epoch !== startEpoch) throw new AuthEpochStaleError();\n";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("INC-20261009-UPLOAD-RETRY-ACCOUNT-SWITCH: a cold-start retry after an account switch never sends the file under the new account", { timeout: 240000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-upload-retry-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  const swapped = { count: 0 };
  await buildHarnessPage({ harness: "upload-retry-account-switch-harness.tsx", assetDir,
    plugins: red ? [exactSwap("drop-upload-epoch-pin", /[\\/]src[\\/]lib[\\/]api\.ts$/, PIN, "", swapped)] : [] });
  assert.equal(swapped.count, red ? 1 : 0);
  const server = await serveHarnessPage(assetDir);
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const probe = () => page.evaluate(() => structuredClone(window.__uploadProbe));
  await page.goto(server.url);
  await page.getByRole("button", { name: "login A", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=account]")?.textContent === "user-a");
  await page.locator('input[type="file"][aria-label="选择附件文件"]').setInputFiles({ name: "a-only.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => window.__uploadProbe.uploads.length === 1, null, { timeout: 15000 });
  const first = await probe();
  assert.deepEqual(first.uploads, [{ authorization: "Bearer synthetic-access-user-a", filename: "a-only.png", status: 503 }],
    "the first attempt is account A's and meets the cold container");
  // Inside the 1 s backoff: A logs out, B logs in.
  await page.getByRole("button", { name: "logout", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=account]")?.textContent === "");
  await page.getByRole("button", { name: "login B", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=account]")?.textContent === "user-b");
  await page.waitForFunction(() => window.__uploadProbe.outcomes.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const end = await probe();
  console.log("UPLOAD_RETRY_RECEIPT", JSON.stringify({ red, swapped: swapped.count, uploads: end.uploads, outcomes: end.outcomes }));
  assert.deepEqual(end.uploads.filter((u) => u.authorization !== "Bearer synthetic-access-user-a"), [],
    "no upload of A's file ever carries another account's token");
  assert.equal(end.uploads.length, 1, "the retry is not sent after the account changed");
  assert.deepEqual(end.outcomes, ["AuthEpochStaleError"], "the upload ends as a stale-identity error, not a success");
});
