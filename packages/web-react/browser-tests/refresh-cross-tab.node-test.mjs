// INC-20261026-REFRESH-GRACE (OCV5-622) proof: two tabs of one browser refresh at the same moment.
// Every POST /api/auth/refresh rotates oc_rt, and a server that sees an already rotated token past its
// grace window revokes the whole family (theft). The fix serializes the network rotate across tabs
// (Web Locks, BroadcastChannel fallback), so the second tab sends the cookie the first one just set.
// Red: OC_REFRESH_CROSS_TAB_RED=1 builds the same app with withCrossTabRefreshLock reduced to run().
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const red = process.env.OC_REFRESH_CROSS_TAB_RED === "1";

async function buildApp(dir) {
  let transforms = 0;
  await build({
    entryPoints: [join(here, "refresh-cross-tab-harness.ts")], bundle: true, format: "esm", outfile: join(dir, "app.js"),
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "remove-cross-tab-refresh-lock", setup(b) {
      b.onLoad({ filter: /\/lib\/refreshCrossTabLock\.ts$/ }, ({ path }) => {
        const needle = "export async function withCrossTabRefreshLock<T>(run: () => Promise<T>): Promise<T> {\n";
        const contents = readFileSync(path, "utf8");
        assert.equal(contents.split(needle).length - 1, 1);
        transforms += 1;
        return { contents: contents.replace(needle, `${needle}  return run();\n`), loader: "ts" };
      });
    }}] : [], logLevel: "warning",
  });
  assert.equal(transforms, red ? 1 : 0);
  writeFileSync(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><script type="module" src="/app.js"></script>');
}

/** Rotating refresh endpoint: a token is good once; presenting a rotated one is theft (past grace). */
function startServer(dir) {
  let generation = 0;
  const seen = [];
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html" || req.url === "/app.js") {
      res.writeHead(200, { "content-type": req.url === "/app.js" ? "text/javascript" : "text/html" });
      res.end(readFileSync(join(dir, req.url === "/app.js" ? "app.js" : "index.html")));
      return;
    }
    if (req.url === "/api/auth/refresh" && req.method === "POST") {
      const presented = /(?:^|;\s*)oc_rt=rt-(\d+)/.exec(req.headers.cookie ?? "")?.[1];
      const current = presented !== undefined && Number(presented) === generation;
      seen.push({ presented: presented === undefined ? null : Number(presented), current });
      // Rotate on arrival (as the server does), answer later: an unserialized second tab sends the
      // old cookie while the first tab's Set-Cookie is still in flight.
      const issued = current ? ++generation : null;
      setTimeout(() => {
        if (issued === null) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "INVALID_REFRESH" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "set-cookie": `oc_rt=rt-${issued}; Path=/; HttpOnly; SameSite=Lax` });
        res.end(JSON.stringify({ access_token: `at-${issued}`, access_exp: Date.now() + 600_000, remember: true }));
      }, 1000);
      return;
    }
    res.writeHead(204); res.end();
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, seen, port: server.address().port })));
}

for (const lock of ["web-locks", "broadcast-channel"]) {
  test(`INC-20261026-REFRESH-GRACE: two tabs refreshing together never present a rotated oc_rt (${lock})`, { timeout: 120000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "oc-refresh-cross-tab-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await buildApp(dir);
    const { server, seen, port } = await startServer(dir);
    t.after(() => server.close());
    const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([{ name: "oc_rt", value: "rt-0", url: `http://127.0.0.1:${port}/`, httpOnly: true }]);
    // Without Web Locks the lock falls back to the BroadcastChannel claim/busy/release handshake.
    if (lock === "broadcast-channel") await context.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
    const tabs = [await context.newPage(), await context.newPage()];
    for (const tab of tabs) {
      await tab.goto(`http://127.0.0.1:${port}/`);
      await tab.waitForFunction(() => typeof window.__refresh === "function");
      assert.equal(await tab.evaluate(() => typeof navigator.locks?.request), lock === "web-locks" ? "function" : "undefined");
    }
    // Both tabs start at one wall-clock instant (same machine, same clock), so the race does not
    // depend on how soon CI schedules the second evaluate (Codex r1 P2).
    const startAt = Date.now() + 500;
    const outcomes = await Promise.all(tabs.map((tab) => tab.evaluate(async (at) => {
      await new Promise((go) => setTimeout(go, Math.max(0, at - Date.now())));
      return window.__refresh();
    }, startAt)));
    assert.deepEqual(seen.filter((s) => !s.current), [], `a tab presented a rotated oc_rt: ${JSON.stringify(seen)}`);
    assert.deepEqual(outcomes, ["success", "success"]);
    assert.deepEqual(seen.map((s) => s.presented), [0, 1]);
  });
}
