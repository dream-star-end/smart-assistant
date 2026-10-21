/**
 * Reviewed Douyin worker (OCV5-553). QR login with the account owner's SMS verification + the read-only
 * `me` action.
 *
 * Same frame protocol, broker relay and storage filtering as the reviewed Bilibili account worker
 * (biliAccountWorkerSource.ts). No Playwright request client and no Node-side cookie replay: the
 * action opens https://creator.douyin.com/robots.txt (light, same origin) and reads the creator
 * platform's own user-info endpoint with `fetch(..., { credentials: 'include' })` inside that page.
 *
 * Login (design 4.3.C, from the 2026-10-22 live test):
 * - QR codes come from the page's own get_qrcode / check_qrconnect responses (PNG + expire_time) and
 *   are published only after the page has polled that code and got `new` with ≥45s left — a code the
 *   page no longer polls can be scanned on the phone but never logs the web session in.
 * - The login widget stops rotating after a few codes (or after a 502): the worker clicks the QR
 *   centre and reopens the page if no new get_qrcode follows.
 * - Douyin asks the account owner to verify identity after the scan. The worker reports it
 *   (`verification` frame) and only acts on the master's command frames on stdin: `send_sms`
 *   (click 「接收短信验证码」; send_code must succeed), `sms_code` (fill + 「验证」; validate_code
 *   decides), `resend_sms`, `abort`. The code is typed into the page and never logged or echoed.
 * - A visible captcha / slider or HTTP 403 / 429 still stops immediately (UPSTREAM_CHALLENGE); no
 *   bypass. Verification methods other than SMS (face, upstream SMS) end the login
 *   (VERIFICATION_REQUIRED).
 * Headless only: the headful-only native 「Open xdg-open?」 dialog never appears; JS dialogs are dismissed.
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
const QR_EXPIRED_TEXT = /二维码已?失效|二维码已过期|点击刷新/;
const QR_MIN_PUBLISH_MS = 45_000;
const QR_STALL_MS = 10_000;
const VERIFY_WINDOW_MS = 180_000;
const VALIDATE_WAIT_MS = 40_000;
const SMS_RESEND_AFTER_SEC = 60;
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
 * passport account/info 返回 message "error" + data.error_code 1「会话过期」。只有这两种明确应答算未登录；
 * 其它应答（含 account/info 登录后的 1011）都是 WORKER_FAILED。
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
  // 登录后这个备用接口返回 1011「用户不存在」（2026-10-22 实测）：表示接口不可用，不是登录失效。
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
  const loggedBlocked = new Set();
  await context.route('**/*', async (route) => {
    const request = route.request();
    let origin;
    try { origin = new URL(request.url()).origin; } catch { await route.abort(); return; }
    if (!allowed.has(origin) || !methods.includes(request.method()) || ['websocket', 'eventsource'].includes(request.resourceType())) {
      // 只记被拦下的来源域名（每个域名一次），用于下一次实测决定白名单；不记路径和参数。
      try { const host = new URL(origin).hostname; if (!loggedBlocked.has(host) && loggedBlocked.size < 64) { loggedBlocked.add(host); emitStep({ step: 'net.blocked', host }); } } catch {}
      await route.abort();
      return;
    }
    await route.continue();
  });
  context.on('page', (page) => page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); }));
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

const QR_SELECTOR = 'img[aria-label="二维码"]';
async function pageText(page) {
  return (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).replace(/\s+/g, ' ');
}
/** 可见的验证码 / 滑块（风控）：任何页面出现就停，绝不尝试处理。 */
function challengeCode(text) { return CHALLENGE_TEXT.test(text) ? 'UPSTREAM_CHALLENGE' : null; }
async function pageChallenge(context) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const code = challengeCode(await pageText(page));
    if (code) return code;
  }
  return null;
}
/** check_qrconnect 返回多因素验证参数（无 status，带 std_verify_* / passport_mfa_*）= 要求本人验证。 */
function isMfaResponse(data) {
  if (!data || typeof data !== 'object' || data.status) return false;
  const keys = JSON.stringify([Object.keys(data.biz_params || {}), Object.keys(data.common_params || {})]);
  return /std_verify|passport_mfa/.test(keys);
}
/**
 * 二维码追踪（纯逻辑）。新码先挂起（记下它的 token）；页面随后**带着这个 token** 轮询并得到 new、且剩余
 * ≥45 秒，才发布给用户。旧码的迟到应答不会让新码被发布（Codex r1 P1）。
 * 返回 { publish, invalidate, mfa, status }；invalidate 时调用方要通知 master 撤下已发布的码。
 */
