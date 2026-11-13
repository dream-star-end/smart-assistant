import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const ts = require("typescript");
const { chromium } = require("playwright-core");

// The mutex starts BEFORE any PG reset/migration and survives browser+HTTP+PG cleanup.
if (process.env.OC_EGRESS_BROWSER_MUTEX_CHILD !== "1") {
  test("Claude egress precheck browser proof under commercial mutex", { timeout: 360000 }, () => {
    const env = { ...process.env };
    // Node nested runners inherit its internal child context, which suppresses discovery.
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync("bash", [join(root, "scripts/test-mutex.sh"), "commercial",
      `env OC_EGRESS_BROWSER_MUTEX_CHILD=1 node --import tsx --test ${JSON.stringify(fileURLToPath(import.meta.url))}`],
      { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(child.stdout ?? "");
    process.stderr.write(child.stderr ?? "");
    assert.ifError(child.error);
    assert.equal(child.status, 0, "real browser/PG proof child must succeed");
    assert.equal((child.stdout.match(/EGRESS_BROWSER_CASE /g) ?? []).length, 3, "all three real case receipts must exist");
    assert.match(child.stdout, /# tests 4\n/, "child TAP has parent plus all three real cases");
    assert.match(child.stdout, /# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n/, "complete child TAP, no silent skip/cancel");
  });
} else {
  test("INC-20260921-CLAUDE-EGRESS-PRECHECK-ACTIVE: real modal POST, PG and audit", { timeout: 300000 }, async (t) => {
    const accountsPath = join(root, "packages/commercial/src/admin/accounts.ts");
    const original = readFileSync(accountsPath, "utf8");
    const sourceHash = createHash("sha256").update(original).digest("hex");
    const red = process.env.OC_EGRESS_PRECHECK_RED === "1";
    const exactSql = "WHERE provider = 'claude' AND status = 'active' AND egress_proxy_id = $1::bigint";
    let reverted = 0;
    mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
    const out = mkdtempSync(join(root, "node_modules/.cache/egress-browser-"));
    let fixture;
    let browser;
    try {
      const backendPath = join(out, "backend.mjs");
      const backendBuild = await build({ entryPoints: [join(here, "claude-egress-precheck-backend.ts")], outfile: backendPath, metafile: true,
        bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
        banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
        plugins: [{ name: "exact-precheck-input-red", setup(plugin) {
          // Bundle the WHOLE real HTTP chain so seed and POST consume one accounts
          // module. Preserve original import.meta URL semantics for source-relative
          // flavor rules/worker assets; identical transform in GREEN and RED.
          plugin.onLoad({ filter: /\.tsx?$/ }, (args) => {
            let input = readFileSync(args.path, "utf8");
            if (red && args.path === accountsPath) {
              assert.equal(input.split(exactSql).length - 1, 1, "single approved precheck constant");
              reverted += 1;
              input = input.replace(exactSql, "WHERE provider = 'claude' AND egress_proxy_id = $1::bigint");
            }
            const source = ts.createSourceFile(args.path, input, ts.ScriptTarget.Latest, true,
              args.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
            const expressions = [];
            const visit = (node) => {
              if (ts.isPropertyAccessExpression(node) && node.name.text === "url" && ts.isMetaProperty(node.expression)
                  && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.expression.name.text === "meta") {
                expressions.push([node.getStart(source), node.getEnd()]);
              }
              ts.forEachChild(node, visit);
            };
            visit(source);
            for (const [start, end] of expressions.sort((a, b) => b[0] - a[0])) {
              input = input.slice(0, start) + JSON.stringify(pathToFileURL(args.path).href) + input.slice(end);
            }
            return { contents: input, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
          });
        } }] });
      assert.equal(reverted, red ? 1 : 0);
      const accountInputs = Object.keys(backendBuild.metafile.inputs).filter((path) => resolve(root, path) === accountsPath);
      assert.equal(accountInputs.length, 1, "exactly one real accounts input in HTTP graph");
      const consumers = Object.entries(backendBuild.metafile.inputs).filter(([, info]) =>
        info.imports.some((item) => item.path === accountInputs[0] && !item.external)).map(([path]) => path);
      assert.ok(consumers.some((path) => path.endsWith("/http/admin/accounts.ts")), "real HTTP handler consumes transformed module");
      assert.ok(consumers.some((path) => path.endsWith("/claude-egress-precheck-backend.ts")), "fixture consumes same module");
      assert.ok(!Object.values(backendBuild.metafile.inputs).some((info) => info.imports.some((item) =>
        item.external && /\/commercial\/src\/admin\/accounts\.(ts|js)$/.test(item.path))), "no second external accounts module");
      console.log("EGRESS_MODULE_GRAPH", JSON.stringify({ red, sourceHash, accounts: accountInputs, consumers }));
      const ui = await build({ entryPoints: [join(here, "claude-egress-precheck-harness.tsx")], bundle: true, write: false,
        format: "iife", jsx: "automatic", loader: { ".css": "empty" },
        alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' }, logLevel: "silent" });
      const cssOut = join(out, "css");
      await viteBuild({ root: join(here, ".."), configFile: false, logLevel: "silent", plugins: [tailwindcss()],
        build: { outDir: cssOut, emptyOutDir: true, cssCodeSplit: false,
          rollupOptions: { input: join(here, "preview-styles.ts"), output: { assetFileNames: "styles[extname]" } } } });
      const css = readFileSync(join(cssOut, readdirSync(cssOut).find((f) => f.endsWith(".css"))), "utf8");
      fixture = await import(pathToFileURL(backendPath).href);
      const base = await fixture.startFixture(root, ui.outputFiles[0].text, css);
      browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
      for (const kind of ["disabled", "active", "non-claude"]) {
        await t.test(kind, async () => {
          const { proxyId, oldId } = await fixture.seed(kind);
          const before = await fixture.snapshot(proxyId);
          assert.equal(before.accounts.length, 1);
          assert.equal(before.accounts[0].provider, kind === "non-claude" ? "codex" : "claude");
          assert.equal(before.accounts[0].status, kind === "disabled" ? "disabled" : "active");
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          try {
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", (e) => errors.push(e.message));
            await page.goto(base + "/fixture");
            const modal = page.getByRole("dialog");
            await modal.getByLabel("label(账号标签,必填)", { exact: true }).fill(`new-${kind}`);
            await modal.getByPlaceholder("粘贴 OAuth access token").fill("synthetic-ui-never-outbound");
            await modal.getByLabel(/egress 代理池条目/).selectOption(proxyId);
            const responsePromise = page.waitForResponse((r) => r.url() === base + "/api/admin/accounts" && r.request().method() === "POST");
            await modal.getByRole("button", { name: "创建", exact: true }).click();
            const response = await responsePromise;
            const body = await response.json();
            // RED must fail directly on the real 400 response, never on modal-close timeout.
            assert.equal(response.status(), kind === "active" ? 400 : 201, `real POST ${kind}`);
            const after = await fixture.snapshot(proxyId);
            if (kind === "active") {
              await page.getByText("创建失败: 该出口已绑定其他启用中的 Claude 账号（已停用的号不占坑）", { exact: true }).waitFor();
              assert.deepEqual(after.accounts, before.accounts, "400 inserts/changes no account");
              assert.deepEqual(after.audit, before.audit, "400 adds no create audit");
              assert.equal(after.profileCalls, before.profileCalls, "occupied precheck happens before profile fetch");
              assert.equal(await page.getByTestId("account-saved").innerText(), "0");
            } else {
              await modal.waitFor({ state: "hidden" });
              assert.equal(await page.getByTestId("account-saved").innerText(), "1");
              assert.equal(after.accounts.length, before.accounts.length + 1);
              assert.deepEqual(after.accounts.find((row) => String(row.id) === oldId), before.accounts[0], "old complete row remains identical");
              const inserted = after.accounts.find((row) => String(row.id) !== oldId);
              assert.equal(inserted.provider, "claude"); assert.equal(inserted.status, "active");
              assert.equal(inserted.label, `new-${kind}`); assert.equal(String(inserted.egress_proxy_id), proxyId);
              assert.equal(after.audit.length, before.audit.length + 1);
              assert.deepEqual(after.audit.slice(0, -1), before.audit);
              assert.equal(after.audit.at(-1).target, `account:${inserted.id}`);
              assert.equal(after.profileCalls, before.profileCalls + 1);
              assert.ok(!JSON.stringify(after.audit.at(-1)).includes("synthetic-ui-never-outbound"));
              assert.equal(String(body.account.id), String(inserted.id), "real HTTP response identifies the PG inserted account");
            }
            assert.deepEqual(errors, []);
            if (process.env.OC_EGRESS_BROWSER_SHOT_DIR) {
              mkdirSync(process.env.OC_EGRESS_BROWSER_SHOT_DIR, { recursive: true });
              await page.screenshot({ path: join(process.env.OC_EGRESS_BROWSER_SHOT_DIR, `${kind}.png`) });
            }
            console.log("EGRESS_BROWSER_CASE", JSON.stringify({ kind, status: response.status(), sourceHash, red, accountDelta: after.accounts.length - before.accounts.length, auditDelta: after.audit.length - before.audit.length }));
          } finally { await context.close(); }
        });
      }
    } finally {
      try { if (browser) await browser.close(); } finally {
        try { if (fixture) await fixture.stopFixture(); } finally {
          assert.equal(createHash("sha256").update(readFileSync(accountsPath)).digest("hex"), sourceHash, "product source unchanged by input negative control");
          rmSync(out, { recursive: true, force: true });
        }
      }
    }
  });
}
