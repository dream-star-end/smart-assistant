/**
 * Reviewed Zhihu worker. It drives rendered, user-visible DOM only: no request
 * client, response-body inspection, private endpoint replay, or challenge bypass.
 */
export const ZHIHU_WORKER_SOURCE = String.raw`
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
const QR_REFRESH_MS = 8_000;
const ACTION_ORIGINS = new Set([
  'https://www.zhihu.com', 'https://zhuanlan.zhihu.com', 'https://static.zhihu.com',
  'https://unpkg.zhimg.com', 'https://pic1.zhimg.com', 'https://pic2.zhimg.com',
  'https://pic3.zhimg.com', 'https://pic4.zhimg.com', 'https://pica.zhimg.com',
  'https://picb.zhimg.com', 'https://picx.zhimg.com'
]);
const WRITE_ACTIONS = new Set([
  'create_question', 'create_answer', 'edit_answer', 'delete_answer',
  'create_article', 'edit_article', 'delete_article', 'create_comment',
  'reply_comment', 'delete_comment', 'set_answer_vote', 'set_comment_vote',
  'set_favorite', 'set_following'
]);
const RISK_TEXT = /安全验证|访问异常|操作频繁|账号存在风险|请完成验证|验证码|登录保护|行为异常|暂时限制/;
const NORMAL_SIGNIN_TEXT = /验证码登录|获取(?:短信)?验证码/g;
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
      const first = pending.subarray(0, end).toString('ascii').split('\r\n')[0] || '';
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
function cleanText(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanContent(value, max) {
  return String(value || '').replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
function pageWithinFrame(items, offset, count) {
  const page = [];
  let bytes = 2;
  for (const item of items.slice(offset, offset + count)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (page.length > 0 && bytes + itemBytes > 700_000) break;
    page.push(item);
    bytes += itemBytes;
  }
  return { items: page, hasMore: items.length > offset + page.length, nextOffset: offset + page.length };
}
function countFrom(value) {
  const text = cleanText(value, 64).replace(/,/g, '');
  const match = /(\d+(?:\.\d+)?)\s*([万亿]?)/.exec(text);
  if (!match) return 0;
  const scale = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1;
  return Math.max(0, Math.round(Number(match[1]) * scale));
}
function hrefIdentity(raw) {
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    let match = /^\/question\/(\d+)(?:\/answer\/(\d+))?\/?$/.exec(url.pathname);
    if (match && match[2]) return { kind: 'answer', id: match[2], questionId: match[1], url: 'https://www.zhihu.com/question/' + match[1] + '/answer/' + match[2] };
    if (match) return { kind: 'question', id: match[1], url: 'https://www.zhihu.com/question/' + match[1] };
    match = /^\/answer\/(\d+)\/?$/.exec(url.pathname);
    if (match) return { kind: 'answer', id: match[1], url: 'https://www.zhihu.com/answer/' + match[1] };
    match = /^\/p\/(\d+)\/?$/.exec(url.pathname);
    if (match && url.hostname === 'zhuanlan.zhihu.com') return { kind: 'article', id: match[1], url: 'https://zhuanlan.zhihu.com/p/' + match[1] };
    return null;
  } catch { return null; }
}
function userToken(raw) {
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    const match = /^\/people\/([A-Za-z0-9-]{1,100})(?:\/|$)/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}
async function bodyText(page) { return cleanText(await page.locator('body').innerText().catch(() => ''), 200000); }
async function assertNoChallenge(page) {
  const text = (await bodyText(page)).replace(NORMAL_SIGNIN_TEXT, '');
  if (RISK_TEXT.test(text) || /(?:captcha|unhuman|challenge)/i.test(page.url()))
    await writeTerminalAndExit({ event: 'failed', code: 'UPSTREAM_FAILED' });
}
async function isLoginVisible(page) {
  return /\/signin(?:[/?#]|$)/.test(page.url()) ||
    await page.locator('canvas.Qrcode-qrcode, .Qrcode-container').first().isVisible().catch(() => false) ||
    await page.getByRole('button', { name: /^登录$/ }).first().isVisible().catch(() => false);
}
async function gotoPage(page, url, requireAuth = true) {
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
  await page.waitForTimeout(2_000);
  await assertNoChallenge(page);
  if (requireAuth && await isLoginVisible(page))
    await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
}
async function visible(locator) { return locator.isVisible().catch(() => false); }
async function uniqueVisible(locator, limit = 200) {
  const matches = [];
  const count = Math.min(await locator.count(), limit);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await visible(candidate)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function exactControl(root, labels) {
  const locator = root.locator('button, a[role="button"], [role="button"]');
  const matches = [];
  const count = Math.min(await locator.count(), 300);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    const text = cleanText(await candidate.innerText().catch(() => ''), 100).replace(/\s+/g, '');
    const aria = cleanText(await candidate.getAttribute('aria-label').catch(() => ''), 100).replace(/\s+/g, '');
    if (await visible(candidate) && labels.includes(text || aria)) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : null;
}
async function scrollFor(page, wanted) {
  for (let index = 0; index < 20; index += 1) {
    const current = await page.locator('a[href*="/question/"], a[href*="zhuanlan.zhihu.com/p/"]').count();
    if (current >= wanted + 1) break;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
}
async function selfTokenFromPage(page) {
  const tokens = await page.locator('header a[href*="/people/"], .AppHeader a[href*="/people/"]').evaluateAll((anchors) => {
    const output = [];
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      const style = getComputedStyle(anchor);
      if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.top > 180 || style.visibility === 'hidden' || style.display === 'none') continue;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const match = /^\/people\/([A-Za-z0-9-]{1,100})(?:\/|$)/.exec(url.pathname);
      if (!match) continue;
      const score = (anchor.querySelector('img') ? 4 : 0) + (rect.right > innerWidth / 2 ? 2 : 0);
      output.push({ token: match[1], score });
    }
    output.sort((a, b) => b.score - a.score);
    return output.map((item) => item.token);
  });
  return tokens.length ? tokens[0] : null;
}
async function ensureSelfToken(page) {
  await gotoPage(page, 'https://www.zhihu.com/');
  const token = await selfTokenFromPage(page);
  if (!token) await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
  return token;
}
async function projectUserFromPage(page, token, selfToken) {
  const raw = await page.evaluate((expected) => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const nameNode = Array.from(document.querySelectorAll('h1, .ProfileHeader-name, [class*="AuthorInfo-name"]')).find((node) => visible(node) && (node.textContent || '').trim());
    const headlineNode = Array.from(document.querySelectorAll('.ProfileHeader-headline, [class*="headline"]')).find((node) => visible(node));
    const avatar = Array.from(document.querySelectorAll('img[src]')).find((node) => visible(node) && /avatar|头像/.test((node.className || '') + ' ' + (node.alt || '')));
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    const stat = (label) => {
      const match = new RegExp('(\\d+(?:\\.\\d+)?[万亿]?)\\s*' + label).exec(text) || new RegExp(label + '\\s*(\\d+(?:\\.\\d+)?[万亿]?)').exec(text);
      return match ? match[1] : '';
    };
    const follow = Array.from(document.querySelectorAll('button')).find((node) => /^(关注|已关注|互相关注)$/.test((node.textContent || '').replace(/\s+/g, '')) && visible(node));
    return {
      expected,
      name: (nameNode && nameNode.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128),
      headline: (headlineNode && headlineNode.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
      avatarUrl: avatar && avatar.src || '',
      followers: stat('关注者'), followingCount: stat('关注了'),
      following: !!follow && !/^关注$/.test((follow.textContent || '').replace(/\s+/g, ''))
    };
  }, token);
  if (!raw.name) throw new Error('user');
  return {
    id: token, name: raw.name, url: 'https://www.zhihu.com/people/' + token,
    ...(raw.headline ? { headline: raw.headline } : {}),
    ...(raw.avatarUrl ? { avatarUrl: raw.avatarUrl.slice(0, 2048) } : {}),
    followerCount: countFrom(raw.followers), followingCount: countFrom(raw.followingCount),
    following: token === selfToken ? true : raw.following, owned: token === selfToken
  };
}
async function getUser(page, token, selfToken) {
  await gotoPage(page, 'https://www.zhihu.com/people/' + token);
  return projectUserFromPage(page, token, selfToken);
}
async function authorFrom(root, selfToken) {
  const raw = await root.evaluate((node) => {
    for (const anchor of node.querySelectorAll('a[href*="/people/"]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const match = /^\/people\/([A-Za-z0-9-]{1,100})(?:\/|$)/.exec(url.pathname);
      if (!match) continue;
      const name = (anchor.getAttribute('title') || anchor.textContent || anchor.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim().slice(0, 128);
      if (name) return { token: match[1], name, url: 'https://www.zhihu.com/people/' + match[1], avatar: anchor.querySelector('img')?.src || '' };
    }
    return null;
  });
  if (!raw) return { id: 'unknown', name: '知乎用户', url: 'https://www.zhihu.com/', owned: false };
  return { id: raw.token, name: raw.name, url: raw.url, ...(raw.avatar ? { avatarUrl: raw.avatar.slice(0, 2048) } : {}), owned: raw.token === selfToken };
}
async function projectQuestion(page, questionId, selfToken) {
  const raw = await page.evaluate((expected) => {
    const title = (document.querySelector('h1.QuestionHeader-title')?.textContent || document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim();
    const detailNode = document.querySelector('.QuestionRichText, .QuestionHeader-detail');
    const detail = detailNode && (detailNode.innerText || detailNode.textContent) || '';
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    const count = (label) => {
      const match = new RegExp('(\\d+(?:\\.\\d+)?[万亿]?)\\s*' + label).exec(text) || new RegExp(label + '\\s*(\\d+(?:\\.\\d+)?[万亿]?)').exec(text);
      return match ? match[1] : '';
    };
    const follow = Array.from(document.querySelectorAll('button')).find((node) => /^(关注问题|已关注)$/.test((node.textContent || '').replace(/\s+/g, '')));
    return { expected, title, detail, answers: count('个回答'), followers: count('关注者'), comments: count('条评论'), followed: !!follow && /已关注/.test(follow.textContent || '') };
  }, questionId);
  if (!raw.title) throw new Error('question');
  const stable = { id: questionId, title: cleanText(raw.title, 1000), detail: cleanContent(raw.detail, 300000) };
  const ownerAnchor = page.locator('.QuestionHeader a[href*="/people/"]').first();
  const owner = await ownerAnchor.getAttribute('href').catch(() => null);
  return {
    ...stable, url: 'https://www.zhihu.com/question/' + questionId,
    answerCount: countFrom(raw.answers), followerCount: countFrom(raw.followers), commentCount: countFrom(raw.comments),
    followed: raw.followed, owned: !!owner && userToken(owner) === selfToken, contentDigest: digest(stable)
  };
}
async function projectAnswer(root, selfToken, expectedAnswerId = null) {
  const raw = await root.evaluate((node) => {
    let identity = null;
    for (const anchor of node.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      let match = /^\/question\/(\d+)\/answer\/(\d+)\/?$/.exec(url.pathname);
      if (match) { identity = { questionId: match[1], id: match[2], url: 'https://www.zhihu.com/question/' + match[1] + '/answer/' + match[2] }; break; }
    }
    if (!identity) {
      const match = /\/question\/(\d+)\/answer\/(\d+)/.exec(location.pathname);
      if (match) identity = { questionId: match[1], id: match[2], url: 'https://www.zhihu.com/question/' + match[1] + '/answer/' + match[2] };
    }
    const contentNode = node.querySelector('.RichContent-inner, .RichText');
    const content = contentNode && (contentNode.innerText || contentNode.textContent) || '';
    const text = (node.textContent || '').replace(/\s+/g, ' ');
    const vote = Array.from(node.querySelectorAll('button')).find((item) => /赞同|取消赞同/.test(item.textContent || ''));
    const down = Array.from(node.querySelectorAll('button')).find((item) => /反对|取消反对/.test(item.getAttribute('aria-label') || item.textContent || ''));
    const favorite = Array.from(node.querySelectorAll('button')).find((item) => /^(收藏|取消收藏|已收藏)$/.test((item.textContent || '').replace(/\s+/g, '')));
    const created = /发布于\s*([^收]+?)(?:\s|$)/.exec(text);
    const updated = /编辑于\s*([^收]+?)(?:\s|$)/.exec(text);
    return {
      identity, content,
      voteText: vote && vote.textContent || '', votePressed: vote && vote.getAttribute('aria-pressed'),
      downPressed: down && down.getAttribute('aria-pressed'), favoriteText: favorite && favorite.textContent || '',
      commentText: (Array.from(node.querySelectorAll('button')).find((item) => /评论/.test(item.textContent || ''))?.textContent || ''),
      createdAt: created && created[1] || '', updatedAt: updated && updated[1] || ''
    };
  });
  if (!raw.identity || !raw.content || (expectedAnswerId && raw.identity.id !== expectedAnswerId)) throw new Error('answer');
  const author = await authorFrom(root, selfToken);
  const stable = { id: raw.identity.id, questionId: raw.identity.questionId, authorId: author.id, content: cleanContent(raw.content, 500000) };
  return {
    id: raw.identity.id, questionId: raw.identity.questionId, author, content: stable.content, url: raw.identity.url,
    ...(raw.createdAt ? { createdAt: cleanText(raw.createdAt, 128) } : {}),
    ...(raw.updatedAt ? { updatedAt: cleanText(raw.updatedAt, 128) } : {}),
    voteCount: countFrom(raw.voteText), commentCount: countFrom(raw.commentText),
    voteState: raw.downPressed === 'true' ? 'down' : raw.votePressed === 'true' || /取消赞同/.test(raw.voteText) ? 'up' : 'none',
    favorited: /取消收藏|已收藏/.test(raw.favoriteText), owned: author.owned, contentDigest: digest(stable)
  };
}
async function projectArticle(page, articleId, selfToken) {
  const root = page.locator('article, .Post-Main').first();
  const raw = await root.evaluate((node) => {
    const title = (node.querySelector('h1.Post-Title, h1')?.textContent || '').replace(/\s+/g, ' ').trim();
    const contentNode = node.querySelector('.Post-RichText, .RichText');
    const content = contentNode && (contentNode.innerText || contentNode.textContent) || '';
    const text = (node.textContent || '').replace(/\s+/g, ' ');
    const vote = Array.from(node.querySelectorAll('button')).find((item) => /赞同|取消赞同/.test(item.textContent || ''));
    const favorite = Array.from(node.querySelectorAll('button')).find((item) => /^(收藏|取消收藏|已收藏)$/.test((item.textContent || '').replace(/\s+/g, '')));
    const created = /发布于\s*([^收]+?)(?:\s|$)/.exec(text);
    const updated = /编辑于\s*([^收]+?)(?:\s|$)/.exec(text);
    return { title, content, voteText: vote && vote.textContent || '', favoriteText: favorite && favorite.textContent || '', commentText: (Array.from(node.querySelectorAll('button')).find((item) => /评论/.test(item.textContent || ''))?.textContent || ''), createdAt: created && created[1] || '', updatedAt: updated && updated[1] || '' };
  });
  if (!raw.title || !raw.content) throw new Error('article');
  const author = await authorFrom(root, selfToken);
  const stable = { id: articleId, title: cleanText(raw.title, 1000), authorId: author.id, content: cleanContent(raw.content, 500000) };
  return {
    id: articleId, title: stable.title, author, content: stable.content, url: 'https://zhuanlan.zhihu.com/p/' + articleId,
    ...(raw.createdAt ? { createdAt: cleanText(raw.createdAt, 128) } : {}),
    ...(raw.updatedAt ? { updatedAt: cleanText(raw.updatedAt, 128) } : {}),
    voteCount: countFrom(raw.voteText), commentCount: countFrom(raw.commentText), favorited: /取消收藏|已收藏/.test(raw.favoriteText),
    owned: author.owned, contentDigest: digest(stable)
  };
}
async function collectAnswers(page, selfToken, wanted) {
  const roots = page.locator('.AnswerItem, [class*="AnswerItem"]');
  const output = [];
  const count = Math.min(await roots.count(), 200);
  for (let index = 0; index < count && output.length < wanted; index += 1) {
    const answer = await projectAnswer(roots.nth(index), selfToken).catch(() => null);
    if (answer && !output.some((known) => known.id === answer.id)) output.push(answer);
  }
  return output;
}
async function projectSummary(root, selfToken) {
  const raw = await root.evaluate((node) => {
    let identity = null;
    let anchor = null;
    for (const candidate of node.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(candidate.href, location.href); } catch { continue; }
      let match = /^\/question\/(\d+)(?:\/answer\/(\d+))?\/?$/.exec(url.pathname);
      if (match) { identity = match[2] ? { kind: 'answer', id: match[2], url: 'https://www.zhihu.com/question/' + match[1] + '/answer/' + match[2] } : { kind: 'question', id: match[1], url: 'https://www.zhihu.com/question/' + match[1] }; anchor = candidate; break; }
      match = /^\/p\/(\d+)\/?$/.exec(url.pathname);
      if (match && url.hostname === 'zhuanlan.zhihu.com') { identity = { kind: 'article', id: match[1], url: 'https://zhuanlan.zhihu.com/p/' + match[1] }; anchor = candidate; break; }
    }
    if (!identity) return null;
    const heading = node.querySelector('h1,h2,h3,h4,[class*="title"], .ContentItem-title');
    const title = (heading?.textContent || anchor?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    const summary = (node.querySelector('.RichContent-inner, .RichText, [class*="excerpt"]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    const text = (node.textContent || '').replace(/\s+/g, ' ');
    const vote = /(\d+(?:\.\d+)?[万亿]?)\s*(?:赞同|赞)/.exec(text);
    const comments = /(\d+(?:\.\d+)?[万亿]?)\s*条?评论/.exec(text);
    const time = /(发布于|编辑于)\s*([^收]+?)(?:\s|$)/.exec(text);
    const author = Array.from(node.querySelectorAll('a[href*="/people/"]')).find((item) => (item.textContent || '').trim());
    return { identity, title, summary, vote: vote && vote[1] || '', comments: comments && comments[1] || '', createdAt: time && time[2] || '', authorName: author && (author.getAttribute('title') || author.textContent) || '', authorHref: author && author.href || '' };
  });
  if (!raw || !raw.title) return null;
  const stable = { kind: raw.identity.kind, id: raw.identity.id, title: cleanText(raw.title, 1000), summary: cleanText(raw.summary, 20000) };
  return {
    ...stable, url: raw.identity.url,
    ...(raw.authorName ? { authorName: cleanText(raw.authorName, 128) } : {}),
    voteCount: countFrom(raw.vote), commentCount: countFrom(raw.comments),
    ...(raw.createdAt ? { createdAt: cleanText(raw.createdAt, 128) } : {}),
    owned: !!raw.authorHref && userToken(raw.authorHref) === selfToken, contentDigest: digest(stable)
  };
}
async function collectSummaries(page, selfToken, wanted, kind) {
  const roots = page.locator('.ContentItem, .HotItem, article, [class*="SearchItem"]');
  const output = [];
  const count = Math.min(await roots.count(), 300);
  for (let index = 0; index < count && output.length < wanted; index += 1) {
    const item = await projectSummary(roots.nth(index), selfToken).catch(() => null);
    if (item && (!kind || kind === 'all' || item.kind === kind) && !output.some((known) => known.kind === item.kind && known.id === item.id)) output.push(item);
  }
  return output;
}
function targetUrl(kind, id) {
  if (kind === 'answer') return 'https://www.zhihu.com/answer/' + id;
  if (kind === 'article') return 'https://zhuanlan.zhihu.com/p/' + id;
  return 'https://www.zhihu.com/question/' + id;
}
async function openComments(page, kind, id) {
  await gotoPage(page, targetUrl(kind, id));
  const candidates = page.locator('button');
  const count = Math.min(await candidates.count(), 300);
  for (let index = 0; index < count; index += 1) {
    const button = candidates.nth(index);
    const text = cleanText(await button.innerText().catch(() => ''), 100);
    if (/评论/.test(text) && await visible(button)) { await button.click({ timeout: 10_000 }); await page.waitForTimeout(700); break; }
  }
  await assertNoChallenge(page);
}
async function projectComment(root, kind, targetId, selfToken, parentId = null) {
  const raw = await root.evaluate((node) => {
    const textRoot = node.querySelector('.CommentItem-content, [class*="CommentContent"], .RichText') || node;
    const text = (textRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    const author = Array.from(node.querySelectorAll('a[href*="/people/"]')).find((item) => (item.textContent || item.querySelector('img')?.alt || '').trim());
    const authorName = (author && (author.getAttribute('title') || author.textContent || author.querySelector('img')?.alt) || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const authorHref = author && author.href || '';
    const time = (node.querySelector('time, [class*="time"]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
    const vote = Array.from(node.querySelectorAll('button')).find((item) => /赞|取消赞/.test(item.textContent || item.getAttribute('aria-label') || ''));
    return { text, authorName, authorHref, time, voteText: vote && (vote.textContent || vote.getAttribute('aria-label')) || '', votePressed: vote && vote.getAttribute('aria-pressed') };
  });
  const token = userToken(raw.authorHref);
  if (!raw.text || !token || !raw.authorName) return null;
  const id = digest({ targetKind: kind, targetId, parentCommentId: parentId, authorId: token, text: cleanText(raw.text, 20000), createdAt: raw.time });
  const stable = { id, targetKind: kind, targetId, authorId: token, text: cleanText(raw.text, 20000), parentCommentId: parentId || null };
  return {
    id, targetKind: kind, targetId,
    author: { id: token, name: raw.authorName, url: 'https://www.zhihu.com/people/' + token, owned: token === selfToken },
    text: stable.text, ...(raw.time ? { createdAt: raw.time } : {}),
    voteCount: countFrom(raw.voteText), voteState: raw.votePressed === 'true' || /取消赞/.test(raw.voteText) ? 'up' : 'none',
    owned: token === selfToken, ...(parentId ? { parentCommentId: parentId } : {}), contentDigest: digest(stable)
  };
}
async function collectCommentEntries(page, kind, targetId, selfToken) {
  const roots = page.locator('.CommentItem, [class*="CommentItem"]');
  const output = [];
  const count = Math.min(await roots.count(), 500);
  for (let index = 0; index < count; index += 1) {
    const root = roots.nth(index);
    const parentRoot = root.locator('xpath=ancestor::*[contains(@class,"CommentItem")][1]');
    let parentId = null;
    if (await parentRoot.count()) {
      const parent = await projectComment(parentRoot.first(), kind, targetId, selfToken, null).catch(() => null);
      parentId = parent && parent.id || null;
    }
    const comment = await projectComment(root, kind, targetId, selfToken, parentId).catch(() => null);
    if (comment && !output.some((entry) => entry.comment.id === comment.id)) output.push({ root, comment });
  }
  return output;
}
async function findComment(page, kind, targetId, commentId, selfToken) {
  const matches = (await collectCommentEntries(page, kind, targetId, selfToken)).filter((entry) => entry.comment.id === commentId);
  return matches.length === 1 ? matches[0] : null;
}
async function actionRead(page, input) {
  const params = input.params;
  const selfToken = await ensureSelfToken(page);
  if (input.actionId === 'get_self') return { user: await getUser(page, selfToken, selfToken) };
  if (input.actionId === 'get_user') return { user: await getUser(page, params.urlToken, selfToken) };
  if (input.actionId === 'get_question') {
    await gotoPage(page, targetUrl('question', params.questionId));
    return { question: await projectQuestion(page, params.questionId, selfToken) };
  }
  if (input.actionId === 'get_answer') {
    await gotoPage(page, targetUrl('answer', params.answerId));
    const root = page.locator('.AnswerItem, [class*="AnswerItem"]').first();
    return { answer: await projectAnswer(root, selfToken, params.answerId) };
  }
  if (input.actionId === 'get_article') {
    await gotoPage(page, targetUrl('article', params.articleId));
    return { article: await projectArticle(page, params.articleId, selfToken) };
  }
  if (input.actionId === 'list_question_answers') {
    const offset = params.offset || 0;
    const count = params.count || 20;
    const sort = params.sort === 'updated' ? '?sort_by=updated' : '';
    await gotoPage(page, targetUrl('question', params.questionId) + sort);
    await scrollFor(page, offset + count + 1);
    const all = await collectAnswers(page, selfToken, offset + count + 1);
    const bounded = pageWithinFrame(all, offset, count);
    return { answers: bounded.items, hasMore: bounded.hasMore, nextOffset: bounded.nextOffset };
  }
  if (input.actionId === 'search_content') {
    const offset = params.offset || 0;
    const count = params.count || 20;
    await gotoPage(page, 'https://www.zhihu.com/search?type=content&q=' + encodeURIComponent(params.keyword));
    await scrollFor(page, offset + count + 1);
    const all = await collectSummaries(page, selfToken, offset + count + 1, params.kind || 'all');
    return pageWithinFrame(all, offset, count);
  }
  if (input.actionId === 'list_hot') {
    const count = params.count || 20;
    await gotoPage(page, 'https://www.zhihu.com/hot');
    await scrollFor(page, count);
    return { items: (await collectSummaries(page, selfToken, count, 'all')).slice(0, count) };
  }
  if (input.actionId === 'list_user_content') {
    const offset = params.offset || 0;
    const count = params.count || 20;
    const suffixes = params.kind === 'all' || !params.kind
      ? ['/answers', '/posts', '/asks']
      : [params.kind === 'article' ? '/posts' : params.kind === 'question' ? '/asks' : '/answers'];
    const all = [];
    for (const suffix of suffixes) {
      await gotoPage(page, 'https://www.zhihu.com/people/' + params.urlToken + suffix);
      await scrollFor(page, offset + count + 1);
      const items = await collectSummaries(page, selfToken, offset + count + 1, params.kind || 'all');
      for (const item of items)
        if (!all.some((known) => known.kind === item.kind && known.id === item.id)) all.push(item);
    }
    return pageWithinFrame(all, offset, count);
  }
  if (input.actionId === 'list_favorites') {
    const offset = params.offset || 0;
    const count = params.count || 20;
    await gotoPage(page, 'https://www.zhihu.com/collections/mine');
    await scrollFor(page, offset + count + 1);
    const all = await collectSummaries(page, selfToken, offset + count + 1, 'all');
    return pageWithinFrame(all, offset, count);
  }
  if (input.actionId === 'list_notifications') {
    const offset = params.offset || 0;
    const count = params.count || 20;
    await gotoPage(page, 'https://www.zhihu.com/notifications');
    for (let index = 0; index < 20; index += 1) {
      const current = await page.locator('.Notifications-item, [class*="NotificationItem"]').count();
      if (current >= offset + count + 1) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(700);
    }
    const roots = page.locator('.Notifications-item, [class*="NotificationItem"]');
    const rows = [];
    const total = Math.min(await roots.count(), offset + count + 1);
    for (let index = 0; index < total; index += 1) {
      const raw = await roots.nth(index).evaluate((node) => {
        const anchor = node.querySelector('a[href]');
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
        const time = (node.querySelector('time, [class*="time"]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 128);
        return { text, url: anchor && anchor.href || 'https://www.zhihu.com/notifications', time, unread: /unread|未读/i.test(node.className + ' ' + (node.getAttribute('aria-label') || '')) };
      });
      if (!raw.text) continue;
      const id = digest({ text: raw.text, url: raw.url, createdAt: raw.time });
      rows.push({ id, text: raw.text, url: raw.url.slice(0, 1024), ...(raw.time ? { createdAt: raw.time } : {}), unread: raw.unread, contentDigest: digest({ id, text: raw.text, url: raw.url }) });
    }
    const bounded = pageWithinFrame(rows, offset, count);
    return { notifications: bounded.items, hasMore: bounded.hasMore, nextOffset: bounded.nextOffset };
  }
  if (input.actionId === 'list_comments' || input.actionId === 'get_comment') {
    await openComments(page, params.targetKind, params.targetId);
    if (input.actionId === 'get_comment') {
      const found = await findComment(page, params.targetKind, params.targetId, params.commentId, selfToken);
      if (!found) throw new Error('comment');
      return { comment: found.comment };
    }
    const offset = params.offset || 0;
    const count = params.count || 20;
    for (let index = 0; index < 20; index += 1) {
      const current = await page.locator('.CommentItem, [class*="CommentItem"]').count();
      if (current >= offset + count + 1) break;
      const more = await exactControl(page, ['查看更多评论', '展开更多评论', '加载更多']);
      if (more) await more.click({ timeout: 10_000 });
      else await page.mouse.wheel(0, 900);
      await page.waitForTimeout(600);
    }
    const all = (await collectCommentEntries(page, params.targetKind, params.targetId, selfToken)).map((entry) => entry.comment);
    const bounded = pageWithinFrame(all, offset, count);
    return { comments: bounded.items, hasMore: bounded.hasMore, nextOffset: bounded.nextOffset };
  }
  throw new Error('action');
}
async function awaitDispatch() {
  writeFrame({ event: 'prepared' });
  const command = await readFrame();
  if (Object.keys(command).sort().join('\0') !== ['command'].join('\0') || command.command !== 'dispatch') throw new Error('dispatch');
}
function sameOwnedSnapshot(item, snapshot) {
  return !!item && item.owned === true && !!snapshot && snapshot.owned === true && item.contentDigest === snapshot.expectedDigest;
}
function sameCommentSnapshot(item, snapshot) {
  return !!item && !!snapshot && item.contentDigest === snapshot.expectedDigest && item.targetKind === snapshot.targetKind && item.targetId === snapshot.targetId && item.owned === snapshot.owned && (item.parentCommentId || null) === (snapshot.parentCommentId || null);
}
async function editorFill(page, text) {
  let editor = await uniqueVisible(page.locator('[contenteditable="true"]'));
  if (!editor) editor = await uniqueVisible(page.locator('textarea:not([placeholder*="标题"]):not([placeholder*="问题"])'));
  if (!editor) throw new Error('editor');
  if ((await editor.getAttribute('contenteditable')) === 'true') {
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(text);
  } else await editor.fill(text);
  return editor;
}
async function freshOwnedAnswer(page, id, selfToken) {
  await gotoPage(page, targetUrl('answer', id));
  const root = page.locator('.AnswerItem, [class*="AnswerItem"]').first();
  return projectAnswer(root, selfToken, id);
}
async function freshOwnedArticle(page, id, selfToken) {
  await gotoPage(page, targetUrl('article', id));
  return projectArticle(page, id, selfToken);
}
async function confirmDialog(page, labels) {
  const dialog = page.locator('[role="dialog"]').last();
  const control = await exactControl(dialog, labels);
  if (!control) throw new Error('confirm');
  await control.click({ timeout: 10_000 });
}
async function writeAction(page, input) {
  const params = input.params;
  const selfToken = await ensureSelfToken(page);
  if (input.actionId === 'create_question') {
    await gotoPage(page, 'https://www.zhihu.com/question/ask');
    const title = await uniqueVisible(page.locator('textarea[placeholder*="问题"], input[placeholder*="问题"], [contenteditable="true"][data-placeholder*="问题"]'));
    if (!title) throw new Error('question-editor');
    if ((await title.getAttribute('contenteditable')) === 'true') await title.fill(params.title); else await title.fill(params.title);
    if (params.detail) {
      const detail = await uniqueVisible(page.locator('[contenteditable="true"][data-placeholder*="问题背景"], textarea[placeholder*="问题背景"]'));
      if (!detail) throw new Error('question-detail');
      await detail.fill(params.detail);
    }
    for (const topic of params.topics || []) {
      const topicInput = await uniqueVisible(page.locator('input[placeholder*="话题"]'));
      if (!topicInput) throw new Error('question-topic');
      await topicInput.fill(topic);
      await page.waitForTimeout(400);
      const candidate = await uniqueVisible(page.getByText(topic, { exact: true }));
      if (!candidate) throw new Error('question-topic');
      await candidate.click({ timeout: 10_000 });
    }
    await awaitDispatch();
    await assertNoChallenge(page);
    if (cleanText(await title.inputValue().catch(() => title.innerText()), 1000) !== cleanText(params.title, 1000)) throw new Error('question-editor');
    const submit = await exactControl(page, ['发布问题']);
    if (!submit) throw new Error('question-submit');
    await submit.click({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    const identity = hrefIdentity(page.url());
    if (!identity || identity.kind !== 'question') throw new Error('question-result');
    return { question: await projectQuestion(page, identity.id, selfToken) };
  }
  if (input.actionId === 'create_article') {
    await gotoPage(page, 'https://zhuanlan.zhihu.com/write');
    const title = await uniqueVisible(page.locator('textarea[placeholder*="标题"], input[placeholder*="标题"]'));
    if (!title) throw new Error('article-title');
    await title.fill(params.title);
    await editorFill(page, params.content);
    await awaitDispatch();
    await assertNoChallenge(page);
    const publish = await exactControl(page, ['发布', '发布文章']);
    if (!publish) throw new Error('article-submit');
    await publish.click({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    const identity = hrefIdentity(page.url());
    if (!identity || identity.kind !== 'article') throw new Error('article-result');
    return { article: await projectArticle(page, identity.id, selfToken) };
  }
  if (input.actionId === 'create_answer') {
    await gotoPage(page, targetUrl('question', params.questionId));
    const write = await exactControl(page, ['写回答']);
    if (write) { await write.click({ timeout: 10_000 }); await page.waitForTimeout(500); }
    await editorFill(page, params.content);
    await awaitDispatch();
    await assertNoChallenge(page);
    const submit = await exactControl(page, ['发布回答']);
    if (!submit) throw new Error('answer-submit');
    await submit.click({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    const identity = hrefIdentity(page.url());
    const roots = page.locator('.AnswerItem, [class*="AnswerItem"]');
    let answer = null;
    const count = Math.min(await roots.count(), 100);
    for (let index = 0; index < count; index += 1) {
      const candidate = await projectAnswer(roots.nth(index), selfToken).catch(() => null);
      if (candidate && candidate.owned && candidate.questionId === params.questionId && candidate.content === cleanContent(params.content, 500000)) { answer = candidate; break; }
    }
    if (!answer && identity && identity.kind === 'answer') answer = await projectAnswer(roots.first(), selfToken, identity.id).catch(() => null);
    if (!answer) throw new Error('answer-result');
    return { answer };
  }
  if (input.actionId === 'edit_answer' || input.actionId === 'delete_answer') {
    const snapshot = input.actionId === 'edit_answer' ? params.editSnapshot : params.deleteSnapshot;
    const current = await freshOwnedAnswer(page, params.answerId, selfToken);
    if (!sameOwnedSnapshot(current, snapshot)) await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    await awaitDispatch();
    await assertNoChallenge(page);
    const fresh = await freshOwnedAnswer(page, params.answerId, selfToken);
    if (!sameOwnedSnapshot(fresh, snapshot)) await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    const menu = await exactControl(page, ['更多']);
    if (menu) { await menu.click({ timeout: 10_000 }); await page.waitForTimeout(300); }
    const control = await exactControl(page, input.actionId === 'edit_answer' ? ['编辑回答'] : ['删除回答', '删除']);
    if (!control) throw new Error('answer-control');
    await control.click({ timeout: 10_000 });
    if (input.actionId === 'delete_answer') {
      await confirmDialog(page, ['确定', '删除']);
      await page.waitForTimeout(1000);
      return { ok: true, changed: true };
    }
    await page.waitForTimeout(500);
    await editorFill(page, params.content);
    const save = await exactControl(page, ['保存修改', '发布回答']);
    if (!save) throw new Error('answer-save');
    await save.click({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    const answer = await freshOwnedAnswer(page, params.answerId, selfToken);
    if (answer.content !== cleanContent(params.content, 500000)) throw new Error('answer-result');
    return { answer };
  }
  if (input.actionId === 'edit_article' || input.actionId === 'delete_article') {
    const snapshot = input.actionId === 'edit_article' ? params.editSnapshot : params.deleteSnapshot;
    const current = await freshOwnedArticle(page, params.articleId, selfToken);
    if (!sameOwnedSnapshot(current, snapshot)) await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    await awaitDispatch();
    await assertNoChallenge(page);
    const fresh = await freshOwnedArticle(page, params.articleId, selfToken);
    if (!sameOwnedSnapshot(fresh, snapshot)) await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    if (input.actionId === 'delete_article') {
      const menu = await exactControl(page, ['更多']);
      if (menu) { await menu.click({ timeout: 10_000 }); await page.waitForTimeout(300); }
      const remove = await exactControl(page, ['删除文章', '删除']);
      if (!remove) throw new Error('article-delete');
      await remove.click({ timeout: 10_000 });
      await confirmDialog(page, ['确定', '删除']);
      await page.waitForTimeout(1000);
      return { ok: true, changed: true };
    }
    await gotoPage(page, 'https://zhuanlan.zhihu.com/p/' + params.articleId + '/edit');
    const title = await uniqueVisible(page.locator('textarea[placeholder*="标题"], input[placeholder*="标题"]'));
    if (!title) throw new Error('article-title');
    await title.fill(params.title);
    await editorFill(page, params.content);
    const publish = await exactControl(page, ['发布', '保存修改']);
    if (!publish) throw new Error('article-save');
    await publish.click({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    const article = await freshOwnedArticle(page, params.articleId, selfToken);
    if (article.title !== cleanText(params.title, 1000) || article.content !== cleanContent(params.content, 500000)) throw new Error('article-result');
    return { article };
  }
  if (input.actionId === 'create_comment') {
    await openComments(page, params.targetKind, params.targetId);
    const before = new Set((await collectCommentEntries(page, params.targetKind, params.targetId, selfToken)).map((entry) => entry.comment.id));
    const editor = await uniqueVisible(page.locator('textarea[placeholder*="评论"], [contenteditable="true"][data-placeholder*="评论"]'));
    if (!editor) throw new Error('comment-editor');
    await editor.fill(params.text);
    await awaitDispatch();
    await assertNoChallenge(page);
    const submit = await exactControl(page, ['发布', '评论']);
    if (!submit) throw new Error('comment-submit');
    await submit.click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    const candidates = await collectCommentEntries(page, params.targetKind, params.targetId, selfToken);
    const created = candidates.map((entry) => entry.comment).filter((item) => !before.has(item.id) && item.owned && item.text === cleanText(params.text, 20000));
    if (created.length !== 1) throw new Error('comment-result');
    return { comment: created[0] };
  }
  if (input.actionId === 'reply_comment' || input.actionId === 'delete_comment') {
    const snapshot = input.actionId === 'reply_comment' ? params.replySnapshot : params.deleteSnapshot;
    await openComments(page, params.targetKind, params.targetId);
    const current = await findComment(page, params.targetKind, params.targetId, params.commentId, selfToken);
    if (!current || !sameCommentSnapshot(current.comment, snapshot)) await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    const before = new Set((await collectCommentEntries(page, params.targetKind, params.targetId, selfToken)).map((entry) => entry.comment.id));
    await awaitDispatch();
    await assertNoChallenge(page);
    await openComments(page, params.targetKind, params.targetId);
    const fresh = await findComment(page, params.targetKind, params.targetId, params.commentId, selfToken);
    if (!fresh || !sameCommentSnapshot(fresh.comment, snapshot)) await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
    const control = await exactControl(fresh.root, input.actionId === 'reply_comment' ? ['回复'] : ['删除']);
    if (!control) throw new Error('comment-control');
    await control.click({ timeout: 10_000 });
    if (input.actionId === 'delete_comment') {
      const confirm = await exactControl(page.locator('[role="dialog"]').last(), ['确定', '删除']);
      if (confirm) await confirm.click({ timeout: 10_000 });
      await page.waitForTimeout(800);
      if (await findComment(page, params.targetKind, params.targetId, params.commentId, selfToken)) throw new Error('comment-delete');
      return { ok: true, changed: true };
    }
    const editor = await uniqueVisible(fresh.root.locator('textarea, [contenteditable="true"]'));
    if (!editor) throw new Error('reply-editor');
    await editor.fill(params.text);
    const submit = await exactControl(fresh.root, ['发布', '回复']);
    if (!submit) throw new Error('reply-submit');
    await submit.click({ timeout: 10_000 });
    await page.waitForTimeout(800);
    const candidates = await collectCommentEntries(page, params.targetKind, params.targetId, selfToken);
    const created = candidates.map((entry) => entry.comment).filter((item) => !before.has(item.id) && item.owned && item.text === cleanText(params.text, 20000));
    if (created.length !== 1) throw new Error('reply-result');
    return { comment: created[0] };
  }
  if (input.actionId === 'set_following') {
    if (params.targetKind === 'user') await gotoPage(page, 'https://www.zhihu.com/people/' + params.targetId);
    else await gotoPage(page, targetUrl('question', params.targetId));
    const labels = params.targetKind === 'user' ? ['关注', '已关注', '互相关注'] : ['关注问题', '已关注'];
    const before = await exactControl(page, labels);
    if (!before) throw new Error('following');
    const beforeState = /已关注|互相关注/.test(cleanText(await before.innerText(), 40));
    await awaitDispatch();
    await assertNoChallenge(page);
    if (params.targetKind === 'user') await gotoPage(page, 'https://www.zhihu.com/people/' + params.targetId);
    else await gotoPage(page, targetUrl('question', params.targetId));
    const fresh = await exactControl(page, labels);
    if (!fresh) throw new Error('following');
    const current = /已关注|互相关注/.test(cleanText(await fresh.innerText(), 40));
    if (current === params.following) return { ok: true, changed: false };
    await fresh.click({ timeout: 10_000 });
    await page.waitForTimeout(700);
    return { ok: true, changed: beforeState !== params.following };
  }
  if (input.actionId === 'set_favorite') {
    await gotoPage(page, targetUrl(params.targetKind, params.targetId));
    const button = await exactControl(page, ['收藏', '取消收藏', '已收藏']);
    if (!button) throw new Error('favorite');
    await awaitDispatch();
    await assertNoChallenge(page);
    await gotoPage(page, targetUrl(params.targetKind, params.targetId));
    const fresh = await exactControl(page, ['收藏', '取消收藏', '已收藏']);
    if (!fresh) throw new Error('favorite');
    const current = /取消收藏|已收藏/.test(cleanText(await fresh.innerText(), 40));
    if (current === params.favorited) return { ok: true, changed: false };
    await fresh.click({ timeout: 10_000 });
    await page.waitForTimeout(700);
    return { ok: true, changed: true };
  }
  if (input.actionId === 'set_answer_vote') {
    await gotoPage(page, targetUrl('answer', params.answerId));
    const root = page.locator('.AnswerItem, [class*="AnswerItem"]').first();
    const current = await projectAnswer(root, selfToken, params.answerId);
    await awaitDispatch();
    await assertNoChallenge(page);
    await gotoPage(page, targetUrl('answer', params.answerId));
    const freshRoot = page.locator('.AnswerItem, [class*="AnswerItem"]').first();
    const fresh = await projectAnswer(freshRoot, selfToken, params.answerId);
    if (fresh.voteState === params.vote) return { ok: true, changed: false };
    const targetVote = params.vote === 'none' ? fresh.voteState : params.vote;
    const labels = targetVote === 'down' ? ['反对', '取消反对'] : ['赞同', '取消赞同'];
    const control = await exactControl(freshRoot, labels);
    if (!control) throw new Error('vote');
    await control.click({ timeout: 10_000 });
    await page.waitForTimeout(700);
    return { ok: true, changed: current.voteState !== params.vote };
  }
  if (input.actionId === 'set_comment_vote') {
    await openComments(page, params.targetKind, params.targetId);
    const current = await findComment(page, params.targetKind, params.targetId, params.commentId, selfToken);
    if (!current) throw new Error('comment');
    await awaitDispatch();
    await assertNoChallenge(page);
    await openComments(page, params.targetKind, params.targetId);
    const fresh = await findComment(page, params.targetKind, params.targetId, params.commentId, selfToken);
    if (!fresh) throw new Error('comment');
    const voted = fresh.comment.voteState === 'up';
    if (voted === params.voted) return { ok: true, changed: false };
    const control = await exactControl(fresh.root, ['赞', '取消赞', '赞同', '取消赞同']);
    if (!control) throw new Error('comment-vote');
    await control.click({ timeout: 10_000 });
    await page.waitForTimeout(700);
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
  const canvas = page.locator('canvas.Qrcode-qrcode').first();
  await canvas.waitFor({ state: 'visible', timeout: 30_000 });
  let valid = false;
  for (let attempt = 0; attempt < 80 && !valid; attempt += 1) {
    valid = await canvas.evaluate((element) => element.width >= 80 && element.height >= 80).catch(() => false);
    if (!valid) await page.waitForTimeout(250);
  }
  if (!valid) throw new Error('qr');
  const png = await canvas.screenshot({ type: 'png', animations: 'disabled' });
  if (png.length < 100 || png.length > 512 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('qr');
  return png;
}
async function authCookieDigest(context) {
  const rows = (await context.cookies())
    .filter((cookie) => ['z_c0', 'd_c0', 'q_c1'].includes(cookie.name) && /(?:^|\.)zhihu\.com$/.test(cookie.domain.replace(/^\./, '')))
    .map((cookie) => cookie.domain + '\0' + cookie.name + '\0' + cookie.value).sort();
  return digest(rows);
}
async function proveSelf(context) {
  const page = await context.newPage();
  try {
    await gotoPage(page, 'https://www.zhihu.com/');
    const first = await selfTokenFromPage(page);
    if (!first) return null;
    await gotoPage(page, 'https://www.zhihu.com/people/' + first);
    const user = await projectUserFromPage(page, first, first);
    return user.owned === true && user.id === first ? first : null;
  } catch { return null; }
  finally { await page.close().catch(() => {}); }
}
async function runLogin(input, relay) {
  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, { cookies: [], origins: [] }, allowed);
    const page = await context.newPage();
    await gotoPage(page, 'https://www.zhihu.com/signin', false);
    let png = await captureQr(page);
    let qrHash = digest(png.toString('base64'));
    writeFrame({ event: 'qr', png: png.toString('base64') });
    const initialCookies = await authCookieDigest(context);
    let nextQr = Date.now() + QR_REFRESH_MS;
    let nextProbe = 0;
    while (Date.now() < input.deadlineMs) {
      if (!page.isClosed()) {
        await assertNoChallenge(page);
        if (Date.now() >= nextQr && await visible(page.locator('canvas.Qrcode-qrcode').first())) {
          nextQr = Date.now() + QR_REFRESH_MS;
          const fresh = await captureQr(page).catch(() => null);
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
      const signal = (await authCookieDigest(context)) !== initialCookies || !/\/signin(?:[/?#]|$)/.test(page.url());
      if (signal && Date.now() >= nextProbe) {
        nextProbe = Date.now() + 5_000;
        const selfToken = await proveSelf(context);
        if (selfToken) {
          const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
          await writeTerminalAndExit({ event: 'authenticated', storageState: state });
        }
      }
      await page.waitForTimeout(800);
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
} catch { await fail(); }
`
