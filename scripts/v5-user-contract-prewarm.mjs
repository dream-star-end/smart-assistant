#!/usr/bin/env node
// OCV5-429: warm the canary container before the C1–C3 clock starts.
// A cutover that changes the runtime tuple makes ensureRunning recycle the canary's container on its
// next connect, and an idle-swept canary cold-starts the same way (~30s+). C2 then gave up after 20s
// on infrastructure, not on the contract (#745 / #746 on 2026-10-15). This runs the same cold UI login
// in its own browser context, sends no message and waits for the bridge's sys.relay_ready. The gate
// that follows uses a fresh context and keeps every assertion and timeout; a prewarm that never gets
// ready only warns, so the gate still decides.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { launchJourneyBrowser } from "./lib/journey-browser.mjs";
import { parseOptions } from "./lib/user-contract.mjs";
import { coldUiLogin, installTurnProbe, waitRelayReady } from "./lib/user-contract-browser.mjs";

export const PREWARM_TIMEOUT = 180_000;
const hard = setTimeout(() => process.exit(1), PREWARM_TIMEOUT + 60_000);
const started = performance.now();
let browser;
try {
  const options = parseOptions(process.env);
  const password = readFileSync(options.passwordFile, "utf8").trim();
  if (!password) throw new Error("Canary password file is empty");
  browser = await launchJourneyBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await context.clearCookies();
  const probe = await installTurnProbe(context, options.base, "dry");
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  await coldUiLogin(page, options, password);
  await waitRelayReady(probe, PREWARM_TIMEOUT);
  console.log(`# canary prewarm relay_ready_ms=${Math.round(performance.now() - started)} relay_connects=${probe.connects}`);
} catch (error) {
  // Do not print credentials, response bodies or request headers.
  console.log(`# warn canary prewarm not ready after ${Math.round(performance.now() - started)}ms: ${error?.message ?? "prewarm failure"}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(hard);
}
