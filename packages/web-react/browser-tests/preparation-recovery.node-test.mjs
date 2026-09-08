import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild'), { chromium } = require('playwright-core');

test('OCV5-174: real timeline preparation, reload/two tabs, success/exhausted and Stop', { timeout: 120000 }, async t => {
  const bundle = process.env.OC_PREPARATION_BROWSER_BUNDLE
    ? { outputFiles: [{ text: await readFile(process.env.OC_PREPARATION_BROWSER_BUNDLE, 'utf8') }] }
    : await build({ entryPoints: [fileURLToPath(new URL('./preparation-recovery-harness.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    alias: { 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)) },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
    plugins: process.env.OC_PREPARATION_BROWSER_RED === '1' ? [{ name: 'preparation-negative-control', setup(b) {
      b.onLoad({ filter: /TurnActivity\.tsx$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replace('retry.cause === "preparation"', 'false'), loader: 'tsx' }));
    } }] : [], logLevel: 'error' });
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [1280, 390]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const errors = [];
      const load = async page => {
        page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
        await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
      };
      const active = async page => {
        await page.getByText('正在重新准备…', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('生成中').count(), 1);
        assert.equal(await page.getByText(/模型繁忙|1\/10|本轮环境准备超时/).count(), 0);
      };
      try {
        const a = await context.newPage(); await load(a);
        await a.evaluate(() => window.preparation.begin()); await active(a);
        const pending = await a.evaluate(() => window.preparation.state());
        const b = await context.newPage(); await load(b);
        await b.evaluate(p => window.preparation.restore({ ...p, unified: true }), pending); await active(b);
        assert.equal((await b.evaluate(() => window.preparation.state())).rows.filter(m => m._automaticRecovery).length, 0);
        // Reload replaces the entire JS/Socket instance, then authoritative REST restores it.
        await load(a); await a.evaluate(p => window.preparation.restore(p), pending); await active(a);
        for (const page of [a, b]) { await page.evaluate(() => { window.preparation.ack(); window.preparation.ack(); }); await active(page); }
        await a.evaluate(() => window.preparation.success());
        await a.getByText('准备后成功完成', { exact: true }).waitFor();
        await a.waitForFunction(() => !window.preparation.state().sending);
        await a.evaluate(() => window.preparation.ack());
        assert.equal(await a.getByText('正在重新准备…', { exact: true }).count(), 0);
        await b.evaluate(() => window.preparation.exhausted());
        await b.getByText('环境准备多次超时', { exact: true }).waitFor();
        assert.equal(await b.getByText('环境准备多次超时', { exact: true }).count(), 1);
        await b.evaluate(() => window.preparation.ack());
        assert.equal((await b.evaluate(() => window.preparation.state())).sending, false);
        await a.evaluate(() => window.preparation.begin()); await active(a);
        await a.getByRole('button', { name: '停止', exact: true }).click();
        await a.evaluate(() => window.preparation.ack());
        assert.equal((await a.evaluate(() => window.preparation.state())).sending, false);
        await a.getByLabel('生成中').waitFor({ state: 'detached' });
        assert.equal(await a.getByLabel('生成中').count(), 0);
        await a.evaluate(() => window.preparation.sourceError());
        assert.equal(await a.getByText(/本轮环境准备超时/).count(), 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
