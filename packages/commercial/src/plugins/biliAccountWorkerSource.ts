/**
 * Reviewed Bilibili account worker (OCV5-402). Read-only.
 *
 * Same frame protocol, broker relay and storage filtering as the reviewed Weibo worker
 * (weiboWorkerSource.ts). No Playwright request client and no Node-side cookie replay:
 * actions open https://www.bilibili.com/robots.txt (light, same site) and call the read-only
 * api.bilibili.com endpoints with `fetch(..., { credentials: 'include' })` inside that page,
 * the way the Weibo worker calls its own ajax endpoints. Login screenshots the official QR code
 * on passport.bilibili.com and proves the session with the nav endpoint before returning state.
 * Risk-control answers (-352 / -412 / -799, HTTP 412) stop immediately; no retry, no bypass.
 */
export const BILI_ACCOUNT_WORKER_SOURCE = String.raw`
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';

const require = createRequire(import.meta.url);
const playwrightMcpVersion = require('/usr/local/lib/node_modules/@playwright/mcp/package.json').version;
const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BROKER_SOCKET = '/run/oc-browser-broker/tls.sock';
const MAX_INPUT = 512 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_STATE_JSON = 256 * 1024;
const MAX_API_TEXT = 900 * 1024;
const QR_REFRESH_MS = 8_000;
const ACTION_ORIGINS = new Set([
  'https://www.bilibili.com', 'https://api.bilibili.com',
  'https://aisubtitle.hdslb.com', 'https://i0.hdslb.com'
]);
const SUBTITLE_HOSTS = new Set(['aisubtitle.hdslb.com', 'i0.hdslb.com']);
const RISK_CODES = new Set([-352, -412, -799]);
const AUTH_COOKIES = ['SESSDATA', 'DedeUserID'];
const FAILURE_CODES = new Set(['WORKER_FAILED', 'LOGIN_EXPIRED', 'UPSTREAM_CHALLENGE', 'LOGIN_STATE_UNSUPPORTED']);
let terminal = false;

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_OUTPUT) throw new Error('output');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function writeFrame(value) { process.stdout.write(encodeFrame(value)); }
async function writeTerminalAndExit(value) {
  terminal = true;
  const output = encodeFrame(value);
  await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
  process.exit(0);
}
function failureCode(reason) {
  const message = reason && typeof reason === 'object' && reason.message != null ? String(reason.message) : String(reason || '');
  return FAILURE_CODES.has(message) ? message : 'WORKER_FAILED';
}
function emitStep(event) {
  try { process.stderr.write(JSON.stringify(Object.assign({ src: 'bili-account-worker', t: Date.now() }, event)) + '\n'); } catch {}
}
async function fail(reason) {
  if (terminal) return;
  await writeTerminalAndExit({ event: 'failed', code: failureCode(reason) });
}
async function readFrame() {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let expected = null;
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.off('error', onError);
      process.stdin.pause();
    };
    const onError = () => { cleanup(); reject(new Error('input')); };
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_INPUT + 4) { cleanup(); reject(new Error('input')); return; }
      if (expected === null && data.length >= 4) {
        expected = data.readUInt32BE(0);
        if (expected < 2 || expected > MAX_INPUT) { cleanup(); reject(new Error('frame')); return; }
      }
      if (expected === null || data.length < expected + 4) return;
      if (data.length !== expected + 4) { cleanup(); reject(new Error('frame')); return; }
      cleanup();
      try {
        const value = JSON.parse(data.subarray(4).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('frame');
        resolve(value);
      } catch { reject(new Error('frame')); }
    };
    process.stdin.on('data', onData);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}
function brokerFrame(token, host, port) {
  const body = Buffer.from(JSON.stringify({ token, host, port }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
async function startRelay(token, allowedHosts) {
  const server = createServer((client) => {
    client.setTimeout(15_000, () => client.destroy());
    let pending = Buffer.alloc(0);
    const readConnect = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 8192) return client.destroy();
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', readConnect);
      const first = (pending.subarray(0, end).toString('ascii').split('\r\n')[0] || '');
      const match = /^CONNECT ([a-z0-9.-]+):(443) HTTP\/1\.[01]$/.exec(first);
      if (!match || !allowedHosts.has(match[1])) return client.destroy();
      const tunnel = createConnection(BROKER_SOCKET);
      let acknowledged = false;
      tunnel.once('connect', () => tunnel.write(brokerFrame(token, match[1], 443)));
      tunnel.once('data', (ack) => {
        if (ack.length < 1 || ack[0] !== 0) return client.destroy();
        acknowledged = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const remainder = pending.subarray(end + 4);
        if (remainder.length) tunnel.write(remainder);
        if (ack.length > 1) client.write(ack.subarray(1));
        client.pipe(tunnel).pipe(client);
      });
      const close = () => { client.destroy(); tunnel.destroy(); };
      tunnel.once('error', close);
      tunnel.once('close', () => acknowledged ? client.end() : close());
      client.once('error', close);
      client.once('close', () => tunnel.destroy());
    };
    client.on('data', readConnect);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('relay');
  return {
    proxy: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
function filteredState(state, domains, origins) {
  const domainSet = new Set(domains);
  const originSet = new Set(origins);
  const normalizeOrigin = (raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
      return 'https://' + url.hostname.toLowerCase() + ':' + (url.port || '443');
    } catch { return null; }
  };
  const cookies = [];
  const cookieKeys = new Set();
  for (const cookie of Array.isArray(state && state.cookies) ? state.cookies : []) {
    const domain = String(cookie && cookie.domain || '');
    const canonicalDomain = domain.replace(/^\./, '').toLowerCase();
    const key = canonicalDomain + '\0' + String(cookie && cookie.path || '') + '\0' + String(cookie && cookie.name || '');
    if (!cookie || cookie.secure !== true || !domainSet.has(canonicalDomain) || cookieKeys.has(key)) continue;
    cookieKeys.add(key);
    cookies.push({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      expires: cookie.expires, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite
    });
    if (cookies.length >= 200) break;
  }
  const filteredOrigins = [];
  const seenOrigins = new Set();
  for (const origin of Array.isArray(state && state.origins) ? state.origins : []) {
    const canonical = normalizeOrigin(origin && origin.origin);
    if (!canonical || !originSet.has(canonical) || seenOrigins.has(canonical)) continue;
    seenOrigins.add(canonical);
    filteredOrigins.push({ origin: canonical, localStorage: [] });
  }
  return { cookies, origins: filteredOrigins };
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function cleanText(value, max) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max); }
function nonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}
function httpsUrl(raw) {
  let value = String(raw || '');
  if (value.startsWith('//')) value = 'https:' + value;
  return /^https:\/\/[^\s]{1,500}$/.test(value) ? value.slice(0, 512) : undefined;
}
function bvidUrl(bvid) { return 'https://www.bilibili.com/video/' + bvid; }
function validBvid(value) { return typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value) ? value : undefined; }
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

async function openSitePage(context) {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return page;
}
/** One same-site read through the page (cookies stay inside the browser). */
async function apiGet(page, url) {
  const response = await page.evaluate(async (input) => {
    try {
      const res = await fetch(input.url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } });
      const text = await res.text();
      return { status: res.status, text: text.length > input.max ? '' : text, tooLarge: text.length > input.max };
    } catch (error) { return { status: 0, text: '', tooLarge: false }; }
  }, { url, max: MAX_API_TEXT });
  if (response.status === 412) throw new Error('UPSTREAM_CHALLENGE');
  if (response.status < 200 || response.status >= 300 || response.tooLarge) throw new Error('WORKER_FAILED');
  let json;
  try { json = JSON.parse(response.text); } catch { throw new Error('WORKER_FAILED'); }
  return json;
}
function checkCode(json) {
  const code = json && typeof json.code === 'number' ? json.code : 0;
  if (code === -101) throw new Error('LOGIN_EXPIRED');
  if (RISK_CODES.has(code)) throw new Error('UPSTREAM_CHALLENGE');
  if (code !== 0) throw new Error('WORKER_FAILED');
  return json.data;
}
async function requireSelf(page) {
  const data = checkCode(await apiGet(page, 'https://api.bilibili.com/x/web-interface/nav'));
  const mid = nonNegInt(data && data.mid);
  if (!data || data.isLogin !== true || !mid) throw new Error('LOGIN_EXPIRED');
  return { data, mid };
}

async function actionRead(page, input) {
  const params = input.params || {};
  const self = await requireSelf(page);
  if (input.actionId === 'me') {
    const nav = self.data;
    return compact({
      mid: self.mid,
      uname: cleanText(nav.uname, 128),
      level: nonNegInt(nav.level_info && nav.level_info.current_level),
      vip: nav.vipStatus === 1
    });
  }
  if (input.actionId === 'favorite_folders') {
    const data = checkCode(await apiGet(page, 'https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + self.mid));
    const list = Array.isArray(data && data.list) ? data.list : [];
    return {
      folders: list.slice(0, 100).map((f) => compact({ id: nonNegInt(f.id) || 0, title: cleanText(f.title, 300), count: nonNegInt(f.media_count) }))
        .filter((f) => f.id > 0)
    };
  }
  if (input.actionId === 'favorite_items') {
    const pageNo = Math.max(1, Math.min(50, Number(params.page || 1)));
    const pageSize = Math.max(1, Math.min(20, Number(params.pageSize || 20)));
    const query = new URLSearchParams({ media_id: String(params.folderId), pn: String(pageNo), ps: String(pageSize), platform: 'web' });
    const data = checkCode(await apiGet(page, 'https://api.bilibili.com/x/v3/fav/resource/list?' + query.toString()));
    const medias = Array.isArray(data && data.medias) ? data.medias : [];
    const items = [];
    for (const m of medias.slice(0, 20)) {
      const bvid = validBvid(m.bvid || m.bv_id);
      if (!bvid) continue;
      items.push(compact({
        bvid, title: cleanText(m.title, 300), cover: httpsUrl(m.cover),
        author: cleanText(m.upper && m.upper.name, 128) || undefined,
        play: nonNegInt(m.cnt_info && m.cnt_info.play), danmaku: nonNegInt(m.cnt_info && m.cnt_info.danmaku),
        durationSec: nonNegInt(m.duration), favAt: nonNegInt(m.fav_time), url: bvidUrl(bvid)
      }));
    }
    return compact({
      title: cleanText(data && data.info && data.info.title, 300) || undefined,
      total: nonNegInt(data && data.info && data.info.media_count),
      hasMore: data && data.has_more === true,
      items
    });
  }
  if (input.actionId === 'history') {
    const pageSize = Math.max(1, Math.min(30, Number(params.pageSize || 20)));
    const data = checkCode(await apiGet(page, 'https://api.bilibili.com/x/web-interface/history/cursor?type=archive&ps=' + pageSize));
    const list = Array.isArray(data && data.list) ? data.list : [];
    const items = [];
    for (const it of list.slice(0, 30)) {
      const bvid = validBvid(it.history && it.history.bvid);
      if (!bvid) continue;
      const progress = Number(it.progress);
      items.push(compact({
        bvid, title: cleanText(it.title, 300), cover: httpsUrl(it.cover),
        author: cleanText(it.author_name, 128) || undefined,
        durationSec: nonNegInt(it.duration),
        progressSec: Number.isFinite(progress) && progress >= -1 ? Math.round(progress) : undefined,
        viewedAt: nonNegInt(it.view_at), url: bvidUrl(bvid)
      }));
    }
    return { items };
  }
  if (input.actionId === 'subtitle') {
    const bvid = validBvid(params.bvid);
    if (!bvid) throw new Error('WORKER_FAILED');
    const pageNo = Math.max(1, Math.min(500, Number(params.page || 1)));
    const pages = checkCode(await apiGet(page, 'https://api.bilibili.com/x/player/pagelist?bvid=' + bvid));
    const part = Array.isArray(pages) ? pages[pageNo - 1] : undefined;
    const cid = nonNegInt(part && part.cid);
    if (!cid) throw new Error('WORKER_FAILED');
    const player = checkCode(await apiGet(page, 'https://api.bilibili.com/x/player/v2?' + new URLSearchParams({ bvid, cid: String(cid) }).toString()));
    const subs = Array.isArray(player && player.subtitle && player.subtitle.subtitles) ? player.subtitle.subtitles : [];
    const available = subs.slice(0, 20).map((s) => compact({ lang: cleanText(s.lan, 32), label: cleanText(s.lan_doc, 64) || undefined })).filter((s) => s.lang);
    if (subs.length === 0) return { bvid, cid, available: [], lines: [], truncated: false };
    const wanted = typeof params.lang === 'string' ? params.lang : '';
    const chosen = subs.find((s) => wanted && String(s.lan || '').startsWith(wanted)) || subs[0];
    const subtitleUrl = httpsUrl(chosen.subtitle_url);
    if (!subtitleUrl || !SUBTITLE_HOSTS.has(new URL(subtitleUrl).hostname)) throw new Error('WORKER_FAILED');
    const body = await apiGet(page, subtitleUrl);
    const rows = Array.isArray(body && body.body) ? body.body : [];
    const lines = [];
    for (const row of rows) {
      const from = Number(row.from);
      const text = cleanText(row.content, 300);
      if (!Number.isFinite(from) || from < 0 || !text) continue;
      const to = Number(row.to);
      lines.push(compact({ from: Math.round(from * 100) / 100, to: Number.isFinite(to) && to >= 0 ? Math.round(to * 100) / 100 : undefined, text }));
      if (lines.length >= 600) break;
    }
    return { bvid, cid, lang: cleanText(chosen.lan, 32), available, lines, truncated: rows.length > lines.length };
  }
  throw new Error('WORKER_FAILED');
}

async function finishAction(context, input, result) {
  const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_JSON) throw new Error('state');
  await writeTerminalAndExit({ event: 'completed', result, storageState: state });
}
function browserArgs() {
  return [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-breakpad', '--disable-component-update', '--disable-default-apps',
    '--disable-domain-reliability', '--disable-extensions',
    '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate',
    '--disable-http2', '--disable-quic', '--disable-sync', '--metrics-recording-only', '--no-first-run',
    '--no-default-browser-check', '--no-pings', '--password-store=basic', '--use-mock-keychain',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp'
  ];
}
async function secureContext(browser, storageState, allowed, methods) {
  const context = await browser.newContext({
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block', storageState
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    let origin;
    try { origin = new URL(request.url()).origin; } catch { await route.abort(); return; }
    if (!allowed.has(origin) || !methods.includes(request.method()) || ['websocket', 'eventsource'].includes(request.resourceType())) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  return context;
}
async function runAction(input, relay) {
  const started = Date.now();
  emitStep({ step: 'action.start', actionId: input.actionId });
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, input.storageState, ACTION_ORIGINS, ['GET']);
    const page = await openSitePage(context);
    try {
      const result = await actionRead(page, input);
      emitStep({ step: 'action.done', actionId: input.actionId, ok: true, ms: Date.now() - started });
      await finishAction(context, input, result);
    } catch (error) {
      emitStep({ step: 'action.failed', actionId: input.actionId, ok: false, ms: Date.now() - started, code: failureCode(error) });
      throw error;
    }
  } finally { await browser.close(); }
}

const QR_SELECTOR = 'img[src^="data:image/png"]';
async function qrElement(page) {
  const images = page.locator(QR_SELECTOR);
  const total = Math.min(await images.count(), 10);
  for (let index = 0; index < total; index += 1) {
    const image = images.nth(index);
    const box = await image.boundingBox().catch(() => null);
    if (box && box.width >= 100 && box.width <= 400 && Math.abs(box.width - box.height) < 8) return image;
  }
  return null;
}
async function captureQr(page) {
  let image = null;
  for (let attempt = 0; attempt < 80 && !image; attempt += 1) {
    image = await qrElement(page);
    if (!image) await page.waitForTimeout(250);
  }
  if (!image) throw new Error('qr');
  const png = await image.screenshot({ type: 'png', animations: 'disabled' });
  if (png.length < 100 || png.length > 512 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('qr');
  return png;
}
async function qrExpired(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return /二维码已失效|已过期|点击刷新/.test(text);
}
async function authCookieDigest(context) {
  const rows = (await context.cookies())
    .filter((cookie) => AUTH_COOKIES.includes(cookie.name) && /(?:^|\.)bilibili\.com$/.test(cookie.domain.replace(/^\./, '')))
    .map((cookie) => cookie.domain + '\0' + cookie.name + '\0' + cookie.value).sort();
  return digest(rows);
}
async function proveSelf(context) {
  const page = await openSitePage(context).catch(() => null);
  if (!page) return null;
  try { return (await requireSelf(page)).mid; }
  catch { return null; }
  finally { await page.close().catch(() => {}); }
}
async function runLogin(input, relay) {
  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, { cookies: [], origins: [] }, allowed, ['GET', 'POST']);
    const login = await context.newPage();
    await login.goto('https://passport.bilibili.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    let png = await captureQr(login);
    let qrHash = digest(png.toString('base64'));
    writeFrame({ event: 'qr', png: png.toString('base64') });
    emitStep({ step: 'login.qr' });
    const initialCookies = await authCookieDigest(context);
    let nextQr = Date.now() + QR_REFRESH_MS;
    let nextProbe = 0;
    while (Date.now() < input.deadlineMs) {
      if (!login.isClosed() && /passport\.bilibili\.com/.test(login.url())) {
        if (await qrExpired(login)) {
          emitStep({ step: 'login.qr_expired' });
          await login.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
          nextQr = 0;
        }
        if (Date.now() >= nextQr) {
          nextQr = Date.now() + QR_REFRESH_MS;
          const fresh = await captureQr(login).catch(() => null);
          if (fresh) {
            const freshHash = digest(fresh.toString('base64'));
            if (freshHash !== qrHash) {
              qrHash = freshHash;
              png = fresh;
              writeFrame({ event: 'qr', png: png.toString('base64') });
            }
          }
        }
      }
      const signal = (await authCookieDigest(context)) !== initialCookies || login.isClosed() || !/passport\.bilibili\.com/.test(login.url());
      if (signal && Date.now() >= nextProbe) {
        nextProbe = Date.now() + 5_000;
        const mid = await proveSelf(context);
        if (mid) {
          const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
          // 平台只保存带 Secure 的 cookie：登录凭据被过滤掉就明确失败，绝不存一份无法使用的登录状态。
          if (!state.cookies.some((cookie) => cookie.name === 'SESSDATA')) {
            emitStep({ step: 'login.state_unsupported' });
            await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_STATE_UNSUPPORTED' });
          }
          emitStep({ step: 'login.authenticated' });
          await writeTerminalAndExit({ event: 'authenticated', storageState: state });
        }
      }
      await login.waitForTimeout(800).catch(() => {});
    }
    await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
  } finally { await browser.close(); }
}
try {
  const input = await readFrame();
  const required = input.mode === 'action'
    ? ['actionId', 'cookieDomains', 'deadlineMs', 'mode', 'params', 'stateOrigins', 'storageState', 'token']
    : ['allowedOrigins', 'cookieDomains', 'deadlineMs', 'mode', 'stateOrigins', 'token'];
  if (Object.keys(input).sort().join('\0') !== required.sort().join('\0')) throw new Error('input');
  if (!['action', 'login'].includes(input.mode) || typeof input.token !== 'string' || !Array.isArray(input.cookieDomains) || !Array.isArray(input.stateOrigins)) throw new Error('input');
  const remaining = Number(input.deadlineMs) - Date.now();
  if (!Number.isFinite(remaining) || remaining < 1_000 || remaining > 15 * 60_000) throw new Error('deadline');
  writeFrame({ event: 'ready', runtime: 'bili-account-worker-v1', playwrightMcpVersion });
  const hosts = new Set(input.mode === 'action'
    ? Array.from(ACTION_ORIGINS).map((origin) => new URL(origin).hostname)
    : input.allowedOrigins.map((origin) => new URL(origin).hostname));
  const relay = await startRelay(input.token, hosts);
  const timer = setTimeout(() => process.exit(124), remaining + 2_000);
  try {
    if (input.mode === 'action') await runAction(input, relay);
    else await runLogin(input, relay);
  } finally {
    clearTimeout(timer);
    await relay.close();
  }
  if (!terminal) await fail();
} catch (error) { await fail(error); }
`
