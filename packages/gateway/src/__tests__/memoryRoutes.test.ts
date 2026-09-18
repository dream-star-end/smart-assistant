/**
 * Static regression tests for the memdir memory API glue in `server.ts`.
 *
 * 运行时路由测试要构造完整 Gateway(config / channel factories / commercial hooks +
 * storage MemoryDir),成本高且被 storage 就绪与否耦合。这里沿用 wechatBindingRoutes
 * 的做法:把 server.ts 当文本抽方法体,只锁「改造后必须成立」的契约:
 *   - user 目标底层换 userProfile,响应结构不变;
 *   - memory 目标 GET 返 {kind:'index', text, files, version} 且 GET 前 ensureMigrated;
 *   - PUT memory → 410 gone;
 *   - files/:file 子路由 CRUD + 文件名双保险(basename + MEMORY_FILE_RE)+ 409 结构对齐 user;
 *   - dispatch 注册了 files/:file。
 *
 * 跑法:npx tsx --test packages/gateway/src/__tests__/memoryRoutes.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_TS = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')

function extractMethodBody(source: string, methodName: string): string {
  const startRe = new RegExp(`^  (private|public|protected)?\\s*(async\\s+)?${methodName}\\b`, 'm')
  const startMatch = startRe.exec(source)
  if (!startMatch) throw new Error(`method ${methodName} not found`)
  const startIdx = startMatch.index
  const rest = source.slice(startIdx + startMatch[0].length)
  const nextMatch = /^  (private|public|protected|async|static)\b/m.exec(rest)
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : source.length
  return source.slice(startIdx, endIdx)
}

const handleMemory = extractMethodBody(SERVER_TS, 'handleMemory')
const handleMemoryFile = extractMethodBody(SERVER_TS, 'handleMemoryFile')
const handleAutoDreamReport = extractMethodBody(SERVER_TS, 'handleAutoDreamReport')
const readJsonBody = extractMethodBody(SERVER_TS, 'readJsonBody')
const sendInternalError = extractMethodBody(SERVER_TS, 'sendInternalError')

describe('handleMemory(memdir)', () => {
  it('user 目标底层换 userProfile(读/写),结构不变', () => {
    assert.match(handleMemory, /readUserProfile\(\)/, 'user GET/PUT 必须走 readUserProfile')
    assert.match(handleMemory, /writeUserProfile\(/, 'user PUT 必须走 writeUserProfile')
    // limit 用注入侧 cap 单一权威
    assert.match(handleMemory, /USER_PROFILE_INJECT_MAX_CHARS/)
    // 409 冲突把 storage 三态的 conflict.current 映射为历史的 text 字段
    assert.match(handleMemory, /r\.conflict\.current/)
    assert.match(handleMemory, /sendJson\(\s*res\s*,\s*409\s*,/)
    // GET 仍回 target 字段
    assert.match(handleMemory, /target,/)
  })

  it('MEM-01:GET / PUT / 409 都回 alwaysCharCount(只算注入块),与 limit 同口径', () => {
    const hits = handleMemory.match(/alwaysCharCount: userProfileAlwaysCharCount\(/g) ?? []
    assert.equal(hits.length, 3, 'GET 200 / PUT 200 / PUT 409 conflict 三处都要带 alwaysCharCount')
    assert.match(handleMemory, /alwaysCharCount: userProfileAlwaysCharCount\(r\.conflict\.current\)/)
    // charCount 仍是全文长度(展示用),两者并存
    assert.match(handleMemory, /charCount: text\.length/)
    assert.match(SERVER_TS, /import \{ USER_PROFILE_INJECT_MAX_CHARS, userProfileAlwaysCharCount \} from '\.\/promptSlots\.js'/)
  })
})

describe('通用 readJsonBody(4 MB 上限 / 413 / 400)', () => {
  it('readJsonBody 委托 httpJsonBody.readJsonBodyBounded,不再自己无上限拼 chunk', () => {
    assert.match(readJsonBody, /return readJsonBodyBounded<T>\(req\)/)
    assert.doesNotMatch(readJsonBody, /for await \(const chunk of req\)/, '无上限整段读入的旧实现必须移除')
    assert.doesNotMatch(readJsonBody, /throw new Error\('invalid json body'\)/)
    assert.match(SERVER_TS, /import \{ jsonBodyErrorStatus, readJsonBodyBounded \} from '\.\/httpJsonBody\.js'/)
  })

  it('sendInternalError 先把 body 类错误映射成 413 / 400,再落 500', () => {
    assert.match(sendInternalError, /jsonBodyErrorStatus\(err\)/)
    assert.match(sendInternalError, /'payload too large'/)
    assert.match(sendInternalError, /'invalid json body'/)
    // 500 兜底仍在,且顺序在映射之后
    const mapIdx = sendInternalError.indexOf('jsonBodyErrorStatus(err)')
    const fallbackIdx = sendInternalError.indexOf("this.sendJson(res, 500, { error: 'internal error' })")
    assert.ok(mapIdx >= 0 && fallbackIdx > mapIdx, '先映射 4xx 再 500 兜底')
  })

  it('memory 目标 GET 返回 index 三元组 + GET 前 ensureMigrated', () => {
    assert.match(handleMemory, /new MemoryDir\(agentId\)/)
    assert.match(handleMemory, /ensureMigrated\(\)/, 'GET 前必须懒迁移')
    assert.match(handleMemory, /reconcileIndex\(\)/, 'index 文本来自 reconcileIndex(读侧自愈)')
    assert.match(handleMemory, /kind: 'index'/)
    assert.match(handleMemory, /files,/, '必须带逐文件元信息 files')
  })

  it('PUT memory → 410 gone(索引不再手写)', () => {
    // 410 且文案指向 files/<file>
    assert.match(handleMemory, /sendError\(\s*res\s*,\s*410\s*,/)
    assert.match(handleMemory, /auto-managed/)
    // 不得残留旧的 MemoryStore.overwrite 覆盖语义
    assert.doesNotMatch(handleMemory, /\.overwrite\(/)
    assert.doesNotMatch(handleMemory, /new MemoryStore\(/)
  })
})

describe('handleMemoryFile(memdir files/:file)', () => {
  it('文件名双保险:basename + MEMORY_FILE_RE,非法名 400', () => {
    assert.match(handleMemoryFile, /basename\(file\)/)
    assert.match(handleMemoryFile, /MEMORY_FILE_RE\.test\(/)
    assert.match(handleMemoryFile, /sendError\(\s*res\s*,\s*400\s*,\s*'invalid memory file name'/)
  })

  it('GET:ensureMigrated → read → {file, content, version} | 404', () => {
    assert.match(handleMemoryFile, /ensureMigrated\(\)/)
    assert.match(handleMemoryFile, /md\.read\(safe\)/)
    assert.match(handleMemoryFile, /content: hit\.content/)
    assert.match(handleMemoryFile, /sendError\(\s*res\s*,\s*404\s*,/)
  })

  it('PUT:write 三态 → 200 {ok,version} / 409 {text,version} / 400', () => {
    assert.match(handleMemoryFile, /md\.write\(safe/)
    // 409 结构对齐 user:conflict.current → text
    assert.match(handleMemoryFile, /sendJson\(\s*res\s*,\s*409\s*,/)
    assert.match(handleMemoryFile, /text: r\.conflict\.current/)
    assert.match(handleMemoryFile, /version: r\.conflict\.version/)
  })

  it('DELETE:remove → {ok} | 404', () => {
    assert.match(handleMemoryFile, /md\.remove\(safe\)/)
    assert.match(handleMemoryFile, /ok: true, file: safe/)
  })
})

describe('dispatch 注册 files/:file 路由', () => {
  it('/memory/files/:file 路由存在并派发到 handleMemoryFile', () => {
    assert.match(SERVER_TS, /\\\/memory\\\/files\\\/\(\[\^\/\]\+\)\$/)
    assert.match(SERVER_TS, /this\.handleMemoryFile\(/)
  })
})

describe('Auto-Dream 用户可见报告路由', () => {
  it('只允许 GET、隐藏系统 agent 返回 404，并调用严格投影服务', () => {
    assert.match(SERVER_TS, /auto-dream-report/)
    assert.match(handleAutoDreamReport, /isHiddenSystemAgentId\(agentId\)/)
    assert.match(handleAutoDreamReport, /req\.method !== 'GET'/)
    assert.match(handleAutoDreamReport, /this\.autoDream\.getPublicStatus\(agentId\)/)
  })
})
