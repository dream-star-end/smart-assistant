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

async function cachedSessionDiagnostic(page) {
  return page.evaluate(async (sessionId) => {
    const dbName = 'ocv5_sessions__u1';
    const names = await indexedDB.databases();
    if (!names.some((entry) => entry.name === dbName)) return { dbName, exists: false };
    const db = await new Promise((done, fail) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => done(request.result);
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = () => { request.transaction.abort(); fail(new Error('diagnostics never create a cache database')); };
    });
    try {
      if (!db.objectStoreNames.contains('sessions')) return { dbName, exists: true, noSessionsStore: true };
      const session = await new Promise((done, fail) => {
        const request = db.transaction('sessions').objectStore('sessions').get(sessionId);
        request.onsuccess = () => done(request.result ?? null);
        request.onerror = () => fail(request.error);
      });
      if (!session) return { dbName, exists: true, session: null };
      return { dbName, id: session.id, historyRevision: session._historyRevision,
        recoveryStatus: session._recoveryStatus, decisions: session._automaticRecoveryDecisions,
        // Canonical timeline rows are deliberately refetched instead of cached.
        // This is diagnostic evidence; absence from IndexedDB is not a failure.
        rows: (session.messages ?? []).slice(-12).map((row) => ({
          id: row.id, role: row.role, clientMessageId: row._clientMessageId,
          text: (row.text ?? '').slice(0, 180), status: row.status,
          errorCode: row._errorCode, recoveryOf: row._recoveryOfClientMessageId,
          errorCardSnapshot: row._errorCardSnapshot, routing: row._routing,
        })) };
    } finally { db.close(); }
  }, BOARD_SESSION).catch((error) => ({ readError: error.message }));
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
        return { contents: readFileSync(baseline, 'utf8'), loader: 'ts', resolveDir: resolve(here, '../src/lib/chat') };
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
    const cases = red ? [[1280, 'paid']] : [[1280, 'paid'], [1280, 'zero'], [390, 'paid'], [390, 'zero']];
    for (const [width, kind] of cases) {
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
        let stage = 'boot';
        let paidAnchorReady = false;
        try {
          await page.goto(preview.url, { waitUntil: 'domcontentloaded' });
          stage = 'authority-card';
          const authorityCard = page.getByRole('alert').filter({ hasText: /任务暂时中断|任务未正常完成/ });
          await authorityCard.waitFor();
          assert.equal(await authorityCard.count(), 1, 'one authoritative interruption card has actually rendered');
          await page.getByText(LONGTASK_CONTEXT, { exact: true }).waitFor();
          await page.getByText(scenario.goal, { exact: true }).waitFor();
          assert.deepEqual(errors, [], 'the real App loads without browser exceptions');
          assert.equal(scenario.frames.length, 0, 'no automatic replay occurs before the human click');
          const body = await page.locator('body').innerText();
          assert.doesNotMatch(body, /本轮已自动免单|积分已原路退回|本轮不收费/,
            'unapplied waiver proposals never claim a refund');
          if (kind === 'paid') {
            stage = 'paid-output-and-billing';
            // These pre-click anchors distinguish the known pre-fix renderer
            // from an unavailable App, missing action, build error or timeout.
            await page.getByText('71 积分', { exact: true }).first().waitFor();
            paidAnchorReady = true;
            assert.equal(await page.getByText(LONGTASK_PARTIAL, { exact: true }).isVisible(), true,
              'LONGTASK_RED_ANCHOR_PARTIAL: LONGTASK_PARTIAL must remain visible before Continue');
            assert.match(body, /按实际用量计费/,
              'LONGTASK_RED_ANCHOR_BILLING: retained work keeps actual usage billing before Continue');
            await revealCompletedTool(page);
          }
          stage = 'continue-action';
          const go = page.getByRole('button', { name: '继续', exact: true });
          await go.first().waitFor();
          await until('one unique Continue', async () => await go.count() === 1);
          assert.equal(await page.getByRole('button', { name: /^(重试|重新尝试|重新发送|从断点继续)$/ }).count(), 0);
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
          stage = 'reload';
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
          if (red && paidAnchorReady && errors.length === 0 && scenario.frames.length === 0 &&
              error.code === 'ERR_ASSERTION' && /^LONGTASK_RED_ANCHOR_(PARTIAL|BILLING):/.test(error.message)) {
            console.error('LONGTASK_BROWSER_EXPECTED_RED_ANCHOR', JSON.stringify({ width, kind,
              anchor: error.message.split(':')[0], cardRendered: true, actualCredits: '71',
              pageErrors: 0, inboundFrames: 0, transforms }));
          }
          console.error('LONGTASK_BROWSER_DIAGNOSTIC', JSON.stringify({ width, kind, red, stage,
            frames: scenario.frames, errors, alerts: await page.getByRole('alert').allInnerTexts(),
            buttons: await page.getByRole('button').allTextContents(),
            cachedSession: await cachedSessionDiagnostic(page),
            body: (await page.locator('body').innerText()).slice(-3500), unknown: preview.unknown }));
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
