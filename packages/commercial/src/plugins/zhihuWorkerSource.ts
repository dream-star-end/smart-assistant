/**
 * Reviewed Zhihu worker. DOM-only: Playwright page interaction plus page.evaluate
 * on visible DOM. No Playwright request client, no response-body inspection, no
 * api.zhihu.com replay, no React internals. Writes stay behind the dispatch fence.
 */
export const ZHIHU_WORKER_SOURCE = String.raw`
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const playwrightMcpVersion = require('/usr/local/lib/node_modules/@playwright/mcp/package.json').version;
const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BROKER_SOCKET = '/run/oc-browser-broker/tls.sock';
const MAX_INPUT = 512 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_STATE_JSON = 256 * 1024;
const QR_REFRESH_MS = 8_000;
const ACTION_ORIGINS = new Set([
  'https://www.zhihu.com', 'https://zhuanlan.zhihu.com', 'https://static.zhihu.com',
  'https://zhstatic.zhihu.com', 'https://unpkg.zhimg.com',
  'https://pic1.zhimg.com', 'https://pic2.zhimg.com', 'https://pic3.zhimg.com',
  'https://pic4.zhimg.com', 'https://pic5.zhimg.com',
  'https://pica.zhimg.com', 'https://picb.zhimg.com', 'https://picx.zhimg.com'
]);
const WRITE_ACTIONS = new Set([
  'create_answer', 'edit_answer', 'delete_answer', 'create_comment', 'reply_comment',
  'delete_comment', 'set_vote', 'set_following', 'create_article', 'create_pin'
]);
const IMPLEMENTED_WRITES = new Set(['create_answer', 'edit_answer', 'delete_answer', 'create_comment', 'delete_comment', 'set_vote', 'set_following', 'create_pin', 'create_article', 'reply_comment']);
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const RISK_TEXT = /安全验证|访问异常|操作频繁|账号存在风险|请完成验证|验证码|登录保护|行为异常|系统检测到异常|点击按钮进行验证|请求存在异常|限制本次访问|系统监测到您的网络环境存在异常/;
const BLOCKED_TEXT = /请求存在异常|限制本次访问|访问异常|系统监测到您的网络环境存在异常/;
const NORMAL_LOGIN_VERIFICATION_TEXT = /验证码登录|获取验证码|短信验证码/g;
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
function classifyWriteFailure(reason) {
  const message = reason && typeof reason === 'object' && reason.message != null ? String(reason.message) : String(reason || '');
  if (message === 'composer-editor') return 'ZHIHU_WRITE_COMPOSER_EDITOR';
  if (message === 'composer-readback') return 'ZHIHU_WRITE_COMPOSER_READBACK';
  if (message === 'composer') return 'ZHIHU_WRITE_COMPOSER';
  if (message === 'send-button') return 'ZHIHU_WRITE_SEND_BUTTON';
  if (message === 'send-click') return 'ZHIHU_WRITE_SEND_CLICK';
  if (message === 'send') return 'ZHIHU_WRITE_SEND';
  if (message === 'result' || message === 'result-projection') return 'ZHIHU_WRITE_RESULT';
  if (message === 'unsupported') return 'ZHIHU_WRITE_UNSUPPORTED';
  if (message === 'media-chooser') return 'ZHIHU_WRITE_MEDIA_CHOOSER';
  if (message === 'media-upload') return 'ZHIHU_WRITE_MEDIA_UPLOAD';
  if (message === 'media-preview-timeout') return 'ZHIHU_WRITE_MEDIA_PREVIEW_TIMEOUT';
  return 'WORKER_FAILED';
}
function emitStep(event) {
  try {
    const payload = { src: 'zhihu-worker', t: Date.now() };
    if (event && typeof event === 'object') {
      if (typeof event.step === 'string') payload.step = String(event.step).slice(0, 64);
      if (event.ok === true || event.ok === false) payload.ok = event.ok;
      if (typeof event.ms === 'number' && Number.isFinite(event.ms)) payload.ms = Math.round(event.ms);
      if (typeof event.hits === 'number' && Number.isFinite(event.hits)) payload.hits = Math.round(event.hits);
      if (typeof event.textLen === 'number' && Number.isFinite(event.textLen)) payload.textLen = Math.round(event.textLen);
      if (typeof event.candidateCount === 'number' && Number.isFinite(event.candidateCount)) payload.candidateCount = Math.round(event.candidateCount);
      if (typeof event.code === 'string') payload.code = String(event.code).slice(0, 64);
      if (typeof event.actionId === 'string') payload.actionId = String(event.actionId).slice(0, 64);
      if (typeof event.branch === 'string') payload.branch = String(event.branch).slice(0, 32);
      if (typeof event.reason === 'string') payload.reason = String(event.reason).slice(0, 32);
      if (typeof event.pathname === 'string') payload.pathname = String(event.pathname).slice(0, 96);
      if (typeof event.selected === 'number' && Number.isFinite(event.selected)) payload.selected = Math.round(event.selected);
    }
    process.stderr.write(JSON.stringify(payload) + '\n');
  } catch {}
}
async function fail(reason) {
  if (terminal) return;
  await writeTerminalAndExit({ event: 'failed', code: classifyWriteFailure(reason) });
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
function cookieDomainAllowed(domain, domainSet) {
  const canonical = String(domain || '').replace(/^\./, '').toLowerCase();
  if (domainSet.has(canonical)) return true;
  if (canonical.startsWith('www.') && domainSet.has(canonical.slice(4))) return true;
  return false;
}
function isZhihuAuthHost(domain) {
  const canonical = String(domain || '').replace(/^\./, '').toLowerCase();
  return canonical === 'zhihu.com' || canonical === 'www.zhihu.com' || /\.zhihu\.com$/.test(canonical);
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
    if (!cookie || cookie.secure !== true || !cookieDomainAllowed(canonicalDomain, domainSet) || cookieKeys.has(key)) continue;
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
function cleanText(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function countFrom(value) {
  const text = cleanText(value, 40).replace(/,/g, '');
  const match = /(\d+(?:\.\d+)?)\s*([万亿]?)/.exec(text);
  if (!match) return 0;
  const scale = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1;
  return Math.max(0, Math.round(Number(match[1]) * scale));
}
function urlTokenOf(raw) {
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
function questionIdOf(raw) {
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    const match = /^\/question\/([0-9]{1,20})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
function answerIdOf(raw) {
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    const match = /(?:^|\/)answer\/([0-9]{1,20})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
function articleIdOf(raw) {
  try {
    const url = new URL(raw, 'https://zhuanlan.zhihu.com/');
    const match = /^\/p\/([0-9]{1,20})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
function pinIdOf(raw) {
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    const match = /(?:^|\/)pin\/([0-9]{1,20})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
async function bodyText(page) { return cleanText(await page.locator('body').innerText().catch(() => ''), 100000); }
async function assertNoChallenge(page) {
  const url = page.url();
  if (url.includes('/account/unhuman') || url.includes('unhuman'))
    await writeTerminalAndExit({ event: 'failed', code: 'ZHIHU_UPSTREAM_CHALLENGE' });
  const text = (await bodyText(page)).replace(NORMAL_LOGIN_VERIFICATION_TEXT, '');
  if (RISK_TEXT.test(text) || /captcha|geetest|challenge/.test(url))
    await writeTerminalAndExit({ event: 'failed', code: 'ZHIHU_UPSTREAM_CHALLENGE' });
}
async function isLoginVisible(page) {
  const url = page.url();
  if (/\/signin(?:[/?#]|$)/.test(url) || /\/account\/login/.test(url)) return true;
  const login = page.getByRole('button', { name: /登录|注册/ }).first();
  const qrTab = page.getByText('二维码登录', { exact: true }).first();
  return await login.isVisible().catch(() => false) && await qrTab.isVisible().catch(() => false);
}
function peopleTokenFromPath(pathname) {
  const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(String(pathname || ''));
  const token = match ? match[1] : null;
  return token && token !== 'edit' ? token : null;
}
async function topBarPeopleTokens(page) {
  return page.locator('a[href]').evaluateAll((anchors) => {
    const rows = [];
    for (const anchor of anchors) {
      const bounds = anchor.getBoundingClientRect();
      const style = getComputedStyle(anchor);
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.top < 0 || bounds.top > 200 || style.visibility !== 'visible' || style.display === 'none') continue;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
      if (!match || match[1] === 'edit') continue;
      rows.push(match[1]);
    }
    return rows;
  }).catch(() => []);
}
async function avatarMenuPeopleToken(page) {
  try {
    const clicked = await page.evaluate(() => {
      const targets = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('img, button, a, [role="button"]')) {
        const bounds = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (bounds.width <= 0 || bounds.height <= 0 || bounds.top < 0 || bounds.top > 200) continue;
        if (bounds.right < window.innerWidth - 280) continue;
        if (style.visibility !== 'visible' || style.display === 'none') continue;
        const hasImg = el.tagName === 'IMG' || !!el.querySelector('img');
        if (!hasImg) continue;
        const clickable = el.closest('a, button, [role="button"]') || el;
        if (seen.has(clickable)) continue;
        seen.add(clickable);
        targets.push(clickable);
      }
      if (targets.length !== 1) return false;
      targets[0].click();
      return true;
    });
    if (!clicked) return null;
    await page.waitForTimeout(500);
    const tokens = await page.locator('a[href*="/people/"]').evaluateAll((anchors) => {
      const rows = [];
      for (const anchor of anchors) {
        const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/我的主页/.test(text)) continue;
        const bounds = anchor.getBoundingClientRect();
        const style = getComputedStyle(anchor);
        if (bounds.width <= 0 || bounds.height <= 0 || style.visibility !== 'visible' || style.display === 'none') continue;
        let url;
        try { url = new URL(anchor.href, location.href); } catch { continue; }
        const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
        if (!match || match[1] === 'edit') continue;
        rows.push(match[1]);
      }
      return rows;
    });
    const unique = Array.from(new Set(tokens));
    return unique.length === 1 ? unique[0] : null;
  } catch {
    return null;
  }
}
async function editRedirectPeopleToken(page) {
  try {
    await page.goto('https://www.zhihu.com/people/edit', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(800);
    return peopleTokenFromPath(new URL(page.url()).pathname);
  } catch {
    return null;
  }
}
async function selfTokenFromPage(page) {
  const found = [];
  const topBar = Array.from(new Set(await topBarPeopleTokens(page)));
  if (topBar.length === 1) found.push(topBar[0]);
  const menu = await avatarMenuPeopleToken(page);
  if (menu) found.push(menu);
  const redirected = await editRedirectPeopleToken(page);
  if (redirected) found.push(redirected);
  const unique = Array.from(new Set(found));
  return unique.length === 1 ? unique[0] : null;
}
async function finishAuthenticatedNav(page, status) {
  const text = await bodyText(page);
  let pathname = '';
  try { pathname = new URL(page.url()).pathname; } catch {}
  if (status === 403 || BLOCKED_TEXT.test(text)) {
    emitStep({
      step: 'nav.blocked',
      ok: false,
      code: 'http-' + status,
      pathname,
      textLen: text.length
    });
    await writeTerminalAndExit({ event: 'failed', code: 'ZHIHU_UPSTREAM_CHALLENGE' });
  }
  await assertNoChallenge(page);
  emitStep({
    step: 'nav.response',
    ok: status < 400,
    code: 'http-' + status,
    pathname,
    textLen: text.length
  });
  if (await isLoginVisible(page)) await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
}
async function gotoAuthenticated(page, url) {
  let response = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      break;
    } catch (error) {
      const retryable = /net::ERR_(?:EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|HTTP2_PROTOCOL_ERROR|NAME_NOT_RESOLVED)/.test(String(error));
      if (attempt !== 0 || !retryable) throw error;
      await page.waitForTimeout(1_000);
    }
  }
  await page.waitForTimeout(2500);
  await finishAuthenticatedNav(page, response ? response.status() : 0);
}
async function gotoInSite(page, url) {
  let currentOrigin = '';
  let targetOrigin = '';
  try { currentOrigin = new URL(page.url()).origin; } catch {}
  try { targetOrigin = new URL(url).origin; } catch {}
  if (!currentOrigin || !targetOrigin || currentOrigin !== targetOrigin) {
    await gotoAuthenticated(page, url);
    return;
  }
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.evaluate((target) => { location.assign(target); }, url);
  } catch {
    throw new Error('nav');
  }
  try {
    await nav;
  } catch {
    throw new Error('nav');
  }
  try {
    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: 15_000 });
  } catch {
    throw new Error('nav');
  }
  await page.waitForTimeout(2500);
  await finishAuthenticatedNav(page, 0);
}
async function ensureSelfToken(page) {
  await gotoAuthenticated(page, 'https://www.zhihu.com/');
  const token = await selfTokenFromPage(page);
  if (!token) await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
  return token;
}
async function visible(locator) { return locator.isVisible().catch(() => false); }
async function uniqueVisible(locator, limit = 100) {
  const matches = [];
  const total = Math.min(await locator.count(), limit);
  for (let index = 0; index < total; index += 1) {
    const candidate = locator.nth(index);
    if (await visible(candidate)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function countVisible(locator, limit = 100) {
  let hits = 0;
  if (!locator || typeof locator.count !== 'function') return hits;
  const total = Math.min(await locator.count().catch(() => 0), limit);
  for (let index = 0; index < total; index += 1) {
    if (await visible(locator.nth(index))) hits += 1;
  }
  return hits;
}
async function uniqueExactControl(locator, labels) {
  const matches = [];
  const total = Math.min(await locator.count(), 200);
  for (let index = 0; index < total; index += 1) {
    const candidate = locator.nth(index);
    if (labels.includes(cleanText(await candidate.innerText().catch(() => ''), 100)) && await visible(candidate)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
function sameZhihuWriteSnapshot(current, snapshot, selfToken, expectedId) {
  return !!snapshot && snapshot.owned === true && !!current
    && current.id === expectedId
    && current.authorUrlToken === selfToken
    && typeof current.contentDigest === 'string'
    && current.contentDigest === snapshot.expectedDigest;
}
async function rejectIfSnapshotChanged(current, snapshot, selfToken, expectedId) {
  if (!sameZhihuWriteSnapshot(current, snapshot, selfToken, expectedId))
    await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
}
async function findAnswerRoot(page, answerId) {
  const items = page.locator('[data-zop], .ContentItem, .AnswerItem');
  const matches = [];
  const total = Math.min(await items.count(), 50);
  for (let index = 0; index < total; index += 1) {
    const item = items.nth(index);
    if (!await visible(item)) continue;
    const zop = await item.getAttribute('data-zop').catch(() => null);
    let idMatch = false;
    if (zop) {
      try {
        const parsed = JSON.parse(zop);
        idMatch = String(parsed.itemId || parsed.answerId || '') === String(answerId);
      } catch {}
    }
    const hrefCount = await item.locator('a[href*="/answer/' + answerId + '"]').count().catch(() => 0);
    if (idMatch || hrefCount > 0) matches.push(item);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function findCommentRoot(page, commentId) {
  const items = page.locator('[class*="CommentItem"], [class*="comment-item"], [data-id]');
  const matches = [];
  const total = Math.min(await items.count(), 100);
  for (let index = 0; index < total; index += 1) {
    const item = items.nth(index);
    if (!await visible(item)) continue;
    const dataId = await item.getAttribute('data-id').catch(() => '');
    if (String(dataId || '') === String(commentId)) matches.push(item);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function uniqueExactActionControl(root, page, labels) {
  const scope = root || page;
  let control = await uniqueExactControl(scope.locator('button, [role="button"], a'), labels);
  if (control) return control;
  const more = await uniqueExactControl(scope.locator('button, [role="button"], a'), ['更多']);
  if (!more) return null;
  await more.click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  return uniqueExactControl(page.locator('button, [role="button"], a, [role="menuitem"]'), labels);
}
async function uniqueExactConfirmControl(page) {
  const dialog = page.locator('[role="dialog"] button, .Modal button, .Modal-wrapper button');
  return await uniqueExactControl(dialog, ['确定'])
    || await uniqueExactControl(dialog, ['删除'])
    || await uniqueExactControl(page.locator('button, [role="button"]'), ['确定'])
    || await uniqueExactControl(page.locator('button, [role="button"]'), ['删除']);
}
async function awaitDispatch() {
  writeFrame({ event: 'prepared' });
  const command = await readFrame();
  if (Object.keys(command).sort().join('\0') !== 'event' || command.event !== 'dispatch') throw new Error('dispatch');
}
async function projectProfile(page, expectedToken) {
  const data = await page.evaluate((expected) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const tokenFrom = (raw) => {
      try {
        const url = new URL(raw, location.href);
        const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
        return match ? match[1] : null;
      } catch { return null; }
    };
    const heading = Array.from(document.querySelectorAll('h1')).find(visible);
    const name = (heading && heading.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    let urlToken = expected || tokenFrom(location.href);
    if (!urlToken) {
      const tokens = Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map((anchor) => tokenFrom(anchor.href)).filter(Boolean)));
      if (tokens.length === 1) urlToken = tokens[0];
    }
    const headlineEl = Array.from(document.querySelectorAll('[class*="headline"], [class*="Headline"], .ProfileHeader-headline')).find(visible);
    const headline = (headlineEl && headlineEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const counts = { followers: 0, following: 0 };
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (!visible(anchor)) continue;
      const href = anchor.getAttribute('href') || '';
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      const n = (() => {
        const match = /(\d+(?:\.\d+)?)\s*([万亿]?)/.exec(text.replace(/,/g, ''));
        if (!match) return 0;
        const scale = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1;
        return Math.max(0, Math.round(Number(match[1]) * scale));
      })();
      if (/\/followers(?:\/|$|\?)/.test(href) || /关注者/.test(text)) counts.followers = Math.max(counts.followers, n);
      if (/\/following(?:\/|$|\?)/.test(href) || /关注了/.test(text)) counts.following = Math.max(counts.following, n);
    }
    if (!urlToken || !name) return null;
    if (expected && urlToken !== expected) return null;
    return {
      urlToken, name, headline,
      profileUrl: 'https://www.zhihu.com/people/' + urlToken,
      followerCount: counts.followers,
      followingCount: counts.following
    };
  }, expectedToken || null);
  if (!data) throw new Error('profile');
  return data;
}
async function waitQuestionRendered(page) {
  await page.waitForSelector('h1, .QuestionHeader-title, [class*="QuestionHeader"]', { timeout: 15_000 }).catch(() => null);
}
async function projectQuestion(page, expectedId) {
  await waitQuestionRendered(page);
  const result = await page.evaluate((expected) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const idFrom = (raw) => {
      try {
        const url = new URL(raw, location.href);
        const match = /^\/question\/([0-9]{1,20})(?:\/|$)/.exec(url.pathname);
        return match ? match[1] : null;
      } catch { return null; }
    };
    const pathname = location.pathname || '';
    const parsedId = idFrom(location.href);
    const visibleH1s = Array.from(document.querySelectorAll('h1')).filter(visible);
    const headerTitles = Array.from(document.querySelectorAll('.QuestionHeader-title')).filter(visible);
    const headerTitleWild = Array.from(document.querySelectorAll('[class*="QuestionHeader-title"]')).filter(visible);
    let title = clean(visibleH1s[0] && visibleH1s[0].textContent);
    if (!title) title = clean(headerTitles[0] && headerTitles[0].textContent);
    if (!title) title = clean(headerTitleWild[0] && headerTitleWild[0].textContent);
    if (!title) title = clean((document.title || '').replace(/\s+- 知乎\s*$/, ''));
    const hits = visibleH1s.length || headerTitles.length || headerTitleWild.length || (title ? 1 : 0);
    const candidateCount = headerTitles.length + headerTitleWild.length;
    const fail = (reason) => ({ ok: false, reason, hits, candidateCount, pathname, data: null });
    if (expected) {
      if (!parsedId) return fail('no-id');
      if (parsedId !== expected) return fail('id-mismatch');
    } else if (!parsedId) {
      return fail('no-id');
    }
    if (!title) return fail('no-title');
    const questionId = parsedId || expected;
    const detailEl = Array.from(document.querySelectorAll('.QuestionRichText, [class*="QuestionRichText"], .QuestionHeader-detail')).find(visible);
    const detail = (detailEl && detailEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
    let followerCount = 0;
    let answerCount = 0;
    const body = (document.body && document.body.innerText || '').replace(/\s+/g, ' ');
    const followMatch = /([0-9.]+)\s*([万亿]?)\s*关注/.exec(body);
    const answerMatch = /([0-9.]+)\s*([万亿]?)\s*个回答/.exec(body) || /([0-9.]+)\s*([万亿]?)\s*回答/.exec(body);
    const scale = (unit) => unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
    if (followMatch) followerCount = Math.max(0, Math.round(Number(followMatch[1]) * scale(followMatch[2])));
    if (answerMatch) answerCount = Math.max(0, Math.round(Number(answerMatch[1]) * scale(answerMatch[2])));
    return {
      ok: true,
      reason: '',
      hits,
      candidateCount,
      pathname,
      data: {
        id: questionId, title, detail, followerCount, answerCount,
        url: 'https://www.zhihu.com/question/' + questionId
      }
    };
  }, expectedId || null);
  const ok = !!(result && result.ok && result.data);
  emitStep({
    step: 'question.project',
    ok,
    reason: ok ? undefined : ((result && result.reason) || 'no-title'),
    pathname: result && result.pathname,
    hits: result && typeof result.hits === 'number' ? result.hits : 0,
    candidateCount: result && typeof result.candidateCount === 'number' ? result.candidateCount : 0,
    textLen: (await bodyText(page)).length
  });
  if (!ok) throw new Error('question');
  return result.data;
}
async function collectAnswers(page, questionId, limit) {
  await page.waitForSelector('.AnswerItem, .ContentItem.AnswerItem, [data-zop], .List-item', { timeout: 15_000 }).catch(() => null);
  const scan = () => page.evaluate((input) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    const seen = new Set();
    const nodes = document.querySelectorAll('[data-zop], .ContentItem, .List-item, .AnswerItem, .QuestionAnswers-answers .List-item, [itemprop="suggestedAnswer"], div[data-za-detail-view-path-module="AnswerItem"]');
    const candidateCount = nodes.length;
    for (const node of nodes) {
      if (!visible(node)) continue;
      let zop = null;
      const raw = node.getAttribute('data-zop');
      if (raw) {
        try { zop = JSON.parse(raw); } catch { zop = null; }
      }
      let answerId = zop && String(zop.itemId || zop.answerId || '');
      if (!/^[0-9]{1,20}$/.test(answerId || '')) {
        const link = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
          try { return new URL(anchor.href, location.href).pathname; } catch { return ''; }
        }).find((path) => /\/answer\/[0-9]{1,20}/.test(path));
        const match = link && /\/answer\/([0-9]{1,20})/.exec(link);
        answerId = match ? match[1] : '';
      }
      if (!answerId || seen.has(answerId)) continue;
      seen.add(answerId);
      const authorName = String((zop && zop.authorName) || '').replace(/\s+/g, ' ').trim().slice(0, 128);
      const authorHref = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
        try {
          const url = new URL(anchor.href, location.href);
          const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
          return match ? match[1] : null;
        } catch { return null; }
      }).find(Boolean) || '';
      const excerptEl = node.querySelector('.RichContent-inner, .RichText, [class*="RichContent"]');
      const excerpt = (excerptEl && excerptEl.textContent || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const voteText = (node.textContent || '');
      const voteMatch = /([0-9.]+)\s*([万亿]?)\s*赞同/.exec(voteText);
      const scale = (unit) => unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
      const voteCount = voteMatch ? Math.max(0, Math.round(Number(voteMatch[1]) * scale(voteMatch[2]))) : 0;
      items.push({
        id: answerId,
        questionId: input.questionId,
        authorName,
        authorUrlToken: authorHref,
        excerpt,
        voteCount,
        url: 'https://www.zhihu.com/question/' + input.questionId + '/answer/' + answerId
      });
      if (items.length >= input.limit) break;
    }
    return { items, candidateCount };
  }, { questionId, limit });
  let scanned = await scan();
  let rows = scanned && Array.isArray(scanned.items) ? scanned.items : [];
  let candidateCount = scanned && typeof scanned.candidateCount === 'number' ? scanned.candidateCount : 0;
  for (let attempt = 0; attempt < 2 && rows.length === 0; attempt += 1) {
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(1500);
    scanned = await scan();
    rows = scanned && Array.isArray(scanned.items) ? scanned.items : [];
    candidateCount = scanned && typeof scanned.candidateCount === 'number' ? scanned.candidateCount : 0;
  }
  let pathname = '';
  try { pathname = new URL(page.url()).pathname; } catch {}
  emitStep({
    step: 'question.answers',
    ok: rows.length > 0,
    hits: rows.length,
    candidateCount,
    pathname,
    textLen: (await bodyText(page)).length
  });
  return rows;
}
async function projectAnswer(page, expectedId) {
  await page.waitForSelector('.RichContent-inner, .RichText, [class*="RichContent"], .AnswerItem, [data-zop]', { timeout: 15_000 }).catch(() => null);
  const data = await page.evaluate((expected) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const idFrom = (raw) => {
      try {
        const url = new URL(raw, location.href);
        const match = /(?:^|\/)answer\/([0-9]{1,20})(?:\/|$)/.exec(url.pathname);
        return match ? match[1] : null;
      } catch { return null; }
    };
    const answerId = expected || idFrom(location.href);
    const qid = (() => {
      try {
        const match = /^\/question\/([0-9]{1,20})(?:\/|$)/.exec(new URL(location.href).pathname);
        return match ? match[1] : '';
      } catch { return ''; }
    })();
    const rich = Array.from(document.querySelectorAll('.RichContent-inner, .RichText, [class*="RichContent"]')).find(visible);
    const text = (rich && rich.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    const heading = Array.from(document.querySelectorAll('h1')).find(visible);
    const title = (heading && heading.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    let zop = null;
    for (const node of document.querySelectorAll('[data-zop]')) {
      try {
        const parsed = JSON.parse(node.getAttribute('data-zop') || '');
        if (String(parsed.itemId || parsed.answerId || '') === String(answerId)) { zop = parsed; break; }
      } catch {}
    }
    const authorName = String((zop && zop.authorName) || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const item = Array.from(document.querySelectorAll('[data-zop], .ContentItem, .AnswerItem')).find((node) => {
      if (!visible(node)) return false;
      try {
        const parsed = JSON.parse(node.getAttribute('data-zop') || '');
        if (String(parsed.itemId || parsed.answerId || '') === String(answerId)) return true;
      } catch {}
      return Array.from(node.querySelectorAll('a[href]')).some((anchor) => {
        try { return new URL(anchor.href, location.href).pathname.indexOf('/answer/' + answerId) >= 0; } catch { return false; }
      });
    }) || document.body;
    const authorHref = Array.from(item.querySelectorAll('a[href]')).map((anchor) => {
      try {
        const url = new URL(anchor.href, location.href);
        const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
        return match ? match[1] : null;
      } catch { return null; }
    }).find(Boolean) || '';
    const timeEl = item.querySelector('time[datetime]');
    let updatedAt = (timeEl && timeEl.getAttribute('datetime') || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    if (!updatedAt) {
      const timeNode = item.querySelector('.ContentItem-time, [class*="ContentItem-time"], [class*="AnswerItem-time"]');
      const timeText = ((timeNode && timeNode.textContent) || '').replace(/\s+/g, ' ').trim();
      const match = /(?:编辑于|发布于|修改于)[^\n]{0,40}/.exec(timeText || (item.innerText || '').replace(/\s+/g, ' '));
      updatedAt = match ? match[0].replace(/\s+/g, ' ').trim().slice(0, 128) : '';
    }
    const body = (document.body && document.body.innerText || '');
    const voteMatch = /([0-9.]+)\s*([万亿]?)\s*赞同/.exec(body);
    const commentMatch = /([0-9.]+)\s*([万亿]?)\s*条评论/.exec(body) || /([0-9.]+)\s*([万亿]?)\s*评论/.exec(body);
    const scale = (unit) => unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
    const voteCount = voteMatch ? Math.max(0, Math.round(Number(voteMatch[1]) * scale(voteMatch[2]))) : 0;
    const commentCount = commentMatch ? Math.max(0, Math.round(Number(commentMatch[1]) * scale(commentMatch[2]))) : 0;
    if (!answerId || !text) return null;
    if (expected && answerId !== expected) return null;
    return {
      id: answerId,
      questionId: qid,
      questionTitle: title,
      authorName,
      authorUrlToken: authorHref,
      text,
      voteCount,
      commentCount,
      url: qid ? ('https://www.zhihu.com/question/' + qid + '/answer/' + answerId) : ('https://www.zhihu.com/answer/' + answerId),
      updatedAt,
      contentDigest: null
    };
  }, expectedId || null);
  if (!data) throw new Error('answer');
  data.contentDigest = digest({
    id: data.id, text: data.text, authorUrlToken: data.authorUrlToken || '',
    updatedAt: data.updatedAt || '', voteCount: data.voteCount
  });
  return data;
}
async function collectComments(page, answerId, limit) {
  const open = await uniqueExactControl(page.locator('button, [role="button"], a'), ['评论', '添加评论', '查看评论'])
    || page.getByText('评论', { exact: true }).first();
  if (open && await visible(open)) {
    await open.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.waitForSelector('[class*="CommentItem"], [class*="comment-item"], [data-id]', { timeout: 15_000 }).catch(() => null);
  const rows = await page.evaluate((input) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('[class*="CommentItem"], [class*="comment-item"], [data-id]')) {
      if (!visible(node)) continue;
      const text = (node.querySelector('[class*="CommentItem-content"], [class*="RichText"]') && node.querySelector('[class*="CommentItem-content"], [class*="RichText"]').textContent || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      if (!text || text.length < 1) continue;
      let commentId = node.getAttribute('data-id') || '';
      if (!/^[0-9]{1,20}$/.test(commentId)) {
        const key = text.slice(0, 80);
        if (seen.has(key)) continue;
        commentId = String(items.length + 1);
        seen.add(key);
      } else {
        if (seen.has(commentId)) continue;
        seen.add(commentId);
      }
      const authorHref = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
        try {
          const url = new URL(anchor.href, location.href);
          const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
          return match ? match[1] : null;
        } catch { return null; }
      }).find(Boolean) || '';
      const authorName = (node.querySelector('a[href*="/people/"]') && node.querySelector('a[href*="/people/"]').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
      const timeEl = node.querySelector('time[datetime]');
      let updatedAt = (timeEl && timeEl.getAttribute('datetime') || '').replace(/\s+/g, ' ').trim().slice(0, 128);
      if (!updatedAt) {
        const timeText = (node.textContent || '').replace(/\s+/g, ' ').trim();
        const match = /(?:编辑于|发布于|修改于)[^\n]{0,40}/.exec(timeText);
        updatedAt = match ? match[0].replace(/\s+/g, ' ').trim().slice(0, 128) : '';
      }
      items.push({
        id: commentId,
        answerId: input.answerId,
        authorName,
        authorUrlToken: authorHref,
        text,
        url: 'https://www.zhihu.com/answer/' + input.answerId,
        updatedAt
      });
      if (items.length >= input.limit) break;
    }
    return items;
  }, { answerId, limit });
  return rows.map((row) => ({
    ...row,
    contentDigest: digest({
      id: row.id, text: row.text, authorUrlToken: row.authorUrlToken || '', updatedAt: row.updatedAt || ''
    })
  }));
}
async function collectSearch(page, query, type, limit) {
  const typeParam = type === 'question' ? 'question' : type === 'people' ? 'people' : 'content';
  await gotoAuthenticated(page, 'https://www.zhihu.com/search?type=' + encodeURIComponent(typeParam) + '&q=' + encodeURIComponent(query));
  const rows = await page.evaluate((input) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('.List-item, .SearchResult-Card, [class*="SearchResult"], .ContentItem')) {
      if (!visible(node)) continue;
      const titleEl = node.querySelector('h2, a[href*="/question/"], a[href*="/people/"], a[href*="/p/"]');
      const title = (titleEl && titleEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const href = titleEl && titleEl.getAttribute && titleEl.getAttribute('href') || (titleEl && titleEl.href) || '';
      let url = '';
      try { url = new URL(href, location.href).href; } catch { continue; }
      if (!url || seen.has(url) || !title) continue;
      seen.add(url);
      const excerpt = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      items.push({ title, url, excerpt, kind: input.type });
      if (items.length >= input.limit) break;
    }
    return items;
  }, { type: typeParam, limit });
  return rows;
}
async function collectFeed(page, limit) {
  await gotoAuthenticated(page, 'https://www.zhihu.com/follow');
  const rows = await page.evaluate((limit) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('.ContentItem, .TopstoryItem, .List-item, [data-zop]')) {
      if (!visible(node)) continue;
      const link = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
        try { return new URL(anchor.href, location.href).href; } catch { return ''; }
      }).find((href) => /\/(question|answer|p)\//.test(href));
      if (!link || seen.has(link)) continue;
      seen.add(link);
      const title = (node.querySelector('h2, .ContentItem-title') && node.querySelector('h2, .ContentItem-title').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const excerpt = (node.querySelector('.RichContent-inner, .RichText') && node.querySelector('.RichContent-inner, .RichText').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      items.push({ title: title || excerpt.slice(0, 80), url: link, excerpt });
      if (items.length >= limit) break;
    }
    return items;
  }, limit);
  return rows;
}
async function collectNotifications(page, limit) {
  await gotoAuthenticated(page, 'https://www.zhihu.com/notifications');
  const rows = await page.evaluate((limit) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    for (const node of document.querySelectorAll('.List-item, [class*="Notification"], [class*="notification"]')) {
      if (!visible(node)) continue;
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!text) continue;
      const href = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
        try { return new URL(anchor.href, location.href).href; } catch { return ''; }
      }).find(Boolean) || 'https://www.zhihu.com/notifications';
      items.push({ id: String(items.length + 1), text, url: href });
      if (items.length >= limit) break;
    }
    return items;
  }, limit);
  return rows;
}
async function collectHot(page) {
  await gotoAuthenticated(page, 'https://www.zhihu.com/hot');
  return page.evaluate(() => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('.HotList-item, [class*="HotItem"], .HotItem')) {
      if (!visible(node)) continue;
      const rankText = (node.querySelector('[class*="index"], [class*="Index"], .HotList-itemIndex') && node.querySelector('[class*="index"], [class*="Index"], .HotList-itemIndex').textContent || '').trim();
      const rank = Number(rankText) || items.length + 1;
      const titleEl = node.querySelector('h2, a, .HotItem-title');
      const title = (titleEl && titleEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      let url = '';
      try { url = titleEl && titleEl.href ? new URL(titleEl.href, location.href).href : ''; } catch { url = ''; }
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const hotText = (node.textContent || '');
      const hotMatch = /([0-9.]+)\s*([万亿]?)/.exec(hotText);
      const scale = (unit) => unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
      const hotValue = hotMatch ? Math.max(0, Math.round(Number(hotMatch[1]) * scale(hotMatch[2] || ''))) : 0;
      items.push({ rank, title, url: url || ('https://www.zhihu.com/search?q=' + encodeURIComponent(title)), hotValue });
      if (items.length >= 50) break;
    }
    return items;
  });
}
async function collectMyList(page, selfToken, kind, limit) {
  const path = kind === 'answers' ? '/answers' : '/posts';
  await gotoAuthenticated(page, 'https://www.zhihu.com/people/' + selfToken + path);
  return page.evaluate((input) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('.List-item, .ContentItem, [data-zop]')) {
      if (!visible(node)) continue;
      const hrefs = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
        try { return new URL(anchor.href, location.href); } catch { return null; }
      }).filter(Boolean);
      let id = '';
      let url = '';
      for (const href of hrefs) {
        if (input.kind === 'answers') {
          const match = /\/answer\/([0-9]{1,20})/.exec(href.pathname);
          if (match) { id = match[1]; url = href.href; break; }
        } else {
          const match = /^\/p\/([0-9]{1,20})/.exec(href.pathname);
          if (match) { id = match[1]; url = href.href; break; }
        }
      }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = (node.querySelector('h2, .ContentItem-title') && node.querySelector('h2, .ContentItem-title').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const excerpt = (node.querySelector('.RichContent-inner, .RichText') && node.querySelector('.RichContent-inner, .RichText').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      items.push({ id, title, url, excerpt });
      if (items.length >= input.limit) break;
    }
    return items;
  }, { kind, limit });
}
async function actionRead(page, input) {
  const params = input.params || {};
  const limit = Math.min(Number(params.limit) || 10, 50);
  if (input.actionId === 'get_self') {
    const token = await ensureSelfToken(page);
    await gotoAuthenticated(page, 'https://www.zhihu.com/people/' + token);
    const user = await projectProfile(page, token);
    return { user };
  }
  if (input.actionId === 'get_user') {
    await ensureSelfToken(page);
    await gotoAuthenticated(page, 'https://www.zhihu.com/people/' + params.urlToken);
    const user = await projectProfile(page, params.urlToken);
    return { user };
  }
  if (input.actionId === 'get_question') {
    await ensureSelfToken(page);
    await gotoInSite(page, 'https://www.zhihu.com/question/' + params.questionId);
    const question = await projectQuestion(page, params.questionId);
    return { question };
  }
  if (input.actionId === 'list_question_answers') {
    await ensureSelfToken(page);
    await gotoInSite(page, 'https://www.zhihu.com/question/' + params.questionId);
    await waitQuestionRendered(page);
    const answers = await collectAnswers(page, params.questionId, limit);
    const complete = answers.length < limit;
    return { answers, complete, ...(answers.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'get_answer') {
    await ensureSelfToken(page);
    await gotoInSite(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const answer = await projectAnswer(page, params.answerId);
    return { answer };
  }
  if (input.actionId === 'list_answer_comments') {
    await ensureSelfToken(page);
    await gotoInSite(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const comments = await collectComments(page, params.answerId, limit);
    return { comments, complete: comments.length < limit, ...(comments.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'search') {
    await ensureSelfToken(page);
    const results = await collectSearch(page, params.query, params.type || 'general', limit);
    return { results, complete: results.length < limit, ...(results.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'list_feed') {
    await ensureSelfToken(page);
    const items = await collectFeed(page, limit);
    return { items, complete: items.length < limit, ...(items.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'list_notifications') {
    await ensureSelfToken(page);
    const notifications = await collectNotifications(page, limit);
    return { notifications, complete: notifications.length < limit, ...(notifications.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'list_my_answers') {
    const token = await ensureSelfToken(page);
    const answers = await collectMyList(page, token, 'answers', limit);
    return { answers, complete: answers.length < limit, ...(answers.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'list_my_articles') {
    const token = await ensureSelfToken(page);
    const articles = await collectMyList(page, token, 'articles', limit);
    return { articles, complete: articles.length < limit, ...(articles.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  if (input.actionId === 'list_hot') {
    await ensureSelfToken(page);
    const searches = await collectHot(page);
    return { searches, complete: searches.length > 0, ...(searches.length === 0 ? { degradedReason: 'empty_list' } : {}) };
  }
  throw new Error('action');
}
async function composerScope(editor) {
  if (!editor || typeof editor.locator !== 'function') return null;
  const queries = [
    'xpath=ancestor::*[.//*[(self::button or @role="button" or @role="menuitem")][normalize-space()="发布"]][1]',
    'xpath=ancestor::*[.//*[(self::button or @role="button" or @role="menuitem")][normalize-space()="图片"]][1]',
    'xpath=ancestor::*[.//*[@title="图片" or @aria-label="图片"]][1]'
  ];
  for (const query of queries) {
    const scope = editor.locator(query);
    if (await scope.count() === 1) return scope;
  }
  const fileScope = editor.locator('xpath=ancestor::*[.//input[@type="file"]][1]');
  if (await fileScope.count() === 1) {
    const tag = String(await fileScope.evaluate((el) => (el && el.tagName) || '').catch(() => '')).toUpperCase();
    if (tag && tag !== 'HTML' && tag !== 'BODY' && tag !== 'MAIN') return fileScope;
  }
  const parent = editor.locator('xpath=ancestor::*[4]');
  if (await parent.count() === 1) return parent;
  return editor;
}
function wrapFileInput(input) {
  return {
    setFiles: async (files) => input.setInputFiles(files),
    element: () => input,
  };
}
async function countImageFileInputs(scope) {
  const result = { total: 0, image: 0, attached: 0 };
  if (!scope || typeof scope.locator !== 'function') return result;
  const nodes = scope.locator('input[type="file"]');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return result;
  const total = Math.min(await nodes.count().catch(() => 0), 40);
  result.total = total;
  for (let index = 0; index < total; index += 1) {
    const node = nodes.nth(index);
    const attached = await node.evaluate((element) => !!element && element.isConnected).catch(() => false);
    if (!attached) continue;
    result.attached += 1;
    const accept = String(await node.getAttribute('accept').catch(() => '') || '');
    if (accept && !/image|\*/i.test(accept)) continue;
    result.image += 1;
  }
  return result;
}
async function uniqueImageFileInput(scope) {
  if (!scope || typeof scope.locator !== 'function') return null;
  const nodes = scope.locator('input[type="file"]');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return null;
  const matches = [];
  const total = Math.min(await nodes.count().catch(() => 0), 40);
  for (let index = 0; index < total; index += 1) {
    const node = nodes.nth(index);
    const attached = await node.evaluate((element) => !!element && element.isConnected).catch(() => false);
    if (!attached) continue;
    const accept = String(await node.getAttribute('accept').catch(() => '') || '');
    if (accept && !/image|\*/i.test(accept)) continue;
    matches.push(node);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function collectVisibleImageSrcs(scope) {
  const srcs = [];
  if (!scope || typeof scope.locator !== 'function') return srcs;
  const nodes = scope.locator('img');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return srcs;
  const total = Math.min(await nodes.count().catch(() => 0), 12);
  for (let index = 0; index < total; index += 1) {
    const node = nodes.nth(index);
    if (!await node.isVisible().catch(() => false)) continue;
    const src = String(await node.getAttribute('src').catch(() => '') || '');
    if (src) srcs.push(src);
  }
  return srcs;
}
async function countVisibleImgs(scope) {
  if (!scope || typeof scope.locator !== 'function') return 0;
  const nodes = scope.locator('img');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return 0;
  const total = Math.min(await nodes.count().catch(() => 0), 12);
  let hits = 0;
  for (let index = 0; index < total; index += 1) {
    if (await nodes.nth(index).isVisible().catch(() => false)) hits += 1;
  }
  return hits;
}
async function countPreviewNodes(scope) {
  if (!scope || typeof scope.locator !== 'function') return 0;
  const nodes = scope.locator('img[src^="blob:"], img[src^="data:"], [class*="Preview"], [class*="preview"], [class*="ImagePreview"], [class*="UploadPicture"]');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return 0;
  const total = Math.min(await nodes.count().catch(() => 0), 20);
  let hits = 0;
  for (let index = 0; index < total; index += 1) {
    if (await visible(nodes.nth(index))) hits += 1;
  }
  return hits;
}
function isComposerPreviewSrc(src) {
  if (!src) return false;
  if (/^(blob:|data:)/i.test(src)) return true;
  if (/zhimg\.com/i.test(src)) return true;
  return false;
}
async function awaitComposerMediaReady(page, editor, expectedNew, timeout, beforeSrcs) {
  if (!editor || typeof editor.locator !== 'function' || editor === page) throw new Error('media-chooser');
  const scope = editor;
  const before = new Set(Array.isArray(beforeSrcs) ? beforeSrcs : []);
  const deadline = Date.now() + timeout;
  const attempts = Math.max(1, Math.ceil(timeout / 250));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (Date.now() >= deadline) break;
    const added = [];
    const seen = new Set();
    for (const src of await collectVisibleImageSrcs(scope)) {
      if (before.has(src) || seen.has(src)) continue;
      seen.add(src);
      added.push(src);
    }
    const addedPreview = added.filter((src) => isComposerPreviewSrc(src)).length;
    if (addedPreview >= expectedNew) return;
    const remaining = deadline - Date.now();
    if (attempt < attempts - 1 && remaining > 0) {
      await page.waitForTimeout(Math.min(250, remaining));
    }
  }
  throw new Error('media-preview-timeout');
}
async function armFileChooser(page, clickable, files) {
  if (!page || typeof page.waitForEvent !== 'function' || !clickable || typeof clickable.click !== 'function') {
    return { chooser: null, timedOut: false, attached: false, attachFailed: false };
  }
  let attached = false;
  let attachFailed = false;
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).then(async (chooser) => {
    if (chooser && Array.isArray(files) && files.length > 0 && typeof chooser.setFiles === 'function') {
      try {
        await chooser.setFiles(files);
        attached = true;
      } catch {
        attachFailed = true;
      }
    }
    return chooser || null;
  }).catch(() => null);
  const clickPromise = clickable.click({ timeout: 5_000, force: true, noWaitAfter: true }).catch(() => null);
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), 8_000);
  });
  try {
    const raced = await Promise.race([chooserPromise, timeoutPromise]);
    if (raced === '__timeout__') return { chooser: null, timedOut: true, attached: false, attachFailed: false };
    if (raced) return { chooser: raced, timedOut: false, attached, attachFailed };
    await Promise.race([clickPromise, timeoutPromise]);
    return { chooser: null, timedOut: false, attached: false, attachFailed: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function proveImageControl(scope, page) {
  if (!scope || typeof scope.locator !== 'function' || scope === page) throw new Error('media-chooser');
  if (await uniqueImageFileInput(scope)) return true;
  if (await uniqueExactControl(scope.locator('button, [role="button"], [role="menuitem"], a'), ['图片'])) return true;
  const byAttr = scope.locator('button[title="图片"], button[aria-label="图片"], [role="button"][title="图片"], [role="button"][aria-label="图片"]');
  if (await uniqueVisible(byAttr)) return true;
  throw new Error('media-chooser');
}
async function uniqueImageTool(scope, page) {
  const root = (scope && typeof scope.locator === 'function' && scope !== page) ? scope : null;
  if (!root) return null;
  const labeled = await uniqueExactControl(root.locator('button, [role="button"], [role="menuitem"], a'), ['图片']);
  if (labeled) return labeled;
  const byAttr = root.locator('button[title="图片"], button[aria-label="图片"], [role="button"][title="图片"], [role="button"][aria-label="图片"]');
  return uniqueVisible(byAttr);
}
async function attachImages(page, scope, manifest, previewBeforeSrcs) {
  const items = Array.isArray(manifest) ? manifest : [];
  if (items.length === 0) return 0;
  if (!scope || typeof scope.locator !== 'function' || scope === page) throw new Error('media-chooser');
  const files = [];
  let selected = 0;
  const target = scope;
  try {
    for (const item of items) {
      const inputId = String(item && item.inputId || '');
      const mimeType = String(item && item.mimeType || '');
      const filename = String(item && item.filename || 'image.png');
      if (!/^[A-Za-z0-9-]{1,64}$/.test(inputId) || !ALLOWED_IMAGE_MIME.has(mimeType)) throw new Error('media-upload');
      files.push({ name: filename, mimeType, buffer: await readFile('/inputs/' + inputId) });
    }
    const previewBefore = Array.isArray(previewBeforeSrcs) ? previewBeforeSrcs : await collectVisibleImageSrcs(target);
    let input = await uniqueImageFileInput(target);
    let attached = false;
    if (!input) {
      const image = await uniqueImageTool(target, page);
      if (image) {
        const armed = await armFileChooser(page, image, files);
        if (armed.timedOut) throw new Error('media-chooser');
        if (armed.attachFailed) throw new Error('media-upload');
        if (armed.attached) { attached = true; selected = files.length; }
        else if (armed.chooser && typeof armed.chooser.setFiles === 'function') {
          try {
            await armed.chooser.setFiles(files);
            attached = true;
            selected = files.length;
          } catch { throw new Error('media-upload'); }
        }
        if (!attached) {
          const local = await uniqueExactControl(target.locator('button, [role="button"], [role="menuitem"], a'), ['本地上传']);
          if (local) {
            const localArmed = await armFileChooser(page, local, files);
            if (localArmed.timedOut) throw new Error('media-chooser');
            if (localArmed.attachFailed) throw new Error('media-upload');
            if (localArmed.attached) { attached = true; selected = files.length; }
          }
        }
        input = await uniqueImageFileInput(target);
      }
    }
    if (!attached) {
      if (!input) input = await uniqueImageFileInput(target);
      if (!input) throw new Error('media-chooser');
      try {
        await wrapFileInput(input).setFiles(files);
      } catch {
        throw new Error('media-upload');
      }
      try {
        selected = await input.evaluate((node) => node.files ? node.files.length : 0);
      } catch { selected = 0; }
    } else if (input) {
      try {
        selected = await input.evaluate((node) => node.files ? node.files.length : 0);
      } catch { selected = files.length; }
    }
    if (selected !== files.length) throw new Error('media-upload');
    await awaitComposerMediaReady(page, target, files.length, 90_000, previewBefore);
    emitStep({ step: 'media.attach', ok: true, hits: selected, candidateCount: files.length });
    return selected;
  } catch (error) {
    emitStep({ step: 'media.attach', ok: false, hits: selected, candidateCount: items.length });
    throw error;
  } finally {
    for (const file of files) {
      if (file.buffer && typeof file.buffer.fill === 'function') file.buffer.fill(0);
    }
  }
}
async function scanOwnPinRows(target, selfToken) {
  return target.evaluate((token) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = [];
    for (const node of document.querySelectorAll('[data-zop], .PinItem, .ContentItem')) {
      if (!visible(node)) continue;
      const authorHref = Array.from(node.querySelectorAll('a[href]')).map((anchor) => {
        try {
          const url = new URL(anchor.href, location.href);
          const match = /^\/people\/([A-Za-z0-9-]{1,64})(?:\/|$)/.exec(url.pathname);
          return match ? match[1] : null;
        } catch { return null; }
      }).find(Boolean) || '';
      if (authorHref !== token) continue;
      const excerpt = (node.querySelector('.RichContent-inner, .RichText, [class*="RichContent"]') && node.querySelector('.RichContent-inner, .RichText, [class*="RichContent"]').textContent || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      let pinId = '';
      for (const anchor of node.querySelectorAll('a[href]')) {
        try {
          const match = /\/pin\/([0-9]{1,20})/.exec(new URL(anchor.href, location.href).pathname);
          if (match) { pinId = match[1]; break; }
        } catch {}
      }
      if (!pinId) continue;
      const timeText = (node.textContent || '').replace(/\s+/g, ' ');
      items.push({
        id: pinId,
        text: excerpt,
        authorUrlToken: authorHref,
        justNow: /刚刚/.test(timeText)
      });
    }
    return items;
  }, selfToken).catch(() => []);
}
async function collectOwnPinIds(page, selfToken) {
  const context = typeof page.context === 'function' ? page.context() : null;
  if (context && typeof context.newPage === 'function') {
    const tab = await context.newPage();
    try {
      await gotoAuthenticated(tab, 'https://www.zhihu.com/people/' + selfToken + '/pins');
      return new Set((await scanOwnPinRows(tab, selfToken)).map((row) => row.id).filter(Boolean));
    } finally {
      await tab.close().catch(() => {});
    }
  }
  return new Set((await scanOwnPinRows(page, selfToken)).map((row) => row.id).filter(Boolean));
}
async function projectCreatedPin(page, selfToken, text, beforeIds) {
  await gotoAuthenticated(page, 'https://www.zhihu.com/people/' + selfToken + '/pins');
  const needle = cleanText(text, 40).slice(0, 20);
  const baseline = beforeIds instanceof Set ? beforeIds : new Set();
  const rows = await scanOwnPinRows(page, selfToken);
  const mine = rows.find((row) => {
    if (!row.id || row.authorUrlToken !== selfToken || baseline.has(row.id)) return false;
    if (needle) return (row.text || '').includes(needle);
    return row.justNow === true;
  });
  if (!mine || !mine.id) throw new Error('result');
  const pinText = cleanText(text, 2000);
  return {
    id: mine.id,
    text: pinText,
    url: 'https://www.zhihu.com/pin/' + mine.id,
    contentDigest: digest({ id: mine.id, text: pinText })
  };
}
async function fillEditor(page, text, existing) {
  const innerSel = '[contenteditable="true"], textarea, .public-DraftEditor-content, .ProseMirror, [role="textbox"]';
  let editor = null;
  if (existing && typeof existing.locator === 'function') {
    editor = await uniqueVisible(existing.locator(innerSel));
    if (!editor && await visible(existing)) editor = existing;
  }
  if (!editor) {
    editor = await uniqueVisible(page.locator('[contenteditable="true"], textarea, .public-DraftEditor-content, .ProseMirror'))
      || await uniqueVisible(page.locator('[role="textbox"]'));
  }
  if (!editor) throw new Error('composer-editor');
  await editor.click({ timeout: 10_000 });
  await page.waitForTimeout(200);
  const tag = await editor.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'textarea' || tag === 'input') await editor.fill(text);
  else {
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.insertText(text);
  }
  await page.waitForTimeout(400);
  const readback = cleanText(await editor.innerText().catch(() => ''), 20000);
  if (!readback.includes(cleanText(text, 80).slice(0, 40))) throw new Error('composer-readback');
  return editor;
}
async function clickUniqueSend(page, labels) {
  const send = await uniqueExactControl(page.locator('button, [role="button"]'), labels);
  if (!send) throw new Error('send-button');
  await send.click({ timeout: 10_000 }).catch((error) => { throw new Error('send-click'); });
}
async function writeAction(page, input) {
  const params = input.params || {};
  if (!IMPLEMENTED_WRITES.has(input.actionId)) throw new Error('unsupported');
  const selfToken = await ensureSelfToken(page);
  if (input.actionId === 'create_answer') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/question/' + params.questionId);
    const open = await uniqueExactControl(page.locator('button, [role="button"], a'), ['写回答', '添加回答']);
    if (open) await open.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const editor = await fillEditor(page, params.text);
    const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
    const scope = await composerScope(editor);
    let previewBefore = [];
    if (manifest.length) {
      await proveImageControl(scope, page);
      previewBefore = await collectVisibleImageSrcs(scope);
    }
    await awaitDispatch();
    await assertNoChallenge(page);
    if (manifest.length) await attachImages(page, scope, manifest, previewBefore);
    await clickUniqueSend(page, ['发布', '提交回答', '提交']);
    await page.waitForTimeout(1500);
    await assertNoChallenge(page);
    const answers = await collectAnswers(page, params.questionId, 20);
    const mine = answers.find((row) => row.authorUrlToken === selfToken && (row.excerpt || '').includes(cleanText(params.text, 40).slice(0, 20)));
    if (!mine) throw new Error('result');
    return { answer: { id: mine.id, questionId: params.questionId, text: params.text, url: mine.url, contentDigest: digest({ id: mine.id, text: params.text }) } };
  }
  if (input.actionId === 'create_comment') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const open = await uniqueExactControl(page.locator('button, [role="button"], a'), ['评论', '添加评论']);
    if (open) await open.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await fillEditor(page, params.text);
    await awaitDispatch();
    await assertNoChallenge(page);
    await clickUniqueSend(page, ['发布', '评论', '提交']);
    await page.waitForTimeout(1200);
    await assertNoChallenge(page);
    const comments = await collectComments(page, params.answerId, 20);
    const mine = comments.find((row) => row.authorUrlToken === selfToken && row.text.includes(cleanText(params.text, 40).slice(0, 20)));
    if (!mine) throw new Error('result');
    return { comment: mine };
  }
  if (input.actionId === 'set_vote') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const vote = params.vote;
    const labels = vote === 'up' ? ['赞同', '同意'] : vote === 'down' ? ['反对', '不赞同'] : ['取消赞同', '取消反对', '赞同'];
    const control = await uniqueExactControl(page.locator('button, [role="button"]'), labels);
    if (!control) throw new Error('send-button');
    await awaitDispatch();
    await assertNoChallenge(page);
    await control.click({ timeout: 10_000 }).catch(() => { throw new Error('send-click'); });
    await page.waitForTimeout(800);
    await assertNoChallenge(page);
    return { ok: true, changed: true };
  }
  if (input.actionId === 'set_following') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/people/' + params.urlToken);
    const want = params.following === true;
    const labels = want ? ['关注'] : ['已关注', '取消关注', '取消'];
    const control = await uniqueExactControl(page.locator('button, [role="button"]'), labels);
    if (!control) throw new Error('send-button');
    const currentLabel = cleanText(await control.innerText().catch(() => ''), 20);
    const already = want ? currentLabel === '已关注' : currentLabel === '关注';
    if (already) {
      await awaitDispatch();
      return { ok: true, changed: false };
    }
    await awaitDispatch();
    await assertNoChallenge(page);
    await control.click({ timeout: 10_000 }).catch(() => { throw new Error('send-click'); });
    await page.waitForTimeout(800);
    await assertNoChallenge(page);
    return { ok: true, changed: true };
  }
  if (input.actionId === 'edit_answer' || input.actionId === 'delete_answer') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const current = await projectAnswer(page, params.answerId);
    await rejectIfSnapshotChanged(current, params.snapshot, selfToken, params.answerId);
    const root = await findAnswerRoot(page, params.answerId);
    const actionLabel = input.actionId === 'edit_answer' ? '编辑' : '删除';
    const control = await uniqueExactActionControl(root, page, [actionLabel]);
    if (!control) throw new Error('control');
    await awaitDispatch();
    await assertNoChallenge(page);
    const fresh = await projectAnswer(page, params.answerId);
    await rejectIfSnapshotChanged(fresh, params.snapshot, selfToken, params.answerId);
    const freshRoot = await findAnswerRoot(page, params.answerId);
    const freshControl = await uniqueExactActionControl(freshRoot, page, [actionLabel]);
    if (!freshControl) throw new Error('control');
    await freshControl.click({ timeout: 10_000 });
    if (input.actionId === 'delete_answer') {
      await page.waitForTimeout(400);
      const confirm = await uniqueExactConfirmControl(page);
      if (!confirm) throw new Error('control');
      await confirm.click({ timeout: 10_000 });
      await page.waitForTimeout(1500);
      await assertNoChallenge(page);
      let remains = true;
      try { await projectAnswer(page, params.answerId); } catch { remains = false; }
      if (remains) throw new Error('result');
      return { ok: true, changed: true };
    }
    await page.waitForTimeout(500);
    const editor = await fillEditor(page, params.text);
    const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
    if (manifest.length) await attachImages(page, await composerScope(editor), manifest);
    const save = await uniqueExactControl(page.locator('button, [role="button"]'), ['确定'])
      || await uniqueExactControl(page.locator('button, [role="button"]'), ['发布'])
      || await uniqueExactControl(page.locator('button, [role="button"]'), ['提交']);
    if (!save) throw new Error('send-button');
    await save.click({ timeout: 10_000 }).catch(() => { throw new Error('send-click'); });
    await page.waitForTimeout(1500);
    await assertNoChallenge(page);
    const updated = await projectAnswer(page, params.answerId);
    if (updated.id !== params.answerId || updated.authorUrlToken !== selfToken || !updated.text.includes(cleanText(params.text, 40).slice(0, 20))) throw new Error('result');
    return { answer: updated };
  }
  if (input.actionId === 'delete_comment') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const comments = await collectComments(page, params.answerId, 50);
    const current = comments.find((row) => row.id === params.commentId);
    await rejectIfSnapshotChanged(current, params.snapshot, selfToken, params.commentId);
    const root = await findCommentRoot(page, params.commentId);
    const control = await uniqueExactActionControl(root, page, ['删除']);
    if (!control) throw new Error('control');
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshComments = await collectComments(page, params.answerId, 50);
    const fresh = freshComments.find((row) => row.id === params.commentId);
    await rejectIfSnapshotChanged(fresh, params.snapshot, selfToken, params.commentId);
    const freshRoot = await findCommentRoot(page, params.commentId);
    const freshControl = await uniqueExactActionControl(freshRoot, page, ['删除']);
    if (!freshControl) throw new Error('control');
    await freshControl.click({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const confirm = await uniqueExactConfirmControl(page);
    if (!confirm) throw new Error('control');
    await confirm.click({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    await assertNoChallenge(page);
    const remains = (await collectComments(page, params.answerId, 50)).some((row) => row.id === params.commentId);
    if (remains) throw new Error('result');
    return { ok: true, changed: true };
  }
  if (input.actionId === 'create_pin') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/');
    const pinOpenerLabels = ['写想法', '发想法', '分享你此刻的想法'];
    let opener = null;
    let selected = -1;
    for (let index = 0; index < pinOpenerLabels.length; index += 1) {
      const control = await uniqueExactControl(page.locator('button, [role="button"], [role="tab"], a'), [pinOpenerLabels[index]]);
      if (control) { opener = control; selected = index; break; }
    }
    if (!opener) {
      opener = await uniqueVisible(page.getByPlaceholder(/写想法|发想法|分享你此刻的想法/));
      if (opener) selected = pinOpenerLabels.length;
    }
    if (!opener) {
      emitStep({ step: 'write.compose', ok: false, reason: 'no-composer' });
      throw new Error('composer');
    }
    emitStep({ step: 'write.compose', ok: true, reason: 'opener', selected });
    await opener.click({ timeout: 10_000 });
    await page.waitForSelector('[class*="PinEditor"], [class*="CreatePin"], .Modal-content [contenteditable="true"], .Editable-content, .public-DraftEditor-content', { timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(400);
    const pinContainers = page.locator('[class*="PinEditor"], [class*="CreatePin"], .Modal-content, [class*="Pin"] form');
    const editorSel = '[contenteditable="true"], [role="textbox"], textarea, .public-DraftEditor-content';
    const scopedEditor = await uniqueVisible(pinContainers.locator(editorSel));
    const editor = scopedEditor
      || await uniqueVisible(page.locator('[contenteditable="true"], textarea, .public-DraftEditor-content, .ProseMirror'))
      || await uniqueVisible(page.locator('[role="textbox"]'));
    const text = cleanText(params.text || '', 2000);
    if (!editor) {
      emitStep({
        step: 'write.compose',
        ok: false,
        reason: 'no-editor',
        hits: await countVisible(page.locator('[contenteditable="true"]')),
        candidateCount: await countVisible(pinContainers),
        textLen: (await bodyText(page)).length
      });
      throw new Error('composer-editor');
    }
    if (text) await fillEditor(page, text, editor);
    const scope = await composerScope(editor);
    const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
    let previewBefore = [];
    if (manifest.length) {
      await proveImageControl(scope, page);
      previewBefore = await collectVisibleImageSrcs(scope);
    }
    const beforePinIds = await collectOwnPinIds(page, selfToken);
    await awaitDispatch();
    await assertNoChallenge(page);
    if (manifest.length) await attachImages(page, scope, manifest, previewBefore);
    const send = await uniqueExactControl((scope || page).locator('button, [role="button"]'), ['发布'])
      || await uniqueExactControl(page.locator('button, [role="button"]'), ['发布']);
    if (!send) {
      emitStep({ step: 'write.compose', ok: false, reason: 'no-send' });
      throw new Error('send-button');
    }
    await send.click({ timeout: 10_000 }).catch(() => { throw new Error('send-click'); });
    await page.waitForTimeout(1500);
    await assertNoChallenge(page);
    const pin = await projectCreatedPin(page, selfToken, text, beforePinIds);
    return { pin };
  }
  if (input.actionId === 'create_article') {
    await gotoInSite(page, 'https://zhuanlan.zhihu.com/write');
    await page.waitForSelector('textarea[placeholder*="标题"], input[placeholder*="标题"], .WriteIndex-titleInput, [contenteditable="true"]', { timeout: 20_000 }).catch(() => null);
    const titleBox = await uniqueVisible(page.getByPlaceholder(/请输入标题|标题/))
      || await uniqueVisible(page.locator('.WriteIndex-titleInput, textarea[class*="title" i]'));
    const articleComposeFail = async (reason) => {
      emitStep({
        step: 'write.compose',
        ok: false,
        reason,
        hits: (await countVisible(page.getByPlaceholder(/请输入标题|标题/))) + (await countVisible(page.locator('.WriteIndex-titleInput, textarea[class*="title" i]'))),
        candidateCount: await countVisible(page.locator('[contenteditable="true"]')),
        textLen: (await bodyText(page)).length
      });
    };
    if (!titleBox) {
      await articleComposeFail('no-title');
      throw new Error('composer');
    }
    await titleBox.fill(params.title);
    const body = await uniqueVisible(page.locator('.public-DraftEditor-content'))
      || await uniqueVisible(page.locator('.Editable-content [contenteditable="true"]'))
      || await uniqueVisible(page.locator('[contenteditable="true"]'));
    if (!body) {
      await articleComposeFail('no-editor');
      throw new Error('composer-editor');
    }
    let editor;
    try { editor = await fillEditor(page, params.text, body); }
    catch (error) {
      if (String(error && error.message) === 'composer-editor') await articleComposeFail('no-editor');
      throw error;
    }
    const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
    const scope = await composerScope(editor);
    let previewBefore = [];
    if (manifest.length) {
      await proveImageControl(scope, page);
      previewBefore = await collectVisibleImageSrcs(scope);
    }
    await awaitDispatch();
    await assertNoChallenge(page);
    if (manifest.length) await attachImages(page, scope, manifest, previewBefore);
    const send = await uniqueExactControl(page.locator('button, [role="button"]'), ['发布文章', '发布']);
    if (!send) {
      emitStep({ step: 'write.compose', ok: false, reason: 'no-send' });
      throw new Error('send-button');
    }
    await send.click({ timeout: 10_000 }).catch(() => { throw new Error('send-click'); });
    await page.waitForTimeout(2000);
    await assertNoChallenge(page);
    let articleId = articleIdOf(page.url());
    for (let attempt = 0; attempt < 8 && !articleId; attempt += 1) {
      await page.waitForTimeout(750);
      articleId = articleIdOf(page.url());
    }
    if (!articleId) throw new Error('result');
    const heading = await uniqueVisible(page.locator('h1'));
    const publishedTitle = cleanText(heading ? await heading.innerText().catch(() => '') : '', 500).replace(/\s*-\s*知乎\s*$/, '');
    if (cleanText(params.title, 500).replace(/\s*-\s*知乎\s*$/, '') !== publishedTitle) throw new Error('result');
    return {
      article: {
        id: articleId,
        title: publishedTitle,
        url: 'https://zhuanlan.zhihu.com/p/' + articleId,
        contentDigest: digest({ id: articleId, title: publishedTitle, text: params.text })
      }
    };
  }
  if (input.actionId === 'reply_comment') {
    await gotoAuthenticated(page, 'https://www.zhihu.com/answer/' + params.answerId);
    const root = await findCommentRoot(page, params.commentId);
    const reply = await uniqueExactActionControl(root, page, ['回复']);
    if (!reply) {
      emitStep({ step: 'write.compose', ok: false, reason: 'no-composer' });
      throw new Error('composer');
    }
    await reply.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    try { await fillEditor(page, params.text); }
    catch (error) {
      if (String(error && error.message) === 'composer-editor')
        emitStep({ step: 'write.compose', ok: false, reason: 'no-editor' });
      throw error;
    }
    await awaitDispatch();
    await assertNoChallenge(page);
    const send = await uniqueExactControl(page.locator('button, [role="button"]'), ['发布', '回复']);
    if (!send) {
      emitStep({ step: 'write.compose', ok: false, reason: 'no-send' });
      throw new Error('send-button');
    }
    await send.click({ timeout: 10_000 }).catch(() => { throw new Error('send-click'); });
    await page.waitForTimeout(1200);
    await assertNoChallenge(page);
    const comments = await collectComments(page, params.answerId, 20);
    const mine = comments.find((row) => row.authorUrlToken === selfToken && row.text.includes(cleanText(params.text, 40).slice(0, 20)));
    if (!mine) throw new Error('result');
    return { comment: mine };
  }
  throw new Error('unsupported');
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
async function secureContext(browser, storageState, allowed) {
  const context = await browser.newContext({
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block', storageState
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    let origin;
    try { origin = new URL(request.url()).origin; } catch { await route.abort(); return; }
    if (!allowed.has(origin) || !['GET', 'POST', 'DELETE', 'OPTIONS'].includes(request.method()) || ['websocket', 'eventsource'].includes(request.resourceType())) {
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
    const context = await secureContext(browser, input.storageState, ACTION_ORIGINS);
    const page = await context.newPage();
    try {
      const result = WRITE_ACTIONS.has(input.actionId) ? await writeAction(page, input) : await actionRead(page, input);
      emitStep({ step: 'action.done', actionId: input.actionId, ok: true, ms: Date.now() - started });
      await finishAction(context, input, result);
    } catch (error) {
      emitStep({ step: 'action.failed', actionId: input.actionId, ok: false, ms: Date.now() - started, code: classifyWriteFailure(error) });
      throw error;
    }
  } finally { await browser.close(); }
}
async function captureQr(page) {
  const candidates = [
    page.locator('img.Qrcode-qrcode, img.Qrcode-img, .Qrcode img, img[alt*="二维码"], canvas').first(),
    page.locator('img').filter({ has: page.locator('xpath=self::img') }).first()
  ];
  let image = null;
  for (const locator of [
    page.locator('img.Qrcode-qrcode'),
    page.locator('img.Qrcode-img'),
    page.locator('.Qrcode img'),
    page.locator('img[alt*="二维码"]'),
    page.locator('canvas')
  ]) {
    const unique = await uniqueVisible(locator, 20);
    if (unique) { image = unique; break; }
  }
  if (!image) throw new Error('qr');
  await image.waitFor({ state: 'visible', timeout: 20_000 });
  let valid = false;
  for (let attempt = 0; attempt < 80 && !valid; attempt += 1) {
    valid = await image.evaluate((element) => {
      if (element.tagName && element.tagName.toLowerCase() === 'canvas') {
        return element.width >= 80 && element.height >= 80;
      }
      return element.complete && element.naturalWidth >= 80 && element.naturalHeight >= 80;
    }).catch(() => false);
    if (!valid) await page.waitForTimeout(250);
  }
  if (!valid) throw new Error('qr');
  const png = await image.screenshot({ type: 'png', animations: 'disabled' });
  if (png.length < 100 || png.length > 512 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('qr');
  return png;
}
async function switchToQrLogin(page) {
  const tab = await uniqueExactControl(page.locator('button, [role="tab"], [role="button"], a, div'), ['二维码登录', '扫码登录'])
    || page.getByText('二维码登录', { exact: true }).first();
  if (tab && await visible(tab)) {
    await tab.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
}
async function authCookieDigest(context) {
  const rows = (await context.cookies())
    .filter((cookie) => ['z_c0', 'q_c1', 'd_c0', '_xsrf'].includes(cookie.name) && isZhihuAuthHost(cookie.domain))
    .map((cookie) => cookie.domain + '\0' + cookie.name + '\0' + cookie.value).sort();
  return digest(rows);
}
function urlPathname(raw) {
  try { return new URL(raw).pathname.slice(0, 96); } catch { return ''; }
}
async function proveSelf(context) {
  const page = await context.newPage();
  try {
    await gotoAuthenticated(page, 'https://www.zhihu.com/');
    const topBar = await topBarPeopleTokens(page);
    const first = await selfTokenFromPage(page);
    if (!first) {
      emitStep({ step: 'login.prove_self', ok: false, reason: 'home-no-unique-token', candidateCount: Array.from(new Set(topBar)).length });
      return null;
    }
    await gotoAuthenticated(page, 'https://www.zhihu.com/people/' + first);
    const current = peopleTokenFromPath(new URL(page.url()).pathname) || await selfTokenFromPage(page);
    if (current !== first) {
      emitStep({ step: 'login.prove_self', ok: false, reason: 'people-page-token-mismatch' });
      return null;
    }
    const profile = await projectProfile(page, first).catch(() => null);
    if (!profile || !profile.urlToken) {
      emitStep({ step: 'login.prove_self', ok: false, reason: 'profile-projection-null' });
      return null;
    }
    return first;
  } catch { return null; }
  finally { await page.close().catch(() => {}); }
}
async function runLogin(input, relay) {
  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, { cookies: [], origins: [] }, allowed);
    const home = await context.newPage();
    await home.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await home.waitForTimeout(1500);
    await assertNoChallenge(home);
    await switchToQrLogin(home);
    let png = await captureQr(home);
    let qrHash = digest(png.toString('base64'));
    writeFrame({ event: 'qr', png: png.toString('base64') });
    const initialCookies = await authCookieDigest(context);
    let nextQr = Date.now() + QR_REFRESH_MS;
    let nextProbe = 0;
    let signalEmitted = false;
    while (Date.now() < input.deadlineMs) {
      await assertNoChallenge(home);
      if (Date.now() >= nextQr) {
        nextQr = Date.now() + QR_REFRESH_MS;
        await switchToQrLogin(home);
        const fresh = await captureQr(home).catch(() => null);
        if (fresh) {
          const freshHash = digest(fresh.toString('base64'));
          if (freshHash !== qrHash) {
            qrHash = freshHash;
            png = fresh;
            writeFrame({ event: 'qr', png: png.toString('base64') });
            emitStep({ step: 'login.qr_refresh' });
          }
        }
      }
      const cookieChanged = (await authCookieDigest(context)) !== initialCookies;
      const leftSignin = !/\/signin/.test(home.url());
      const signal = cookieChanged || leftSignin;
      if (signal && !signalEmitted) {
        signalEmitted = true;
        emitStep({
          step: 'login.signal',
          ok: true,
          reason: cookieChanged ? 'cookie-changed' : 'url-left-signin',
          pathname: urlPathname(home.url())
        });
      }
      if (signal && Date.now() >= nextProbe) {
        nextProbe = Date.now() + 5_000;
        const selfId = await proveSelf(context);
        if (selfId) {
          const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
          await writeTerminalAndExit({ event: 'authenticated', storageState: state });
        }
      }
      await home.waitForTimeout(800);
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
  writeFrame({ event: 'ready', runtime: 'zhihu-worker-v1', playwrightMcpVersion });
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
`;
