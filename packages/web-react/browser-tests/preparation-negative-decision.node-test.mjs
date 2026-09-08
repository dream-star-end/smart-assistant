import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild'), { chromium } = require('playwright-core');

test('OCV5-174 R1: actual bridge no-job frames close preparation and allow one exact manual retry', { timeout: 180000 }, async t => {
  const fixturePath = process.env.OC_PREPARATION_NEGATIVE_FRAMES || fileURLToPath(new URL('./fixtures/preparationNegativeFrames.json', import.meta.url));
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const frames = fixture.frames;
  assert.equal(frames[0].type, 'error');
  assert.equal(frames[0].code, 'DISPATCH_ENRICHMENT_TIMEOUT');
  assert.equal(frames[1].type, 'sys.recovery_decision');
  assert.equal(frames[1].scheduled, false);
  const bundle = process.env.OC_PREPARATION_BROWSER_BUNDLE
    ? { outputFiles: [{ text: await readFile(process.env.OC_PREPARATION_BROWSER_BUNDLE, 'utf8') }] }
    : await build({ entryPoints: [fileURLToPath(new URL('./preparation-recovery-harness.tsx', import.meta.url))],
      bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      alias: { 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)) },
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}' },
      plugins: process.env.OC_PREPARATION_NEGATIVE_RED === '1' ? [{ name: 'negative-decision-order-counterfactual', setup(b) {
        b.onLoad({ filter: /chat[\/]socket\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const target = 'sess._automaticRecoveryDecisions = { ...(sess._automaticRecoveryDecisions ?? {}), [source.id]: true };';
          assert.ok(source.includes(target), 'negative control must match the new early-decision fence');
          return { contents: source.replace(target, '/* negative control: discard early no-job decision */'), loader: 'ts' };
        });
      } }] : [],
      logLevel: 'error' });
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
  try {
    for (const width of [1280, 390]) await t.test(`${width}px / ordered and decision-first`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        for (const decisionFirst of [false, true]) {
          await page.evaluate(() => window.preparation.startSource());
          const before = await page.evaluate(() => window.preparation.state());
          const exactFrames = frames.map(frame => ({ ...frame, peer: { id: 's-browser-preparation', kind: 'dm' },
            ...(frame.type === 'error' ? { clientMessageId: before.source } : { sourceClientMessageId: before.source }) }));
          const ordered = decisionFirst ? [...exactFrames].reverse() : exactFrames;
          const after = await page.evaluate(raw => {
            // Raw master JSON enters exactly the public WS onmessage surface.
            window.preparation.rawFrames(raw);
            return window.preparation.state();
          }, ordered);
          assert.equal(after.sending, false, 'must stop synchronously on the negative decision/error, not after a 20s timer');
          assert.equal(after.rows.filter(m => m._errorCode).length, 1);
          assert.equal(after.rows.filter(m => m._automaticRecovery).length, 0);
          await page.getByText('环境准备超时', { exact: true }).waitFor();
          assert.equal(await page.getByText('正在重新准备…', { exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1);
          await page.evaluate(raw => window.preparation.rawFrames(raw), [...ordered, ...ordered]);
          assert.equal((await page.evaluate(() => window.preparation.state())).rows.filter(m => m._errorCode).length, 1);
          const prior = await page.evaluate(() => window.preparation.sent().filter(f => f.type === 'inbound.message').length);
          await page.getByRole('button', { name: '重试', exact: true }).click();
          await page.waitForFunction(n => window.preparation.sent().filter(f => f.type === 'inbound.message').length === n + 1, prior);
          const sent = await page.evaluate(() => window.preparation.sent().filter(f => f.type === 'inbound.message').at(-1));
          assert.equal(typeof sent.clientMessageId, 'string', 'manual Retry must actually send an exact identity');
          assert.notEqual(sent.clientMessageId, before.source, 'terminal source gets a new exact manual-send identity');
          assert.equal(sent.content.text, '精确原始请求');
          assert.equal(sent.content.recovery, undefined, 'manual Retry is not a fabricated automatic child');
        }
        // An unrelated no-job decision must not release this source, and a
        // negative/error pair arriving after a real Stop must stay cancelled.
        await page.evaluate(() => window.preparation.startSource());
        const stoppedSource = (await page.evaluate(() => window.preparation.state())).source;
        const exact = frames.map(frame => ({ ...frame, peer: { id: 's-browser-preparation', kind: 'dm' },
          ...(frame.type === 'error' ? { clientMessageId: stoppedSource } : { sourceClientMessageId: stoppedSource }) }));
        await page.evaluate(raw => window.preparation.rawFrames(raw), [exact[0], { ...exact[1], sourceClientMessageId: 'm-unrelated-source' }]);
        assert.equal((await page.evaluate(() => window.preparation.state())).sending, true);
        await page.getByText('正在重新准备…', { exact: true }).waitFor();
        await page.getByRole('button', { name: '停止', exact: true }).click();
        await page.evaluate(raw => window.preparation.rawFrames(raw), [exact[1], exact[0]]);
        const stopped = await page.evaluate(() => window.preparation.state());
        assert.equal(stopped.sending, false);
        assert.equal(stopped.rows.filter(m => m._errorCode).length, 0);
        await page.getByLabel('生成中').waitFor({ state: 'detached' });
        await page.evaluate(() => window.preparation.startSource());
        await page.evaluate(raw => window.preparation.rawFrames(raw), [exact[1]]);
        assert.equal((await page.evaluate(() => window.preparation.state())).sending, true, 'old source decision cannot release the new source');
        const queueSource = (await page.evaluate(() => window.preparation.state())).source;
        const queueFrames = frames.map(frame => ({ ...frame, peer: { id: 's-browser-preparation', kind: 'dm' },
          ...(frame.type === 'error' ? { clientMessageId: queueSource } : { sourceClientMessageId: queueSource }) }));
        await page.evaluate(raw => { window.preparation.rawFrames([raw[0]]); window.preparation.queueHuman(); window.preparation.rawFrames([raw[1]]); }, queueFrames);
        await page.waitForFunction(() => window.preparation.sent().some(f => f.type === 'inbound.message' && f.content.text === '排队的下一条请求'));
        const queued = await page.evaluate(() => window.preparation.sent().findLast(f => f.type === 'inbound.message' && f.content.text === '排队的下一条请求'));
        await page.evaluate(raw => window.preparation.rawFrames([raw]), queueFrames[1]);
        const queueState = await page.evaluate(() => window.preparation.state());
        assert.equal(queueState.sending, true);
        assert.equal(queueState.rows.filter(m => m._clientMessageId === queued.clientMessageId && m._errorCode).length, 0);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
