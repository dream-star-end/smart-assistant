/** Trusted source materialized read-only into the exact pinned runtime image. */
export const KNOWLEDGE_PLANET_WORKER_SOURCE = String.raw`import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';

const require = createRequire(import.meta.url);
const playwrightMcpVersion = require('/usr/local/lib/node_modules/@playwright/mcp/package.json').version;
const { chromium, request } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BROKER_SOCKET = '/run/oc-browser-broker/tls.sock';
const MAX_INPUT = 512 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const NUMERIC_ID = /^\d{6,32}$/;
let terminal = false;

function fail() {
  if (terminal) return;
  terminal = true;
  writeFrame({ event: 'failed', code: 'WORKER_FAILED' });
}

function writeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_OUTPUT) throw new Error('output');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
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
      if (data.length > MAX_INPUT + 4) { cleanup(); return reject(new Error('input')); }
      if (expected === null && data.length >= 4) {
        expected = data.readUInt32BE(0);
        if (expected < 2 || expected > MAX_INPUT) { cleanup(); return reject(new Error('frame')); }
      }
      if (expected === null || data.length < expected + 4) return;
      if (data.length !== expected + 4) { cleanup(); return reject(new Error('frame')); }
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
      const head = pending.subarray(0, end).toString('ascii');
      const first = head.split('\r\n')[0] || '';
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
      tunnel.once('close', () => { if (acknowledged) client.end(); else close(); });
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function parseJsonPreservingLargeIntegers(text) {
  let normalized = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (inString) {
      normalized += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      index += 1;
      continue;
    }
    if (character === '-' || /\d/.test(character)) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        const number = match[0];
        const integer = !/[.eE]/.test(number);
        const unsafe = integer && (BigInt(number) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(number) < BigInt(Number.MIN_SAFE_INTEGER));
        normalized += unsafe ? JSON.stringify(number) : number;
        index += number.length;
        continue;
      }
    }
    normalized += character;
    index += 1;
  }
  return JSON.parse(normalized);
}

function text(value, maximum) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maximum);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function id(value) {
  const candidate = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return NUMERIC_ID.test(candidate) ? candidate : undefined;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function projectAuthor(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({ id: id(raw.user_id || raw.id), name: text(raw.name, 128) });
}

function topicText(raw) {
  return text(raw?.talk?.text ?? raw?.question?.text ?? raw?.answer?.text ?? raw?.text, 12_000);
}

function projectTopic(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.topic_id || raw.id),
    type: text(raw.type, 32),
    createdAt: text(raw.create_time || raw.created_at, 64),
    text: topicText(raw),
    author: projectAuthor(raw.talk?.owner || raw.question?.owner || raw.owner),
    commentCount: integer(raw.comments_count || raw.comment_count),
    likeCount: integer(raw.likes_count || raw.like_count),
  });
}

function projectGroup(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.group_id || raw.id),
    name: text(raw.name, 256),
    description: text(raw.description, 4_000),
    memberCount: integer(raw.members_count ?? raw.statistics?.members_count),
  });
}

function projectComment(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.comment_id || raw.id),
    createdAt: text(raw.create_time || raw.created_at, 64),
    text: text(raw.text, 5_000),
    author: projectAuthor(raw.owner || raw.user),
  });
}

function arrayAt(payload, key) {
  const data = payload && typeof payload === 'object' && payload.resp_data && typeof payload.resp_data === 'object' ? payload.resp_data : {};
  return Array.isArray(data[key]) ? data[key] : [];
}

function buildAction(action, params) {
  const count = Number.isInteger(params.count) ? params.count : 20;
  if (action === 'list_groups') return { path: '/v2/groups', query: {}, project: (data) => ({ groups: arrayAt(data, 'groups').slice(0, 50).map(projectGroup) }) };
  if (action === 'list_topics' && NUMERIC_ID.test(params.groupId)) return {
    path: '/v2/groups/' + params.groupId + '/topics',
    query: compact({ scope: 'all', count, end_time: text(params.endTime, 80) }),
    project: (data) => ({ topics: arrayAt(data, 'topics').slice(0, 50).map(projectTopic) }),
  };
  if (action === 'list_comments' && NUMERIC_ID.test(params.topicId)) return {
    path: '/v2/topics/' + params.topicId + '/comments',
    query: { sort: 'asc', count },
    project: (data) => ({ comments: arrayAt(data, 'comments').slice(0, 50).map(projectComment) }),
  };
  if (action === 'search_topics' && NUMERIC_ID.test(params.groupId) && typeof params.keyword === 'string') return {
    path: '/v2/search/groups/' + params.groupId + '/topics',
    query: { keyword: params.keyword.trim(), count, index: 0 },
    project: (data) => ({ topics: arrayAt(data, 'topics').slice(0, 50).map(projectTopic) }),
  };
  throw new Error('action');
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
  return {
    cookies: (Array.isArray(state?.cookies) ? state.cookies : []).filter((cookie) => domainSet.has(String(cookie.domain || '').replace(/^\./, '').toLowerCase())),
    origins: (Array.isArray(state?.origins) ? state.origins : []).filter((origin) => originSet.has(normalizeOrigin(origin?.origin))),
  };
}

function readAduid(state) {
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) if (item.name === 'XAduid' && typeof item.value === 'string' && item.value.length <= 256) return item.value;
  }
  return randomUUID();
}

async function runAction(input, relay) {
  const spec = buildAction(input.actionId, input.params || {});
  const url = new URL(spec.path, 'https://api.zsxq.com');
  for (const [key, value] of Object.entries(spec.query)) if (value !== undefined) url.searchParams.set(key, String(value));
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const aduid = readAduid(input.storageState || {});
  const signature = createHash('sha1').update(url.toString().replace(/'/g, '%27') + ' ' + timestamp + ' ' + requestId).digest('hex');
  const api = await request.newContext({
    storageState: input.storageState,
    proxy: { server: relay.proxy },
    ignoreHTTPSErrors: false,
  });
  try {
    const response = await api.get(url.toString(), {
      failOnStatusCode: false,
      timeout: 30_000,
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://wx.zsxq.com',
        referer: 'https://wx.zsxq.com/',
        'x-request-id': requestId,
        'x-timestamp': timestamp,
        'x-version': '2.94.0',
        'x-signature': signature,
        'x-aduid': aduid,
      },
    });
    const body = await response.body();
    if (body.length > 2 * 1024 * 1024) throw new Error('response');
    let data;
    try { data = parseJsonPreservingLargeIntegers(body.toString('utf8')); } catch { throw new Error('response'); }
    if (!response.ok() || data?.succeeded === false) {
      writeFrame({ event: 'failed', code: response.status() === 401 || [1001, 1002, 1059].includes(data?.code) ? 'LOGIN_EXPIRED' : 'UPSTREAM_FAILED' });
      terminal = true;
      return;
    }
    const state = await api.storageState();
    writeFrame({ event: 'completed', result: spec.project(data), storageState: filteredState(state, input.cookieDomains, input.stateOrigins) });
    terminal = true;
  } finally {
    await api.dispose();
  }
}

async function captureQr(page) {
  for (const frame of page.frames().slice(1)) {
    const images = frame.locator('img.qrcode, img[src*="/connect/qrcode/"]');
    for (let i = 0, count = await images.count().catch(() => 0); i < count; i += 1) {
      const image = images.nth(i);
      if (!await image.isVisible().catch(() => false)) continue;
      const loaded = await image.evaluate((element) => element.complete && element.naturalWidth >= 180 && element.naturalHeight >= 180).catch(() => false);
      if (loaded) return image.screenshot({ type: 'png' });
    }
  }
  const frame = page.locator('iframe[src*="open.weixin.qq.com"]').first();
  if (await frame.isVisible().catch(() => false)) return frame.screenshot({ type: 'png' });
  throw new Error('qr');
}

async function runLogin(input, relay) {
  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: relay.proxy },
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
      '--disable-breakpad', '--disable-component-update', '--disable-default-apps',
      '--disable-domain-reliability', '--disable-extensions', '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate',
      '--disable-quic', '--disable-sync', '--metrics-recording-only', '--no-first-run',
      '--no-default-browser-check', '--no-pings', '--password-store=basic',
      '--use-mock-keychain', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  });
  try {
    const context = await browser.newContext({
      locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block', storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const request = route.request();
      let origin;
      try { origin = new URL(request.url()).origin; } catch { return route.abort(); }
      if (!allowed.has(origin) || !['GET', 'POST'].includes(request.method()) || ['websocket', 'eventsource'].includes(request.resourceType())) return route.abort();
      return route.continue();
    });
    if (typeof page.routeWebSocket === 'function') await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.goto('https://wx.zsxq.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    let qrButton = page.getByRole('button', { name: /获取登录二维码/ }).first();
    if (!await qrButton.isVisible().catch(() => false)) {
      const switchButton = page.getByText('切换至微信登录', { exact: true }).first();
      if (await switchButton.isVisible().catch(() => false)) await switchButton.click();
      qrButton = page.getByRole('button', { name: /获取登录二维码/ }).first();
    }
    if (await qrButton.isVisible().catch(() => false)) await qrButton.click();
    const agree = page.locator('.agreement-overlay .agree-btn, button.agree-btn').first();
    if (await agree.isVisible().catch(() => false)) await agree.click();
    if (await qrButton.isVisible().catch(() => false)) await qrButton.click();
    await page.locator('iframe[src*="open.weixin.qq.com"]').first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(800);
    const qr = await captureQr(page);
    if (qr.length > 512 * 1024) throw new Error('qr');
    writeFrame({ event: 'qr', png: qr.toString('base64') });
    while (Date.now() < input.deadlineMs) {
      const url = page.url();
      const loginVisible = await page.getByText('登录知识星球', { exact: false }).first().isVisible().catch(() => false);
      if (!/\/login(?:[/?#]|$)/.test(new URL(url).pathname + new URL(url).search) && !loginVisible) {
        const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
        writeFrame({ event: 'authenticated', storageState: state });
        terminal = true;
        return;
      }
      await page.waitForTimeout(1000);
    }
    writeFrame({ event: 'failed', code: 'LOGIN_EXPIRED' });
    terminal = true;
  } finally {
    await browser.close();
  }
}

try {
  const input = await readFrame();
  const required = input.mode === 'action'
    ? ['actionId', 'cookieDomains', 'deadlineMs', 'mode', 'params', 'stateOrigins', 'storageState', 'token']
    : ['allowedOrigins', 'cookieDomains', 'deadlineMs', 'mode', 'stateOrigins', 'token'];
  if (Object.keys(input).sort().join('\0') !== required.sort().join('\0')) throw new Error('input');
  if (!['action', 'login'].includes(input.mode) || typeof input.token !== 'string' || !Array.isArray(input.cookieDomains) || !Array.isArray(input.stateOrigins)) throw new Error('input');
  const remaining = Number(input.deadlineMs) - Date.now();
  if (!Number.isFinite(remaining) || remaining < 1_000 || remaining > 5 * 60_000) throw new Error('deadline');
  writeFrame({ event: 'ready', runtime: 'knowledge-planet-worker-v1', playwrightMcpVersion });
  const relayHosts = new Set(input.mode === 'action' ? ['api.zsxq.com'] : input.allowedOrigins.map((origin) => new URL(origin).hostname));
  const relay = await startRelay(input.token, relayHosts);
  const timer = setTimeout(() => process.exit(124), remaining + 2_000);
  try {
    if (input.mode === 'action') await runAction(input, relay);
    else await runLogin(input, relay);
  } finally {
    clearTimeout(timer);
    await relay.close();
  }
  if (!terminal) fail();
} catch {
  fail();
}
`
