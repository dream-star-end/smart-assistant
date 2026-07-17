export const KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS = 3_000
export const KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS = 5_000
export const KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS = 48
export const KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS = 45_000
// C3:zsxq 登录二维码约 2 分钟过期,而登录窗口有 4 分钟。只在 t=0 截一次会让窗口后半段
// 展示死码(用户扫了也没用)。轮询期每 RECAPTURE_INTERVAL 重截一次,内容变化即重发 qr 帧;
// 每次重截至多花 RECAPTURE_BUDGET(短预算,不阻塞认证轮询)。
export const KNOWLEDGE_PLANET_QR_RECAPTURE_INTERVAL_MS = 15_000
export const KNOWLEDGE_PLANET_QR_RECAPTURE_BUDGET_MS = 5_000
export const KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION = 0.15
export const KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION = 0.2
export const KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION = 70
export const KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES = 1024 * 1024
export const KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES = 256 * 1024
export const KNOWLEDGE_PLANET_TOPIC_PAGE_MAX = 10

export const KNOWLEDGE_PLANET_LOGIN_PROBE_CONTROL_SOURCE = String.raw`
function scheduleKnowledgePlanetLoginProbe(now, pageAuthenticated, pageHintApplied, nextProbeAt, attempts) {
  const applyPageHint = pageAuthenticated && !pageHintApplied;
  return {
    pageHintApplied: pageHintApplied || pageAuthenticated,
    nextProbeAt: applyPageHint ? Math.min(nextProbeAt, now) : nextProbeAt,
    due: now >= (applyPageHint ? Math.min(nextProbeAt, now) : nextProbeAt) && attempts < ${KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS},
  };
}

function hasAuthenticatedKnowledgePlanetSession(probeAuthenticated) {
  return probeAuthenticated === true;
}`

/** Single source for official write routes and the current Web signature. */
export const KNOWLEDGE_PLANET_WRITE_REQUEST_SOURCE = String.raw`
function buildKnowledgePlanetWriteRequest(action, params, uploaded) {
  const imageIds = Array.isArray(uploaded?.imageIds) ? uploaded.imageIds : [];
  const fileIds = Array.isArray(uploaded?.fileIds) ? uploaded.fileIds : [];
  if (action === 'create_topic' && NUMERIC_ID.test(params.groupId) && typeof params.text === 'string' && params.text.length <= 10000 && (params.text.length > 0 || imageIds.length > 0 || fileIds.length > 0)) return {
    method: 'POST',
    path: '/v2/groups/' + params.groupId + '/topics',
    query: {},
    resultKind: 'topic',
    body: JSON.stringify({
      req_data: {
        type: 'talk',
        text: params.text,
        image_ids: imageIds,
        file_ids: fileIds,
        mentioned_user_ids: [],
      },
    }),
  };
  if (action === 'create_comment' && NUMERIC_ID.test(params.topicId) && typeof params.text === 'string' && params.text.length <= 1200 && (params.text.length > 0 || imageIds.length > 0) && imageIds.length <= 1 && fileIds.length === 0) return {
    method: 'POST',
    path: '/v2/topics/' + params.topicId + '/comments',
    query: {},
    resultKind: 'comment',
    body: JSON.stringify({
      req_data: {
        text: params.text,
        image_ids: imageIds,
        ...(NUMERIC_ID.test(params.repliedCommentId || '') ? { replied_comment_id: params.repliedCommentId } : {}),
        mentioned_user_ids: [],
      },
    }),
  };
  if (action === 'edit_topic' && NUMERIC_ID.test(params.groupId) && NUMERIC_ID.test(params.topicId) && typeof params.text === 'string' && params.text.length <= 10000 && (params.text.length > 0 || imageIds.length > 0 || fileIds.length > 0)) return {
    method: 'PUT',
    path: '/v2/groups/' + params.groupId + '/topics/' + params.topicId,
    query: {},
    resultKind: 'topic',
    body: JSON.stringify({ req_data: { type: 'talk', text: params.text, image_ids: imageIds, file_ids: fileIds, mentioned_user_ids: [] } }),
  };
  if (action === 'delete_topic' && NUMERIC_ID.test(params.topicId)) return {
    method: 'DELETE', path: '/v2/topics/' + params.topicId, query: {}, resultKind: 'ok', body: undefined,
  };
  if (action === 'delete_comment' && NUMERIC_ID.test(params.commentId)) return {
    method: 'DELETE', path: '/v2/comments/' + params.commentId, query: {}, resultKind: 'ok', body: undefined,
  };
  if (action === 'set_topic_like' && NUMERIC_ID.test(params.topicId) && typeof params.liked === 'boolean') return {
    method: params.liked ? 'POST' : 'DELETE', path: '/v2/topics/' + params.topicId + '/likes', query: {}, resultKind: 'ok', body: params.liked ? JSON.stringify({ req_data: {} }) : undefined,
  };
  if (action === 'set_comment_like' && NUMERIC_ID.test(params.commentId) && typeof params.liked === 'boolean') return {
    method: params.liked ? 'POST' : 'DELETE', path: '/v2/comments/' + params.commentId + '/likes', query: {}, resultKind: 'ok', body: undefined,
  };
  return null;
}

function knowledgePlanetSignature(url, timestamp, requestId) {
  return createHash('sha1').update(url.replace(/'/g, '%27') + ' ' + timestamp + ' ' + requestId).digest('hex');
}`

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
import { open } from 'node:fs/promises';
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

