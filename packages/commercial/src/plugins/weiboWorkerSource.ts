/**
 * Reviewed Weibo worker. It drives the public web UI only: no Playwright request
 * client, response-body inspection, private endpoint replay, or challenge bypass.
 *
 * Listed backup, not implemented: login cookies + picupload.weibo.com +
 * /ajax/statuses/update. That path needs an origin allowlist and a product-contract
 * change. Current media path stays DOM-only: arm filechooser, click in parallel,
 * and setFiles inside the filechooser callback before any other Playwright work.
 */
export const WEIBO_WORKER_SOURCE = String.raw`
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
  'https://weibo.com', 'https://m.weibo.cn', 'https://s.weibo.com',
  'https://passport.weibo.com', 'https://h5.sinaimg.cn', 'https://js.t.sinajs.cn',
  'https://img.t.sinajs.cn', 'https://tvax1.sinaimg.cn',
  'https://tvax2.sinaimg.cn', 'https://tvax3.sinaimg.cn', 'https://tvax4.sinaimg.cn',
  'https://wx1.sinaimg.cn', 'https://wx2.sinaimg.cn', 'https://wx3.sinaimg.cn',
  'https://wx4.sinaimg.cn'
]);
const WRITE_ACTIONS = new Set([
  'create_post', 'edit_post', 'delete_post', 'create_comment', 'reply_comment',
  'delete_comment', 'repost_post', 'set_post_like', 'set_following',
  'send_message', 'set_post_favorite', 'set_comment_like'
]);
const RISK_TEXT = /安全验证|访问异常|操作频繁|账号存在风险|请完成验证|验证码|登录保护|行为异常/;
const NORMAL_LOGIN_VERIFICATION_TEXT = /验证码登录|获取验证码/g;
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
  if (message === 'composer-editor') return 'WEIBO_WRITE_COMPOSER_EDITOR';
  if (message === 'composer-readback') return 'WEIBO_WRITE_COMPOSER_READBACK';
  if (message === 'composer-longtext') return 'WEIBO_WRITE_COMPOSER_LONGTEXT';
  if (message === 'composer') return 'WEIBO_WRITE_COMPOSER';
  if (message === 'media-chooser') return 'WEIBO_WRITE_MEDIA_CHOOSER';
  if (message === 'media-upload') return 'WEIBO_WRITE_MEDIA_UPLOAD';
  if (message === 'media-preview-timeout') return 'WEIBO_WRITE_MEDIA_PREVIEW_TIMEOUT';
  if (message === 'media-preview') return 'WEIBO_WRITE_MEDIA_PREVIEW';
  if (message === 'media') return 'WEIBO_WRITE_MEDIA';
  if (message === 'send-button') return 'WEIBO_WRITE_SEND_BUTTON';
  if (message === 'send-click') return 'WEIBO_WRITE_SEND_CLICK';
  if (message === 'send-uncleared') return 'WEIBO_WRITE_SEND_UNCLEARED';
  if (message === 'send') return 'WEIBO_WRITE_SEND';
  if (message === 'result') return 'WEIBO_WRITE_RESULT';
  return 'WORKER_FAILED';
}
function emitStep(event) {
  try {
    const payload = { src: 'weibo-worker', t: Date.now() };
    if (event && typeof event === 'object') {
      if (typeof event.step === 'string') payload.step = String(event.step).slice(0, 64);
      if (event.ok === true || event.ok === false) payload.ok = event.ok;
      if (typeof event.ms === 'number' && Number.isFinite(event.ms)) payload.ms = Math.round(event.ms);
      if (typeof event.hits === 'number' && Number.isFinite(event.hits)) payload.hits = Math.round(event.hits);
      if (typeof event.timeoutMs === 'number' && Number.isFinite(event.timeoutMs)) payload.timeoutMs = Math.round(event.timeoutMs);
      if (typeof event.textLen === 'number' && Number.isFinite(event.textLen)) payload.textLen = Math.round(event.textLen);
      if (typeof event.textHash8 === 'string') payload.textHash8 = String(event.textHash8).slice(0, 8);
      if (event.longText === true || event.longText === false) payload.longText = event.longText;
      if (event.hasImage === true || event.hasImage === false) payload.hasImage = event.hasImage;
      if (event.retried === true || event.retried === false) payload.retried = event.retried;
      if (typeof event.mediaCount === 'number' && Number.isFinite(event.mediaCount)) payload.mediaCount = Math.round(event.mediaCount);
      if (typeof event.scopeInputs === 'number' && Number.isFinite(event.scopeInputs)) payload.scopeInputs = Math.round(event.scopeInputs);
      if (typeof event.pageInputs === 'number' && Number.isFinite(event.pageInputs)) payload.pageInputs = Math.round(event.pageInputs);
      if (typeof event.scopeImageInputs === 'number' && Number.isFinite(event.scopeImageInputs)) payload.scopeImageInputs = Math.round(event.scopeImageInputs);
      if (typeof event.pageImageInputs === 'number' && Number.isFinite(event.pageImageInputs)) payload.pageImageInputs = Math.round(event.pageImageInputs);
      if (typeof event.imageTitleHits === 'number' && Number.isFinite(event.imageTitleHits)) payload.imageTitleHits = Math.round(event.imageTitleHits);
      if (typeof event.imageIconHits === 'number' && Number.isFinite(event.imageIconHits)) payload.imageIconHits = Math.round(event.imageIconHits);
      if (typeof event.imageTextHits === 'number' && Number.isFinite(event.imageTextHits)) payload.imageTextHits = Math.round(event.imageTextHits);
      if (typeof event.imageControlHits === 'number' && Number.isFinite(event.imageControlHits)) payload.imageControlHits = Math.round(event.imageControlHits);
      if (typeof event.selected === 'number' && Number.isFinite(event.selected)) payload.selected = Math.round(event.selected);
      if (typeof event.freshSelected === 'number' && Number.isFinite(event.freshSelected)) payload.freshSelected = Math.round(event.freshSelected);
      if (typeof event.imgCount === 'number' && Number.isFinite(event.imgCount)) payload.imgCount = Math.round(event.imgCount);
      if (typeof event.addedSrcs === 'number' && Number.isFinite(event.addedSrcs)) payload.addedSrcs = Math.round(event.addedSrcs);
      if (typeof event.bgCount === 'number' && Number.isFinite(event.bgCount)) payload.bgCount = Math.round(event.bgCount);
      if (typeof event.canvasCount === 'number' && Number.isFinite(event.canvasCount)) payload.canvasCount = Math.round(event.canvasCount);
      if (typeof event.frameCount === 'number' && Number.isFinite(event.frameCount)) payload.frameCount = Math.round(event.frameCount);
      if (typeof event.deleteHits === 'number' && Number.isFinite(event.deleteHits)) payload.deleteHits = Math.round(event.deleteHits);
      if (typeof event.code === 'string') payload.code = String(event.code).slice(0, 64);
      if (typeof event.actionId === 'string') payload.actionId = String(event.actionId).slice(0, 64);
      if (typeof event.branch === 'string') payload.branch = String(event.branch).slice(0, 32);
      if (typeof event.reason === 'string') payload.reason = String(event.reason).slice(0, 32);
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
  return {
    cookies,
    origins: filteredOrigins
  };
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function cleanText(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanPostText(value, max) { return cleanText(String(value || '').replace(/ \u200B{3}$/g, ''), max); }
function countFrom(value) {
  const text = cleanText(value, 40).replace(/,/g, '');
  const match = /(\d+(?:\.\d+)?)\s*([万亿]?)/.exec(text);
  if (!match) return 0;
  const scale = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1;
  return Math.max(0, Math.round(Number(match[1]) * scale));
}
function numericUid(raw) {
  try {
    const url = new URL(raw, 'https://weibo.com/');
    const match = /^\/u\/(\d{5,20})(?:\/|$)/.exec(url.pathname) || /^\/(\d{5,20})(?:\/|$)/.exec(url.pathname);
    if (match) return match[1];
    const query = url.searchParams.get('uid') || '';
    return /^\d{5,20}$/.test(query) ? query : null;
  } catch { return null; }
}
function postIdentity(raw) {
  try {
    const url = new URL(raw, 'https://weibo.com/');
    const match = /^\/(\d{5,20})\/([A-Za-z0-9_-]{5,32})\/?$/.exec(url.pathname);
    return match ? { userId: match[1], postId: match[2], url: 'https://weibo.com/' + match[1] + '/' + match[2] } : null;
  } catch { return null; }
}
async function bodyText(page) { return cleanText(await page.locator('body').innerText().catch(() => ''), 100000); }
async function assertNoChallenge(page) {
  // The standard sign-in page offers SMS as an alternative to QR login. Its
  // labels are not a challenge; every other occurrence of 验证码 remains
  // fail-closed below.
  const text = (await bodyText(page)).replace(NORMAL_LOGIN_VERIFICATION_TEXT, '');
  if (RISK_TEXT.test(text) || /geetest|challenge/.test(page.url()))
    await writeTerminalAndExit({ event: 'failed', code: 'UPSTREAM_FAILED' });
}
async function isLoginVisible(page) {
  return await page.getByRole('button', { name: '登录/注册' }).first().isVisible().catch(() => false) || /\/newlogin(?:[/?#]|$)/.test(page.url());
}
async function selfIdFromPage(page) {
  const candidates = await page.locator('a[href]').evaluateAll((anchors) => {
    const rows = [];
    for (const anchor of anchors) {
      const bounds = anchor.getBoundingClientRect();
      const style = getComputedStyle(anchor);
      if (bounds.width <= 0 || bounds.height <= 0 || bounds.top < 0 || bounds.top > 180 || style.visibility !== 'visible' || style.display === 'none') continue;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const match = /^\/u\/(\d{5,20})(?:\/|$)/.exec(url.pathname);
      if (!match || !anchor.querySelector('img')) continue;
      rows.push({ id: match[1], top: bounds.top, right: bounds.right });
    }
    rows.sort((a, b) => a.top - b.top || b.right - a.right);
    return rows.map((row) => row.id);
  });
  const unique = Array.from(new Set(candidates));
  return unique.length === 1 ? unique[0] : null;
}
async function gotoAuthenticated(page, url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      break;
    } catch (error) {
      const retryable = /net::ERR_(?:EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|HTTP2_PROTOCOL_ERROR|NAME_NOT_RESOLVED)/.test(String(error));
      if (attempt !== 0 || !retryable) throw error;
      await page.waitForTimeout(1_000);
    }
  }
  await page.waitForTimeout(2500);
  await assertNoChallenge(page);
  if (await isLoginVisible(page)) await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
}
async function ensureSelfId(page) {
  await gotoAuthenticated(page, 'https://weibo.com/');
  const id = await selfIdFromPage(page);
  if (!id) await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
  return id;
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
async function uniqueExactControl(locator, labels) {
  const matches = [];
  const total = Math.min(await locator.count(), 200);
  for (let index = 0; index < total; index += 1) {
    const candidate = locator.nth(index);
    if (labels.includes(cleanText(await candidate.innerText().catch(() => ''), 100)) && await visible(candidate)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function findPostCard(page, userId, postId) {
  const target = 'https://weibo.com/' + userId + '/' + postId;
  const exact = page.locator('a[href]');
  const count = await exact.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = exact.nth(index);
    const href = await candidate.getAttribute('href');
    const identity = postIdentity(href || '');
    if (!identity || identity.url !== target) continue;
    const article = candidate.locator('xpath=ancestor::article[1]');
    if (await article.count()) return article.first();
    const card = candidate.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," card-wrap ")][1]');
    if (await card.count()) return card.first();
  }
  return null;
}
async function awaitPostCard(page, userId, postId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const card = await findPostCard(page, userId, postId);
    if (card && await card.count()) return card;
    await page.waitForTimeout(500);
  }
  return null;
}
async function projectPost(card, selfId, expectedUserId, expectedPostId) {
  const data = await card.evaluate((root, expected) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    let identity = null;
    let permalink = null;
    for (const anchor of root.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const match = /^\/(\d{5,20})\/([A-Za-z0-9_-]{5,32})\/?$/.exec(url.pathname);
      if (!match) continue;
      const candidate = { userId: match[1], postId: match[2] };
      if (!identity) {
        identity = candidate;
        permalink = 'https://weibo.com/' + match[1] + '/' + match[2];
      }
      if (expected && candidate.userId === expected.userId && candidate.postId === expected.postId) {
        identity = candidate;
        permalink = 'https://weibo.com/' + match[1] + '/' + match[2];
        break;
      }
    }
    if (expected && (!identity || identity.userId !== expected.userId || identity.postId !== expected.postId)) return null;
    if (!identity || !permalink) return null;
    const textCandidates = Array.from(root.querySelectorAll('[class*="wbtext"], [class*="text_"], [node-type="feed_list_content"]'))
      .filter(visible).map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 0 && text.length <= 20000).sort((a, b) => b.length - a.length);
    const text = textCandidates[0] || '';
    const authorAnchor = Array.from(root.querySelectorAll('a[href], [usercard]')).find((element) => {
      const value = element.getAttribute('usercard') || element.getAttribute('href') || '';
      return value.includes(identity.userId) && visible(element);
    });
    const authorName = (authorAnchor && (authorAnchor.getAttribute('title') || authorAnchor.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const timeAnchor = Array.from(root.querySelectorAll('a[href]')).find((anchor) => {
      try { return new URL(anchor.href, location.href).pathname === '/' + identity.userId + '/' + identity.postId; } catch { return false; }
    });
    const createdAt = (timeAnchor && (timeAnchor.getAttribute('title') || timeAnchor.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const images = [];
    for (const image of root.querySelectorAll('img[src]')) {
      if (!visible(image) || image.naturalWidth < 100 || image.naturalHeight < 100) continue;
      let url;
      try { url = new URL(image.src, location.href); } catch { continue; }
      if (!/sinaimg\.cn$/.test(url.hostname)) continue;
      const item = { url: url.toString().slice(0, 2048) };
      const alt = (image.alt || '').trim();
      if (alt) item.alt = alt.slice(0, 512);
      if (!images.some((known) => known.url === item.url)) images.push(item);
      if (images.length >= 18) break;
    }
    const like = root.querySelector('button.woo-like-main');
    const liked = !!like && (like.getAttribute('aria-pressed') === 'true' || /(?:^|\s)_cur_/.test(like.className));
    const actionText = (selector) => {
      const icon = root.querySelector(selector);
      const parent = icon && (icon.closest('button, a, [role="button"], .woo-box-item-flex') || icon.parentElement);
      return parent ? parent.textContent || '' : '';
    };
    return {
      id: identity.postId, userId: identity.userId, authorName, text, createdAt, url: permalink,
      liked, likeText: like ? like.textContent || '' : '',
      commentText: actionText('i.woo-font--comment'), repostText: actionText('i.woo-font--retweet'), images
    };
  }, expectedUserId && expectedPostId ? { userId: expectedUserId, postId: expectedPostId } : null);
  if (!data) throw new Error('post');
  const stable = { id: data.id, userId: data.userId, text: cleanPostText(data.text, 20000), images: data.images.map((image) => image.url) };
  return {
    id: data.id,
    userId: data.userId,
    ...(data.authorName ? { authorName: data.authorName } : {}),
    text: stable.text,
    ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    url: data.url,
    owned: data.userId === selfId,
    liked: data.liked,
    likeCount: countFrom(data.likeText),
    commentCount: countFrom(data.commentText),
    repostCount: countFrom(data.repostText),
    images: data.images,
    contentDigest: digest(stable)
  };
}
async function collectPosts(page, selfId, count) {
  const roots = page.locator('article, .card-wrap');
  const output = [];
  const total = Math.min(await roots.count(), 100);
  for (let index = 0; index < total && output.length < count; index += 1) {
    const card = roots.nth(index);
    const post = await projectPost(card, selfId).catch(() => null);
    if (post && !output.some((known) => known.id === post.id && known.userId === post.userId)) output.push(post);
  }
  return output;
}
async function projectMobileSearchPost(card, selfId) {
  const data = await card.evaluate((root) => {
    let mid = null;
    let userId = null;
    for (const anchor of root.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const status = /^\/status\/(\d{5,20})\/?$/.exec(url.pathname);
      if (status) mid = status[1];
      const user = /^\/u\/(\d{5,20})(?:\/|$)/.exec(url.pathname);
      const container = /^100505(\d{5,20})$/.exec(url.searchParams.get('containerid') || '');
      if (user || container) userId = (user || container)[1];
    }
    const textRoot = root.querySelector('.weibo-text');
    const text = (textRoot && textRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    const authorName = (root.querySelector('header h3.m-text-cut')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const createdAt = (root.querySelector('header h4.m-text-cut')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const controls = Array.from(root.querySelectorAll('footer .m-diy-btn')).map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim());
    const images = [];
    for (const image of root.querySelectorAll('article img[src]')) {
      let url;
      try { url = new URL(image.src, location.href); } catch { continue; }
      if (!/sinaimg\.cn$/.test(url.hostname)) continue;
      const item = { url: url.toString().slice(0, 2048) };
      const alt = (image.alt || '').trim();
      if (alt) item.alt = alt.slice(0, 512);
      if (!images.some((known) => known.url === item.url)) images.push(item);
      if (images.length >= 18) break;
    }
    return { mid, userId, text, authorName, createdAt, controls, images };
  });
  if (!data.mid || !data.text) return null;
  const id = data.mid;
  const stable = { id, userId: data.userId || null, text: cleanText(data.text, 20000), images: data.images.map((image) => image.url) };
  return {
    id,
    ...(data.userId ? { userId: data.userId } : {}),
    ...(data.authorName ? { authorName: data.authorName } : {}),
    text: stable.text,
    ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    url: 'https://m.weibo.cn/status/' + data.mid,
    ...(data.userId && selfId ? { owned: data.userId === selfId } : {}),
    likeCount: countFrom(data.controls[2] || ''),
    commentCount: countFrom(data.controls[1] || ''),
    repostCount: countFrom(data.controls[0] || ''),
    images: data.images,
    detailAvailable: false,
    contentDigest: digest(stable)
  };
}
async function collectMobileSearchPosts(page, selfId, count) {
  const cards = page.locator('.card');
  const output = [];
  const total = Math.min(await cards.count(), 100);
  for (let index = 0; index < total && output.length < count; index += 1) {
    const post = await projectMobileSearchPost(cards.nth(index), selfId).catch(() => null);
    if (post && !output.some((known) => known.id === post.id)) output.push(post);
  }
  return output;
}
async function projectUser(page, userId, selfId) {
  const data = await page.evaluate((expected) => {
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,[class*="name"]')).find((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.top < 600 && (element.textContent || '').trim().length > 0;
    });
    const name = (heading && (heading.textContent || '') || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const stat = (label) => {
      const match = new RegExp('(\\d+(?:\\.\\d+)?[万亿]?)\\s*' + label).exec(text);
      return match ? match[1] : '';
    };
    const bioElement = Array.from(document.querySelectorAll('[class*="intro"], [class*="desc"], [title]')).find((element) => {
      const value = (element.textContent || '').replace(/\s+/g, ' ').trim();
      return value.length > 0 && value.length <= 2000 && /简介|认证|签名/.test(value);
    });
    const follow = Array.from(document.querySelectorAll('button,[role="button"]')).find((element) => /^(关注|已关注|互相关注)$/.test((element.textContent || '').replace(/\s+/g, '').trim()));
    return {
      name,
      bio: (bioElement && bioElement.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
      verified: /认证/.test(text),
      following: !!follow && !/^关注$/.test((follow.textContent || '').replace(/\s+/g, '').trim()),
      follower: stat('粉丝'), followingCount: stat('关注'), posts: stat('微博'), expected
    };
  }, userId);
  return {
    id: userId,
    name: data.name || ('微博用户' + userId.slice(-4)),
    profileUrl: 'https://weibo.com/u/' + userId,
    ...(data.bio ? { bio: data.bio } : {}),
    verified: data.verified,
    following: userId === selfId ? true : data.following,
    followerCount: countFrom(data.follower),
    followingCount: countFrom(data.followingCount),
    postCount: countFrom(data.posts)
  };
}
async function projectComment(root, postId, selfId, parentCommentId) {
  const raw = await root.evaluate((element) => {
    const nested = element.classList.contains('item2');
    const body = nested ? element.querySelector(':scope > .con2') : element.querySelector(':scope > .item1in .con1');
    const textRoot = body && body.querySelector('.text');
    const anchors = textRoot ? Array.from(textRoot.querySelectorAll('a[href]')) : [];
    const authorAnchors = anchors.flatMap((anchor) => {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { return []; }
      const match = /^\/u\/(\d{5,20})(?:\/|$)/.exec(url.pathname);
      return match ? [{ anchor, userId: match[1] }] : [];
    });
    const author = authorAnchors.find((item) => (item.anchor.textContent || '').trim().length > 0) || authorAnchors[0];
    const authorName = (author && (author.anchor.getAttribute('title') || author.anchor.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    let text = (textRoot && textRoot.textContent || '').replace(/\s+/g, ' ').trim();
    if (authorName && text.startsWith(authorName)) text = text.slice(authorName.length).replace(/^\s*[：:]\s*/, '');
    const info = body && body.querySelector('.info');
    const createdAt = info && Array.from(info.children).map((child) => ({ child, text: (child.textContent || '').replace(/\s+/g, ' ').trim() })).find((item) => !item.child.classList.contains('opt') && item.text.length > 0);
    const like = body && body.querySelector('button.woo-like-main');
    const liked = !!like && (like.getAttribute('aria-pressed') === 'true' || /(?:^|\s)_cur_/.test(like.closest('[class*="_likebox_"]')?.className || '') || !!like.querySelector('.woo-like-liked'));
    return {
      userId: author && author.userId, text: text.slice(0, 5000), authorName,
      createdAt: createdAt && createdAt.text.slice(0, 128), liked,
      likeText: like && (like.textContent || '').slice(0, 40)
    };
  });
  if (!raw.userId || !/^\d{5,20}$/.test(raw.userId) || !raw.createdAt) return null;
  const text = cleanText(raw.text, 5000);
  const createdAt = cleanText(raw.createdAt, 128);
  const id = digest({ postId, userId: raw.userId, text, parentCommentId: parentCommentId || null });
  const stable = { id, postId, userId: raw.userId, text };
  return {
    ...stable,
    ...(raw.authorName ? { authorName: raw.authorName } : {}),
    createdAt,
    ...(parentCommentId ? { parentCommentId } : {}),
    owned: raw.userId === selfId,
    liked: raw.liked,
    likeCount: countFrom(raw.likeText || ''),
    contentDigest: digest(stable)
  };
}
async function collectCommentEntries(page, postId, selfId) {
  const entries = [];
  let totalNodes = 0;
  let projectedNodes = 0;
  let truncated = false;
  const roots = page.locator('.wbpro-scroller-item > .wbpro-list > .item1');
  const availableRoots = await roots.count();
  const rootCount = Math.min(availableRoots, 100);
  truncated = availableRoots > rootCount;
  for (let index = 0; index < rootCount; index += 1) {
    const root = roots.nth(index);
    totalNodes += 1;
    const comment = await projectComment(root, postId, selfId, null).catch(() => null);
    if (!comment) continue;
    projectedNodes += 1;
    entries.push({ root, comment });
    const replies = root.locator(':scope > .list2 .item2');
    const availableReplies = await replies.count();
    const replyCount = Math.min(availableReplies, 100);
    truncated = truncated || availableReplies > replyCount;
    totalNodes += replyCount;
    for (let replyIndex = 0; replyIndex < replyCount; replyIndex += 1) {
      const replyRoot = replies.nth(replyIndex);
      const reply = await projectComment(replyRoot, postId, selfId, comment.id).catch(() => null);
      if (!reply) continue;
      projectedNodes += 1;
      entries.push({ root: replyRoot, comment: reply });
    }
  }
  const counts = new Map();
  for (const entry of entries) counts.set(entry.comment.id, (counts.get(entry.comment.id) || 0) + 1);
  const unique = entries.filter((entry) => counts.get(entry.comment.id) === 1);
  return { entries: unique, totalNodes, projectedNodes, collisions: entries.length - unique.length, truncated };
}
async function findComment(page, postId, commentId, selfId) {
  const matches = (await collectCommentEntries(page, postId, selfId)).entries.filter((entry) => entry.comment.id === commentId);
  return matches.length === 1 ? matches[0] : null;
}
async function projectUserCard(anchor, selfId) {
  const raw = await anchor.evaluate((element) => {
    let url;
    try { url = new URL(element.href, location.href); } catch { return null; }
    const match = /^\/u\/(\d{5,20})(?:\/|$)/.exec(url.pathname);
    if (!match) return null;
    const root = element.closest('.list_person, .wbpro-scroller-item, li, article, [class*="card"]') || element.parentElement || element;
    const sameUser = Array.from(root.querySelectorAll('a[href]')).filter((candidate) => {
      try { return new URL(candidate.href, location.href).pathname === '/u/' + match[1]; } catch { return false; }
    });
    const named = sameUser.find((candidate) => (candidate.textContent || '').trim().length > 0);
    const name = ((named && (named.getAttribute('title') || named.textContent)) || element.getAttribute('title') || element.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 128);
    const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
    const follow = Array.from(root.querySelectorAll('button,[role="button"]')).find((candidate) => /^(关注|已关注|互相关注)$/.test((candidate.textContent || '').replace(/\s+/g, '').trim()));
    const follower = /粉丝[：:]?\s*(\d+(?:\.\d+)?[万亿]?)/.exec(text) || /(\d+(?:\.\d+)?[万亿]?)\s*粉丝/.exec(text);
    return {
      id: match[1], name, text, follower: follower && follower[1],
      verified: /认证|icon_approve|verified/.test(text + ' ' + root.className),
      following: !!follow && !/^关注$/.test((follow.textContent || '').replace(/\s+/g, '').trim())
    };
  });
  if (!raw || !raw.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    profileUrl: 'https://weibo.com/u/' + raw.id,
    verified: raw.verified,
    following: raw.id === selfId ? true : raw.following,
    ...(raw.follower ? { followerCount: countFrom(raw.follower) } : {})
  };
}
async function collectUsers(page, selfId, count) {
  const roots = page.locator('.wbpro-scroller-item, .list_person, .card-user-b');
  const users = [];
  const seen = new Set();
  const total = Math.min(await roots.count(), 200);
  for (let index = 0; index < total && users.length < count; index += 1) {
    const root = roots.nth(index);
    if (!await visible(root)) continue;
    const anchors = root.locator('a[href*="/u/"]');
    let anchor = null;
    const anchorCount = Math.min(await anchors.count(), 20);
    for (let anchorIndex = 0; anchorIndex < anchorCount; anchorIndex += 1) {
      const candidate = anchors.nth(anchorIndex);
      if (await visible(candidate)) { anchor = candidate; break; }
    }
    if (!anchor) continue;
    const user = await projectUserCard(anchor, selfId).catch(() => null);
    if (!user || seen.has(user.id)) continue;
    seen.add(user.id);
    users.push(user);
  }
  const text = await bodyText(page);
  const explicitEnd = /暂无数据|暂无内容|没有更多内容了|没有更多了/.test(text);
  const clientOnly = /更多内容请至客户端查看/.test(text);
  return { users, complete: explicitEnd && !clientOnly && users.length <= count };
}
async function projectNotification(root, category) {
  const raw = await root.evaluate((element) => {
    const visible = (candidate) => {
      const bounds = candidate.getBoundingClientRect(); const style = getComputedStyle(candidate);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const actors = [];
    let target = null;
    for (const anchor of element.querySelectorAll('a[href]')) {
      if (!visible(anchor)) continue;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const user = /^\/u\/(\d{5,20})(?:\/|$)/.exec(url.pathname);
      if (user) {
        const name = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
        actors.push({ id: user[1], name, url: 'https://weibo.com/u/' + user[1] });
      }
      const post = /^\/(\d{5,20})\/([A-Za-z0-9_-]{5,32})\/?$/.exec(url.pathname);
      if (post) target = { userId: post[1], postId: post[2], url: 'https://weibo.com/' + post[1] + '/' + post[2] };
    }
    const actor = actors.find((candidate) => candidate.name) || actors[0] || null;
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
    const time = Array.from(element.querySelectorAll('time,a,span')).map((candidate) => (candidate.getAttribute('title') || candidate.textContent || '').replace(/\s+/g, ' ').trim())
      .find((value) => /(?:\d{1,2}[-月]\d{1,2}|\d{1,2}:\d{2}|分钟前|小时前|昨天)/.test(value)) || '';
    const unread = !!element.querySelector('.woo-badge-dot,.woo-badge-count,[class*="unread"],[class*="new_"]');
    return { actor, target, text, time: time.slice(0, 128), unread };
  });
  if (!raw.actor || !raw.text) return null;
  const stable = { category, actorId: raw.actor.id, text: cleanText(raw.text, 5000), url: raw.target?.url || raw.actor.url };
  return {
    id: digest(stable),
    category,
    actor: { id: raw.actor.id, name: raw.actor.name || ('微博用户' + raw.actor.id.slice(-4)), profileUrl: raw.actor.url },
    text: stable.text,
    ...(raw.time ? { createdAt: raw.time } : {}),
    unread: raw.unread,
    ...(raw.target ? { userId: raw.target.userId, postId: raw.target.postId } : {}),
    url: stable.url,
    contentDigest: digest(stable)
  };
}
async function collectNotifications(page, category, count) {
  const roots = page.locator('.wbpro-scroller-item');
  const notifications = [];
  const seen = new Set();
  const total = Math.min(await roots.count(), 200);
  for (let index = 0; index < total && notifications.length < count; index += 1) {
    const item = await projectNotification(roots.nth(index), category).catch(() => null);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    notifications.push(item);
  }
  const text = await bodyText(page);
  return {
    notifications,
    complete: /暂无数据|暂无内容|没有更多内容了|没有更多了/.test(text) && notifications.length <= count
  };
}
async function unreadCounts(page) {
  await gotoAuthenticated(page, 'https://weibo.com/');
  const message = page.locator('a[title="消息"]').first();
  if (await visible(message)) {
    await message.hover().catch(() => {});
    await page.waitForTimeout(500);
  }
  const desktop = await page.evaluate(() => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const aliases = new Map([['@我的', 'mentions'], ['评论', 'comments'], ['赞', 'likes'], ['新粉丝', 'followers'], ['粉丝', 'followers'], ['私信', 'privateMessages']]);
    const counts = { mentions: 0, comments: 0, likes: 0, followers: 0, privateMessages: 0 };
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (!visible(anchor)) continue;
      const label = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      const key = aliases.get(label);
      if (!key) continue;
      seen.add(key);
      const root = anchor.closest('li,[role="menuitem"],.woo-pop-item-main') || anchor;
      const badge = root.querySelector('.woo-badge-count,[class*="badge-count"]');
      const match = /\d+/.exec((badge && badge.textContent) || '');
      counts[key] = match ? Number(match[0]) : 0;
    }
    return { counts, complete: ['mentions','comments','likes','followers','privateMessages'].every((key) => seen.has(key)) };
  });
  try {
    await gotoMessagePage(page, 'https://m.weibo.cn/message');
    await page.waitForFunction(() => document.querySelectorAll('.lite-msg-list').length >= 4, null, { timeout: 15_000 });
    const mobile = await page.locator('.lite-msg-list').evaluateAll((rows) => {
      const aliases = new Map([['@我的', 'mentions'], ['评论', 'comments'], ['赞', 'likes'], ['未关注人私信', 'privateMessages']]);
      const counts = { mentions: 0, comments: 0, likes: 0, privateMessages: 0 };
      const seen = new Set();
      for (const row of rows.slice(0, 4)) {
        const label = (row.querySelector('h3') && row.querySelector('h3').textContent || '').replace(/\s+/g, ' ').trim();
        const key = aliases.get(label);
        if (!key) continue;
        seen.add(key);
        const badge = row.querySelector('.m-bubble-red');
        counts[key] = Number.parseInt((badge && badge.textContent || '0').trim(), 10) || 0;
      }
      for (const row of rows.slice(4)) {
        const badge = row.querySelector('.m-bubble-red');
        counts.privateMessages += Number.parseInt((badge && badge.textContent || '0').trim(), 10) || 0;
      }
      return { counts, complete: ['mentions','comments','likes','privateMessages'].every((key) => seen.has(key)) };
    });
    for (const key of ['mentions', 'comments', 'likes', 'privateMessages'])
      desktop.counts[key] = Math.max(desktop.counts[key], mobile.counts[key]);
    desktop.complete = desktop.complete && mobile.complete;
  } catch {}
  return desktop;
}
async function hotSearches(page, count) {
  await gotoAuthenticated(page, 'https://weibo.com/');
  return page.locator('.hotBand a[href*="s.weibo.com/weibo"]').evaluateAll((anchors, maximum) => {
    const output = [];
    const seen = new Set();
    let truncated = false;
    for (const anchor of anchors) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      let keyword = (url.searchParams.get('q') || '').replace(/^#|#$/g, '').trim();
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      if (output.length >= maximum) {
        truncated = true;
        continue;
      }
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      const trailing = /(\d{3,})$/.exec(text);
      const item = { rank: output.length + 1, keyword: keyword.slice(0, 200), url: url.toString().slice(0, 512) };
      if (trailing) item.hotValue = Number(trailing[1]);
      if (/登顶/.test(text)) item.label = '登顶';
      output.push(item);
    }
    return { searches: output, complete: !truncated };
  }, count);
}
async function gotoMessagePage(page, url) {
  let failure = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await gotoAuthenticated(page, url);
      return;
    } catch (error) {
      failure = error;
      if (attempt < 2) await page.waitForTimeout(750);
    }
  }
  throw failure || new Error('message');
}
function isMessagePageEmptyResponse(error) {
  return /(?:^|\s)net::ERR_EMPTY_RESPONSE(?:\s|$)/.test(String(error));
}
function avatarUserId(src) {
  let filename = '';
  try { filename = new URL(src).pathname.split('/').pop() || ''; } catch { return null; }
  const prefix = filename.slice(0, 8);
  let value = NaN;
  if (/^00[0-9A-Za-z]{6}$/.test(prefix)) {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    value = 0;
    for (const character of prefix) {
      const digit = alphabet.indexOf(character);
      if (digit < 0) return null;
      value = value * 62 + digit;
    }
  } else if (/^[0-9a-f]{8}$/i.test(prefix)) value = Number.parseInt(prefix, 16);
  if (!Number.isSafeInteger(value)) return null;
  const userId = String(value);
  return /^\d{5,20}$/.test(userId) ? userId : null;
}
async function collectMessageThreads(page, count) {
  try {
    await gotoMessagePage(page, 'https://m.weibo.cn/message');
  } catch (error) {
    if (isMessagePageEmptyResponse(error)) return {
      threads: [],
      complete: false,
      degradedReason: 'upstream_message_page_empty_response'
    };
    throw error;
  }
  await page.waitForFunction(() => document.querySelectorAll('.lite-msg-list').length >= 4 || /暂无|出错|重试/.test(document.body.innerText || ''), null, { timeout: 15_000 }).catch(() => {});
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await page.locator('.lite-msg-list').count();
    if (Math.max(0, before - 4) >= count) break;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(900);
    const after = await page.locator('.lite-msg-list').count();
    if (after === before) break;
  }
  await assertNoChallenge(page);
  const raw = await page.locator('.lite-msg-list').evaluateAll((rows) => rows.slice(4).map((row) => {
    const name = row.querySelector('h3.m-text-cut');
    const preview = row.querySelector('.m-box-col.m-box-dir .m-text-box h4.m-text-cut');
    const date = row.querySelector('.box-right h4.m-text-cut');
    const badge = row.querySelector('.m-bubble-red');
    const image = row.querySelector('img');
    return {
      userName: (name && name.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128),
      lastMessage: (preview && preview.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
      lastMessageAt: (date && date.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128),
      unreadCount: Number.parseInt((badge && badge.textContent || '0').trim(), 10) || 0,
      avatar: image && image.src || ''
    };
  }));
  const threads = [];
  const seen = new Set();
  for (const item of raw) {
    const userId = avatarUserId(item.avatar);
    if (!userId || !item.userName || seen.has(userId)) continue;
    seen.add(userId);
    const stable = {
      userId, userName: item.userName, lastMessage: item.lastMessage,
      lastMessageAt: item.lastMessageAt, unreadCount: item.unreadCount
    };
    threads.push({
      userId,
      userName: item.userName,
      profileUrl: 'https://weibo.com/u/' + userId,
      lastMessage: item.lastMessage,
      ...(item.lastMessageAt ? { lastMessageAt: item.lastMessageAt } : {}),
      unreadCount: item.unreadCount,
      url: 'https://m.weibo.cn/message/chat?uid=' + userId,
      contentDigest: digest(stable)
    });
    if (threads.length >= count) break;
  }
  const text = await bodyText(page);
  return { threads, complete: /暂无私信|暂无消息|没有更多/.test(text) && threads.length <= count };
}
async function projectMessageThread(page, userId, selfId, count) {
  const raw = await page.evaluate(() => {
    let createdAt = '';
    const messages = [];
    for (const element of document.querySelectorAll('.lite-bubble-time,.lite-bubble-list')) {
      if (element.classList.contains('lite-bubble-time')) {
        createdAt = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
        continue;
      }
      const bubble = element.querySelector('.bubble-box');
      let text = (bubble && bubble.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
      if (!text) text = bubble && bubble.querySelector('img') ? '[图片]' : '[非文本消息]';
      const sender = element.querySelector('h4');
      messages.push({
        mine: element.classList.contains('bubble-r'),
        text,
        createdAt,
        senderName: (sender && sender.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128)
      });
    }
    return { messages, hasEarlier: /更早前的私信/.test(document.body.innerText || '') };
  });
  const occurrences = new Map();
  const projected = raw.messages.map((message) => {
    const senderId = message.mine ? selfId : userId;
    const stable = {
      userId, senderId, text: cleanText(message.text, 5000),
      createdAt: message.createdAt || '', mine: message.mine
    };
    const contentDigest = digest(stable);
    const occurrence = (occurrences.get(contentDigest) || 0) + 1;
    occurrences.set(contentDigest, occurrence);
    return {
      id: digest({ contentDigest, occurrence }),
      userId,
      senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      text: stable.text,
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      mine: message.mine,
      contentDigest
    };
  });
  const limit = Math.min(count, 50);
  return {
    messages: projected.slice(Math.max(0, projected.length - limit)),
    complete: !raw.hasEarlier && projected.length <= limit
  };
}
async function collectMessageThread(page, userId, selfId, count) {
  await gotoMessagePage(page, 'https://m.weibo.cn/message/chat?uid=' + userId);
  await page.waitForFunction(() => document.querySelector('.chat-page-wrap') || /暂无|出错|重试/.test(document.body.innerText || ''), null, { timeout: 15_000 }).catch(() => {});
  const current = new URL(page.url());
  if (current.pathname !== '/message/chat' || current.searchParams.get('uid') !== userId) throw new Error('message');
  await assertNoChallenge(page);
  return projectMessageThread(page, userId, selfId, count);
}
async function prepareMessageComposer(page, userId, text) {
  await gotoMessagePage(page, 'https://m.weibo.cn/message/chat?uid=' + userId);
  const current = new URL(page.url());
  if (current.pathname !== '/message/chat' || current.searchParams.get('uid') !== userId) throw new Error('message');
  await assertNoChallenge(page);
  let textarea = await uniqueVisible(page.locator('.lite-page-editor textarea:not(.shadow)'));
  if (!textarea) {
    const trigger = await uniqueVisible(page.locator('.lite-page-editor .main-text'));
    if (!trigger) throw new Error('message-composer');
    await trigger.click({ timeout: 10_000 });
    textarea = await uniqueVisible(page.locator('.lite-page-editor textarea:not(.shadow)'));
  }
  if (!textarea) throw new Error('message-composer');
  await textarea.fill(text);
  await page.waitForTimeout(150);
  const send = await uniqueVisible(page.locator('.lite-page-editor button.btn-send'));
  if (!send || await send.evaluate((element) => element.classList.contains('disable'))) throw new Error('message-composer');
  const recipient = cleanText(await page.locator('.lite-topbar .nav-main').first().innerText().catch(() => ''), 128);
  return { send, recipient };
}
async function actionRead(page, input) {
  const params = input.params || {};
  const selfId = ['search_posts', 'search_users'].includes(input.actionId) ? null : await ensureSelfId(page);
  if (input.actionId === 'get_self') {
    await gotoAuthenticated(page, 'https://weibo.com/u/' + selfId);
    return { user: await projectUser(page, selfId, selfId) };
  }
  if (input.actionId === 'get_user') {
    await gotoAuthenticated(page, 'https://weibo.com/u/' + params.userId);
    return { user: await projectUser(page, params.userId, selfId) };
  }
  if (input.actionId === 'list_home_posts') {
    await gotoAuthenticated(page, 'https://weibo.com/');
    return { posts: await collectPosts(page, selfId, params.count || 10) };
  }
  if (input.actionId === 'list_user_posts') {
    await gotoAuthenticated(page, 'https://weibo.com/u/' + params.userId);
    return { posts: await collectPosts(page, selfId, params.count || 10) };
  }
  if (input.actionId === 'get_post') {
    await gotoAuthenticated(page, 'https://weibo.com/' + params.userId + '/' + params.postId);
    const card = await awaitPostCard(page, params.userId, params.postId);
    if (!card || !await card.count()) throw new Error('post');
    const post = await projectPost(card, selfId, params.userId, params.postId);
    if (post.id !== params.postId || post.userId !== params.userId) throw new Error('post');
    return { post };
  }
  if (input.actionId === 'list_comments') {
    await gotoAuthenticated(page, 'https://weibo.com/' + params.userId + '/' + params.postId);
    const card = await awaitPostCard(page, params.userId, params.postId);
    if (!card || !await card.count()) throw new Error('post');
    const post = await projectPost(card, selfId, params.userId, params.postId);
    if (post.id !== params.postId || post.userId !== params.userId) throw new Error('post');
    const collection = await collectCommentEntries(page, params.postId, selfId);
    const limit = Math.min(params.count || 20, 50);
    const comments = collection.entries.slice(0, limit).map((entry) => entry.comment);
    const complete = !collection.truncated && collection.collisions === 0 &&
      collection.projectedNodes === collection.totalNodes && collection.entries.length <= limit &&
      post.commentCount <= collection.entries.length;
    return { comments, complete };
  }
  if (input.actionId === 'search_posts') {
    const count = params.count || 10;
    try {
      await gotoAuthenticated(page, 'https://s.weibo.com/weibo?q=' + encodeURIComponent(params.keyword));
      const posts = await collectPosts(page, '', count);
      if (posts.length > 0) return {
        posts: posts.map(({ owned: _owned, ...post }) => ({ ...post, detailAvailable: true }))
      };
    } catch {}
    await gotoAuthenticated(page, 'https://m.weibo.cn/search?containerid=' + encodeURIComponent('100103type=1&q=' + params.keyword));
    return { posts: await collectMobileSearchPosts(page, null, count) };
  }
  if (input.actionId === 'get_unread_counts') return unreadCounts(page);
  if (input.actionId === 'list_message_threads') return collectMessageThreads(page, Math.min(params.count || 20, 50));
  if (input.actionId === 'get_message_thread') {
    try {
      return await collectMessageThread(page, params.userId, selfId, Math.min(params.count || 20, 50));
    } catch (error) {
      if (isMessagePageEmptyResponse(error)) return {
        messages: [],
        complete: false,
        degradedReason: 'upstream_message_page_empty_response'
      };
      throw error;
    }
  }
  if (input.actionId === 'list_notifications') {
    const limit = Math.min(params.count || 20, 50);
    if (params.category === 'followers') {
      await gotoAuthenticated(page, 'https://weibo.com/u/page/follow/' + selfId + '?relate=fans');
      const listed = await collectUsers(page, selfId, limit);
      return {
        notifications: listed.users.map((user) => {
          const stable = { category: 'followers', actorId: user.id, text: user.name + ' 关注了你', url: user.profileUrl };
          return {
            id: digest(stable), category: 'followers', actor: user, text: stable.text,
            url: user.profileUrl, contentDigest: digest(stable)
          };
        }),
        complete: listed.complete
      };
    }
    const paths = { mentions: '/at/weibo', comments: '/comment/inbox', likes: '/like/inbox' };
    await gotoAuthenticated(page, 'https://weibo.com' + paths[params.category]);
    return collectNotifications(page, params.category, limit);
  }
  if (input.actionId === 'list_followers' || input.actionId === 'list_following') {
    const userId = params.userId || selfId;
    const suffix = input.actionId === 'list_followers' ? '?relate=fans' : '';
    await gotoAuthenticated(page, 'https://weibo.com/u/page/follow/' + userId + suffix);
    return collectUsers(page, selfId, Math.min(params.count || 20, 50));
  }
  if (input.actionId === 'search_users') {
    await gotoAuthenticated(page, 'https://s.weibo.com/user?q=' + encodeURIComponent(params.keyword));
    return collectUsers(page, '', Math.min(params.count || 10, 20));
  }
  if (input.actionId === 'list_favorites' || input.actionId === 'list_liked_posts') {
    const segment = input.actionId === 'list_favorites' ? 'fav' : 'like';
    const limit = Math.min(params.count || 10, 20);
    await gotoAuthenticated(page, 'https://weibo.com/u/page/' + segment + '/' + selfId);
    const posts = await collectPosts(page, selfId, limit);
    const marked = posts.map((post) => input.actionId === 'list_favorites' ? { ...post, favorited: true } : { ...post, liked: true });
    const text = await bodyText(page);
    return { posts: marked, complete: /暂无数据|暂无内容|没有更多内容了|没有更多了/.test(text) && !/更多内容请至客户端查看/.test(text) && marked.length <= limit };
  }
  if (input.actionId === 'list_hot_searches') return hotSearches(page, Math.min(params.count || 10, 50));
  throw new Error('action');
}
async function awaitDispatch() {
  writeFrame({ event: 'prepared' });
  const command = await readFrame();
  if (Object.keys(command).sort().join('\0') !== 'event' || command.event !== 'dispatch') throw new Error('dispatch');
}
function sameSnapshot(current, snapshot) {
  return !!snapshot && snapshot.owned === true && current.owned === true && current.contentDigest === snapshot.expectedDigest;
}
function sameCommentDeleteSnapshot(comment, post, snapshot) {
  if (!snapshot || comment.contentDigest !== snapshot.expectedDigest) return false;
  if (snapshot.targetKind === 'own_comment') return comment.owned === true;
  return snapshot.targetKind === 'received_on_own_post' && comment.owned === false &&
    post.owned === true && post.contentDigest === snapshot.postExpectedDigest;
}
async function exactMenuItem(page, text) {
  const candidates = page.locator('[role="button"],button,[role="menuitem"]');
  const matches = [];
  const total = Math.min(await candidates.count(), 200);
  for (let index = 0; index < total; index += 1) {
    const candidate = candidates.nth(index);
    if (!await visible(candidate)) continue;
    const ownText = cleanText(await candidate.innerText().catch(() => ''), 100);
    const exactDescendant = await candidate.getByText(text, { exact: true }).count().catch(() => 0);
    const popItem = await candidate.evaluate((element) => element.classList.contains('woo-pop-item-main')).catch(() => false);
    if (ownText === text || (popItem && exactDescendant > 0)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function clickMoreForCard(card) {
  const more = card.locator('.woo-pop-wrap').first();
  if (!await visible(more)) throw new Error('menu');
  await more.click({ timeout: 10_000 });
}
async function inspectFavoriteState(page, card) {
  await clickMoreForCard(card);
  const add = await exactMenuItem(page, '收藏');
  const remove = await exactMenuItem(page, '取消收藏');
  if (!!add === !!remove) throw new Error('favorite');
  return { favorited: !!remove, item: remove || add };
}
async function confirmDialog(page, labels) {
  for (const label of labels) {
    const button = await exactMenuItem(page, label);
    if (button) { await button.click({ timeout: 10_000 }); return; }
  }
  throw new Error('confirm');
}
async function newestOwnPost(page, selfId, text, beforeIds) {
  await gotoAuthenticated(page, 'https://weibo.com/u/' + selfId);
  const posts = await collectPosts(page, selfId, 10);
  const matches = posts.filter((post) => post.owned && !beforeIds.has(post.id) && post.text === cleanText(text, 20000));
  return matches.length === 1 ? matches[0] : null;
}
async function awaitNewestOwnPost(page, selfId, text, beforeIds) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const post = await newestOwnPost(page, selfId, text, beforeIds);
    if (post) return post;
    if (attempt < 7) await page.waitForTimeout(750);
  }
  return null;
}
async function composerScope(editor) {
  if (!editor || typeof editor.locator !== 'function') return null;
  const queries = [
    'xpath=ancestor::*[.//*[(self::button or @role="button" or @role="menuitem")][normalize-space()="发送"]][1]',
    'xpath=ancestor::*[.//*[(self::button or @role="button" or @role="menuitem")][normalize-space()="图片"]][1]',
    'xpath=ancestor::*[.//*[@title="图片" or @aria-label="图片" or contains(@class,"woo-font--image") or contains(@class,"woo-font--pic") or contains(@class,"woo-font--picture")]][1]'
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
async function countVisibleLocator(root, selector, limit = 20) {
  let hits = 0;
  if (!root || typeof root.locator !== 'function' || !selector) return hits;
  const nodes = root.locator(selector);
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return hits;
  const total = Math.min(await nodes.count().catch(() => 0), limit);
  for (let index = 0; index < total; index += 1) {
    if (await visible(nodes.nth(index))) hits += 1;
  }
  return hits;
}
async function clickableImageTool(node) {
  const wrap = node.locator('xpath=ancestor-or-self::*[self::button or @role="button" or @role="menuitem" or contains(concat(" ",normalize-space(@class)," ")," wbpro-iconbed ")][1]');
  if (await wrap.count() === 1 && await visible(wrap)) return wrap;
  return node;
}
async function uniqueVisibleClickable(root, selector) {
  if (!root || typeof root.locator !== 'function') return null;
  const nodes = root.locator(selector);
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return null;
  const matches = [];
  const total = Math.min(await nodes.count().catch(() => 0), 20);
  for (let index = 0; index < total; index += 1) {
    const node = nodes.nth(index);
    if (!await visible(node)) continue;
    matches.push(await clickableImageTool(node));
  }
  return matches.length === 1 ? matches[0] : null;
}
async function countPreviewSignals(scope, page) {
  const imgCount = await countVisibleImgs(scope);
  let canvasCount = 0;
  let bgCount = 0;
  let frameCount = 0;
  try {
    const canvases = scope && typeof scope.locator === 'function' ? scope.locator('canvas') : null;
    canvasCount = Math.min(canvases && typeof canvases.count === 'function' ? await canvases.count().catch(() => 0) : 0, 12);
  } catch {}
  try {
    const styled = scope && typeof scope.locator === 'function' ? scope.locator('[style*="background"]') : null;
    bgCount = Math.min(styled && typeof styled.count === 'function' ? await styled.count().catch(() => 0) : 0, 12);
  } catch {}
  try {
    const frames = page && typeof page.locator === 'function' ? page.locator('iframe') : null;
    frameCount = Math.min(frames && typeof frames.count === 'function' ? await frames.count().catch(() => 0) : 0, 12);
  } catch {}
  const deleted = await exactMenuItem(scope, '删除');
  return { imgCount, canvasCount, bgCount, frameCount, deleteHits: deleted ? 1 : 0 };
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
  let visible = 0;
  for (let index = 0; index < total; index += 1) {
    if (await nodes.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}
async function awaitComposerCleared(page, editor, timeout) {
  const deadline = Date.now() + timeout;
  const attempts = Math.max(1, Math.ceil(timeout / 250));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await readPostComposer(editor))) return true;
    const remaining = deadline - Date.now();
    if (attempt < attempts - 1 && remaining > 0) {
      await page.waitForTimeout(Math.min(250, remaining));
    }
  }
  return false;
}
async function awaitComposerMediaReady(page, editor, expectedNew, timeout, beforeSrcs, beforeCount, beforeDelete) {
  const scope = (await composerScope(editor)) || page;
  if (!scope || typeof scope.locator !== 'function') throw new Error('media-preview-timeout');
  const before = new Set(Array.isArray(beforeSrcs) ? beforeSrcs : []);
  const baseCount = Number.isFinite(beforeCount) ? beforeCount : before.size;
  const deadline = Date.now() + timeout;
  const attempts = Math.max(1, Math.ceil(timeout / 250));
  let emittedChange = false;
  const startSignals = await countPreviewSignals(scope, page);
  emitStep({
    step: 'media.preview.start',
    timeoutMs: timeout,
    imgCount: startSignals.imgCount,
    bgCount: startSignals.bgCount,
    canvasCount: startSignals.canvasCount,
    frameCount: startSignals.frameCount,
    deleteHits: startSignals.deleteHits,
  });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const added = [];
    const seen = new Set();
    for (const src of await collectVisibleImageSrcs(scope)) {
      if (before.has(src) || seen.has(src)) continue;
      seen.add(src);
      added.push(src);
    }
    const imgs = await countVisibleImgs(scope);
    const deleted = await exactMenuItem(scope, '删除');
    const ready = added.length >= expectedNew || imgs >= baseCount + expectedNew || (!!deleted && !beforeDelete);
    if (!emittedChange && (added.length > 0 || imgs !== startSignals.imgCount || (!!deleted && !beforeDelete))) {
      emittedChange = true;
      const change = await countPreviewSignals(scope, page);
      emitStep({
        step: 'media.preview.change',
        addedSrcs: added.length,
        imgCount: change.imgCount,
        bgCount: change.bgCount,
        canvasCount: change.canvasCount,
        frameCount: change.frameCount,
        deleteHits: change.deleteHits,
      });
    }
    if (ready) {
      emitStep({
        step: 'media.preview.ready',
        reason: added.length >= expectedNew ? 'added-src' : imgs >= baseCount + expectedNew ? 'img-count' : 'delete',
        addedSrcs: added.length,
        imgCount: imgs,
        deleteHits: deleted ? 1 : 0,
      });
      return;
    }
    const remaining = deadline - Date.now();
    if (attempt < attempts - 1 && remaining > 0) {
      await page.waitForTimeout(Math.min(250, remaining));
    }
  }
  const timed = await countPreviewSignals(scope, page);
  emitStep({
    step: 'media.preview.timeout',
    reason: 'timeout',
    addedSrcs: 0,
    imgCount: timed.imgCount,
    bgCount: timed.bgCount,
    canvasCount: timed.canvasCount,
    frameCount: timed.frameCount,
    deleteHits: timed.deleteHits,
  });
  throw new Error('media-preview-timeout');
}
function nodeDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function awaitFileChooser(page, clickable) {
  const armed = await armFileChooser(page, clickable);
  if (armed.timedOut) throw new Error('media-chooser');
  if (!armed.chooser) throw new Error('media-chooser');
  return armed.chooser;
}
async function uniqueExactText(root, text) {
  if (!root || typeof root.locator !== 'function' || !text) return null;
  const nodes = root.locator('xpath=.//*[normalize-space()="' + text + '"]');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return null;
  const matches = [];
  const total = Math.min(await nodes.count().catch(() => 0), 20);
  for (let index = 0; index < total; index += 1) {
    const node = nodes.nth(index);
    if (await visible(node)) matches.push(node);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function nodeBox(node) {
  if (!node || typeof node.evaluate !== 'function') return null;
  return node.evaluate((el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }).catch(() => null);
}
function containsBox(outer, inner) {
  if (!outer || !inner) return false;
  return outer.x <= inner.x + 0.5 && outer.y <= inner.y + 0.5
    && outer.x + outer.w + 0.5 >= inner.x + inner.w
    && outer.y + outer.h + 0.5 >= inner.y + inner.h
    && (outer.w * outer.h > inner.w * inner.h + 0.5);
}
async function boxCenter(node) {
  const box = await nodeBox(node);
  if (!box) return null;
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}
async function controlIdentity(node) {
  if (!node || typeof node.evaluate !== 'function') return '';
  return String(await node.evaluate((el) => {
    if (!el) return '';
    const r = el.getBoundingClientRect();
    return [el.tagName, el.id || '', String(el.className || '').slice(0, 80), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join('|');
  }).catch(() => ''));
}
async function clickableExactTextControls(root, text) {
  if (!root || typeof root.locator !== 'function' || !text) return [];
  const nodes = root.locator('xpath=.//*[normalize-space()="' + text + '"]');
  if (!nodes || typeof nodes.count !== 'function' || typeof nodes.nth !== 'function') return [];
  const controls = [];
  const seen = new Set();
  const total = Math.min(await nodes.count().catch(() => 0), 20);
  for (let index = 0; index < total; index += 1) {
    const node = nodes.nth(index);
    if (!await visible(node)) continue;
    const control = await clickableImageTool(node);
    const id = await controlIdentity(control);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    controls.push(control);
  }
  const boxed = [];
  for (const control of controls) boxed.push({ control, box: await nodeBox(control) });
  const collapsed = [];
  for (const item of boxed) {
    if (!item.box) {
      collapsed.push(item.control);
      continue;
    }
    const inside = boxed.some((other) => other !== item && containsBox(other.box, item.box));
    if (!inside) collapsed.push(item.control);
  }
  return collapsed;
}
async function uniqueOrNearestImageText(root, input, text) {
  const controls = await clickableExactTextControls(root, text);
  if (controls.length === 1) return controls[0];
  if (controls.length === 0) return null;
  if (!input || typeof input.evaluate !== 'function') return null;
  const inputBox = await boxCenter(input);
  if (!inputBox) return null;
  let best = null;
  let bestDist = Infinity;
  for (const control of controls) {
    const box = await boxCenter(control);
    if (!box) continue;
    const dist = Math.hypot(box.x - inputBox.x, box.y - inputBox.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = control;
    }
  }
  return best;
}
async function exactTextNearInput(input, text) {
  if (!input || typeof input.locator !== 'function' || !text) return null;
  for (let depth = 1; depth <= 8; depth += 1) {
    const ancestor = input.locator('xpath=ancestor::*[' + depth + ']');
    if (await ancestor.count() !== 1) continue;
    const found = await uniqueExactText(ancestor, text);
    if (found) return found;
  }
  return null;
}
async function smallVisibleAncestor(input) {
  if (!input || typeof input.locator !== 'function') return null;
  for (let depth = 1; depth <= 5; depth += 1) {
    const node = input.locator('xpath=ancestor::*[' + depth + ']');
    if (await node.count() !== 1) continue;
    if (!await visible(node)) continue;
    const box = await node.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }).catch(() => null);
    if (box && box.w >= 8 && box.w <= 96 && box.h >= 8 && box.h <= 96) return node;
  }
  return null;
}
async function clickableImageToolFromInput(input) {
  if (!input || typeof input.locator !== 'function') return null;
  const queries = [
    'xpath=ancestor::label[1]',
    'xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," wbpro-iconbed ")][1]',
    'xpath=ancestor::*[@role="button" or self::button or @title="图片" or @aria-label="图片"][1]',
  ];
  for (const query of queries) {
    const node = input.locator(query);
    if (await node.count() === 1 && await visible(node)) return node;
  }
  return smallVisibleAncestor(input);
}
async function imageToolControl(scope, page, scopedInput) {
  const labeled = await exactMenuItem(scope, '图片')
    || await uniqueOrNearestImageText(scope, scopedInput, '图片')
    || await uniqueOrNearestImageText(scope, scopedInput, '相册')
    || await exactTextNearInput(scopedInput, '图片')
    || await exactTextNearInput(scopedInput, '相册')
    || await uniqueExactText(scope, '图片')
    || await uniqueExactText(scope, '相册');
  if (labeled) return labeled;
  for (const root of [scope, page]) {
    const titled = await uniqueVisibleClickable(root, '[title="图片"], [aria-label="图片"]');
    if (titled) return titled;
    const icon = await uniqueVisibleClickable(root, 'i.woo-font--image, i.woo-font--pic, i.woo-font--picture');
    if (icon) return icon;
  }
  const fromInput = await clickableImageToolFromInput(scopedInput);
  if (fromInput) return fromInput;
  return await exactMenuItem(page, '图片') || await uniqueExactText(page, '图片');
}
async function preparePostImageChooser(page, editor, files) {
  const scope = (await composerScope(editor)) || page;
  const scopedInput = await uniqueImageFileInput(scope);
  const image = await imageToolControl(scope, page, scopedInput);
  const beforeScope = await countImageFileInputs(scope);
  const beforePage = await countImageFileInputs(page);
  const imageTitleHits = await countVisibleLocator(scope, '[title="图片"], [aria-label="图片"]');
  const imageIconHits = await countVisibleLocator(scope, 'i.woo-font--image, i.woo-font--pic, i.woo-font--picture');
  const imageTextHits = await countVisibleLocator(scope, 'xpath=.//*[normalize-space()="图片"]');
  const imageControlHits = (await clickableExactTextControls(scope, '图片')).length;
  const emitChooser = (branch) => {
    emitStep({
      step: 'media.chooser',
      branch,
      hasImage: !!image,
      scopeInputs: beforeScope.total,
      scopeImageInputs: beforeScope.image,
      pageInputs: beforePage.total,
      pageImageInputs: beforePage.image,
      imageTitleHits,
      imageIconHits,
      imageTextHits,
      imageControlHits,
      hits: beforeScope.image,
      mediaCount: beforePage.image,
    });
  };
  const finishArmed = (branch, armed) => {
    emitChooser(branch);
    if (armed.attachFailed) throw new Error('media-upload');
    return { chooser: armed.chooser, attached: !!armed.attached };
  };
  if (image) {
    const armed = await armFileChooser(page, image, files);
    if (armed.timedOut) {
      emitChooser('timeout');
      throw new Error('media-chooser');
    }
    if (armed.chooser) return finishArmed('native', armed);
    const local = await exactMenuItem(scope, '本地上传') || await exactMenuItem(page, '本地上传')
      || await exactMenuItem(scope, '相册') || await exactMenuItem(page, '相册');
    if (local) {
      const localArmed = await armFileChooser(page, local, files);
      if (localArmed.timedOut) {
        emitChooser('timeout');
        throw new Error('media-chooser');
      }
      if (localArmed.chooser) return finishArmed('local', localArmed);
    }
    const appeared = await uniqueImageFileInput(scope);
    if (appeared) {
      emitChooser('appeared');
      return { chooser: wrapFileInput(appeared), attached: false };
    }
  }
  if (scopedInput) {
    emitChooser('existing');
    return { chooser: wrapFileInput(scopedInput), attached: false };
  }
  emitChooser('miss');
  throw new Error('media-chooser');
}
async function provePostImageControl(page, editor) {
  const scope = (await composerScope(editor)) || page;
  const scopedInput = await uniqueImageFileInput(scope);
  if (scopedInput) return true;
  const image = await imageToolControl(scope, page, scopedInput);
  return !!image;
}
async function openLongTextComposer(page) {
  const opener = await exactMenuItem(page, '长文');
  if (!opener) return false;
  await opener.click({ timeout: 10_000 });
  return true;
}
async function postComposerEditor(page, longText) {
  if (longText) {
    const editable = await uniqueVisible(page.locator('[contenteditable="true"]'));
    if (editable) return editable;
  }
  const nodes = page.locator('textarea');
  if (nodes && typeof nodes.count === 'function' && typeof nodes.nth === 'function') {
    const matches = [];
    const total = Math.min(await nodes.count(), 40);
    for (let index = 0; index < total; index += 1) {
      const node = nodes.nth(index);
      if (!await visible(node)) continue;
      const sendTool = node.locator('xpath=ancestor::*[.//*[(self::button or @role="button" or @role="menuitem")][normalize-space()="发送"]][1]');
      const imageTool = node.locator('xpath=ancestor::*[.//*[(self::button or @role="button" or @role="menuitem")][normalize-space()="图片"] or .//*[@title="图片" or @aria-label="图片"]][1]');
      if (await sendTool.count() === 1 || await imageTool.count() === 1) matches.push(node);
    }
    if (matches.length === 1) return matches[0];
  }
  return uniqueVisible(page.locator('textarea'));
}
async function readPostComposer(editor) {
  const value = await editor.inputValue().catch(() => '');
  if (value) return cleanText(value, 20000);
  const inner = typeof editor.innerText === 'function' ? await editor.innerText().catch(() => '') : '';
  return cleanText(inner, 20000);
}
async function provePostSendReady(send, timeout) {
  if (!send) throw new Error('send-button');
  await send.click({ trial: true, timeout });
}
async function awaitPostSendReady(page, timeout, editor) {
  const deadline = Date.now() + timeout;
  const attempts = Math.max(1, Math.ceil(timeout / 250));
  const scope = (await composerScope(editor)) || page;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const send = await exactMenuItem(scope, '发送');
    remaining = deadline - Date.now();
    if (send && remaining > 0) {
      try {
        await provePostSendReady(send, Math.min(250, remaining));
        return send;
      } catch {}
    }
    remaining = deadline - Date.now();
    if (attempt < attempts - 1 && remaining > 0) {
      await page.waitForTimeout(Math.min(250, remaining));
    }
  }
  throw new Error('send-button');
}
async function activatePostSend(send) {
  await provePostSendReady(send, 10_000);
  try {
    await send.click({ timeout: 10_000, noWaitAfter: true });
    return null;
  } catch (error) {
    return error;
  }
}
async function commentActionControl(root, kind) {
  await root.hover({ timeout: 10_000 });
  const nested = await root.evaluate((element) => element.classList.contains('item2'));
  const body = nested ? root.locator(':scope > .con2') : root.locator(':scope > .item1in .con1');
  if (await body.count() !== 1) return null;
  if (kind === 'like') {
    const button = await uniqueVisible(body.locator('button.woo-like-main'));
    return button;
  }
  const selector = kind === 'reply' ? 'i.woo-font--comment[title="评论"]' : 'i[title="删除"]';
  const icon = await uniqueVisible(body.locator(selector));
  if (!icon) return null;
  const control = icon.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," wbpro-iconbed ")][1]');
  return await control.count() === 1 && await visible(control) ? control : null;
}
async function findNewOwnedComment(page, postId, selfId, beforeIds, text, parentCommentId) {
  const expected = cleanText(text, 5000);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const collection = await collectCommentEntries(page, postId, selfId);
    if (!collection.truncated && collection.collisions === 0 && collection.projectedNodes === collection.totalNodes) {
      const matches = collection.entries.map((entry) => entry.comment).filter((comment) => {
        if (!comment.owned || beforeIds.has(comment.id)) return false;
        if (parentCommentId ? comment.parentCommentId !== parentCommentId : !!comment.parentCommentId) return false;
        return comment.text === expected || (parentCommentId && comment.text.endsWith(expected));
      });
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    await page.waitForTimeout(750);
  }
  return null;
}
async function writeAction(page, input) {
  const params = input.params || {};
  const selfId = await ensureSelfId(page);
  if (input.actionId === 'create_post') {
    await gotoAuthenticated(page, 'https://weibo.com/u/' + selfId);
    const beforeIds = new Set((await collectPosts(page, selfId, 10)).map((post) => post.id));
    await gotoAuthenticated(page, 'https://weibo.com/');
    const expectedText = cleanText(params.text || '', 20000);
    const longText = expectedText.length > 2000;
    if (longText) await openLongTextComposer(page);
    const editor = await postComposerEditor(page, longText);
    if (!editor) throw new Error(longText ? 'composer-longtext' : 'composer-editor');
    if (expectedText) await editor.fill(expectedText);
    if ((await readPostComposer(editor)) !== expectedText) throw new Error('composer-readback');
    const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
    await assertNoChallenge(page);
    let imageChooser = null;
    let previewBefore = [];
    let previewBeforeCount = 0;
    let previewBeforeDelete = false;
    if (manifest.length === 0) {
      await awaitPostSendReady(page, 30_000, editor);
    } else if (!(await provePostImageControl(page, editor))) {
      throw new Error('media-chooser');
    } else {
      const previewScope = (await composerScope(editor)) || page;
      previewBefore = await collectVisibleImageSrcs(previewScope);
      previewBeforeCount = await countVisibleImgs(previewScope);
      previewBeforeDelete = !!(await exactMenuItem(previewScope, '删除'));
    }
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshEditor = await postComposerEditor(page, longText);
    if (!freshEditor || (await readPostComposer(freshEditor)) !== expectedText) throw new Error('composer-readback');
    if (manifest.length) {
      const files = [];
      try {
        for (const item of manifest) files.push({ name: item.filename, mimeType: item.mimeType, buffer: await readFile('/inputs/' + item.inputId) });
        const prepared = await preparePostImageChooser(page, freshEditor, files);
        if (!prepared || !prepared.chooser) throw new Error('media-chooser');
        imageChooser = prepared.chooser;
        let selected = 0;
        if (!prepared.attached) {
          try {
            await imageChooser.setFiles(files);
          } catch {
            emitStep({ step: 'media.upload', selected: 0, retried: false, freshSelected: -1, mediaCount: manifest.length });
            throw new Error('media-upload');
          }
        }
        try {
          if (typeof imageChooser.element === 'function') {
            selected = await imageChooser.element().evaluate((node) => node.files ? node.files.length : 0);
          }
        } catch {}
        let retried = false;
        let freshSelected = -1;
        if (!prepared.attached) {
          const scope = (await composerScope(freshEditor)) || page;
          const liveInput = await uniqueImageFileInput(scope);
          if (selected !== manifest.length && liveInput) {
            await liveInput.setInputFiles(files);
            try {
              selected = await liveInput.evaluate((node) => node.files ? node.files.length : 0);
            } catch {}
          }
          if (selected !== manifest.length) {
            retried = true;
            const freshInput = await uniqueImageFileInput(scope);
            if (freshInput) {
              await freshInput.setInputFiles(files);
              try {
                freshSelected = await freshInput.evaluate((node) => node.files ? node.files.length : 0);
              } catch {
                freshSelected = -1;
              }
              if (freshSelected >= 0) selected = freshSelected;
            }
          }
        }
        emitStep({
          step: 'media.upload',
          selected,
          retried,
          freshSelected,
          attached: !!prepared.attached,
          mediaCount: manifest.length,
        });
        if (selected !== manifest.length && !prepared.attached) throw new Error('media-upload');
        await awaitComposerMediaReady(page, freshEditor, manifest.length, 90_000, previewBefore, previewBeforeCount, previewBeforeDelete);
      } finally {
        for (const file of files) file.buffer.fill(0);
      }
    }
    await assertNoChallenge(page);
    const send = await awaitPostSendReady(page, manifest.length ? 90_000 : 30_000, freshEditor);
    const clickFailure = await activatePostSend(send);
    await page.waitForTimeout(2500);
    const cleared = await awaitComposerCleared(page, freshEditor, 10_000);
    const post = await awaitNewestOwnPost(page, selfId, expectedText, beforeIds);
    if (!post) {
      if (clickFailure) throw new Error('send-click');
      if (manifest.length && !cleared) throw new Error('send-uncleared');
      throw new Error('result');
    }
    return { post };
  }
  if (input.actionId === 'set_following') {
    await gotoAuthenticated(page, 'https://weibo.com/u/' + params.userId);
    const stateButton = await uniqueExactControl(page.locator('button.woo-button-m'), ['关注', '已关注', '互相关注']);
    if (!stateButton) throw new Error('follow');
    const current = !/^关注$/.test(cleanText(await stateButton.innerText(), 20));
    await awaitDispatch();
    await assertNoChallenge(page);
    if (numericUid(page.url()) !== params.userId) throw new Error('follow');
    const freshButton = await uniqueExactControl(page.locator('button.woo-button-m'), ['关注', '已关注', '互相关注']);
    if (!freshButton) throw new Error('follow');
    const freshText = cleanText(await freshButton.innerText(), 20);
    const fresh = !/^关注$/.test(freshText);
    if (fresh === params.following) return { ok: true, changed: false };
    await freshButton.click({ timeout: 10_000 });
    if (!params.following) {
      await page.waitForTimeout(400);
      const cancel = await exactMenuItem(page, '取消关注');
      if (cancel) await cancel.click({ timeout: 10_000 });
      const confirm = await exactMenuItem(page, '确定');
      if (confirm) await confirm.click({ timeout: 10_000 });
    }
    await page.waitForTimeout(1200);
    await assertNoChallenge(page);
    const observedButton = await uniqueExactControl(page.locator('button.woo-button-m'), ['关注', '已关注', '互相关注']);
    if (!observedButton) throw new Error('follow');
    const observedText = cleanText(await observedButton.innerText().catch(() => ''), 20);
    const observed = !/^关注$/.test(observedText);
    if (observed !== params.following) throw new Error('follow');
    return { ok: true, changed: current !== observed };
  }
  if (input.actionId === 'send_message') {
    const before = await collectMessageThread(page, params.userId, selfId, 50);
    const beforeIds = new Set(before.messages.map((message) => message.id));
    const prepared = await prepareMessageComposer(page, params.userId, params.text);
    await awaitDispatch();
    const fresh = await prepareMessageComposer(page, params.userId, params.text);
    if (prepared.recipient && fresh.recipient && prepared.recipient !== fresh.recipient)
      await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    await fresh.send.click({ timeout: 10_000 });
    await assertNoChallenge(page);
    const expected = cleanText(params.text, 1000);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const observed = await projectMessageThread(page, params.userId, selfId, 50);
      const matches = observed.messages.filter((message) => message.mine && message.text === expected && !beforeIds.has(message.id));
      if (matches.length === 1) return { message: matches[0] };
      if (matches.length > 1) throw new Error('message-result');
      await page.waitForTimeout(500);
    }
    throw new Error('message-result');
  }
  await gotoAuthenticated(page, 'https://weibo.com/' + params.userId + '/' + params.postId);
  const card = await awaitPostCard(page, params.userId, params.postId);
  if (!card || !await card.count()) throw new Error('post');
  const currentPost = await projectPost(card, selfId, params.userId, params.postId);
  if (currentPost.id !== params.postId || currentPost.userId !== params.userId) throw new Error('post');
  if (input.actionId === 'set_post_like') {
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    if (!freshCard) throw new Error('post');
    const beforePost = await projectPost(freshCard, selfId, params.userId, params.postId);
    if (beforePost.id !== params.postId || beforePost.userId !== params.userId) throw new Error('post');
    const button = freshCard.locator('button.woo-like-main').first();
    if (!await visible(button)) throw new Error('like');
    const before = beforePost.liked;
    if (before === params.liked) return { ok: true, changed: false };
    await button.click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    const after = (await projectPost(freshCard, selfId, params.userId, params.postId)).liked;
    if (after !== params.liked) throw new Error('like');
    return { ok: true, changed: true };
  }
  if (input.actionId === 'set_post_favorite') {
    const before = await inspectFavoriteState(page, card);
    await page.keyboard.press('Escape').catch(() => {});
    await awaitDispatch();
    await assertNoChallenge(page);
    await gotoAuthenticated(page, currentPost.url);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    if (!freshCard) throw new Error('post');
    const freshPost = await projectPost(freshCard, selfId, params.userId, params.postId);
    if (freshPost.id !== params.postId || freshPost.userId !== params.userId) throw new Error('post');
    const fresh = await inspectFavoriteState(page, freshCard);
    if (fresh.favorited === params.favorited) {
      await page.keyboard.press('Escape').catch(() => {});
      return { ok: true, changed: false };
    }
    await fresh.item.click({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await gotoAuthenticated(page, currentPost.url);
    const observedCard = await awaitPostCard(page, params.userId, params.postId);
    if (!observedCard) throw new Error('post');
    const observed = await inspectFavoriteState(page, observedCard);
    await page.keyboard.press('Escape').catch(() => {});
    if (observed.favorited !== params.favorited) throw new Error('favorite');
    return { ok: true, changed: before.favorited !== observed.favorited };
  }
  if (input.actionId === 'set_comment_like') {
    const found = await findComment(page, params.postId, params.commentId, selfId);
    if (!found) throw new Error('comment');
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    if (!freshCard) throw new Error('post');
    const freshPost = await projectPost(freshCard, selfId, params.userId, params.postId);
    if (freshPost.id !== params.postId || freshPost.userId !== params.userId) throw new Error('post');
    const fresh = await findComment(page, params.postId, params.commentId, selfId);
    if (!fresh) throw new Error('comment');
    if (fresh.comment.liked === params.liked) return { ok: true, changed: false };
    const control = await commentActionControl(fresh.root, 'like');
    if (!control) throw new Error('comment-like');
    await control.click({ timeout: 10_000 });
    await page.waitForTimeout(1_000);
    const observed = await findComment(page, params.postId, params.commentId, selfId);
    if (!observed || observed.comment.liked !== params.liked) throw new Error('comment-like');
    return { ok: true, changed: true };
  }
  if (input.actionId === 'edit_post' || input.actionId === 'delete_post') {
    const snapshot = input.actionId === 'edit_post' ? params.editSnapshot : params.deleteSnapshot;
    if (!sameSnapshot(currentPost, snapshot))
      await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    await clickMoreForCard(card);
    const label = input.actionId === 'edit_post' ? '编辑微博' : '删除';
    const item = await exactMenuItem(page, label);
    if (!item) throw new Error('menu');
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    if (!freshCard) throw new Error('post');
    const fresh = await projectPost(freshCard, selfId, params.userId, params.postId);
    if (!sameSnapshot(fresh, snapshot))
      await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    const freshItem = await exactMenuItem(page, label);
    if (!freshItem) throw new Error('menu');
    await freshItem.click({ timeout: 10_000 });
    if (input.actionId === 'delete_post') {
      await page.waitForTimeout(400);
      await confirmDialog(page, ['确定', '删除']);
      await page.waitForTimeout(1500);
      const remains = await findPostCard(page, params.userId, params.postId);
      if (remains && await remains.count()) throw new Error('delete');
      return { ok: true, changed: true };
    }
    await page.waitForTimeout(500);
    const editor = await uniqueVisible(page.locator('[role="dialog"] textarea, .woo-modal-main textarea'));
    if (!editor) throw new Error('editor');
    await editor.fill(params.text);
    await confirmDialog(page, ['确定', '保存', '发布']);
    await page.waitForTimeout(1800);
    await gotoAuthenticated(page, currentPost.url);
    const updatedCard = await awaitPostCard(page, params.userId, params.postId);
    if (!updatedCard) throw new Error('post');
    const post = await projectPost(updatedCard, selfId, params.userId, params.postId);
    if (post.id !== params.postId || post.userId !== params.userId || post.text !== cleanText(params.text, 20000)) throw new Error('edit');
    return { post };
  }
  if (input.actionId === 'create_comment') {
    const before = await collectCommentEntries(page, params.postId, selfId);
    if (before.truncated || before.collisions > 0 || before.projectedNodes !== before.totalNodes) throw new Error('comment');
    const beforeIds = new Set(before.entries.map((entry) => entry.comment.id));
    const textarea = await uniqueVisible(page.locator('textarea'));
    if (!textarea) throw new Error('comment');
    await textarea.fill(params.text);
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    const freshTextarea = await uniqueVisible(page.locator('textarea'));
    if (!freshCard || !freshTextarea || cleanText(await freshTextarea.inputValue().catch(() => ''), 1000) !== cleanText(params.text, 1000)) throw new Error('comment');
    const submit = await exactMenuItem(page, '评论');
    if (!submit) throw new Error('comment');
    await submit.click({ timeout: 10_000 });
    const comment = await findNewOwnedComment(page, params.postId, selfId, beforeIds, params.text, null);
    if (comment) return { comment };
    throw new Error('comment');
  }
  if (input.actionId === 'reply_comment' || input.actionId === 'delete_comment') {
    const found = await findComment(page, params.postId, params.commentId, selfId);
    if (!found) throw new Error('comment');
    if (input.actionId === 'delete_comment' && !sameCommentDeleteSnapshot(found.comment, currentPost, params.deleteSnapshot))
      await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    const kind = input.actionId === 'reply_comment' ? 'reply' : 'delete';
    const control = await commentActionControl(found.root, kind);
    if (!control) throw new Error('comment-control');
    const before = input.actionId === 'reply_comment' ? await collectCommentEntries(page, params.postId, selfId) : null;
    if (before && (before.truncated || before.collisions > 0 || before.projectedNodes !== before.totalNodes)) throw new Error('comment');
    const beforeIds = new Set(before ? before.entries.map((entry) => entry.comment.id) : []);
    const replyParentId = found.comment.parentCommentId || found.comment.id;
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    const fresh = await findComment(page, params.postId, params.commentId, selfId);
    if (!freshCard) throw new Error('post');
    const freshPost = await projectPost(freshCard, selfId, params.userId, params.postId);
    if (!fresh || (input.actionId === 'delete_comment' && !sameCommentDeleteSnapshot(fresh.comment, freshPost, params.deleteSnapshot)))
      await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    const freshControl = await commentActionControl(fresh.root, kind);
    if (!freshControl) throw new Error('comment-control');
    await freshControl.click({ timeout: 10_000 });
    if (input.actionId === 'delete_comment') {
      await page.waitForTimeout(400);
      const confirm = await exactMenuItem(page, '确定');
      if (confirm) await confirm.click({ timeout: 10_000 });
      await page.waitForTimeout(1000);
      if (await findComment(page, params.postId, params.commentId, selfId)) throw new Error('delete-comment');
      return { ok: true, changed: true };
    }
    const textarea = await uniqueVisible(fresh.root.locator('textarea'));
    if (!textarea) throw new Error('reply');
    await textarea.fill(params.text);
    const submit = await exactMenuItem(fresh.root, '评论') || await exactMenuItem(fresh.root, '回复');
    if (!submit) throw new Error('reply');
    await submit.click({ timeout: 10_000 });
    const comment = await findNewOwnedComment(page, params.postId, selfId, beforeIds, params.text, replyParentId);
    if (comment) return { comment };
    throw new Error('reply');
  }
  if (input.actionId === 'repost_post') {
    const icon = card.locator('i.woo-font--retweet').first();
    if (!await visible(icon)) throw new Error('repost');
    const control = icon.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," woo-box-item-flex ")][1]');
    if (!await control.count()) throw new Error('repost');
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshCard = await awaitPostCard(page, params.userId, params.postId);
    if (!freshCard) throw new Error('post');
    const freshPost = await projectPost(freshCard, selfId, params.userId, params.postId);
    if (freshPost.id !== params.postId || freshPost.userId !== params.userId) throw new Error('post');
    const freshIcon = freshCard.locator('i.woo-font--retweet').first();
    if (!await visible(freshIcon)) throw new Error('repost');
    const freshControl = freshIcon.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," woo-box-item-flex ")][1]');
    if (!await freshControl.count()) throw new Error('repost');
    await freshControl.click({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const textarea = await uniqueVisible(page.locator('[role="dialog"] textarea, .woo-modal-main textarea'));
    if (params.text) {
      if (!textarea) throw new Error('repost');
      await textarea.fill(params.text);
    }
    await confirmDialog(page, ['转发']);
    await page.waitForTimeout(1200);
    await assertNoChallenge(page);
    return { ok: true, changed: true };
  }
  throw new Error('action');
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
    if (!allowed.has(origin) || !['GET', 'POST', 'DELETE'].includes(request.method()) || ['websocket', 'eventsource'].includes(request.resourceType())) {
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
  const image = page.locator('img[src*="v2.qr.weibo.cn/inf/gen"]').first();
  await image.waitFor({ state: 'visible', timeout: 20_000 });
  let valid = false;
  for (let attempt = 0; attempt < 80 && !valid; attempt += 1) {
    valid = await image.evaluate((element) => element.complete && element.naturalWidth >= 80 && element.naturalHeight >= 80).catch(() => false);
    if (!valid) await page.waitForTimeout(250);
  }
  if (!valid) throw new Error('qr');
  const png = await image.screenshot({ type: 'png', animations: 'disabled' });
  if (png.length < 100 || png.length > 512 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('qr');
  return png;
}
async function authCookieDigest(context) {
  const rows = (await context.cookies())
    .filter((cookie) => ['SUB', 'SUBP', 'WBPSESS', 'SSOLoginState'].includes(cookie.name) && /(?:^|\.)(?:weibo\.com|sina\.com\.cn)$/.test(cookie.domain.replace(/^\./, '')))
    .map((cookie) => cookie.domain + '\0' + cookie.name + '\0' + cookie.value).sort();
  return digest(rows);
}
async function proveSelf(context) {
  const page = await context.newPage();
  try {
    await gotoAuthenticated(page, 'https://weibo.com/');
    const first = await selfIdFromPage(page);
    if (!first) return null;
    await gotoAuthenticated(page, 'https://weibo.com/u/' + first);
    const current = numericUid(page.url());
    const posts = await collectPosts(page, first, 3);
    if (current !== first || posts.some((post) => post.owned !== true)) return null;
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
    await home.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    for (let index = 0; index < 50 && !home.url().includes('/newlogin'); index += 1) await home.waitForTimeout(500);
    await assertNoChallenge(home);
    const login = home.getByRole('button', { name: '登录/注册' }).first();
    await login.waitFor({ state: 'visible', timeout: 30_000 });
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 });
    await login.click({ timeout: 10_000 });
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    let png = await captureQr(popup);
    let qrHash = digest(png.toString('base64'));
    writeFrame({ event: 'qr', png: png.toString('base64') });
    const initialCookies = await authCookieDigest(context);
    let nextQr = Date.now() + QR_REFRESH_MS;
    let nextProbe = 0;
    while (Date.now() < input.deadlineMs) {
      if (!popup.isClosed()) {
        await assertNoChallenge(popup);
        if (Date.now() >= nextQr && await visible(popup.locator('img[src*="v2.qr.weibo.cn/inf/gen"]').first())) {
          nextQr = Date.now() + QR_REFRESH_MS;
          const fresh = await captureQr(popup).catch(() => null);
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
      const signal = (await authCookieDigest(context)) !== initialCookies || popup.isClosed() || (!popup.isClosed() && !/passport\.weibo\.com\/sso\/signin/.test(popup.url()));
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
  writeFrame({ event: 'ready', runtime: 'weibo-worker-v1', playwrightMcpVersion });
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
