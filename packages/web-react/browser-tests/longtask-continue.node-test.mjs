import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { build as viteBuild } from 'vite';
import { startPreviewServer } from './process-disclosure-app-server.mjs';
import { BOARD_SESSION } from './process-disclosure-story.mjs';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
import { attachLongtaskWebSocket, createLongtaskScenario, LONGTASK_CONTEXT,
  LONGTASK_PARTIAL, LONGTASK_TOOL_FILE, LONGTASK_FINISHED } from './longtask-continue-fixture.mjs';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));
const red = process.env.OC_LONGTASK_BROWSER_RED === '1';

async function until(label, predicate, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(`${label}: timed out`);
}

async function revealCompletedTool(page) {
  // Settled process rows intentionally unmount while collapsed. Exercise the
  // real disclosure control before checking the completed tool's filename.
  if (await page.getByText(LONGTASK_TOOL_FILE, { exact: false }).count() === 0) {
    for (const toggle of await page.getByTestId('process-toggle').all()) {
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    }
  }
  await page.getByText(LONGTASK_TOOL_FILE, { exact: false }).first().waitFor();
}

test('t1360u real App: paid and zero-output tasks continue in the original conversation', { timeout: 180_000 }, async (t) => {
  const assets = mkdtempSync(join(tmpdir(), 'oc-longtask-continue-'));
  t.after(() => rmSync(assets, { recursive: true, force: true }));
  const shots = process.env.OC_LONGTASK_BROWSER_SHOTS ?? assets;
  mkdirSync(shots, { recursive: true });
  let transforms = 0;
  await build({
    entryPoints: [join(here, 'process-disclosure-app-harness.tsx')], bundle: true,
    splitting: true, format: 'esm', outdir: assets, entryNames: 'app', chunkNames: 'chunks/[name]-[hash]', jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
    alias: { 'node:crypto': join(here, 'stubs/node-crypto.js') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: red ? [{ name: 'real-render-before-longtask-fix', setup(builder) {
      builder.onLoad({ filter: /\/src\/lib\/chat\/render\.ts$/ }, () => {
        const baseline = process.env.OC_LONGTASK_RENDER_BASELINE ?? resolve(here, '../../../../fixtures/render-before.ts');
        transforms += 1;
        return { contents: readFileSync(baseline, 'utf8'), loader: 'ts' };
      });
    } }] : [], logLevel: 'warning',
  });
  assert.equal(transforms, red ? 1 : 0, 'red run must load the real pre-fix render module');
  const cssDir = join(assets, 'css-build'); mkdirSync(cssDir);
  await viteBuild({ root: join(here, '..'), configFile: false, logLevel: 'silent', plugins: [tailwindcss()],
    build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
      rollupOptions: { input: join(here, 'preview-styles.ts'), output: { assetFileNames: 'styles[extname]' } } } });
  writeFileSync(join(assets, 'styles.css'), readFileSync(join(cssDir, readdirSync(cssDir).find((name) => name.endsWith('.css')))));
  const preview = await startPreviewServer(assets);
  let scenario;
  attachLongtaskWebSocket(preview, () => scenario);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
    for (const width of [1280, 390]) for (const kind of ['paid', 'zero']) {
      await t.test(`${width}px ${kind} retains context and sends one continuation`, async () => {
        scenario = createLongtaskScenario(kind);
        preview.store.board = structuredClone(scenario.rows);
        preview.store.older = []; preview.store.revision += 1;
        const oldRows = structuredClone(preview.store.board);
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 950 },
          isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.setDefaultTimeout(20_000);
        const screenshot = (stage) => page.screenshot({ path: join(shots, `longtask-${red ? 'red' : 'green'}-${width}-${kind}-${stage}.png`), fullPage: true });
        try {
          await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
          const go = page.getByRole('button', { name: '继续', exact: true });
          await go.first().waitFor();
          await until('one unique Continue', async () => await go.count() === 1);
          assert.equal(scenario.frames.length, 0, 'no automatic replay occurs before the human click');
          assert.equal(await page.getByRole('button', { name: /^(重试|重新尝试|重新发送|从断点继续)$/ }).count(), 0);
          await page.getByText(LONGTASK_CONTEXT, { exact: true }).waitFor();
          await page.getByText(scenario.goal, { exact: true }).waitFor();
          const body = await page.locator('body').innerText();
          assert.doesNotMatch(body, /本轮已自动免单|积分已原路退回|本轮不收费/,
            'unapplied waiver proposals never claim a refund');
          if (kind === 'paid') {
            await page.getByText(LONGTASK_PARTIAL, { exact: true }).waitFor();
            await revealCompletedTool(page);
            assert.match(body, /按实际用量计费/, 'retained work keeps actual usage billing');
          }
          await screenshot('before');
          await go.click(); // trusted browser action reaches the actual continuation hook
          await page.getByText(LONGTASK_FINISHED, { exact: true }).first().waitFor();
          await until('one actual inbound continuation', () => scenario.frames.length === 1);
          const frame = scenario.frames[0];
          assert.equal(frame.peer.id, BOARD_SESSION);
          assert.notEqual(frame.clientMessageId, scenario.source, 'continuation is a newly admitted turn');
          assert.notEqual(frame.content.text, scenario.goal, 'the original request is never replayed');
          assert.match(frame.content.text, /不要重新执行已经完成的步骤/);
          assert.equal(frame.content.media, undefined, 'these completed/context-only fixtures do not replay attachments');
          if (kind === 'zero') {
            assert.equal(frame.content.recovery, undefined, 'zero-output manual continuation uses normal admission, not automatic recovery metadata');
            assert.equal(frame.content.displayText, '继续');
            assert.match(frame.content.text, /原任务目标/);
            assert.ok(frame.content.text.includes(scenario.goal), 'the never-executed goal survives as continuation context');
          } else {
            assert.equal(frame.content.recovery?.mode, 'checkpoint');
            assert.equal(frame.content.recovery?.automatic, false);
          }
          assert.ok(page.url().includes(`/s/${BOARD_SESSION}`), 'the browser stays in the same conversation');
          assert.deepEqual(preview.store.board.slice(0, oldRows.length), oldRows, 'the fixture retains the original user, body and tool records unchanged');
          await page.getByText(LONGTASK_CONTEXT, { exact: true }).waitFor();
          if (kind === 'paid') await page.getByText(LONGTASK_PARTIAL, { exact: true }).waitFor();
          const buttonBox = await page.getByPlaceholder(/对话/).boundingBox();
          assert.ok(buttonBox && buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= width + 1, 'composer remains inside mobile/desktop viewport');
          await screenshot('continued');
          await page.reload();
          await page.getByText(LONGTASK_FINISHED, { exact: true }).first().waitFor();
          await page.getByText(LONGTASK_CONTEXT, { exact: true }).waitFor();
          if (kind === 'paid') {
            await page.getByText(LONGTASK_PARTIAL, { exact: true }).waitFor();
            await revealCompletedTool(page);
          }
          assert.equal(scenario.frames.length, 1, 'reload never resends the continuation');
          assert.deepEqual(errors, []);
          await screenshot('reloaded');
          console.log('LONGTASK_BROWSER_RECEIPT', JSON.stringify({ width, kind, red, transforms,
            sessionId: frame.peer.id, sourceId: scenario.source, continuationId: frame.clientMessageId,
            sends: scenario.frames.length, originalRowsRetained: oldRows.length,
            recoveryMode: frame.content.recovery?.mode ?? 'normal-manual' }));
        } catch (error) {
          console.error('LONGTASK_BROWSER_DIAGNOSTIC', JSON.stringify({ width, kind, red,
            frames: scenario.frames, errors, alerts: await page.getByRole('alert').allInnerTexts(),
            body: (await page.locator('body').innerText()).slice(-2500), unknown: preview.unknown }));
          await screenshot('failure').catch(() => {});
          throw error;
        } finally { await context.close(); }
      });
    }
  } finally {
    await browser?.close();
    for (const ws of preview.wss.clients) ws.terminate();
    await new Promise((done) => preview.wss.close(done));
    await new Promise((done) => preview.server.close(done));
  }
});
