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
