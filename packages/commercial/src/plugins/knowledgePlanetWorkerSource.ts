export const KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS = 3_000
export const KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS = 5_000
export const KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS = 48
export const KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS = 45_000
export const KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION = 0.15
export const KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION = 0.2
export const KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION = 70
export const KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES = 1024 * 1024
export const KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES = 256 * 1024
export const KNOWLEDGE_PLANET_TOPIC_PAGE_MAX = 10

export function isKnowledgePlanetQrPixelSampleReady(input: {
  darkFraction: number
  lightFraction: number
  luminanceDeviation: number
}): boolean {
  return (
    input.darkFraction >= KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION &&
    input.lightFraction >= KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION &&
    input.luminanceDeviation >= KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION
  )
}

export function isKnowledgePlanetLoginProbeDue(
  now: number,
  nextProbeAt: number,
  attempts: number,
): boolean {
  return now >= nextProbeAt && attempts < KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS
}

/** Trusted source materialized read-only into the exact pinned runtime image. */
export const KNOWLEDGE_PLANET_WORKER_SOURCE = String.raw`import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';

const require = createRequire(import.meta.url);
const playwrightMcpVersion = require('/usr/local/lib/node_modules/@playwright/mcp/package.json').version;
const { chromium, request } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');
const BROKER_SOCKET = '/run/oc-browser-broker/tls.sock';
const MAX_INPUT = 512 * 1024;
const MAX_OUTPUT = ${KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES};
const MAX_STATE_JSON = ${KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES};
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

// Bound the serialized JSON string, not only JavaScript characters. CJK text,
// quotes and backslashes otherwise make schema-valid arrays exceed the 1 MiB
// worker frame even when every maxLength/maxItems constraint is respected.
function jsonText(value, maximum, maximumJsonBytes) {
  let candidate = text(value, maximum);
  if (candidate === undefined) return undefined;
  while (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maximumJsonBytes) {
    if (candidate.length === 0) return '';
    candidate = candidate.slice(0, Math.max(0, Math.floor(candidate.length * 0.8)));
  }
  return candidate;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined;
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
  return compact({ id: id(raw.user_id || raw.uid || raw.id), name: text(raw.name, 128) });
}

function plainText(value, maximum, maximumJsonBytes) {
  if (typeof value !== 'string') return undefined;
  return jsonText(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), maximum, maximumJsonBytes);
}

function topicText(raw) {
  const parts = [
    raw?.talk?.text, raw?.task?.title, raw?.task?.text, raw?.text,
  ].filter((item) => typeof item === 'string' && item.trim());
  return jsonText(parts.join('\n\n'), 12_000, 12 * 1024);
}

function projectImage(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const original = raw.original && typeof raw.original === 'object' ? raw.original : {};
  return compact({
    id: id(raw.image_id || raw.id),
    type: text(raw.type || raw.mime_type, 64),
    width: integer(original.width ?? raw.width),
    height: integer(original.height ?? raw.height),
    size: integer(original.size ?? raw.size),
  });
}

function projectFile(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.file_id || raw.id),
    name: jsonText(raw.name || raw.filename, 512, 1024),
    type: jsonText(raw.type || raw.mime_type || raw.content_type, 128, 256),
    size: integer(raw.size),
    duration: integer(raw.duration),
  });
}

function projectArticle(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.article_id || raw.id),
    title: jsonText(raw.title, 512, 1024),
    summary: plainText(raw.summary || raw.inline_content_html || raw.content, 4_000, 4 * 1024),
  });
}

function projectTopic(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const talk = raw.talk && typeof raw.talk === 'object' ? raw.talk : {};
  const article = talk.article || raw.article;
  const images = Array.isArray(talk.images) ? talk.images : Array.isArray(raw.images) ? raw.images : [];
  const files = Array.isArray(talk.files) ? talk.files : Array.isArray(raw.files) ? raw.files : [];
  return compact({
    id: id(raw.topic_id || raw.id),
    type: text(raw.type, 32),
    createdAt: text(raw.create_time || raw.created_at, 64),
    groupId: id(raw.group?.group_id || raw.group_id),
    title: jsonText(raw.title || raw.task?.title || article?.title, 512, 1024),
    text: topicText(raw),
    question: jsonText(raw.question?.text, 8_000, 8 * 1024),
    answer: jsonText(raw.answer?.text || raw.solution?.text, 8_000, 8 * 1024),
    author: projectAuthor(talk.owner || raw.task?.owner || raw.question?.owner || raw.answer?.owner || raw.solution?.owner || raw.owner),
    commentCount: integer(raw.comments_count ?? raw.comment_count),
    likeCount: integer(raw.likes_count ?? raw.like_count),
    readCount: integer(raw.readers_count ?? raw.reading_count ?? raw.read_count),
    rewardCount: integer(raw.rewards_count ?? raw.reward_count),
    digested: booleanValue(raw.digested),
    sticky: booleanValue(raw.sticky),
    images: images.slice(0, 10).map(projectImage),
    files: files.slice(0, 10).map(projectFile),
    article: article && typeof article === 'object' ? projectArticle(article) : undefined,
  });
}

function projectGroup(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.group_id || raw.id),
    name: text(raw.name, 256),
    description: text(raw.description, 4_000),
    type: text(raw.type, 32),
    memberCount: integer(raw.member_count ?? raw.members_count ?? raw.statistics?.members_count ?? raw.statistics?.subscriptions_count),
    topicCount: integer(raw.topic_count ?? raw.topics_count ?? raw.statistics?.topics_count),
    createdAt: text(raw.create_time || raw.created_at, 64),
    joinedAt: text(raw.user_specific?.join_time, 64),
    validUntil: text(raw.user_specific?.validity?.end_time, 64),
    owner: projectAuthor(raw.owner),
  });
}

function projectComment(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.comment_id || raw.id),
    createdAt: text(raw.create_time || raw.created_at, 64),
    text: text(raw.text, 5_000),
    author: projectAuthor(raw.owner || raw.user),
    replyTo: projectAuthor(raw.repliee || raw.reply_to),
    likeCount: integer(raw.likes_count ?? raw.like_count),
    sticky: booleanValue(raw.sticky),
  });
}

function projectHashtag(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.hashtag_id || raw.id),
    name: text(raw.name || raw.title, 256),
    topicCount: integer(raw.topics_count ?? raw.topic_count ?? raw.statistics?.topics_count),
  });
}

function projectColumn(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.column_id || raw.id),
    name: text(raw.name, 256),
    description: text(raw.description, 4_000),
    topicCount: integer(raw.topics_count ?? raw.topic_count ?? raw.statistics?.topics_count),
    createdAt: text(raw.create_time || raw.created_at, 64),
  });
}

function projectCheckin(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return compact({
    id: id(raw.checkin_id || raw.id),
    groupId: id(raw.group?.group_id || raw.group_id),
    name: text(raw.name || raw.title, 256),
    description: text(raw.description || raw.text, 4_000),
    status: text(raw.status, 32),
    createdAt: text(raw.create_time || raw.created_at, 64),
    beginAt: text(raw.begin_time || raw.begin_at, 64),
    endAt: text(raw.end_time || raw.end_at, 64),
    owner: projectAuthor(raw.owner),
  });
}

function dataAt(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const candidate = payload.resp_data ?? payload.data ?? payload;
  return candidate && typeof candidate === 'object' ? candidate : {};
}

function firstArrayAt(payload, keys) {
  const data = dataAt(payload);
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data[key])) return data[key];
  return [];
}

function objectAt(payload, key) {
  const data = dataAt(payload);
  if (data && typeof data === 'object' && data[key] && typeof data[key] === 'object') return data[key];
  return data && typeof data === 'object' ? data : {};
}

function topicListResult(payload) {
  const topics = firstArrayAt(payload, ['topics', 'search_result', 'items', 'list']).slice(0, ${KNOWLEDGE_PLANET_TOPIC_PAGE_MAX}).map(projectTopic);
  return compact({ topics, nextEndTime: topics.at(-1)?.createdAt });
}

function topicQuery(params, count) {
  return compact({
    count,
    scope: ['all', 'digests', 'by_owner'].includes(params.scope) ? params.scope : undefined,
    direction: ['forward', 'backward'].includes(params.direction) ? params.direction : undefined,
    begin_time: text(params.beginTime, 80),
    end_time: text(params.endTime, 80),
  });
}

function buildAction(action, params) {
  const count = Number.isInteger(params.count) ? params.count : 10;
  const topicCount = Math.min(count, ${KNOWLEDGE_PLANET_TOPIC_PAGE_MAX});
  if (action === 'list_groups') return { path: '/v2/groups', query: {}, project: (data) => ({ groups: firstArrayAt(data, ['groups', 'items', 'list']).slice(0, 50).map(projectGroup) }) };
  if (action === 'get_group' && NUMERIC_ID.test(params.groupId)) return {
    path: '/v2/groups/' + params.groupId,
    query: {},
    project: (data) => ({ group: projectGroup(objectAt(data, 'group')) }),
  };
  if (action === 'list_topics' && NUMERIC_ID.test(params.groupId)) return {
    path: '/v2/groups/' + params.groupId + '/topics',
    query: topicQuery({ scope: params.scope || 'all', direction: params.direction, beginTime: params.beginTime, endTime: params.endTime }, topicCount),
    project: topicListResult,
  };
  if (action === 'get_topic' && NUMERIC_ID.test(params.topicId)) return {
    path: '/v2/topics/' + params.topicId,
    query: {},
    project: (data) => ({ topic: projectTopic(objectAt(data, 'topic')) }),
  };
  if (action === 'list_comments' && NUMERIC_ID.test(params.topicId)) return {
    path: '/v2/topics/' + params.topicId + '/comments',
    query: { sort: ['asc', 'desc'].includes(params.sort) ? params.sort : 'asc', count },
    project: (data) => ({ comments: firstArrayAt(data, ['comments', 'items', 'list']).slice(0, 50).map(projectComment) }),
  };
  if (action === 'search_topics' && NUMERIC_ID.test(params.groupId) && typeof params.keyword === 'string') return {
    path: '/v2/search/groups/' + params.groupId + '/topics',
    query: { keyword: params.keyword.trim(), count: topicCount, index: Number.isInteger(params.index) ? params.index : 0 },
    project: topicListResult,
  };
  if (action === 'list_dynamics') return {
    path: '/v2/dynamics',
    query: compact({ scope: 'general', count: topicCount, end_time: text(params.endTime, 80) }),
    project: (data) => {
      const dynamics = firstArrayAt(data, ['dynamics', 'items', 'list']).slice(0, ${KNOWLEDGE_PLANET_TOPIC_PAGE_MAX}).map((value) => {
        const raw = value && typeof value === 'object' ? value : {};
        return compact({
          createdAt: text(raw.create_time || raw.created_at || raw.topic?.create_time, 64),
          action: text(raw.action, 64),
          topic: raw.topic && typeof raw.topic === 'object' ? projectTopic(raw.topic) : undefined,
        });
      });
      return compact({ dynamics, nextEndTime: dynamics.at(-1)?.createdAt });
    },
  };
  if (action === 'get_unread_counts') return {
    path: '/v2/groups/unread_topics_count',
    query: {},
    project: (data) => {
      const raw = dataAt(data);
      const groups = Array.isArray(raw.groups) ? raw.groups : [];
      if (groups.length) {
        return {
          counts: groups.flatMap((value) => {
            const item = value && typeof value === 'object' ? value : {};
            const groupId = id(item.group_id || item.id);
            const unreadCount = integer(item.count ?? item.unread_count);
            return groupId && unreadCount !== undefined ? [{ groupId, unreadCount }] : [];
          }).slice(0, 50),
        };
      }
      const source = raw.unread_topics_count && typeof raw.unread_topics_count === 'object' ? raw.unread_topics_count : raw;
      const counts = Object.entries(source).flatMap(([groupId, value]) => NUMERIC_ID.test(groupId) && integer(value) !== undefined ? [{ groupId, unreadCount: value }] : []).slice(0, 50);
      return { counts };
    },
  };
  if (action === 'list_hashtags' && NUMERIC_ID.test(params.groupId)) return {
    path: '/v2/groups/' + params.groupId + '/hashtags',
    query: {},
    project: (data) => ({ hashtags: firstArrayAt(data, ['hashtags', 'items', 'list']).slice(0, 50).map(projectHashtag) }),
  };
  if (action === 'list_hashtag_topics' && NUMERIC_ID.test(params.hashtagId)) return {
    path: '/v2/hashtags/' + params.hashtagId + '/topics',
    query: topicQuery(params, topicCount),
    project: topicListResult,
  };
  if (action === 'list_columns' && NUMERIC_ID.test(params.groupId)) return {
    path: '/v2/groups/' + params.groupId + '/columns',
    query: {},
    project: (data) => ({ columns: firstArrayAt(data, ['columns', 'items', 'list']).slice(0, 50).map(projectColumn) }),
  };
  if (action === 'list_column_topics' && NUMERIC_ID.test(params.groupId) && NUMERIC_ID.test(params.columnId)) return {
    path: '/v2/groups/' + params.groupId + '/columns/' + params.columnId + '/topics',
    query: topicQuery(params, topicCount),
    project: topicListResult,
  };
  if (action === 'list_checkins' && NUMERIC_ID.test(params.groupId)) return {
    path: '/v2/groups/' + params.groupId + '/checkins',
    query: compact({ scope: ['ongoing', 'closed', 'over'].includes(params.scope) ? params.scope : undefined, count }),
    project: (data) => ({ checkins: firstArrayAt(data, ['checkins', 'items', 'list']).slice(0, 50).map(projectCheckin) }),
  };
  if (action === 'get_checkin' && NUMERIC_ID.test(params.groupId) && NUMERIC_ID.test(params.checkinId)) return {
    path: '/v2/groups/' + params.groupId + '/checkins/' + params.checkinId,
    query: {},
    project: (data) => ({ checkin: projectCheckin(objectAt(data, 'checkin')) }),
  };
  if (action === 'list_checkin_topics' && NUMERIC_ID.test(params.groupId) && NUMERIC_ID.test(params.checkinId)) return {
    path: '/v2/groups/' + params.groupId + '/checkins/' + params.checkinId + '/topics',
    query: topicQuery(params, topicCount),
    project: topicListResult,
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

function signedHeaders(url, state) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHash('sha1').update(url.toString().replace(/'/g, '%27') + ' ' + timestamp + ' ' + requestId).digest('hex');
  return {
    accept: 'application/json, text/plain, */*',
    origin: 'https://wx.zsxq.com',
    referer: 'https://wx.zsxq.com/',
    'x-request-id': requestId,
    'x-timestamp': timestamp,
    'x-version': '2.94.0',
    'x-signature': signature,
    'x-aduid': readAduid(state),
  };
}

async function boundedJsonResponse(response) {
  const body = await response.body();
  if (body.length > 2 * 1024 * 1024) throw new Error('response');
  try { return parseJsonPreservingLargeIntegers(body.toString('utf8')); }
  catch { throw new Error('response'); }
}

async function runAction(input, relay) {
  const spec = buildAction(input.actionId, input.params || {});
  const url = new URL(spec.path, 'https://api.zsxq.com');
  for (const [key, value] of Object.entries(spec.query)) if (value !== undefined) url.searchParams.set(key, String(value));
  const api = await request.newContext({
    storageState: input.storageState,
    proxy: { server: relay.proxy },
    ignoreHTTPSErrors: false,
  });
  try {
    const response = await api.get(url.toString(), {
      failOnStatusCode: false,
      timeout: 30_000,
      headers: signedHeaders(url, input.storageState || {}),
    });
    const data = await boundedJsonResponse(response);
    if (!response.ok() || data?.succeeded !== true) {
      writeFrame({ event: 'failed', code: response.status() === 401 || [1001, 1002, 1059].includes(data?.code) ? 'LOGIN_EXPIRED' : 'UPSTREAM_FAILED' });
      terminal = true;
      return;
    }
    const state = filteredState(await api.storageState(), input.cookieDomains, input.stateOrigins);
    const serializedState = JSON.stringify(state);
    if (Buffer.byteLength(serializedState, 'utf8') > MAX_STATE_JSON) throw new Error('state');
    let result = spec.project(data);
    let completed = { event: 'completed', result, storageState: state };
    // The upstream may ignore the requested count. Keep a deterministic valid prefix rather
    // than failing the whole action when a legal response approaches the frame
    // ceiling. Pagination cursors are recomputed from the retained prefix.
    if (Buffer.byteLength(JSON.stringify(completed), 'utf8') > MAX_OUTPUT) {
      const listKey = Object.keys(result).find((key) => Array.isArray(result[key]));
      if (!listKey) throw new Error('output');
      result = { ...result, [listKey]: [...result[listKey]] };
      while (result[listKey].length > 0 && Buffer.byteLength(JSON.stringify({ event: 'completed', result, storageState: state }), 'utf8') > MAX_OUTPUT) result[listKey].pop();
      if ('nextEndTime' in result) result.nextEndTime = result[listKey].at(-1)?.createdAt;
      completed = { event: 'completed', result: compact(result), storageState: state };
    }
    writeFrame(completed);
    terminal = true;
  } finally {
    await api.dispose();
  }
}

async function authenticatedProbe(context) {
  const url = new URL('/v2/groups', 'https://api.zsxq.com');
  const state = await context.storageState();
  let response;
  try {
    response = await context.request.get(url.toString(), {
      failOnStatusCode: false,
      timeout: 5_000,
      headers: signedHeaders(url, state),
    });
    if (!response.ok()) return false;
    const data = await boundedJsonResponse(response);
    return data?.succeeded === true;
  } catch {
    return false;
  } finally {
    await response?.dispose().catch(() => {});
  }
}

function remainingCaptureTimeout(deadlineMs) {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error('qr');
  return remaining;
}

async function beforeCaptureDeadline(operation, deadlineMs) {
  const remaining = remainingCaptureTimeout(deadlineMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('qr')), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function captureQr(page, qrButton, switchButton, captureDeadline) {
  let requested = false;
  let consentHandled = false;
  let loginModeHandled = false;
  const agree = page.locator('.agreement-overlay .agree-btn, button.agree-btn').first();
  while (Date.now() < captureDeadline) {
    if (!consentHandled && await beforeCaptureDeadline(() => agree.isVisible(), captureDeadline).catch(() => false)) {
      const clicked = await beforeCaptureDeadline(
        () => agree.click({ timeout: remainingCaptureTimeout(captureDeadline) }),
        captureDeadline,
      ).then(() => true).catch(() => false);
      if (clicked) {
        consentHandled = true;
        requested = false;
      }
    }
    let qrButtonVisible = await beforeCaptureDeadline(() => qrButton.isVisible(), captureDeadline).catch(() => false);
    if (!qrButtonVisible && !loginModeHandled) {
      const switchVisible = await beforeCaptureDeadline(() => switchButton.isVisible(), captureDeadline).catch(() => false);
      if (switchVisible) {
        const switched = await beforeCaptureDeadline(
          () => switchButton.click({ timeout: remainingCaptureTimeout(captureDeadline) }),
          captureDeadline,
        ).then(() => true).catch(() => false);
        if (switched) {
          loginModeHandled = true;
          requested = false;
        }
      }
      qrButtonVisible = await beforeCaptureDeadline(() => qrButton.isVisible(), captureDeadline).catch(() => false);
    } else if (qrButtonVisible) {
      loginModeHandled = true;
    }
    if (!requested && qrButtonVisible) {
      requested = await beforeCaptureDeadline(
        () => qrButton.click({ timeout: remainingCaptureTimeout(captureDeadline) }),
        captureDeadline,
      ).then(() => true).catch(() => false);
    }
    for (const frame of page.frames().slice(1)) {
      const images = frame.locator('img.qrcode, img[src*="/connect/qrcode/"]');
      const count = await beforeCaptureDeadline(() => images.count(), captureDeadline).catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const image = images.nth(i);
        if (!await beforeCaptureDeadline(() => image.isVisible(), captureDeadline).catch(() => false)) continue;
        const encodedQr = await beforeCaptureDeadline(
          () => image.evaluate(
            (element) => {
              if (!element.complete || element.naturalWidth < 180 || element.naturalHeight < 180) return null;
              if (element.naturalWidth > 1024 || element.naturalHeight > 1024) return null;
              if (Math.abs(element.naturalWidth - element.naturalHeight) > Math.max(element.naturalWidth, element.naturalHeight) * 0.05) return null;
              for (let current = element; current; current = current.parentElement) {
                const style = getComputedStyle(current);
                if (style.filter !== 'none' || Number(style.opacity) < 0.99 || style.visibility !== 'visible') return null;
              }
              const bounds = element.getBoundingClientRect();
              if (bounds.width < 180 || bounds.height < 180) return null;
              if (Math.abs(bounds.width - bounds.height) > Math.max(bounds.width, bounds.height) * 0.05) return null;
              if (document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) !== element) return null;
              const sample = document.createElement('canvas');
              sample.width = 128;
              sample.height = 128;
              const sampleContext = sample.getContext('2d', { willReadFrequently: true });
              if (!sampleContext) return null;
              sampleContext.fillStyle = '#fff';
              sampleContext.fillRect(0, 0, sample.width, sample.height);
              sampleContext.imageSmoothingEnabled = false;
              sampleContext.drawImage(element, 0, 0, sample.width, sample.height);
              const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
              let dark = 0;
              let light = 0;
              let luminanceSum = 0;
              let luminanceSquareSum = 0;
              const pixelCount = pixels.length / 4;
              for (let index = 0; index < pixels.length; index += 4) {
                const luminance = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
                if (luminance < 96) dark += 1;
                if (luminance > 224) light += 1;
                luminanceSum += luminance;
                luminanceSquareSum += luminance * luminance;
              }
              const mean = luminanceSum / pixelCount;
              const deviation = Math.sqrt(Math.max(0, luminanceSquareSum / pixelCount - mean * mean));
              if (dark / pixelCount < ${KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION} || light / pixelCount < ${KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION} || deviation < ${KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION}) return null;
              const output = document.createElement('canvas');
              output.width = element.naturalWidth;
              output.height = element.naturalHeight;
              const outputContext = output.getContext('2d');
              if (!outputContext) return null;
              outputContext.fillStyle = '#fff';
              outputContext.fillRect(0, 0, output.width, output.height);
              outputContext.imageSmoothingEnabled = false;
              outputContext.drawImage(element, 0, 0, output.width, output.height);
              const dataUrl = output.toDataURL('image/png');
              const prefix = 'data:image/png;base64,';
              const encoded = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : '';
              return encoded.length > 0 && encoded.length <= Math.ceil(512 * 1024 / 3) * 4 ? encoded : null;
            },
            undefined,
            { timeout: remainingCaptureTimeout(captureDeadline) },
          ),
          captureDeadline,
        ).catch(() => null);
        if (!encodedQr || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedQr) || encodedQr.length % 4 !== 0) continue;
        const png = Buffer.from(encodedQr, 'base64');
        if (png.toString('base64') !== encodedQr || png.length > 512 * 1024) continue;
        if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
        remainingCaptureTimeout(captureDeadline);
        return png;
      }
    }
    await beforeCaptureDeadline(
      () => page.waitForTimeout(Math.min(250, remainingCaptureTimeout(captureDeadline))),
      captureDeadline,
    );
  }
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
    const qrCaptureDeadline = Math.min(input.deadlineMs, Date.now() + ${KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS});
    const qrButton = page.getByRole('button', { name: /获取登录二维码/ }).first();
    const switchButton = page.getByText('切换至微信登录', { exact: true }).first();
    const qr = await beforeCaptureDeadline(
      () => captureQr(page, qrButton, switchButton, qrCaptureDeadline),
      qrCaptureDeadline,
    );
    if (qr.length > 512 * 1024) throw new Error('qr');
    remainingCaptureTimeout(qrCaptureDeadline);
    writeFrame({ event: 'qr', png: qr.toString('base64') });
    let nextProbeAt = Date.now() + ${KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS};
    let probeAttempts = 0;
    while (Date.now() < input.deadlineMs) {
      const url = page.url();
      const loginVisible = await page.getByText('登录知识星球', { exact: false }).first().isVisible().catch(() => false);
      const pageAuthenticated = !/\/login(?:[/?#]|$)/.test(new URL(url).pathname + new URL(url).search) && !loginVisible;
      const probeAuthenticated = Date.now() >= nextProbeAt && probeAttempts < ${KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS}
        ? await (async () => {
            probeAttempts += 1;
            const result = await authenticatedProbe(context);
            nextProbeAt = Date.now() + ${KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS};
            return result;
          })()
        : false;
      if (pageAuthenticated || probeAuthenticated) {
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
  writeFrame({ event: 'ready', runtime: 'knowledge-planet-worker-v1.1', playwrightMcpVersion });
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
