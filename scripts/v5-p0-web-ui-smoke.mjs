#!/usr/bin/env node
// OCV5-489 P0-Web UI gate (selfhost): the frontend half of the user contract — C1 cold UI login
// and C2 collapsed model reaches the outbound request (always intercepted, cost=dry). Same
// browser steps as scripts/v5-user-contract-smoke.mjs; C3 (real turns per engine) is not here
// because a P0-Web flip ships no backend bytes. The normal cutover still runs the full C1–C3.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { launchJourneyBrowser } from "./lib/journey-browser.mjs";
import { CASES, TOTAL_TIMEOUT, parseOptions, tapResult } from "./lib/user-contract.mjs";
import { coldUiLogin, installTurnProbe, selectJourneyModel, sendContractTurn, contractEvidenceBase } from "./lib/user-contract-browser.mjs";

const UI_CASES = CASES.slice(0, 2);
let browser;
let page;
let current = 0;
let stepStart = performance.now();
const timings = [];
console.log(`TAP version 13\n1..${UI_CASES.length}`);
let finishing = false;
async function fail(error) {
  if (finishing) return;
  finishing = true;
  const n = current + 1;
  console.log(tapResult(false, n, UI_CASES[current], performance.now() - stepStart, error));
  for (let i = n + 1; i <= UI_CASES.length; i++) console.log(tapResult(false, i, UI_CASES[i - 1], 0, "Prerequisite failed; not executed"));
  try {
    const shot = `${contractEvidenceBase()}-p0web-fail-${n}.png`;
    await page?.screenshot({ path: shot, fullPage: true, timeout: 1_000 });
    console.log(`# evidence screenshot=${shot}`);
  } catch { /* original failure remains fatal */ }
  await browser?.close().catch(() => {});
  process.exitCode = 1;
}
const hard = setTimeout(() => process.exit(1), TOTAL_TIMEOUT);
const timer = setTimeout(() => { void fail("Four-minute total deadline exhausted"); }, TOTAL_TIMEOUT - 2_000);
async function step(fn) {
  stepStart = performance.now();
  await fn();
  if (finishing) throw new Error("Gate already failed");
  const ms = performance.now() - stepStart;
  timings.push(ms);
  console.log(tapResult(true, current + 1, UI_CASES[current], ms));
  current++;
}
try {
  const options = { ...parseOptions(process.env), cost: "dry" };
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
    await selectJourneyModel(page, options.model, { requireCollapsed: false });
    await sendContractTurn(page, probe, { model: options.model, catalog: [], cost: "dry", requireHttpModel: true });
  });
  console.log(`# timings_ms ${JSON.stringify(timings.map(Math.round))}`);
} catch (error) {
  // Do not print credentials, response bodies or request headers.
  await fail(error?.message ?? "P0-Web UI gate failure");
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(timer); clearTimeout(hard);
}
