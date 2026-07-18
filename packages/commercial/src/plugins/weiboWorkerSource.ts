/**
 * Reviewed Weibo worker. It drives the public web UI only: no Playwright request
 * client, response-body inspection, private endpoint replay, or challenge bypass.
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
  'delete_comment', 'repost_post', 'set_post_like', 'set_following'
]);
const RISK_TEXT = /安全验证|访问异常|操作频繁|账号存在风险|请完成验证|验证码|登录保护|行为异常/;
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
async function fail() {
  if (terminal) return;
  await writeTerminalAndExit({ event: 'failed', code: 'WORKER_FAILED' });
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
  const text = await bodyText(page);
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
  const stable = { id: data.id, userId: data.userId, text: cleanText(data.text, 20000), images: data.images.map((image) => image.url) };
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
    return { userId: author && author.userId, text: text.slice(0, 5000), authorName, createdAt: createdAt && createdAt.text.slice(0, 128) };
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
async function actionRead(page, input) {
  const params = input.params || {};
  const selfId = input.actionId === 'search_posts' ? null : await ensureSelfId(page);
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
async function commentActionControl(root, kind) {
  await root.hover({ timeout: 10_000 });
  const nested = await root.evaluate((element) => element.classList.contains('item2'));
  const body = nested ? root.locator(':scope > .con2') : root.locator(':scope > .item1in .con1');
  if (await body.count() !== 1) return null;
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
    const textarea = await uniqueVisible(page.locator('textarea'));
    if (!textarea) throw new Error('composer');
    if (params.text) await textarea.fill(params.text);
    const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
    await assertNoChallenge(page);
    await awaitDispatch();
    await assertNoChallenge(page);
    const freshTextarea = await uniqueVisible(page.locator('textarea'));
    if (!freshTextarea || cleanText(await freshTextarea.inputValue().catch(() => ''), 2000) !== cleanText(params.text || '', 2000)) throw new Error('composer');
    if (manifest.length) {
      const fileInput = page.locator('input[type="file"]').first();
      if (!await fileInput.count()) throw new Error('media');
      const files = [];
      try {
        for (const item of manifest) files.push({ name: item.filename, mimeType: item.mimeType, buffer: await readFile('/inputs/' + item.inputId) });
        await fileInput.setInputFiles(files);
      } finally {
        for (const file of files) file.buffer.fill(0);
      }
      const selected = await fileInput.evaluate((element) => element.files ? element.files.length : 0);
      if (selected !== manifest.length) throw new Error('media');
      await page.waitForTimeout(1500);
    }
    await assertNoChallenge(page);
    const send = await exactMenuItem(page, '发送');
    if (!send || await send.isDisabled().catch(() => false)) throw new Error('send');
    await send.click({ timeout: 10_000 });
    await page.waitForTimeout(2500);
    await assertNoChallenge(page);
    const post = await newestOwnPost(page, selfId, params.text || '', beforeIds);
    if (!post) throw new Error('result');
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
    if (input.actionId === 'delete_comment' && !sameSnapshot(found.comment, params.deleteSnapshot))
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
    const fresh = await findComment(page, params.postId, params.commentId, selfId);
    if (!fresh || (input.actionId === 'delete_comment' && !sameSnapshot(fresh.comment, params.deleteSnapshot)))
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
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, input.storageState, ACTION_ORIGINS);
    const page = await context.newPage();
    const result = WRITE_ACTIONS.has(input.actionId) ? await writeAction(page, input) : await actionRead(page, input);
    await finishAction(context, input, result);
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
} catch { await fail(); }
`
