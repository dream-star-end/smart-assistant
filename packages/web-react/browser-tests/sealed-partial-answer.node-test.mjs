import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";

// INC-20261028-BOX-SEALED-PARTIAL-ANSWER: a sealed crashed tape may append
// `API Error: 409 {BOX_REPLAY_PENDING…}` directly after legitimate Markdown.
// The real App must keep the Markdown body and paint the hard failure card —
// not swallow the partial answer as an internal dump, and not keep the soft
// 「结果正在收尾」 promise. OC_SEALED_PARTIAL_RED=1 restores the pre-fix
// classify-before-split path so the Markdown disappears.
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const renderPath = resolve(here, "../src/lib/chat/render.ts");
const red = process.env.OC_SEALED_PARTIAL_RED === "1";
let transformCount = 0;

const MARKDOWN = [
  "可以压，已经压好了。",
  "",
  "```ui",
  '{"type":"next","text":"插入后是第3章，帮我改一下章号"}',
  "```",
].join("\n");
const DETAIL =
  'API Error: 409 {"error":{"code":"BOX_REPLAY_PENDING","message":"previous Box call still resolving"},"request_id":"bc37bc74b82fa8b7606a18461cdd7fa4"}';
const OWNER = "u-sealed-partial";

function board() {
  return [
    {
      id: OWNER,
      role: "user",
      text: "把这段压进第3章并改章号",
      status: "replied",
      ts: Date.now() - 60_000,
      _source: "server",
    },
    {
      id: "a-sealed-partial",
      role: "assistant",
      text: `${MARKDOWN}${DETAIL}`,
      ts: Date.now() - 59_000,
      _source: "server",
      _clientMessageId: OWNER,
      _errorCode: "ENGINE_ERROR",
      _errorDetail: DETAIL,
      _turnTapeComplete: true,
      _dispatchOutcome: "crashed",
      _turnTapeId: "tape-sealed-partial",
    },
  ];
}

test("INC-20261028-BOX-SEALED-PARTIAL-ANSWER: sealed crash keeps Markdown and the hard failure card", { timeout: 180000 }, async (t) => {
  const assetDir = mkdtempSync(join(tmpdir(), "oc-sealed-partial-"));
  t.after(() => rmSync(assetDir, { recursive: true, force: true }));
  await build({
    entryPoints: [join(here, "process-disclosure-app-harness.tsx")],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: assetDir,
    entryNames: "app",
    chunkNames: "chunks/[name]-[hash]",
    jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" },
    alias: { "node:crypto": join(here, "stubs/node-crypto.js") },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}',
    },
    plugins: red
      ? [{
          name: "classify-before-split",
          setup(b) {
            b.onLoad({ filter: /\/lib\/chat\/render\.ts$/ }, ({ path }) => {
              assert.equal(resolve(path), renderPath);
              let contents = readFileSync(path, "utf8");
              const needle =
                "const { body: beforeTrailingTerminator } = splitTrailingTerminator(text?.trim() ?? \"\");";
              assert.equal(contents.split(needle).length - 1, 1, "ablation needle must appear once");
              contents = contents.replace(
                needle,
                'const beforeTrailingTerminator = ""; // OC_SEALED_PARTIAL_RED: classify whole text before split',
              );
              transformCount += 1;
              return { contents, loader: "ts" };
            });
          },
        }]
      : [],
    logLevel: "warning",
  });
  assert.equal(transformCount, red ? 1 : 0);

  const cssDir = join(assetDir, "css-build");
  mkdirSync(cssDir);
  await viteBuild({
    root: join(here, ".."),
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    build: {
      outDir: cssDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: join(here, "preview-styles.ts"),
        output: { assetFileNames: "styles[extname]" },
      },
    },
  });
  writeFileSync(
    join(assetDir, "styles.css"),
    readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith(".css")))),
  );

  const preview = await startPreviewServer(assetDir);
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ["--no-sandbox"],
    });
    for (const width of [1280, 390]) {
      await t.test(`${width}: sealed partial Markdown + hard card`, async () => {
        preview.store.board = board();
        preview.store.older = [];
        preview.store.revision += 1;
        const context = await browser.newContext({
          viewport: { width, height: 950 },
          isMobile: width === 390,
          hasTouch: width === 390,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          await page.goto(preview.url);
          await page.getByText("把这段压进第3章并改章号", { exact: true }).waitFor();
          const body = await page.locator("body").innerText();
          if (red) {
            assert.equal(
              await page.getByText("可以压，已经压好了。", { exact: false }).count(),
              0,
              "negative control: Markdown partial answer is swallowed",
            );
            assert.match(body, /任务执行失败|内部错误/);
            assert.doesNotMatch(body, /结果正在收尾/);
          } else {
            assert.ok(
              body.includes("可以压，已经压好了。"),
              "sealed crash keeps the legitimate Markdown partial answer",
            );
            assert.doesNotMatch(body, /API Error: 409/);
            assert.doesNotMatch(body, /BOX_REPLAY_PENDING/);
            assert.equal(
              await page.getByText("任务执行失败", { exact: true }).count(),
              1,
              "hard failure card is shown once",
            );
            assert.equal(
              await page.getByText("结果正在收尾", { exact: true }).count(),
              0,
              "soft BOX_REPLAY_PENDING card must not linger on a sealed crash",
            );
          }
          assert.deepEqual(errors, []);
          console.log(
            "SEALED_PARTIAL_RECEIPT",
            JSON.stringify({
              width,
              red,
              transformCount,
              markdownVisible: !red,
              hardCard: !red,
            }),
          );
        } catch (error) {
          console.error(
            "SEALED_PARTIAL_DIAGNOSTIC",
            JSON.stringify({
              width,
              red,
              body: (await page.locator("body").innerText()).slice(-2000),
              errors,
            }),
          );
          throw error;
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser?.close();
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
  }
});
