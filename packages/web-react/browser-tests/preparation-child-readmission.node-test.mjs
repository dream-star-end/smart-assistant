import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild'), { chromium } = require('playwright-core');

test('OCV5-174 C1: real 5s readmission + 15.5s wait does not terminalize a live child', { timeout: 120000, concurrency: true }, async t => {
  const bundle = process.env.OC_PREPARATION_BROWSER_BUNDLE
    ? await readFile(process.env.OC_PREPARATION_BROWSER_BUNDLE, 'utf8')
    : (await build({ entryPoints: [fileURLToPath(new URL('./preparation-recovery-harness.tsx', import.meta.url))],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      alias: { 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)) },
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
      logLevel: 'error' })).outputFiles[0].text;
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
  try {
    await Promise.all([1280, 390].map(width => t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const pageErrors = [];
      try {
        const names = ['readmit-success', 'readmit-exhausted', 'queued', 'stopped', 'new-active'];
        const pages = Object.fromEntries(await Promise.all(names.map(async name => {
          const page = await context.newPage();
          page.setDefaultTimeout(5000); page.on('pageerror', e => pageErrors.push(e.message));
          await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
          await page.addScriptTag({ content: bundle });
          return [name, page];
        })));
        await Promise.all(Object.values(pages).map(async page => {
          await page.evaluate(() => {
            window.preparation.begin(); window.preparation.ack();
            window.preparation.rawFrames([{ type: 'error', peer: { id: 's-browser-preparation', kind: 'dm' },
              clientMessageId: 'm-recover-browser-preparation', code: 'DISPATCH_ENRICHMENT_TIMEOUT',
              message: 'child physical preparation timeout' }]);
          });
          await page.getByText('正在重新准备…', { exact: true }).waitFor();
        }));
        // Real wall time and production 20s/35s constants. No clock mocking,
        // direct session mutation, timer shortening or regex stand-in.
        const startedAt = Date.now();
        await delay(5000);
        await Promise.all(['readmit-success', 'readmit-exhausted'].map(name =>
          pages[name].evaluate(() => window.preparation.ack())));
        await pages.stopped.getByRole('button', { name: '停止', exact: true }).click();
        await pages.stopped.evaluate(() => window.preparation.ack());
        await pages['new-active'].evaluate(() => {
          window.preparation.success(); window.preparation.queueHuman();
          const user = window.preparation.state().rows.find(m => m.text === '排队的下一条请求');
          window.preparation.rawFrames([{ type: 'outbound.ack', admitted: true,
            peer: { id: 's-browser-preparation', kind: 'dm' }, clientMessageId: user.id }]);
          window.preparation.ack();
        });
        await delay(15500);
        assert.ok(Date.now() - startedAt >= 20500);
        for (const name of ['readmit-success', 'readmit-exhausted', 'queued']) {
          const page = pages[name], state = await page.evaluate(() => window.preparation.state());
          assert.equal(state.sending, true, `${name}: the previous physical timeout must not terminate the logical child`);
          assert.equal(state.rows.filter(m => m._errorCode).length, 0, `${name}: no fabricated failure card`);
          assert.equal(state.rows.filter(m => m.id === 'm-recover-browser-preparation').length, 1);
          assert.equal(state.turnStatus.cause, 'preparation');
          await page.getByText('正在重新准备…', { exact: true }).waitFor();
          assert.equal(await page.getByLabel('生成中').count(), 1);
          const checks = await page.evaluate(() => window.preparation.authorityChecks());
          if (name === 'queued') {
            assert.ok(checks.some(c => c.context?.clientMessageId === 'm-recover-browser-preparation'),
              'queued expiry must request exact-child authority, not just silently drop the timer');
          } else {
            assert.equal(checks.filter(c => c.context?.clientMessageId === 'm-recover-browser-preparation').length, 0,
              `${name}: ACK must actually retire the old timer`);
          }
        }
        for (const name of ['stopped', 'new-active']) {
          const state = await pages[name].evaluate(() => window.preparation.state());
          assert.equal(state.sending, name === 'new-active');
          assert.equal(state.rows.filter(m => m._errorCode).length, 0);
          assert.equal((await pages[name].evaluate(() => window.preparation.authorityChecks()))
            .filter(c => c.at >= startedAt + 10_000 && c.context?.clientMessageId === 'm-recover-browser-preparation').length, 0);
        }
        await pages['readmit-success'].evaluate(() => window.preparation.success());
        await pages['readmit-success'].getByText('准备后成功完成', { exact: true }).waitFor();
        for (const name of ['readmit-exhausted', 'queued']) {
          await pages[name].evaluate(() => window.preparation.exhausted());
          await pages[name].getByText('环境准备多次超时', { exact: true }).waitFor();
          assert.equal((await pages[name].evaluate(() => window.preparation.state())).rows.filter(m => m._errorCode).length, 1);
        }
        for (const name of ['readmit-success', 'readmit-exhausted', 'queued']) {
          await pages[name].evaluate(() => window.preparation.ack());
          assert.equal((await pages[name].evaluate(() => window.preparation.state())).sending, false, `${name}: late ACK cannot resurrect terminal`);
          assert.equal(await pages[name].getByLabel('生成中').count(), 0);
        }
        t.diagnostic(`${width}px: real elapsed ${Date.now() - startedAt}ms; 2 readmitted, 1 queued, Stop/new-active and terminal fences verified`);
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    })));
  } finally { await browser.close(); }
});
