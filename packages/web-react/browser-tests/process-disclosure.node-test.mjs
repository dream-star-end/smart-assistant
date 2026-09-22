import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.env.OC_PROCESS_SHOT_DIR || "/home/agent/.openclaude/generated";

test("OCV5-265 process disclosure: real MessageList, production CSS, red/green entry", { timeout: 180000 }, async () => {
  mkdirSync(shots, { recursive: true });
  const out = join(tmpdir(), `oc-process-disclosure-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const bundle = await build({
    entryPoints: [join(here, "process-disclosure-harness.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    loader: { ".css": "empty" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.MODE": '"production"',
    },
    logLevel: "silent",
  });
  await viteBuild({
    root: join(here, ".."),
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      outDir: out,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: join(here, "preview-styles.ts"),
        output: { assetFileNames: "styles[extname]" },
      },
    },
  });
  const css = readFileSync(join(out, readdirSync(out).find((name) => name.endsWith(".css"))), "utf8");
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    async function open(width, touch) {
      const context = await browser.newContext({
        viewport: { width, height: touch ? 844 : 900 },
        isMobile: touch,
        hasTouch: touch,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.getByTestId("process-harness").waitFor();
      return { context, page, errors };
    }

    const desktop = await open(1280, false);
    try {
      await desktop.page.evaluate(() => window.__processPage.setMode("legacy"));
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-harness]")?.getAttribute("data-mode") === "legacy");
      assert.equal(await desktop.page.getByTestId("process-disclosure").count(), 0, "legacy entry has no disclosure");
      await desktop.page.getByText("probe-stock-layout").waitFor();
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-legacy-desktop.png") });

      await desktop.page.evaluate(() => window.__processPage.setMode("manus"));
      await desktop.page.getByTestId("process-toggle").waitFor();
      assert.equal(await desktop.page.getByText("probe-stock-layout").count(), 0, "tool stays folded");
      await desktop.page.getByText("看板已经做好").waitFor();
      await desktop.page.getByText("paper.pdf").waitFor();
      const collapsedShot = join(shots, "ocv5-265-manus-desktop-collapsed.png");
      await desktop.page.screenshot({ path: collapsedShot });

      await desktop.page.getByTestId("process-toggle").click();
      await desktop.page.getByText("先核对库存口径").waitFor();
      assert.equal(await desktop.page.getByText("probe-stock-layout").count(), 0, "level 2 is narrative and counts only");
      await desktop.page.getByTestId("process-detail-toggle").click();
      await desktop.page.getByText("probe-stock-layout").waitFor();
      await desktop.page.screenshot({ path: join(shots, "ocv5-265-manus-desktop-expanded.png") });

      await desktop.page.getByTestId("process-toggle").focus();
      await desktop.page.keyboard.press("Enter");
      await desktop.page.waitForFunction(() => document.querySelector("[data-testid=process-toggle]")?.getAttribute("aria-expanded") === "false");
      assert.equal(desktop.errors.length, 0, desktop.errors.join("\n"));
    } finally {
      await desktop.context.close();
    }

    const mobile = await open(390, true);
    try {
      await mobile.page.getByTestId("process-toggle").waitFor();
      const box = await mobile.page.getByTestId("process-toggle").boundingBox();
      assert.ok(box && box.height >= 44, `touch target too small: ${JSON.stringify(box)}`);
      assert.ok(box.x >= -1 && box.x + box.width <= 391, `toggle overflows viewport: ${JSON.stringify(box)}`);
      await mobile.page.getByText("看板已经做好").waitFor();
      assert.equal(await mobile.page.getByText("probe-stock-layout").count(), 0);
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-manus-mobile-collapsed.png") });
      await mobile.page.getByTestId("process-toggle").tap();
      await mobile.page.getByTestId("process-detail-toggle").tap();
      await mobile.page.getByText("probe-stock-layout").waitFor();
      const detail = await mobile.page.getByTestId("process-details").boundingBox();
      assert.ok(detail && detail.x >= -1 && detail.x + detail.width <= 391, `details overflow: ${JSON.stringify(detail)}`);
      await mobile.page.screenshot({ path: join(shots, "ocv5-265-manus-mobile-expanded.png") });
      assert.equal(mobile.errors.length, 0, mobile.errors.join("\n"));
    } finally {
      await mobile.context.close();
    }
  } finally {
    await browser.close();
  }
});
