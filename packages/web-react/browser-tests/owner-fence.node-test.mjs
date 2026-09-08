import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

test("Composer owner fence (real Chromium, no backend)", { timeout: 120_000 }, async (t) => {
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
    async function openPage() {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      return { context, page, errors };
    }

    await t.test("new attachments stay on new, not an existing other session", async () => {
      const { context, page, errors } = await openPage();
      try {
        await page.getByRole("button", { name: "session new", exact: true }).click();
        const fileInput = page.locator("input[type=file]");
        await fileInput.setInputFiles({
          name: "new-private.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("private"),
        });
        await page.getByText("new-private.txt").waitFor();
        await page.getByRole("button", { name: "session existing-other", exact: true }).click();
        assert.equal(await page.getByText("new-private.txt").count(), 0);
        await page.getByRole("button", { name: "session new", exact: true }).click();
        assert.equal(await page.getByText("new-private.txt").count(), 1);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test("true materialize keeps attachments and finishes delayed upload", async () => {
      const { context, page, errors } = await openPage();
      try {
        await page.getByRole("button", { name: "session new", exact: true }).click();
        await page.getByRole("button", { name: "delay off" }).click();
        const fileInput = page.locator("input[type=file]");
        await fileInput.setInputFiles({
          name: "late.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("late"),
        });
        await page.getByText("late.txt").waitFor();
        await page.getByRole("button", { name: "materialize new" }).click();
        assert.equal(await page.getByTestId("active").textContent(), "created");
        await page.getByRole("button", { name: "finish upload" }).click();
        await page.getByRole("textbox", { name: "消息输入框" }).fill("after materialize");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        assert.equal(await page.getByTestId("sent").textContent(), "created:after materialize:/stub/late.txt");
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test("account switch does not inherit previous account attachments", async () => {
      const { context, page, errors } = await openPage();
      try {
        await page.getByRole("button", { name: "session new", exact: true }).click();
        const fileInput = page.locator("input[type=file]");
        await fileInput.setInputFiles({
          name: "account-private.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("private"),
        });
        await page.getByText("account-private.txt").waitFor();
        await page.getByRole("button", { name: "switch account" }).click();
        assert.equal(await page.getByTestId("account").textContent(), "user-b");
        assert.equal(await page.getByText("account-private.txt").count(), 0);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test("remove after switch only deletes the current session file", async () => {
      const { context, page, errors } = await openPage();
      try {
        const fileInput = page.locator("input[type=file]");
        await fileInput.setInputFiles({
          name: "A-keep.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("a"),
        });
        await page.getByText("A-keep.txt").waitFor();
        await page.getByRole("button", { name: "session B", exact: true }).click();
        assert.equal(await page.getByText("A-keep.txt").count(), 0);
        await fileInput.setInputFiles({
          name: "B-drop.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("b"),
        });
        await page.getByText("B-drop.txt").waitFor();
        await page.getByRole("button", { name: "移除 B-drop.txt" }).click();
        assert.equal(await page.getByText("B-drop.txt").count(), 0);
        await page.getByRole("button", { name: "session A", exact: true }).click();
        assert.equal(await page.getByText("A-keep.txt").count(), 1);
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
