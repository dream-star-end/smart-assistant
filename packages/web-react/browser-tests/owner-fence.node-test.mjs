import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const prefix = "oc_v5_composer_draft:";

test("Composer owner fence (real Chromium, no backend)", { timeout: 90_000 }, async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./owner-fence-harness.tsx", import.meta.url))],
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
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    await t.test("A attachment does not send on B", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const fileInput = page.locator('input[type=file]');
        await fileInput.waitFor({ state: "attached" });
        await fileInput.setInputFiles({
          name: "A-private.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("private"),
        });
        await page.getByText("A-private.txt").waitFor();
        await page.getByRole("button", { name: "session B", exact: true }).click();
        assert.equal(await page.getByText("A-private.txt").count(), 0);
        await page.getByRole("textbox", { name: "消息输入框" }).fill("from B");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        assert.equal(await page.getByTestId("sent").textContent(), "B:from B:");
        await page.getByRole("button", { name: "session A", exact: true }).click();
        assert.equal(await page.getByText("A-private.txt").count(), 1);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
    await t.test("unscoped new draft is not inherited by the next account", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(({ prefix }) => {
          sessionStorage.setItem(`${prefix}new`, "account-A private unsent draft");
        }, { prefix });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const input = page.getByRole("textbox", { name: "消息输入框" });
        await input.waitFor();
        await page.getByRole("button", { name: "switch account" }).click();
        assert.equal(await input.inputValue(), "");
        assert.equal(await page.getByTestId("account").textContent(), "user-b");
        assert.equal(
          await page.evaluate((key) => sessionStorage.getItem(key), `${prefix}new`),
          null,
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
