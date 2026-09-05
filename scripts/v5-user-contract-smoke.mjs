#!/usr/bin/env node
// Selfhost-only direct-origin gate. No SSH, API login, hint/token seeding or retries.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { launchJourneyBrowser } from "./lib/journey-browser.mjs";
import { CASES, TOTAL_TIMEOUT, parseOptions, engineMatrix, tapResult } from "./lib/user-contract.mjs";
import { coldUiLogin, newSession, installTurnProbe, selectJourneyModel, sendContractTurn } from "./lib/user-contract-browser.mjs";
let browser, page, current = 0, stepStart = performance.now();
const timings = [];
console.log("TAP version 13\n1..3");
let finishing = false;
async function fail(error) {
  if (finishing) return;
  finishing = true;
  const n = current + 1;
  console.log(tapResult(false, n, CASES[current], performance.now() - stepStart, error));
  for (let i = n + 1; i <= 3; i++) console.log(tapResult(false, i, CASES[i - 1], 0, "Prerequisite failed; not executed"));
  try { await page?.screenshot({ path: `/tmp/v5-contract-fail-${n}.png`, fullPage: true, timeout: 1_000 }); } catch { /* original failure remains fatal */ }
  await browser?.close().catch(() => {});
  process.exitCode = 1;
}
// The inner budget leaves 2s for screenshot and browser teardown. Hard cap is 4m.
const hard = setTimeout(() => process.exit(1), TOTAL_TIMEOUT);
const timer = setTimeout(() => { void fail("Four-minute total deadline exhausted"); }, TOTAL_TIMEOUT - 2_000);
async function step(fn) {
  stepStart = performance.now();
  await fn();
  if (finishing) throw new Error("Gate already failed");
  const ms = performance.now() - stepStart;
  timings.push(ms);
  console.log(tapResult(true, current + 1, CASES[current], ms));
  current++;
}
try {
  const options = parseOptions(process.env);
  const password = readFileSync(options.passwordFile, "utf8").trim();
  if (!password) throw new Error("Canary password file is empty");
  browser = await launchJourneyBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await context.clearCookies();
  const probe = await installTurnProbe(context, options.base, options.cost);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  await step(() => coldUiLogin(page, options, password));
  await step(async () => {
    await selectJourneyModel(page, options.model, { requireCollapsed: true });
    await sendContractTurn(page, probe, { model: options.model, catalog: [], cost: "dry", requireHttpModel: true });
    // C2 is always intercepted: no background paid turn competes with C3.
  });
  await step(async () => {
    const catalog = (await Promise.all(probe.catalogs)).flat();
    // Responses can include anonymous then authenticated catalogs. The last
    // occurrence is the UI's newest view, not an invented model→engine table.
    const latest = [...new Map(catalog.map((m) => [m.id, m])).values()];
    const matrix = engineMatrix(options.models, latest);
    for (const { id, engine } of matrix) {
      await newSession(page);
      await selectJourneyModel(page, id);
      console.log(`# route model=${id} engine=${engine} cost=${options.cost}`);
      await sendContractTurn(page, probe, { model: id, engine, catalog: latest, cost: options.cost });
    }
  });
  console.log(`# timings_ms ${JSON.stringify(timings.map(Math.round))}`);
} catch (error) {
  // Do not print credentials, response bodies or request headers.
  await fail(error?.message ?? "Contract failure");
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(timer); clearTimeout(hard);
}
