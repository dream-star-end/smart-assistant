import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

test("OCV5-676: background results wait for confirmation across reload; the primary action still sends new text", { timeout: 90_000 }, async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./background-delegates-harness.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" },
    alias: { "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)),
      "@openclaude/protocol/browser": fileURLToPath(new URL("../../protocol/src/browser.ts", import.meta.url)),
      "@openclaude/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)) },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const input = page.getByRole("textbox", { name: "消息输入框" });
    await input.waitFor(); await input.fill("新的问题照常发送"); await page.getByRole("button", { name: "发送", exact: true }).click();
    assert.equal(await page.getByTestId("sent").innerText(), "新的问题照常发送");
    assert.equal(await page.getByRole("button", { name: "停止", exact: true }).count(), 1);
    await input.focus();
    await page.getByRole("button", { name: "后台结果到达", exact: true }).evaluate((button) => button.click());
    assert.equal(await input.evaluate((element) => document.activeElement === element), true, "background delivery does not steal composer focus");
    assert.equal(await page.getByTestId("stored-background").innerText(), "1");
    assert.equal(await page.getByText("校验结果：三项已通过。", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    assert.equal(await page.getByText("校验结果：三项已通过。", { exact: true }).count(), 0, "answer persistence is still waiting for its receipt");
    await page.reload(); await input.waitFor();
    assert.equal(await page.getByText("校验结果：三项已通过。", { exact: true }).count(), 0, "reload derives visibility from the same unresolved control");
    assert.equal(await page.getByTestId("stored-background").innerText(), "1");
    await page.getByRole("button", { name: "服务端确认回执", exact: true }).click();
    await page.getByText("校验结果：三项已通过。", { exact: true }).waitFor();
    assert.equal(await page.getByText("校验结果：三项已通过。", { exact: true }).count(), 1);
    assert.equal(await page.getByTestId("background-delegate-record").count(), 1);
    await page.getByRole("button", { name: "停止", exact: true }).click();
    const stop = JSON.parse(await page.getByTestId("stopped").innerText());
    assert.deepEqual(stop.backgroundJobIds, ["dlgjob-676"]); assert.equal(stop.clientMessageId, undefined);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((done) => server.close(done));
  }
});
