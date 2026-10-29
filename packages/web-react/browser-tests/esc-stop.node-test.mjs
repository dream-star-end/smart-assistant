import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");

test("#1233: trusted Escape confirms, cancels safely, and never stops a replacement turn", { timeout: 60000 }, async (t) => {
  const red = process.env.OC_ESC_STOP_RED === "1";
  let replacements = 0;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./esc-stop-harness.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: "restore-immediate-escape-stop", setup(b) {
      b.onLoad({ filter: /\/useStopShortcut\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        const needle = '      event.preventDefault();';
        assert.equal(source.split(needle).length, 2);
        replacements += 1;
        return { contents: source.replace(needle, `${needle}\n      current.current.onStop();\n      return;`), loader: "ts" };
      });
    } }] : [], logLevel: "silent",
  });
  assert.equal(replacements, red ? 1 : 0);
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><meta charset="utf-8"><style>[role="dialog"]{position:fixed;top:10px;left:10px;background:white;z-index:100}button{min-height:40px}</style><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  await input.click();
  await page.keyboard.press("Escape");
  const dialog = page.getByRole("dialog", { name: "停止当前任务？" });
  await dialog.waitFor({ timeout: 5000 });
  assert.equal(await page.getByTestId("stops").textContent(), "0");
  assert.equal(await page.getByRole("button", { name: "继续运行" }).evaluate((el) => el === document.activeElement), true);
  // The same key dismisses the confirmation; it cannot cascade into another Stop.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("stops").textContent(), "0");
  await input.click();
  await page.keyboard.press("Escape");
  await dialog.waitFor();
  await page.evaluate(() => window.nextTurn());
  await page.getByTestId("turn").filter({ hasText: "2" }).waitFor();
  await page.getByRole("button", { name: "停止任务" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("stops").textContent(), "0");
  // Input methods and repeat events must keep the task running without opening a dialog.
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  assert.equal(await dialog.count(), 0);
  await input.click();
  await page.keyboard.press("Escape");
  await dialog.waitFor();
  await page.getByRole("button", { name: "停止任务" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("stops").textContent(), "1");
  assert.equal(await page.getByRole("img", { name: "出错", exact: true }).count(), 0);
  const status = page.getByRole("img", { name: "已停止", exact: true });
  assert.match(await status.getAttribute("class"), /bg-status-idle/);
  // The Composer's deliberate Stop button remains a single direct action.
  await page.evaluate(() => window.nextTurn());
  await page.getByRole("button", { name: "停止", exact: true }).click();
  assert.equal(await page.getByTestId("stops").textContent(), "2");
});
