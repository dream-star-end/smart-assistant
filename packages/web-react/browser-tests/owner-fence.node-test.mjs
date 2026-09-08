import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, join } from "node:path";
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
    plugins: process.env.OC_OWNER_COMPONENT_BASELINE ? [{
      name: 'pinned-owner-component-negative-control',
      setup(build) {
        build.onLoad({ filter: /\/src\/components\/(Composer|taskboard\/TicketListView)\.tsx$/ }, (args) => ({
          contents: readFileSync(join(process.env.OC_OWNER_COMPONENT_BASELINE, relative(fileURLToPath(new URL('../', import.meta.url)), args.path)), 'utf8'),
          loader: 'tsx', resolveDir: dirname(args.path),
        }));
      },
    }] : [],
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
    async function openPage(suffix = "") {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}${suffix}`);
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

    await t.test("two promotions cannot redirect the first delayed upload", async () => {
      const { context, page, errors } = await openPage();
      try {
        await page.getByRole("button", { name: "session new", exact: true }).click();
        await page.getByRole("button", { name: "delay off" }).click();
        const input = page.locator("input[type=file]");
        await input.setInputFiles({ name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("a") });
        await page.getByText("first.txt").waitFor();
        await page.getByRole("button", { name: "materialize new" }).click();
        await page.getByRole("button", { name: "session new", exact: true }).click();
        await input.setInputFiles({ name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("b") });
        await page.getByText("second.txt").waitFor();
        await page.getByRole("button", { name: "materialize new" }).click();
        assert.equal(await page.getByTestId("active").textContent(), "created-2");
        await page.getByRole("button", { name: "finish upload" }).click();
        assert.equal(await page.getByText("first.txt").count(), 0);
        await page.getByRole("button", { name: "session created", exact: true }).click();
        await page.getByRole("button", { name: "发送", exact: true }).click();
        assert.equal(await page.getByTestId("sent").textContent(), "created::/stub/first.txt");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test("filtered empty page can load more and stops at raw total", async () => {
      const { context, page, errors } = await openPage("?pagination=1");
      try {
        assert.equal(await page.getByTestId("loaded-raw").textContent(), "200");
        await page.getByTestId("ticket-list-load-more").click();
        assert.equal(await page.getByTestId("loaded-raw").textContent(), "201");
        assert.equal(await page.getByTestId("ticket-list-load-more").count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
