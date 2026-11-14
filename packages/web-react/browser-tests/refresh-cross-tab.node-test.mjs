import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(label, fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error(label);
}

// Only the upstream auth transport is synthetic. Both tabs execute the production lock,
// real HTTP, real shared HttpOnly cookies, and browser reload; no fake BroadcastChannel.
async function scenario(browser, transport, disabled) {
  let mutations = 0;
  const built = await build({ stdin: { contents: `
    import { withCrossTabRefreshLock } from '../src/lib/refreshCrossTabLock.ts';
    window.refresh = () => {
      window.started = true;
      window.finished = withCrossTabRefreshLock(async () => {
        const response = await fetch('/api/auth/refresh', { method: 'POST' });
        return response.status;
      });
    };`, resolveDir: here }, bundle: true, write: false, format: 'iife',
    plugins: disabled ? [{ name: 'ablate-refresh-lock', setup(b) {
      b.onLoad({ filter: /refreshCrossTabLock\.ts$/ }, ({ path }) => {
        const original = readFileSync(path, 'utf8');
        const anchor = 'export async function withCrossTabRefreshLock<T>(run: () => Promise<T>): Promise<T> {';
        assert.equal(original.split(anchor).length - 1, 1);
        mutations++;
        return { contents: original.replace(anchor, `${anchor}\n return run();`), loader: 'ts' };
      });
    } }] : [], logLevel: 'silent' });
  assert.equal(mutations, disabled ? 1 : 0);
  let current = 'initial';
  let requests = 0;
  let active = 0;
  let overlap = false;
  let releaseFirst;
  const first = new Promise(r => { releaseFirst = r; });
  const received = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(built.outputFiles[0].text); return; }
    if (req.url === '/api/auth/refresh') {
      const ordinal = ++requests;
      active++;
      if (active > 1) overlap = true;
      const cookie = /(?:^|;\s*)oc_rt=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      received.push(cookie);
      if (ordinal === 1) await first;
      if (cookie !== current) { res.writeHead(401); res.end('stale cookie'); }
      else { current = `token-${ordinal}`; res.setHeader('set-cookie', `oc_rt=${current}; Path=/; HttpOnly; SameSite=Lax`); res.end('ok'); }
      active--;
      return;
    }
    if (req.url === '/api/auth/me') {
      res.writeHead((req.headers.cookie ?? '').includes(`oc_rt=${current}`) ? 200 : 401);
      res.end('synthetic-user'); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Refresh proof</title><script src="/app.js"></script>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  try {
    if (transport === 'broadcast') await context.addInitScript(() =>
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }));
    await context.addCookies([{ name: 'oc_rt', value: 'initial', url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const a = await context.newPage();
    const b = await context.newPage();
    await Promise.all([a.goto(origin), b.goto(origin)]);
    if (transport === 'locks') assert.equal(await a.evaluate(() => typeof navigator.locks?.request), 'function');
    else assert.equal(await a.evaluate(() => typeof BroadcastChannel), 'function');
    await a.evaluate(() => window.refresh());
    await until('first refresh reached real HTTP', () => requests === 1);
    await b.evaluate(() => window.refresh());
    assert.equal(await b.evaluate(() => window.started), true);
    if (disabled) {
      await until('red control reaches concurrent HTTP', () => requests === 2);
      assert.equal(overlap, true, 'negative control must expose the removed serialization');
    } else {
      // Exceed both production BC claim windows while the first HTTP request is held.
      await sleep(350);
      assert.equal(requests, 1, 'second tab must not send an overlapping refresh');
      assert.equal(overlap, false);
    }
    releaseFirst();
    const statuses = await Promise.all([a.evaluate(() => window.finished), b.evaluate(() => window.finished)]);
    if (disabled) {
      assert.deepEqual(statuses.toSorted(), [200, 401], 'without the lock one real request uses a stale cookie');
    } else {
      assert.deepEqual(statuses, [200, 200]);
      assert.deepEqual(received, ['initial', 'token-1']);
      await Promise.all([a.reload(), b.reload()]);
      for (const page of [a, b]) assert.equal(await page.evaluate(async () => (await fetch('/api/auth/me')).status), 200);
    }
  } finally {
    releaseFirst();
    await context.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

test('OCV5-622 actual two browser tabs serialize refresh and preserve cookies after reload', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const transport of ['locks', 'broadcast']) {
      await scenario(browser, transport, false);
      await scenario(browser, transport, true);
    }
  } finally { await browser.close(); }
});