const QR_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
function newQrTracker() { return { pending: null, published: null, lastPollAt: 0, lastGetQrAt: 0, status: null }; }
function qrOnResponse(tracker, path, http, json, now, requestToken) {
  const out = { publish: null, invalidate: false, mfa: false, status: null };
  const isPoll = /check_qrconnect/.test(path);
  if (!isPoll && !/get_qrcode/.test(path)) return out;
  if (isPoll && http !== 200) { out.invalidate = !!(tracker.published || tracker.pending); tracker.published = null; tracker.pending = null; return out; }
  if (isPoll) tracker.lastPollAt = now;
  const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : {};
  if (isPoll && isMfaResponse(data)) { out.mfa = true; return out; }
  if (typeof data.status === 'string') { tracker.status = data.status; out.status = data.status; }
  if (typeof data.qrcode === 'string' && data.qrcode.length > 100 && Number.isFinite(Number(data.expire_time))) {
    const b64 = data.qrcode.replace(/^data:image\/[a-z]+;base64,/, '');
    const token = typeof data.token === 'string' && QR_TOKEN_RE.test(data.token) ? data.token : null;
    tracker.pending = token && /^[A-Za-z0-9+/=]+$/.test(b64) && b64.length <= 700000 ? { png: b64, expireAt: Number(data.expire_time) * 1000, token } : null;
    tracker.published = null;
    out.invalidate = true;
    return out;
  }
  if (isPoll && data.status === 'new' && tracker.pending && requestToken === tracker.pending.token) {
    if (tracker.pending.expireAt - now >= QR_MIN_PUBLISH_MS) { tracker.published = tracker.pending; out.publish = tracker.pending; }
    tracker.pending = null;
  }
  return out;
}
/** 轮询请求带的二维码 token（查询串或表单 / JSON 请求体）。拿不到就是 null，对应的码不会被发布。 */
function requestQrToken(url, postData) {
  try { const q = new URL(url).searchParams.get('token'); if (q && QR_TOKEN_RE.test(q)) return q; } catch {}
  if (typeof postData === 'string' && postData) {
    try { const f = new URLSearchParams(postData).get('token'); if (f && QR_TOKEN_RE.test(f)) return f; } catch {}
    try { const j = JSON.parse(postData); if (j && typeof j.token === 'string' && QR_TOKEN_RE.test(j.token)) return j.token; } catch {}
  }
  return null;
}
/** send_code / validate_code 的应答：403/429 或带验证码 = 风控，立即停（不重试）。 */
function smsResponse(http, json) {
  const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : {};
  return {
    ok: !!(http === 200 && json && json.message === 'success'),
    challenge: http === 403 || http === 429 || (typeof data.captcha === 'string' && data.captcha.length > 0)
  };
}
/** 换码卡住：显示失效覆盖层 / 已发布的码过期超过 10 秒 / 超过 10 秒没有轮询。 */
function qrNeedsKick(tracker, now, overlayVisible) {
  return !!(overlayVisible || (tracker.published && now > tracker.published.expireAt + QR_STALL_MS) || (tracker.lastPollAt && now - tracker.lastPollAt > QR_STALL_MS));
}
/** master → worker 命令帧。验证码只接受 4–8 位数字。 */
function validCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { cmd: 'invalid' };
  const keys = Object.keys(value).sort().join(',');
  if (['send_sms', 'resend_sms', 'abort'].includes(value.cmd) && keys === 'cmd') return { cmd: value.cmd };
  if (value.cmd === 'sms_code' && keys === 'cmd,code' && typeof value.code === 'string' && /^[0-9]{4,8}$/.test(value.code)) return { cmd: 'sms_code', code: value.code };
  return { cmd: 'invalid' };
}
const commands = [];
function startCommandReader() {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 64 * 1024) { buffer = Buffer.alloc(0); commands.push({ cmd: 'invalid' }); return; }
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (size < 2 || size > 4096) { buffer = Buffer.alloc(0); commands.push({ cmd: 'invalid' }); return; }
      if (buffer.length < size + 4) return;
      const body = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      try { commands.push(validCommand(JSON.parse(body.toString('utf8')))); } catch { commands.push({ cmd: 'invalid' }); }
      body.fill(0);
    }
  });
  process.stdin.resume();
}
async function nextCommand(page, untilMs) {
  while (Date.now() < untilMs) {
    if (commands.length) return commands.shift();
    await page.waitForTimeout(200).catch(() => {});
  }
  return null;
}
async function waitFor(page, predicate, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (predicate()) return true; await page.waitForTimeout(150).catch(() => {}); }
  return predicate();
}
async function kickQr(page, tracker) {
  const before = tracker.lastGetQrAt;
  const box = await page.locator(QR_SELECTOR).first().boundingBox().catch(() => null);
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
  if (await waitFor(page, () => tracker.lastGetQrAt !== before, 6_000)) { emitStep({ step: 'login.qr_kicked', ok: true }); return 'clicked'; }
  emitStep({ step: 'login.qr_reopen' });
  tracker.lastPollAt = 0; tracker.published = null; tracker.pending = null;
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  return 'reopened';
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
async function failLogin(code, step) {
  emitStep({ step: step || 'login.failed', code });
  await writeTerminalAndExit({ event: 'failed', code });
}
/** 本人短信验证：等 master 的命令；验证码只填进输入框，不记录、不回显。 */
async function runVerification(login, flags, deadlineMs) {
  const smsOption = login.getByText('接收短信验证码', { exact: true }).first();
  const available = await waitFor(login, () => false, 1_500).then(() => smsOption.isVisible().catch(() => false));
  writeFrame({ event: 'verification', kind: available ? 'sms_available' : 'unsupported' });
  emitStep({ step: 'login.verification', kind: available ? 'sms_available' : 'unsupported' });
  const until = Math.min(deadlineMs, Date.now() + VERIFY_WINDOW_MS);
  while (Date.now() < until) {
    const challenge = await pageChallenge(login.context());
    if (challenge) await failLogin(challenge, 'login.blocked');
    if (flags.validated) return;
    const command = await nextCommand(login, Math.min(until, Date.now() + 1_000));
    if (!command) continue;
    if (command.cmd === 'invalid') await failLogin('WORKER_FAILED', 'login.command_invalid');
    if (command.cmd === 'abort' || !available) await failLogin('VERIFICATION_REQUIRED', 'login.verification_aborted');
    if (command.cmd === 'send_sms' || command.cmd === 'resend_sms') {
      // 一次命令只点一次（一份限频额度对应一次发送，Codex r1 P1）；以 send_code 应答为准。
      const before = flags.sendCode.at;
      const target = command.cmd === 'send_sms' ? smsOption : login.getByText('重新发送', { exact: true }).last();
      await target.click({ timeout: 3_000 }).catch(() => {});
      await waitFor(login, () => flags.sendCode.at !== before, 6_000);
      if (flags.sendCode.at !== before && flags.sendCode.challenge) await failLogin('UPSTREAM_CHALLENGE', 'login.sms_challenge');
      if (flags.sendCode.at !== before && flags.sendCode.ok) { writeFrame({ event: 'sms_sent', resendAfterSec: SMS_RESEND_AFTER_SEC }); emitStep({ step: 'login.sms_sent' }); }
      else if (command.cmd === 'send_sms') await failLogin('VERIFICATION_REQUIRED', 'login.sms_send_failed');
      else writeFrame({ event: 'sms_resend_failed' });
      continue;
    }
    if (command.cmd === 'sms_code') {
      const before = flags.validateAt;
      const input = login.getByPlaceholder('请输入验证码').last();
      await input.click({ timeout: 5_000 }).catch(() => {});
      await input.fill(command.code, { timeout: 5_000 }).catch(() => {});
      command.code = '';
      await login.getByText('验证', { exact: true }).last().click({ timeout: 5_000 }).catch(() => {});
      await waitFor(login, () => flags.validateAt !== before, VALIDATE_WAIT_MS);
      if (flags.validateAt !== before && flags.validateChallenge) await failLogin('UPSTREAM_CHALLENGE', 'login.sms_challenge');
      if (flags.validateAt !== before && flags.validateOk) { flags.validated = true; emitStep({ step: 'login.sms_validated' }); return; }
      await input.fill('', { timeout: 2_000 }).catch(() => {});
      writeFrame({ event: 'sms_rejected' });
      emitStep({ step: 'login.sms_rejected' });
    }
  }
  await failLogin('LOGIN_EXPIRED', 'login.verification_timeout');
}
async function runLogin(input, relay) {
  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const browser = await chromium.launch({ headless: true, proxy: { server: relay.proxy }, args: browserArgs() });
  try {
    const context = await secureContext(browser, { cookies: [], origins: [] }, allowed, ['GET', 'POST', 'HEAD']);
    const tracker = newQrTracker();
    const flags = { mfa: false, validated: false, sendCode: { at: 0, ok: false, challenge: false }, validateAt: 0, validateOk: false, validateChallenge: false };
    context.on('request', (request) => { try { if (/\/passport\/web\/get_qrcode\//.test(new URL(request.url()).pathname)) tracker.lastGetQrAt = Date.now(); } catch {} });
    context.on('response', async (response) => {
      let path;
      try { path = new URL(response.url()).pathname; } catch { return; }
      if (!/\/passport\/web\/(get_qrcode|check_qrconnect|send_code|validate_code)\//.test(path)) return;
      let json = null;
      try { json = JSON.parse(await response.text()); } catch {}
      if (/send_code/.test(path)) { const r = smsResponse(response.status(), json); flags.sendCode = { at: Date.now(), ok: r.ok, challenge: r.challenge }; return; }
      if (/validate_code/.test(path)) { const r = smsResponse(response.status(), json); flags.validateOk = r.ok; flags.validateChallenge = r.challenge; flags.validateAt = Date.now(); return; }
      const request = response.request();
      const out = qrOnResponse(tracker, path, response.status(), json, Date.now(), requestQrToken(request.url(), request.postData()));
      if (out.mfa) flags.mfa = true;
      // 码作废（换码 / 502）：立即让 master 撤下已发布的码，免得用户继续扫一个已失效的码（Codex r1 P1）。
      if (out.invalidate) writeFrame({ event: 'qr_invalid' });
      if (out.publish) { writeFrame({ event: 'qr', png: out.publish.png, expireAt: out.publish.expireAt }); emitStep({ step: 'login.qr' }); }
    });
    const login = await context.newPage();
    await login.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!(await waitFor(login, () => !!tracker.published, Math.min(QR_WAIT_MS, Math.max(1_000, input.deadlineMs - Date.now() - 5_000)))))
      await failLogin((await pageChallenge(context)) || 'WORKER_FAILED', 'login.no_qr');
    const initialCookies = await authCookieDigest(context);
    let nextProbe = 0, nextKick = 0;
    while (Date.now() < input.deadlineMs) {
      const challenge = await pageChallenge(context);
      if (challenge) await failLogin(challenge, 'login.blocked');
      const onRoot = onLoginPage(login);
      if (!flags.validated && (flags.mfa || (onRoot && VERIFICATION_TEXT.test(await pageText(login))))) {
        await runVerification(login, flags, input.deadlineMs);
        continue;
      }
      if (onRoot && !flags.validated && tracker.status !== 'scanned' && tracker.status !== 'confirmed' && Date.now() >= nextKick &&
          qrNeedsKick(tracker, Date.now(), QR_EXPIRED_TEXT.test(await pageText(login)))) {
        nextKick = Date.now() + ((await kickQr(login, tracker)) === 'reopened' ? 90_000 : 15_000);
      }
      const signal = (await authCookieDigest(context)) !== initialCookies || !onLoginPage(login) || tracker.status === 'confirmed';
      if (signal && Date.now() >= nextProbe) {
        nextProbe = Date.now() + 5_000;
        const self = await proveSelf(context);
        if (self) {
          const late = await pageChallenge(context);
          if (late) await failLogin(late, 'login.blocked');
          const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
          // 平台只保存带 Secure 的 cookie：登录凭据被过滤掉就明确失败，绝不存一份无法使用的登录状态。
          if (!state.cookies.some((cookie) => SESSION_COOKIES.includes(cookie.name))) await failLogin('LOGIN_STATE_UNSUPPORTED', 'login.state_unsupported');
          emitStep({ step: 'login.authenticated' });
          await writeTerminalAndExit({ event: 'authenticated', storageState: state });
        }
      }
      await login.waitForTimeout(800).catch(() => {});
    }
    await failLogin('LOGIN_EXPIRED', 'login.deadline');
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
    else { startCommandReader(); await runLogin(input, relay); }
  } finally {
    clearTimeout(timer);
    await relay.close();
  }
  if (!terminal) await fail();
} catch (error) { await fail(error); }
`
