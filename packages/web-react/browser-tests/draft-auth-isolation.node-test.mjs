import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

const CANDIDATE_SHA = "39d0ff109530c3aefc5da69a61b2b5bd36dff9df";
const NEGATIVE_SHA = "87d4554efd27289844cfb3ce0146fb713ce24954";

function baselinePlugin(baselineRoot) {
  return {
    name: "pinned-draft-auth-negative-control",
    setup(esbuildApi) {
      esbuildApi.onLoad(
        { filter: /[\\/]src[\\/](lib[\\/]composerDraft|hooks[\\/]useAuth)\.ts$/ },
        (args) => {
          const pinned = args.path.endsWith("composerDraft.ts")
            ? join(baselineRoot, "lib", "composerDraft.ts")
            : join(baselineRoot, "hooks", "useAuth.ts");
          return {
            contents: readFileSync(pinned, "utf8"),
            loader: "ts",
            resolveDir: dirname(args.path),
          };
        },
      );
    },
  };
}

async function bundleHarness() {
  const plugins = process.env.OC_DRAFT_AUTH_BASELINE
    ? [baselinePlugin(process.env.OC_DRAFT_AUTH_BASELINE)]
    : [];
  return build({
    entryPoints: [fileURLToPath(new URL("./draft-auth-isolation-harness.tsx", import.meta.url))],
    plugins,
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: {
      "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)),
      "@openclaude/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)),
    },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' },
  });
}

async function fillComposer(page, text) {
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.waitFor();
  await input.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  return input;
}

test("Composer drafts isolate across real useAuth login/logout (Chromium, stubbed auth network)", { timeout: 180_000 }, async (t) => {
  const bundle = await bundleHarness();
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });

    async function openPage() {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return { context, page, errors };
    }

    async function probe(page) {
      return page.evaluate(() => window.__draftAuthProbe);
    }

    await t.test("persistent new draft: logout then B first-read is empty", async () => {
      const { context, page, errors } = await openPage();
      try {
        const marker = `OCV5-188-F5-A-PERSIST-${Date.now()}`;
        await page.getByRole("button", { name: "login A", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-a" }).waitFor();
        const input = await fillComposer(page, marker);
        assert.equal(await input.inputValue(), marker);
        const before = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          return {
            aKey,
            aRead: p.readDraft(aKey),
            aStored: p.sessionItem(aKey),
            keys: p.allDraftStorageKeys(),
            draftKey: document.querySelector('[data-testid="draft-key"]')?.textContent ?? "",
            fetches: window.__authFetches.slice(),
          };
        });
        assert.equal(before.aRead, marker, "A readDraft must prove the unique body exists before logout");
        assert.equal(before.aStored, marker);
        assert.equal(before.draftKey, before.aKey);
        assert.ok(before.fetches.some((f) => f.url.includes("/api/auth/login") && f.email === "a@example.test"));

        await page.getByRole("button", { name: "logout", exact: true }).click();
        await page.getByTestId("authed").filter({ hasText: "0" }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "消息输入框" }).count(), 0, "Composer must unmount before B login");

        const afterLogout = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          const bKey = p.accountDraftKey(p.newKey, "user-b");
          return {
            bFirstRead: p.readDraft(bKey),
            aRead: p.readDraft(aKey),
            bareNew: p.readDraft(p.newKey),
            aStored: p.sessionItem(aKey),
            bareStored: p.sessionItem(p.newKey),
            keys: p.allDraftStorageKeys(),
            fetches: window.__authFetches.slice(),
          };
        });
        assert.equal(afterLogout.bFirstRead, "", "B new must be empty on first read, before any B write/clear/fill");
        assert.equal(afterLogout.aRead, "");
        assert.equal(afterLogout.bareNew, "");
        assert.equal(afterLogout.aStored, null);
        assert.equal(afterLogout.bareStored, null);
        assert.ok(afterLogout.fetches.some((f) => f.url.includes("/api/auth/logout")));

        await page.getByRole("button", { name: "login B", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-b" }).waitFor();
        const bInput = page.getByRole("textbox", { name: "消息输入框" });
        await bInput.waitFor();
        const bValue = await bInput.inputValue();
        assert.equal(bValue, "");
        assert.equal(bValue.includes(marker), false);
        const bKey = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          return p.accountDraftKey(p.newKey, "user-b");
        });
        assert.equal(await page.getByTestId("draft-key").textContent(), bKey);
        assert.deepEqual(errors, []);
        t.diagnostic(`persist bytes=${Buffer.byteLength(marker, "utf8")} pageErrors=0 aKey=${before.aKey} sourceSha=${process.env.OC_DRAFT_AUTH_BASELINE ? NEGATIVE_SHA : CANDIDATE_SHA}`);
      } finally {
        await context.close();
      }
    });

    await t.test("volatile >20KiB draft: logout clears A read, then B is empty", async () => {
      const { context, page, errors } = await openPage();
      try {
        const unique = `OCV5-188-F5-A-VOL-${Date.now()}-`;
        const text = unique + "x".repeat(20 * 1024 + 32);
        assert.ok(new Blob([text]).size > 20 * 1024);
        await page.getByRole("button", { name: "login A", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-a" }).waitFor();
        const input = await fillComposer(page, text);
        assert.equal(await input.inputValue(), text);
        const before = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          return {
            aRead: p.readDraft(aKey),
            aStored: p.sessionItem(aKey),
            input: document.querySelector('[aria-label="消息输入框"]')?.value ?? "",
          };
        });
        assert.equal(before.aRead, text, "volatile A readDraft must return the full body");
        assert.equal(before.input, text);
        assert.equal(before.aStored, null, "sessionStorage A key empty is the positive proof of the volatile path");

        await page.getByRole("button", { name: "logout", exact: true }).click();
        await page.getByTestId("authed").filter({ hasText: "0" }).waitFor();
        const afterLogout = await page.evaluate(() => {
          const p = window.__draftAuthProbe;
          const aKey = p.accountDraftKey(p.newKey, "user-a");
          const bKey = p.accountDraftKey(p.newKey, "user-b");
          return {
            aRead: p.readDraft(aKey),
            bFirstRead: p.readDraft(bKey),
            aStored: p.sessionItem(aKey),
          };
        });
        assert.equal(afterLogout.aRead, "", "A read empty after logout proves volatile teardown, B empty alone is not enough");
        assert.equal(afterLogout.bFirstRead, "");
        assert.equal(afterLogout.aStored, null);

        await page.getByRole("button", { name: "login B", exact: true }).click();
        await page.getByTestId("account").filter({ hasText: "user-b" }).waitFor();
        const bInput = page.getByRole("textbox", { name: "消息输入框" });
        await bInput.waitFor();
        const bValue = await bInput.inputValue();
        assert.equal(bValue, "");
        assert.equal(bValue.includes(unique), false);
        assert.deepEqual(errors, []);
        t.diagnostic(`volatile bytes=${new Blob([text]).size} pageErrors=0 sourceSha=${process.env.OC_DRAFT_AUTH_BASELINE ? NEGATIVE_SHA : CANDIDATE_SHA}`);
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
