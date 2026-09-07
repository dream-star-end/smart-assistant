import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const prefix = "oc_v5_composer_draft:";

test("Composer session-owned drafts (real Chromium, no backend)", { timeout: 90_000 }, async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./composer-draft-harness.tsx", import.meta.url))],
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
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    async function scenario(name, seeds, run) {
      await t.test(name, async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(5000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.evaluate(({ prefix, seeds }) => {
            for (const [key, value] of Object.entries(seeds)) sessionStorage.setItem(prefix + key, value);
          }, { prefix, seeds });
          const mount = () => page.addScriptTag({ content: bundle.outputFiles[0].text });
          await mount();
          const input = page.getByRole("textbox", { name: "消息输入框" });
          await input.waitFor();
          const select = (id) => page.getByRole("button", { name: `session ${id}`, exact: true }).click();
          const stored = (id) => page.evaluate((key) => sessionStorage.getItem(key), prefix + id);
          await run({ page, input, select, stored, mount });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }

    await scenario("clean sessions never invent text", {}, async ({ input, select }) => {
      await select("B"); await select("A");
      assert.equal(await input.inputValue(), "");
    });
    await scenario("switch preserves both drafts and the input DOM", { A: "、", B: "B draft" }, async ({ page, input, select, stored }) => {
      await input.evaluate((el) => { window.__originalComposerInput = el; });
      await select("B");
      assert.equal(await input.inputValue(), "B draft");
      await input.fill("B edited");
      await select("A");
      assert.equal(await input.inputValue(), "、");
      assert.equal(await stored("B"), "B edited");
      assert.equal(await input.evaluate((el) => window.__originalComposerInput === el), true);
    });
    await scenario("input and deletion survive immediate switches (no debounce wait)", { B: "B draft" }, async ({ input, select, stored }) => {
      await input.fill("、");
      assert.equal(await stored("A"), "、");
      await select("B"); await select("A");
      assert.equal(await input.inputValue(), "、");
      await input.fill("");
      assert.equal(await stored("A"), null);
      await select("B"); await select("A");
      assert.equal(await input.inputValue(), "");
      assert.equal(await stored("B"), "B draft");
    });
    await scenario("immediate unmount and refresh preserve latest text/deletion", {}, async ({ page, input, stored, mount }) => {
      await input.fill("latest draft");
      await page.getByRole("button", { name: "toggle composer" }).click();
      await page.getByRole("button", { name: "toggle composer" }).click();
      assert.equal(await input.inputValue(), "latest draft");
      await page.reload(); await mount(); await input.waitFor();
      assert.equal(await input.inputValue(), "latest draft");
      await input.fill("");
      await page.reload(); await mount(); await input.waitFor();
      assert.equal(await input.inputValue(), "");
      assert.equal(await stored("A"), null);
    });
    await scenario("send clears only the sending session", { A: "A draft", B: "B draft" }, async ({ page, input, select, stored }) => {
      await page.getByRole("button", { name: "发送", exact: true }).click();
      assert.equal(await page.getByTestId("sent").textContent(), "A:A draft");
      assert.equal(await stored("A"), null);
      await select("B"); assert.equal(await input.inputValue(), "B draft");
      await select("A"); assert.equal(await input.inputValue(), "");
    });
    await scenario("new to real session ID does not resurrect sent draft", { A: "A draft" }, async ({ page, input, select, stored }) => {
      await select("new"); assert.equal(await input.inputValue(), "");
      await input.fill("first message"); await input.press("Enter");
      assert.equal(await page.getByTestId("active").textContent(), "created");
      assert.equal(await input.inputValue(), "");
      assert.equal(await stored("new"), null);
      assert.equal(await stored("created"), null);
      await select("A"); assert.equal(await input.inputValue(), "A draft");
      await select("new"); assert.equal(await input.inputValue(), "");
    });
    await scenario("allocating an ID before send preserves unsent new draft", {}, async ({ page, input, select, stored }) => {
      await select("new"); await input.fill("unsent before GitHub setup");
      await page.getByRole("button", { name: "materialize new" }).click();
      assert.equal(await input.inputValue(), "unsent before GitHub setup");
      assert.equal(await stored("created"), "unsent before GitHub setup");
      assert.equal(await stored("new"), null);
      await select("new"); assert.equal(await input.inputValue(), "");
    });
    await scenario("oversized draft stays with its session instead of restoring a stale prefix", {}, async ({ input, select, stored }) => {
      await input.fill("old prefix");
      const text = "中".repeat(8000);
      await input.fill(text);
      await select("B"); assert.equal(await input.inputValue(), "");
      await select("A"); assert.equal(await input.inputValue(), text);
      assert.equal(await stored("A"), null);
      await input.fill(""); await select("B"); await select("A");
      assert.equal(await input.inputValue(), "");
    });
    await scenario("explicit prefill owns target draft, unchanged nonce is not replayed", { A: "A draft", B: "B draft" }, async ({ page, input, select, stored }) => {
      await page.getByRole("button", { name: "prefill B" }).click();
      assert.equal(await input.inputValue(), "explicit B prefill");
      assert.equal(await stored("A"), "A draft");
      await input.fill("B manual edit");
      await select("A"); assert.equal(await input.inputValue(), "A draft");
      await select("B"); assert.equal(await input.inputValue(), "B manual edit");
    });
    await scenario("ArrowUp recall is saved only to active session", { B: "B draft" }, async ({ input, select, stored }) => {
      await input.press("ArrowUp");
      assert.equal(await input.inputValue(), "previous user message");
      assert.equal(await stored("A"), "previous user message");
      await select("B"); assert.equal(await input.inputValue(), "B draft");
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
