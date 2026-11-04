import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { build as viteBuild } from 'vite';
import { startPreviewServer } from './process-disclosure-app-server.mjs';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));

test('Antigravity observation failure preserves partial output and offers no retry CTA, including reload',
  { timeout: 180000 }, async () => {
    const assets = mkdtempSync(join(tmpdir(), 'agy-observation-browser-'));
    let preview;
    let browser;
    let sends = 0;
    try {
      await build({
        entryPoints: [join(here, 'process-disclosure-app-harness.tsx')], bundle: true,
        splitting: true, format: 'esm', outdir: assets, entryNames: 'app',
        chunkNames: 'chunks/[name]-[hash]', jsx: 'automatic',
        loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl' },
        alias: { 'node:crypto': join(here, 'stubs/node-crypto.js') },
        define: { 'process.env.NODE_ENV': '"production"',
          'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
        logLevel: 'warning',
      });
      const cssDir = join(assets, 'css-build'); mkdirSync(cssDir);
      await viteBuild({ root: join(here, '..'), configFile: false, logLevel: 'silent',
        plugins: [tailwindcss()], build: { outDir: cssDir, emptyOutDir: true, cssCodeSplit: false,
          rollupOptions: { input: join(here, 'preview-styles.ts'),
            output: { assetFileNames: 'styles[extname]' } } } });
      writeFileSync(join(assets, 'styles.css'),
        readFileSync(join(cssDir, readdirSync(cssDir).find((n) => n.endsWith('.css')))));
      preview = await startPreviewServer(assets);
      preview.wss.removeAllListeners('connection');
      preview.wss.on('connection', (ws) => {
        const send = (f) => ws.readyState === 1 && ws.send(JSON.stringify(f));
        send({ type: 'sys.relay_ready', automaticRecoveryOwner: 'master-v1' });
        ws.on('message', (raw) => {
          const f = JSON.parse(String(raw));
          if (f.type === 'ping') send({ type: 'pong', id: f.id });
          if (f.type === 'inbound.hello') send({ type: 'sys.relay_ready', automaticRecoveryOwner: 'master-v1' });
          if (f.type === 'inbound.message') sends++;
        });
      });
      const text = '执行进度同步失败，本轮可能已有操作完成，已停止自动重试。请先核对执行结果，再决定是否继续。';
      preview.store.board = [
        { id: 'agy-user', role: 'user', text: '执行核验', status: 'error', ts: 1, _source: 'server' },
        { id: 'agy-partial', role: 'assistant', text: '已完成第一项操作。', status: 'completed',
          ts: 2, _source: 'server', _clientMessageId: 'agy-user' },
        { id: 'agy-error', role: 'assistant', text, status: 'crashed', ts: 3,
          _source: 'server', _clientMessageId: 'agy-user',
          _errorCode: 'antigravity_start_observation_failed', _turnTapeComplete: true,
          _dispatchOutcome: 'error' },
      ];
      preview.store.older = []; preview.store.revision++;
      browser = await chromium.launch({ executablePath: resolveBrowserExecutable(),
        headless: true, args: ['--no-sandbox'] });
      for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 1100 } });
        try {
          const page = await context.newPage();
          for (const reload of [false, true]) {
            if (reload) await page.reload(); else await page.goto(preview.url);
            await page.getByText('执行进度同步失败', { exact: true }).waitFor();
            await page.getByText('已完成第一项操作。', { exact: true }).waitFor();
            const card = page.getByRole('alert').filter({ hasText: '执行进度同步失败' });
            assert.match(await card.innerText(), /本轮可能已有操作完成/);
            assert.match(await card.innerText(), /已停止自动重试/);
            assert.equal(await card.getByRole('button', { name: /重试|继续/ }).count(), 0);
            assert.equal(await page.getByText('正在自动重试', { exact: false }).count(), 0);
          }
          if (process.env.OC_AGY_BROWSER_EVIDENCE_DIR) {
            mkdirSync(process.env.OC_AGY_BROWSER_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.OC_AGY_BROWSER_EVIDENCE_DIR, `${width}.png`), fullPage: true });
          }
        } finally { await context.close(); }
      }
      assert.equal(sends, 0, 'view/reload must never send a recovery turn');
    } finally {
      await browser?.close();
      if (preview) {
        for (const ws of preview.wss.clients) ws.terminate();
        await new Promise((done) => preview.wss.close(done));
        await new Promise((done) => preview.server.close(done));
      }
      rmSync(assets, { recursive: true, force: true });
    }
  });
