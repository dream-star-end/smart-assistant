// OCV5-245 visual proof: 390×844 ChatHeader model picker as a bottom sheet.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/vite';
import { build as viteBuild } from 'vite';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));
const shotDir = process.env.OC_SHEET_SHOT_DIR || '/home/agent/.openclaude/generated';

const out = mkdtempSync(join(tmpdir(), 'oc-model-picker-sheet-'));
const bundle = await build({
  entryPoints: [join(here, 'mobile-harness.tsx')],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  alias: { 'node:crypto': join(here, 'stubs/node-crypto.js') },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  logLevel: 'silent',
});
await viteBuild({
  root: join(here, '..'),
  configFile: false,
  logLevel: 'silent',
  plugins: [tailwindcss()],
  build: {
    outDir: out,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: { input: join(here, 'preview-styles.ts'), output: { assetFileNames: 'styles[extname]' } },
  },
});
const css = readFileSync(join(out, readdirSync(out).find((n) => n.endsWith('.css'))), 'utf8');
const browser = await chromium.launch({
  executablePath: resolveBrowserExecutable(),
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>' +
      css +
      '</style><div id="root"></div>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByTestId('mobile-chat-scroll').waitFor();
  const model = page.getByRole('button', { name: '选择对话模型' });
  await model.tap();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box, 'sheet has no box');
  assert.ok(box.x <= 1, `sheet not full-bleed x=${box.x}`);
  assert.ok(Math.abs(box.width - 390) <= 2, `sheet width ${box.width}`);
  assert.ok(box.y >= 0, `sheet y ${box.y}`);
  assert.ok(box.y + box.height <= 844 + 1, `sheet overflows bottom ${box.y}+${box.height}`);
  assert.ok(box.y + box.height >= 844 - 2, `sheet not stuck to bottom ${box.y}+${box.height}`);
  await page.screenshot({
    path: join(shotDir, 'ocv5-245-sheet-open.png'),
    fullPage: false,
  });
  const high = page.getByRole('menuitem', { name: '高' });
  await high.scrollIntoViewIfNeeded();
  const highBox = await high.boundingBox();
  assert.ok(highBox, 'effort 高 missing');
  assert.ok(highBox.height >= 43.5, `effort 高 too short ${highBox.height}`);
  assert.ok(highBox.y + highBox.height <= 844 + 1, `effort 高 clipped ${JSON.stringify(highBox)}`);
  await page.screenshot({
    path: join(shotDir, 'ocv5-245-sheet-effort-high.png'),
    fullPage: false,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        sheet: box,
        effortHigh: highBox,
        shots: [
          join(shotDir, 'ocv5-245-sheet-open.png'),
          join(shotDir, 'ocv5-245-sheet-effort-high.png'),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
