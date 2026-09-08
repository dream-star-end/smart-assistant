import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const componentPath = fileURLToPath(new URL("../src/components/settings/ApiKeysSection.tsx", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// Synthetic keys only: no real account, backend, or native ccswitch:// handler is contacted.
const CREATED_KEY = "oc-cc.newkey01.0123456789abcdef0123456789abcdef0123456789abcdef";
const EXISTING_KEY = "oc-cc.oldkey02.fedcba9876543210fedcba9876543210fedcba9876543210";
const LABEL = "OCV5-180 Chromium fixture";
const TOKEN = "ocv5-180-browser-fixture-token";
const MODELS = [
  { id: "gpt-5.6-sol", engine: "codex", display_name: "Non-Cursor distractor" },
  { id: "cursor-opus-5-high", engine: "cursor", display_name: "Opus fixture" },
  { id: "cursor-sonnet-5-high", engine: "cursor", display_name: "Sonnet fixture" },
  { id: "cursor-gemini-3.8-flash-low", engine: "cursor", display_name: "Haiku fixture" },
];
const EXISTING_SUMMARY = {
  id: "existing-key-fixture", label: "Existing fixture", key_prefix: "oldkey02",
  created_at: "2026-09-08T00:00:00.000Z", last_used_at: null,
  disabled_at: null, credit_limit: null, spent_credits: "0",
};

async function bundleHarness() {
  const source = await readFile(componentPath, "utf8");
  const negative = process.env.OC_CC_SWITCH_ASCII_NAME_RED === "1";
  const fixed = "name: BRAND.nameEn,";
  const historical = "name: BRAND.name,";
  let replacements = 0;
  let bundledSource = source;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./cc-switch-ascii-name-harness.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", jsx: "automatic",
    loader: { ".css": "empty" },
    alias: {
      "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)),
      "@openclaude/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)),
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    plugins: negative ? [{
      name: "cc-switch-exact-pre-f496-name-expression",
      setup(esbuildApi) {
        esbuildApi.onLoad({ filter: /[\\/]ApiKeysSection\.tsx$/ }, async ({ path }) => {
          assert.equal(path, componentPath, "negative control must target the real component only");
          const current = await readFile(path, "utf8");
          assert.equal(current, source, "source must not drift during bundling");
          assert.equal(current.split(fixed).length - 1, 1, "negative control requires exactly one expression");
          replacements += 1;
          bundledSource = current.replace(fixed, historical);
          return { contents: bundledSource, loader: "tsx", resolveDir: dirname(path) };
        });
      },
    }] : [],
    logLevel: "error",
  });
  assert.equal(replacements, negative ? 1 : 0, "exactly one controlled replacement, never a product edit");
  assert.equal(await readFile(componentPath, "utf8"), source, "bundle injection leaves product bytes intact");
  console.log("cc-switch-source-evidence " + JSON.stringify({
    mode: negative ? "exact-pre-f496-name-expression-negative" : "current-worktree",
    historicalFix: "f496228de43718852cebda8fb9f35eb0e9c3a9c0",
    replacements, sourceSha256: sha256(source), bundledSourceSha256: sha256(bundledSource),
    testSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    harnessSha256: sha256(await readFile(new URL("./cc-switch-ascii-name-harness.tsx", import.meta.url))),
    apiSha256: sha256(await readFile(new URL("../src/lib/api.ts", import.meta.url))),
    brandSha256: sha256(await readFile(new URL("../src/lib/brand.ts", import.meta.url))),
  }));
  return { text: bundle.outputFiles[0].text, source };
}

async function assertNotImportable(page) {
  const action = page.getByTestId("ccswitch-deeplink");
  await action.waitFor();
  assert.equal(await action.evaluate((el) => el.tagName), "BUTTON");
  assert.equal(await action.isDisabled(), true, "missing/incomplete key disables real DOM action");
  assert.equal(await action.getAttribute("href"), null, "missing/incomplete key has no href");
  assert.equal(await page.locator('a[href^="ccswitch:"]').count(), 0);
}

describe("CC Switch ASCII provider name from real ApiKeysSection (Chromium, fixture API)", { timeout: 90_000 }, () => {
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
    const executablePath = resolveBrowserExecutable();
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    console.log("cc-switch-browser " + JSON.stringify({ executablePath, version: browser.version(), origin }));
  });
  after(async () => {
    try { await browser?.close(); }
    finally {
      try {
        if (server?.listening) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      } finally {
        if (bundled) assert.equal(await readFile(componentPath, "utf8"), bundled.source, "product source unchanged after both journeys");
      }
    }
  });

  async function journey(t, source) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: "block" });
    const calls = [], unexpected = [], pageErrors = [];
    let decoded;
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => pageErrors.push(error.message));
      // All fixture network goes through the actual api.ts -> browser fetch -> page.route path.
      await page.route("**/*", async (route) => {
        const req = route.request(), url = new URL(req.url()), method = req.method();
        if (url.origin === origin && url.pathname === "/" && method === "GET") {
          await route.continue(); return;
        }
        const path = url.pathname;
        const call = { path, method, authorization: req.headers().authorization, body: req.postDataJSON() };
        calls.push(call);
        let body, status = 200;
        if (url.origin === origin && path === "/api/public/models" && method === "GET") {
          body = { models: MODELS };
        } else if (url.origin === origin && path === "/api/me/api-keys" && method === "GET") {
          body = { keys: source === "existing" ? [EXISTING_SUMMARY] : [] };
        } else if (url.origin === origin && path === "/api/me/api-keys" && method === "POST" && source === "new") {
          status = 201;
          body = {
            id: "created-key-fixture", label: LABEL, key_prefix: "newkey01",
            plaintext: CREATED_KEY, created_at: "2026-09-08T00:00:00.000Z",
          };
        } else {
          unexpected.push(method + " " + req.url());
          await route.abort("blockedbyclient"); return;
        }
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.goto(origin);
      await page.addScriptTag({ content: bundled.text });
      if (source === "new") await page.getByText("还没有 API Key", { exact: true }).waitFor();
      else await page.getByTestId("api-keys-list").waitFor();
      // A nondefault model proves the real fetch response, filtering and public-id conversion settled.
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="env-snippet"]')?.textContent?.includes("ANTHROPIC_MODEL=opus-5-high"));
      await assertNotImportable(page);

      if (source === "new") {
        await page.getByRole("tab", { name: "创建新密钥", exact: true }).click();
        await page.getByRole("textbox", { name: "新密钥名称", exact: true }).fill(LABEL);
        await assertNotImportable(page); // A label alone must not manufacture a key.
        await page.getByRole("button", { name: "创建", exact: true }).click();
        await page.getByText("已包含刚创建的密钥,可直接导入。", { exact: true }).waitFor();
      } else {
        await page.getByRole("tab", { name: "使用已有密钥", exact: true }).click();
        const input = page.getByLabel("完整 API Key", { exact: true });
        await input.waitFor();
        assert.equal(await input.inputValue(), "");
        await assertNotImportable(page);
        await input.fill("oc-cc.oldkey02.••••••••");
        await assertNotImportable(page); // Listed prefix / mask is not a usable credential.
        await input.fill("  " + EXISTING_KEY + "  ");
        await page.getByText("已填入完整密钥。有效性以实际请求为准。", { exact: true }).waitFor();
      }

      const action = page.getByTestId("ccswitch-deeplink");
      assert.equal(await action.evaluate((el) => el.tagName), "A");
      assert.equal(await action.isEnabled(), true);
      // Intentionally read the real href; never click/invoke the native protocol.
      const href = await action.getAttribute("href");
      assert.ok(href);
      const link = new URL(href);
      assert.equal(link.protocol, "ccswitch:");
      assert.equal(link.hostname, "v1");
      assert.equal(link.pathname, "/import");
      const p = link.searchParams;
      assert.equal(p.get("resource"), "provider");
      assert.equal(p.get("app"), "claude");
      assert.equal(p.get("endpoint"), new URL(page.url()).origin + "/api/anthropic");
      assert.equal(p.get("apiKey"), source === "new" ? CREATED_KEY : EXISTING_KEY);
      for (const [field, model] of Object.entries({
        model: "opus-5-high", opusModel: "opus-5-high",
        sonnetModel: "sonnet-5-high", haikuModel: "gemini-3.8-flash-low",
      })) {
        assert.equal(p.get(field), model, field + " remains the public model id");
        assert.doesNotMatch(p.get(field), /^cursor-/);
      }
      assert.equal(p.get("enabled"), "true");
      assert.equal(p.get("usageEnabled"), "true");
      assert.equal(p.get("usageAutoInterval"), "30");
      const usage = Buffer.from(p.get("usageScript") ?? "", "base64").toString("utf8");
      assert.match(usage, /url: "\{\{baseUrl\}\}\/v1\/usage"/);
      assert.match(usage, /"Authorization": "Bearer \{\{apiKey\}\}"/);
      assert.match(usage, /extractor: function \(response\)/);
      assert.equal(page.url(), origin + "/", "no native protocol or external navigation");

      assert.deepEqual(calls.map(({ method, path }) => method + " " + path).sort(), [
        "GET /api/me/api-keys", "GET /api/public/models",
        ...(source === "new" ? ["POST /api/me/api-keys"] : []),
      ].sort(), "real fetches match this independent journey only");
      for (const call of calls) assert.equal(call.authorization, "Bearer " + TOKEN);
      if (source === "new") assert.deepEqual(calls.find((c) => c.method === "POST").body, { label: LABEL });
      assert.deepEqual(unexpected, [], "no unfaked backend or external request");
      assert.deepEqual(pageErrors, [], "no Chromium pageerror");
      decoded = { name: p.get("name"), ascii: /^[\x20-\x7e]+$/.test(p.get("name") ?? "") };
      t.diagnostic("cc-switch-journey " + JSON.stringify({
        source, decoded, nonNameContract: "PASS", pageErrors: pageErrors.length,
        unexpectedRequests: unexpected.length, requests: calls.map(({ method, path }) => method + " " + path),
      }));
    } finally {
      await context.close();
    }
    // Same final assertion in both modes, after all other contracts and cleanup.
    // The old exact expression must fail here, never at bundling/import/network setup.
    assert.deepEqual(decoded, { name: "Clarvy", ascii: true }, "decoded provider name must be exactly Clarvy and printable ASCII");
  }

  test("new key: real create click exports exact Clarvy ASCII name and intact import contract", async (t) => {
    await journey(t, "new");
  });
  test("existing key: real paste exports exact Clarvy ASCII name and intact import contract", async (t) => {
    await journey(t, "existing");
  });
});