${KNOWLEDGE_PLANET_LOGIN_PROBE_CONTROL_SOURCE}
${KNOWLEDGE_PLANET_WRITE_REQUEST_SOURCE}

function fail() {
  if (terminal) return;
  terminal = true;
  writeFrame({ event: 'failed', code: 'WORKER_FAILED' });
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_OUTPUT) throw new Error('output');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function writeFrame(value) {
  process.stdout.write(encodeFrame(value));
}

async function writeTerminalAndExit(value) {
  const output = encodeFrame(value);
  await new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
  });
  process.exit(0);
}

async function writeAuthenticatedAndExit(storageState) {
  await writeTerminalAndExit({ event: 'authenticated', storageState });
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

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function contentDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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
  const projected = compact({
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
    liked: booleanValue(raw.user_specific?.liked ?? raw.liked),
    images: images.slice(0, 10).map(projectImage),
    files: files.slice(0, 10).map(projectFile),
    article: article && typeof article === 'object' ? projectArticle(article) : undefined,
  });
  return { ...projected, contentDigest: contentDigest({
    text: projected.text || '',
    imageIds: Array.isArray(projected.images) ? projected.images.map((item) => item.id).filter(Boolean) : [],
    fileIds: Array.isArray(projected.files) ? projected.files.map((item) => item.id).filter(Boolean) : [],
  }) };
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
  const images = Array.isArray(raw.images) ? raw.images : [];
  const projected = compact({
    id: id(raw.comment_id || raw.id),
    createdAt: text(raw.create_time || raw.created_at, 64),
    text: text(raw.text, 1_200),
    author: projectAuthor(raw.owner || raw.user),
    replyTo: projectAuthor(raw.repliee || raw.reply_to),
    likeCount: integer(raw.likes_count ?? raw.like_count),
    sticky: booleanValue(raw.sticky),
    liked: booleanValue(raw.user_specific?.liked ?? raw.liked),
    images: images.slice(0, 1).map(projectImage),
  });
  return { ...projected, contentDigest: contentDigest({
    text: projected.text || '',
    imageIds: Array.isArray(projected.images) ? projected.images.map((item) => item.id).filter(Boolean) : [],
  }) };
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
  if (action === 'get_self') return { path: '/v2/users/self', query: {}, project: (data) => ({ user: projectAuthor(objectAt(data, 'user')) }) };
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
  const write = buildKnowledgePlanetWriteRequest(action, params);
  if (write) return {
    ...write,
    project: write.resultKind === 'topic'
      ? (data) => ({ topic: projectTopic(objectAt(data, 'topic')) })
      : (data) => ({ comment: projectComment(objectAt(data, 'comment')) }),
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
    cookies: (Array.isArray(state?.cookies) ? state.cookies : [])
      .filter((cookie) => domainSet.has(String(cookie?.domain || '').replace(/^\./, '').toLowerCase()))
      .map((cookie) => ({
        name: cookie?.name,
        value: cookie?.value,
        domain: cookie?.domain,
        path: cookie?.path,
        expires: cookie?.expires,
        httpOnly: cookie?.httpOnly,
        secure: cookie?.secure,
        sameSite: cookie?.sameSite,
      })),
    origins: (Array.isArray(state?.origins) ? state.origins : [])
      .filter((origin) => originSet.has(normalizeOrigin(origin?.origin)))
      .map((origin) => ({
        origin: origin?.origin,
        localStorage: Array.isArray(origin?.localStorage)
          ? origin.localStorage.map((item) => ({ name: item?.name, value: item?.value }))
          : origin?.localStorage,
      })),
  };
}

