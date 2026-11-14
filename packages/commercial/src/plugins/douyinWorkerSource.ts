/**
 * Reviewed Douyin worker (OCV5-553). This version: QR login + the read-only `me` action.
 *
 * Same frame protocol, broker relay and storage filtering as the reviewed Bilibili account worker
 * (biliAccountWorkerSource.ts). No Playwright request client and no Node-side cookie replay: the
 * action opens https://creator.douyin.com/robots.txt (light, same origin) and reads the creator
 * platform's own user-info endpoint with `fetch(..., { credentials: 'include' })` inside that page.
 * Login screenshots the official QR code on creator.douyin.com (`img[aria-label="二维码"]`) and
 * proves the session with the user-info endpoint before returning state.
 *
 * Stops immediately, never retries and never tries to get around:
 * - a visible captcha / slider or HTTP 403 / 429 → UPSTREAM_CHALLENGE;
 * - Douyin asking the account owner to verify identity (SMS etc.) after the scan →
 *   VERIFICATION_REQUIRED (the user finishes it on the phone and scans again).
 */
export const DOUYIN_WORKER_SOURCE = String.raw`
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
const MAX_API_TEXT = 256 * 1024;
const QR_REFRESH_MS = 8_000;
// 2026-10-21 侦察：登录组件懒加载，二维码在打开页面后约 55 秒才出现（宿主负载高时）。
const QR_WAIT_MS = 150_000;
const SITE = 'https://creator.douyin.com';
const ACTION_ORIGINS = new Set([SITE]);
const USER_INFO_URL = SITE + '/web/api/media/user/info/';
const ACCOUNT_INFO_URL = SITE + '/passport/web/account/info/';
// 登录凭据 cookie；平台只保存 Secure cookie，过滤后一个都不剩就明确失败。
const SESSION_COOKIES = ['sessionid', 'sessionid_ss'];
const AUTH_COOKIES = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt'];
const CHALLENGE_TEXT = /请完成(下列|安全)验证|拖动(下方)?滑块|按住左边按钮|向右滑动/;
const VERIFICATION_TEXT = /身份验证|短信验证|接收短信|验证码已发送/;
const QR_EXPIRED_TEXT = /二维码已失效|二维码失效|二维码已过期/;
const FAILURE_CODES = new Set(['WORKER_FAILED', 'LOGIN_EXPIRED', 'UPSTREAM_CHALLENGE', 'LOGIN_STATE_UNSUPPORTED', 'VERIFICATION_REQUIRED']);
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
  try { process.stderr.write(JSON.stringify(Object.assign({ src: 'douyin-worker', t: Date.now() }, event)) + '\n'); } catch {}
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
function digits(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value == null ? '' : value);
  return /^[0-9]{1,32}$/.test(text) ? text : undefined;
}
function secUid(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined; }
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return out;
}

async function openSitePage(context) {
  const page = await context.newPage();
  await page.goto(SITE + '/robots.txt', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return page;
}
/** One same-origin read through the page (cookies stay inside the browser). */
async function apiGet(page, url) {
  const response = await page.evaluate(async (input) => {
    try {
      const res = await fetch(input.url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } });
      const text = await res.text();
      return { status: res.status, text: text.length > input.max ? '' : text, tooLarge: text.length > input.max };
    } catch (error) { return { status: 0, text: '', tooLarge: false }; }
  }, { url, max: MAX_API_TEXT });
  if (response.status === 403 || response.status === 429) throw new Error('UPSTREAM_CHALLENGE');
  if (response.status < 200 || response.status >= 300 || response.tooLarge) throw new Error('WORKER_FAILED');
  let json;
  try { json = JSON.parse(response.text); } catch { throw new Error('WORKER_FAILED'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('WORKER_FAILED');
  return json;
}
function identityFromUserInfo(user) {
  if (!user || typeof user !== 'object') return null;
  const nickname = cleanText(user.nickname, 128);
  const uid = digits(user.uid);
  const sec = secUid(user.sec_uid);
  if (!nickname || (!uid && !sec)) return null;
  return compact({
    nickname, uid, secUid: sec,
    followerCount: nonNegInt(user.follower_count),
    followingCount: nonNegInt(user.following_count),
    awemeCount: nonNegInt(user.aweme_count),
    totalFavorited: nonNegInt(user.total_favorited)
  });
}
function identityFromAccountInfo(data) {
  if (!data || typeof data !== 'object') return null;
  const nickname = cleanText(data.screen_name || data.name, 128);
  const uid = digits(data.user_id_str || data.user_id);
  const sec = secUid(data.sec_user_id);
  if (!nickname || (!uid && !sec)) return null;
  return compact({ nickname, uid, secUid: sec });
}
/**
 * 当前登录身份。未登录时（侦察实测）：user/info 返回 status_code 8「用户未登录」，
 * passport account/info 返回 message "error" + data.error_code 1「会话过期」。
 */
async function readSelf(page) {
  const info = await apiGet(page, USER_INFO_URL);
  if (info.status_code === 8) throw new Error('LOGIN_EXPIRED');
  if (info.status_code === 0) {
    const self = identityFromUserInfo(info.user);
    if (self) return self;
  }
  const account = await apiGet(page, ACCOUNT_INFO_URL);
  const data = account.data && typeof account.data === 'object' ? account.data : null;
  if (data && typeof data.captcha === 'string' && data.captcha) throw new Error('UPSTREAM_CHALLENGE');
  if (account.message === 'error' && data && data.error_code === 1) throw new Error('LOGIN_EXPIRED');
  if (account.message === 'success') {
    const self = identityFromAccountInfo(data);
    if (self) return self;
  }
  throw new Error('WORKER_FAILED');
}

async function actionRead(page, input) {
  const self = await readSelf(page);
  if (input.actionId === 'me') return self;
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

const QR_SELECTOR = 'img[aria-label="二维码"][src^="data:image/png"]';
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
async function pageText(page) {
  return (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).replace(/\s+/g, ' ');
}
/**
 * 页面上出现可见的风控 / 本人验证就停：返回失败码，绝不尝试处理。没有「静态文案」豁免：任何页面上只要
 * 出现这些提示词就停（宁可误停也不放过真实验证；Codex r1/r2 P1）。侦察时登录页文字不含这些词。
 */
function blockerCode(text) {
  if (VERIFICATION_TEXT.test(text)) return 'VERIFICATION_REQUIRED';
  if (CHALLENGE_TEXT.test(text)) return 'UPSTREAM_CHALLENGE';
  return null;
}
/** 检查浏览器里所有打开的页面（含跳转后的验证页和弹窗）。 */
async function pageBlocker(context) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const code = blockerCode(await pageText(page));
    if (code) return code;
  }
  return null;
}
/** 等二维码。等待期间不因页面文字提前失败（登录组件懒加载）；超时才看页面是否被验证挡住。 */
async function captureQr(page, waitMs) {
  const until = Date.now() + waitMs;
  let image = null;
  while (!image && Date.now() < until) {
    image = await qrElement(page);
    if (image) break;
    await page.waitForTimeout(1_000);
  }
  if (!image) throw new Error(blockerCode(await pageText(page)) || 'qr');
  const png = await image.screenshot({ type: 'png', animations: 'disabled' });
  if (png.length < 100 || png.length > 512 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('qr');
  return png;
}
async function refreshExpiredQr(page) {
  // 失效后登录组件在二维码上盖一层「刷新」；点不到就整页重载（重载要等登录组件重新加载）。
  const refresh = page.getByText('刷新', { exact: false }).first();
  if (await refresh.isVisible().catch(() => false)) {
    await refresh.click({ timeout: 5_000 }).catch(() => {});
    return;
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
}
async function authCookieDigest(context) {
  const rows = (await context.cookies())
    .filter((cookie) => AUTH_COOKIES.includes(cookie.name) && /(?:^|\.)douyin\.com$/.test(cookie.domain.replace(/^\./, '')))
    .map((cookie) => cookie.domain + '\0' + cookie.name + '\0' + cookie.value).sort();
  return digest(rows);
}
function onLoginPage(page) {
  if (page.isClosed()) return false;
  try {
    const url = new URL(page.url());
    return url.origin === SITE && (url.pathname === '/' || url.pathname === '');
  } catch { return false; }
}
async function proveSelf(context) {
  const page = await openSitePage(context).catch(() => null);
  if (!page) return null;
  try { return await readSelf(page); }
  catch (error) {
    // 风控即停：登录后身份接口被风控时不再每 5 秒重探，直接以 UPSTREAM_CHALLENGE 结束登录。
    if (failureCode(error) === 'UPSTREAM_CHALLENGE') throw error;
    return null;
  }
  finally { await page.close().catch(() => {}); }
}
async function runLogin(input, relay) {
  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, { cookies: [], origins: [] }, allowed, ['GET', 'POST', 'HEAD']);
    const login = await context.newPage();
    await login.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    let png = await captureQr(login, Math.min(QR_WAIT_MS, Math.max(1_000, input.deadlineMs - Date.now() - 5_000)));
    let qrHash = digest(png.toString('base64'));
    writeFrame({ event: 'qr', png: png.toString('base64') });
    emitStep({ step: 'login.qr' });
    const initialCookies = await authCookieDigest(context);
    let nextQr = Date.now() + QR_REFRESH_MS;
    let nextProbe = 0;
    while (Date.now() < input.deadlineMs) {
      const blocked = await pageBlocker(context);
      if (blocked) {
        emitStep({ step: 'login.blocked', code: blocked });
        await writeTerminalAndExit({ event: 'failed', code: blocked });
      }
      if (onLoginPage(login)) {
        const text = await pageText(login);
        if (QR_EXPIRED_TEXT.test(text)) {
          emitStep({ step: 'login.qr_expired' });
          await refreshExpiredQr(login);
          nextQr = 0;
        }
        if (Date.now() >= nextQr) {
          nextQr = Date.now() + QR_REFRESH_MS;
          const fresh = await captureQr(login, 2_000).catch(() => null);
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
      const signal = (await authCookieDigest(context)) !== initialCookies || !onLoginPage(login);
      if (signal && Date.now() >= nextProbe) {
        nextProbe = Date.now() + 5_000;
        const self = await proveSelf(context);
        if (self) {
          // 身份接口通过也不代表没有本人验证：保存前再看一遍所有页面。
          const late = await pageBlocker(context);
          if (late) {
            emitStep({ step: 'login.blocked', code: late });
            await writeTerminalAndExit({ event: 'failed', code: late });
          }
          const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
          // 平台只保存带 Secure 的 cookie：登录凭据被过滤掉就明确失败，绝不存一份无法使用的登录状态。
          if (!state.cookies.some((cookie) => SESSION_COOKIES.includes(cookie.name))) {
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
  writeFrame({ event: 'ready', runtime: 'douyin-worker-v1', playwrightMcpVersion });
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
