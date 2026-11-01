import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const { build } = createRequire(import.meta.url)("esbuild");
const { chromium } = createRequire(import.meta.url)("playwright-core");
const MIB = 1024 * 1024;

test("附件合计超过 300MB 时不上传并提示分条发送", { timeout: 90_000 }, async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./upload-total-limit-harness.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: {
      "node:crypto": fileURLToPath(new URL("./stubs/node-crypto.js", import.meta.url)),
      "@openclaude/protocol/browser": fileURLToPath(new URL("../../protocol/src/browser.ts", import.meta.url)),
      "@openclaude/protocol": fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url)),
    },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.MODE": '"production"' },
  });
  const server = createServer((req, res) => {
    if (req.url === "/fixture-bundle.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(bundle.outputFiles[0].text);
      return;
    }
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
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/fixture-bundle.js` });
    const input = page.getByRole("textbox", { name: "消息输入框" });
    await input.waitFor();
    await input.fill("请看这些附件");
    await page.evaluate((sizes) => {
      const picker = document.querySelector('input[aria-label="选择附件文件"]');
      const transfer = new DataTransfer();
      for (const spec of sizes) {
        const file = new File([new Uint8Array([1])], spec.name, { type: "application/octet-stream" });
        Object.defineProperty(file, "size", { value: spec.size });
        transfer.items.add(file);
      }
      picker.files = transfer.files;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    }, [
      { name: "a.rar", size: 160 * MIB },
      { name: "b.rar", size: 160 * MIB },
    ]);
    const notice = page.getByTestId("composer-upload-total-limit");
    await notice.waitFor();
    const text = await notice.textContent();
    assert.match(text ?? "", /320MB/);
    assert.match(text ?? "", /300MB/);
    assert.match(text ?? "", /两条/);
    assert.equal((text ?? "").includes("请重试"), false);
    assert.equal(await page.getByTestId("uploads").textContent(), "0");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    assert.equal(await page.getByTestId("sent").textContent(), "请看这些附件|0");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