function readAduid(state) {
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) if (item.name === 'XAduid' && typeof item.value === 'string' && item.value.length <= 256) return item.value;
  }
  return randomUUID();
}

function signedHeaders(url, state, body) {
  const requestId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = knowledgePlanetSignature(url.toString(), timestamp, requestId);
  const headers = {
    accept: 'application/json, text/plain, */*',
    origin: 'https://wx.zsxq.com',
    referer: 'https://wx.zsxq.com/',
    'x-request-id': requestId,
    'x-timestamp': timestamp,
    'x-version': '2.94.0',
    'x-signature': signature,
    'x-aduid': readAduid(state),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return headers;
}

async function boundedJsonResponse(response) {
  const body = await response.body();
  if (body.length > 2 * 1024 * 1024) throw new Error('response');
  try { return parseJsonPreservingLargeIntegers(body.toString('utf8')); }
  catch { throw new Error('response'); }
}

const WRITE_ACTIONS = new Set(['create_topic', 'create_comment', 'edit_topic', 'delete_topic', 'delete_comment', 'set_topic_like', 'set_comment_like']);

function apiUrl(spec) {
  const url = new URL(spec.path, 'https://api.zsxq.com');
  for (const [key, value] of Object.entries(spec.query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
  return url;
}

async function fetchApi(api, spec, state, timeout = 120_000) {
  const url = apiUrl(spec);
  const response = await api.fetch(url.toString(), {
    method: spec.method || 'GET',
    ...(spec.body === undefined ? {} : { data: Buffer.from(spec.body, 'utf8') }),
    failOnStatusCode: false,
    timeout,
    headers: signedHeaders(url, state || {}, spec.body),
  });
  let data;
  try {
    data = await boundedJsonResponse(response);
  } catch {
    if (response.status() === 401) await writeTerminalAndExit({ event: 'failed', code: 'LOGIN_EXPIRED' });
    throw new Error('response');
  }
  if (!response.ok() || data?.succeeded !== true) {
    await writeTerminalAndExit({ event: 'failed', code: response.status() === 401 || [1001, 1002, 1059].includes(data?.code) ? 'LOGIN_EXPIRED' : 'UPSTREAM_FAILED' });
  }
  return data;
}

async function finishAction(api, input, result) {
  const state = filteredState(await api.storageState(), input.cookieDomains, input.stateOrigins);
  const serializedState = JSON.stringify(state);
  if (Buffer.byteLength(serializedState, 'utf8') > MAX_STATE_JSON) throw new Error('state');
  let completed = { event: 'completed', result, storageState: state };
  if (Buffer.byteLength(JSON.stringify(completed), 'utf8') > MAX_OUTPUT) {
    const listKey = Object.keys(result).find((key) => Array.isArray(result[key]));
    if (!listKey) throw new Error('output');
    result = { ...result, [listKey]: [...result[listKey]] };
    while (result[listKey].length > 0 && Buffer.byteLength(JSON.stringify({ event: 'completed', result, storageState: state }), 'utf8') > MAX_OUTPUT) result[listKey].pop();
    if ('nextEndTime' in result) result.nextEndTime = result[listKey].at(-1)?.createdAt;
    completed = { event: 'completed', result: compact(result), storageState: state };
  }
  await writeTerminalAndExit(completed);
}

function exactObjectKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

async function verifyInputMedia(item) {
  if (!exactObjectKeys(item, ['path', 'inputId', 'filename', 'sizeBytes', 'sha256', 'mimeType', 'kind'])) throw new Error('media');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(item.inputId) || !/^[0-9a-f]{64}$/.test(item.sha256) || !['image', 'file'].includes(item.kind)) throw new Error('media');
  const file = await open('/inputs/' + item.inputId, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== item.sizeBytes || stat.size <= 0 || stat.size > 50 * 1024 * 1024) throw new Error('media');
    const bytes = await file.readFile();
    try {
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('media');
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
}

function relevantTopicDigest(topic) {
  return contentDigest({
    text: topic?.text || '',
    imageIds: Array.isArray(topic?.images) ? topic.images.map((item) => item.id).filter(Boolean) : [],
    fileIds: Array.isArray(topic?.files) ? topic.files.map((item) => item.id).filter(Boolean) : [],
  });
}

function automationTopicDigest(topic) {
  const createdAt = new Date(topic?.createdAt || '');
  if (!topic?.id || !Number.isFinite(createdAt.getTime())) return null;
  return contentDigest(compact({
    id: topic.id,
    createdAt: createdAt.toISOString(),
    type: typeof topic.type === 'string' ? topic.type : undefined,
    title: typeof topic.title === 'string' ? topic.title : undefined,
    text: typeof topic.text === 'string' ? topic.text : undefined,
    question: typeof topic.question === 'string' ? topic.question : undefined,
    answer: typeof topic.answer === 'string' ? topic.answer : undefined,
    contentDigest: typeof topic.contentDigest === 'string' ? topic.contentDigest : undefined,
    author: topic.author && typeof topic.author === 'object' ? topic.author : undefined,
  }));
}

async function currentTopic(api, state, topicId) {
  const data = await fetchApi(api, { method: 'GET', path: '/v2/topics/' + topicId, query: {} }, state);
  return projectTopic(objectAt(data, 'topic'));
}

async function currentComment(api, state, topicId, commentId) {
  for (const sort of ['desc', 'asc']) {
    const data = await fetchApi(api, { method: 'GET', path: '/v2/topics/' + topicId + '/comments', query: { count: 50, sort } }, state);
    const found = firstArrayAt(data, ['comments', 'items', 'list']).map(projectComment).find((item) => item.id === commentId);
    if (found) return found;
  }
  return null;
}

async function verifyWritePrecondition(api, state, action, params) {
  if (action === 'create_comment' && params.automationSourceSnapshot) {
    const snapshot = params.automationSourceSnapshot;
    if (!exactObjectKeys(snapshot, ['expectedDigest']) || !/^[0-9a-f]{64}$/.test(snapshot.expectedDigest)) throw new Error('snapshot');
    const topic = await currentTopic(api, state, params.topicId);
    return automationTopicDigest(topic) === snapshot.expectedDigest;
  }
  if (action === 'edit_topic' || action === 'delete_topic') {
    if (!params.editSnapshot && !params.deleteSnapshot) throw new Error('snapshot');
    const snapshot = params.editSnapshot || params.deleteSnapshot;
    const topic = await currentTopic(api, state, params.topicId);
    return topic && relevantTopicDigest(topic) === snapshot.expectedDigest;
  }
  if (action === 'delete_comment') {
    if (!params.deleteSnapshot) throw new Error('snapshot');
    const comment = await currentComment(api, state, params.topicId, params.commentId);
    return comment !== null && comment.contentDigest === params.deleteSnapshot.expectedDigest;
  }
  return true;
}

async function uploadOne(api, relay, state, item) {
  const uploadBody = JSON.stringify({ req_data: item.kind === 'image'
    ? { type: 'image', size: item.sizeBytes, name: '', hash: '' }
    : { type: 'file', size: item.sizeBytes, name: item.filename, hash: item.sha256 } });
  const tokenData = await fetchApi(api, { method: 'POST', path: '/v2/uploads', query: {}, body: uploadBody }, state);
  const uploadData = dataAt(tokenData);
  const token = uploadData.upload_token;
  if (typeof token !== 'string' || token.length < 1 || token.length > 4096) throw new Error('upload');
  const advertisedDomain = Array.isArray(uploadData.upload_zone?.domains) ? uploadData.upload_zone.domains[0] : undefined;
  let uploadUrl = 'https://upload-z1.qiniup.com';
  if (advertisedDomain !== undefined) {
    if (typeof advertisedDomain !== 'string' || advertisedDomain.length > 256) throw new Error('upload');
    const advertisedUrl = new URL(advertisedDomain);
    if (advertisedUrl.origin !== uploadUrl || advertisedUrl.pathname !== '/' || advertisedUrl.search || advertisedUrl.hash) throw new Error('upload');
    uploadUrl = advertisedUrl.origin;
  }
  const file = await open('/inputs/' + item.inputId, 'r');
  let bytes;
  try { bytes = await file.readFile(); } finally { await file.close(); }
  const qiniu = await request.newContext({ proxy: { server: relay.proxy }, ignoreHTTPSErrors: false });
  try {
    const requestId = randomUUID();
    const response = await qiniu.post(uploadUrl, {
      multipart: {
        file: { name: item.filename, mimeType: item.mimeType, buffer: bytes },
        token,
      },
      headers: { 'x-request-id': requestId, 'x-version': '2.94.0' },
      failOnStatusCode: false,
      timeout: 120_000,
    });
    const data = await boundedJsonResponse(response);
    if (!response.ok() || data?.succeeded !== true) throw new Error('upload');
    const uploadedId = item.kind === 'image' ? dataAt(data).image_id : dataAt(data).file_id;
    if (!NUMERIC_ID.test(typeof uploadedId === 'string' ? uploadedId : String(uploadedId || ''))) throw new Error('upload');
    return String(uploadedId);
  } finally {
    bytes.fill(0);
    await qiniu.dispose();
  }
}

async function runWriteAction(input, relay, api) {
  const params = { ...(input.params || {}) };
  params.text = typeof params.text === 'string' ? params.text : '';
  params.preserveExistingMedia = params.preserveExistingMedia !== false;
  const manifest = Array.isArray(params.mediaManifest) ? params.mediaManifest : [];
  if (manifest.length > 18 || manifest.reduce((sum, item) => sum + Number(item?.sizeBytes || 0), 0) > 200 * 1024 * 1024) throw new Error('media');
  if (manifest.filter((item) => item.kind === 'image').length > (input.actionId === 'create_comment' ? 1 : 9) || manifest.filter((item) => item.kind === 'file').length > 9) throw new Error('media');
  for (const item of manifest) await verifyInputMedia(item);
  if (!(await verifyWritePrecondition(api, input.storageState || {}, input.actionId, params))) {
    await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
  }
  writeFrame({ event: 'prepared' });
  const dispatch = await readFrame();
  if (!exactObjectKeys(dispatch, ['event']) || dispatch.event !== 'dispatch') throw new Error('dispatch');
  if (!(await verifyWritePrecondition(api, input.storageState || {}, input.actionId, params))) {
    await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
  }
  const uploaded = { imageIds: [], fileIds: [] };
  for (const item of manifest) {
    const uploadedId = await uploadOne(api, relay, input.storageState || {}, item);
    if (item.kind === 'image') uploaded.imageIds.push(uploadedId);
    else uploaded.fileIds.push(uploadedId);
  }
  if (input.actionId === 'edit_topic' && params.preserveExistingMedia) {
    uploaded.imageIds = [...params.editSnapshot.imageIds, ...uploaded.imageIds];
    uploaded.fileIds = [...params.editSnapshot.fileIds, ...uploaded.fileIds];
  }
  if (uploaded.imageIds.length > 9 || uploaded.fileIds.length > 9) throw new Error('media');
  // Uploading can take materially longer than the final API mutation. Recheck again after all
  // uploads so the remaining unavoidable upstream GET→mutation race is kept as short as possible.
  // A failed check may leave unreferenced upload objects, but never mutates the target topic.
  if (!(await verifyWritePrecondition(api, input.storageState || {}, input.actionId, params))) {
    await writeTerminalAndExit({ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' });
  }
  const spec = buildKnowledgePlanetWriteRequest(input.actionId, params, uploaded);
  if (!spec) throw new Error('action');
  const data = await fetchApi(api, spec, input.storageState || {});
  const result = spec.resultKind === 'topic'
    ? { topic: projectTopic(objectAt(data, 'topic')) }
    : spec.resultKind === 'comment'
      ? { comment: projectComment(objectAt(data, 'comment')) }
      : { ok: true };
  await finishAction(api, input, result);
}

async function runAction(input, relay) {
  const api = await request.newContext({
    storageState: input.storageState,
    proxy: { server: relay.proxy },
    ignoreHTTPSErrors: false,
  });
  try {
    if (WRITE_ACTIONS.has(input.actionId)) return await runWriteAction(input, relay, api);
    const spec = buildAction(input.actionId, input.params || {});
    const data = await fetchApi(api, { ...spec, method: spec.method || 'GET' }, input.storageState || {}, 30_000);
    await finishAction(api, input, spec.project(data));
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
    let lastQrHash = createHash('sha256').update(qr).digest('hex');
    let nextQrRecaptureAt = Date.now() + ${KNOWLEDGE_PLANET_QR_RECAPTURE_INTERVAL_MS};
    let nextProbeAt = Date.now() + ${KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS};
    let probeAttempts = 0;
    let pageHintApplied = false;
    while (Date.now() < input.deadlineMs) {
      const url = page.url();
      const loginVisible = await page.getByText('登录知识星球', { exact: false }).first().isVisible().catch(() => false);
      const pageAuthenticated = !/\/login(?:[/?#]|$)/.test(new URL(url).pathname + new URL(url).search) && !loginVisible;
      const probeSchedule = scheduleKnowledgePlanetLoginProbe(Date.now(), pageAuthenticated, pageHintApplied, nextProbeAt, probeAttempts);
      pageHintApplied = probeSchedule.pageHintApplied;
      nextProbeAt = probeSchedule.nextProbeAt;
      const probeAuthenticated = probeSchedule.due
        ? await (async () => {
            probeAttempts += 1;
            const result = await authenticatedProbe(context);
            nextProbeAt = Date.now() + ${KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS};
            return result;
          })()
        : false;
      if (hasAuthenticatedKnowledgePlanetSession(probeAuthenticated)) {
        const state = filteredState(await context.storageState(), input.cookieDomains, input.stateOrigins);
        await writeAuthenticatedAndExit(state);
      }
      // C3:先判认证(已扫码则上面已退出),未认证再看是否到点重截 QR。best-effort:
      // 短预算内重截,内容 hash 变化(旧码过期、zsxq 刷新了 img)才重发一帧覆盖父侧 QR_PATH;
      // 截不到(页面正在跳转/无可见 QR)只跳过本轮,绝不因此让登录失败。
      if (Date.now() >= nextQrRecaptureAt) {
        nextQrRecaptureAt = Date.now() + ${KNOWLEDGE_PLANET_QR_RECAPTURE_INTERVAL_MS};
        const recaptureDeadline = Math.min(input.deadlineMs, Date.now() + ${KNOWLEDGE_PLANET_QR_RECAPTURE_BUDGET_MS});
        const fresh = await captureQr(page, qrButton, switchButton, recaptureDeadline).catch(() => null);
        if (fresh && fresh.length > 0 && fresh.length <= 512 * 1024) {
          const freshHash = createHash('sha256').update(fresh).digest('hex');
          if (freshHash !== lastQrHash) {
            lastQrHash = freshHash;
            writeFrame({ event: 'qr', png: fresh.toString('base64') });
          }
        }
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
  if (!Number.isFinite(remaining) || remaining < 1_000 || remaining > 15 * 60_000) throw new Error('deadline');
  writeFrame({ event: 'ready', runtime: 'knowledge-planet-worker-v1.3', playwrightMcpVersion });
  const relayHosts = new Set(input.mode === 'action' ? ['api.zsxq.com', 'upload-z1.qiniup.com'] : input.allowedOrigins.map((origin) => new URL(origin).hostname));
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
