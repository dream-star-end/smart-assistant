/**
 * platformPrompts — LKG 加载器行为 + 「fallback 常量 === bundle 文件」同步门。
 *
 * 设计出处:V5_RUNTIME_HOTCFG_PLAN.md §1.2 / §4.2。断言覆盖:
 *   - env 未设 → 恒回落 fallback,且不建立任何快照(不起轮询);
 *   - 三文件齐全+合法 → 整套生效,getPlatformPrompt 返回文件内容;
 *   - 缺一个/超大/非空校验失败 → 保留 last-known-good + console.error 告警(半套不生效);
 *   - 翻转 current symlink 后按 rev 变化 TTL 重读;TTL 未到不重读;
 *   - workspace 缺省 cwd(sessionManager.resolveDefaultWorkspaceCwd);
 *   - fallback 常量与 platform-runtime/prompts/*.md 逐字一致(漂移即红)。
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  getPlatformPrompt,
  _internals,
  type PlatformPromptKey,
} from '../platformPrompts.js'
import { _platformPromptFallbacks } from '../promptSlots.js'
import { _internals as codexInternals } from '../codexLaunchOverrides.js'

const KEYS: PlatformPromptKey[] = ['platform-capabilities', 'memory-instructions', 'codex-preamble']
const FILES = _internals.PROMPT_FILES

// 每个 case 独立造一个 bundle 根:bundles/<rev>/ + current -> bundles/<rev>,
// env 指向 current(经 symlink,realpath 用于 rev 变化检测)。
function makeBundleRoot(): string {
  return mkdtempSync(join(tmpdir(), 'oc-prompts-'))
}
function writeBundle(root: string, rev: string, contents: Record<PlatformPromptKey, string>): string {
  const revDir = join(root, 'bundles', rev, 'prompts')
  mkdirSync(revDir, { recursive: true })
  for (const k of KEYS) writeFileSync(join(revDir, FILES[k]), contents[k], 'utf8')
  return revDir
}
function pointCurrent(root: string, rev: string): void {
  // current -> bundles/<rev>(mv -T 语义:先删再建,近似原子翻转)
  const cur = join(root, 'current')
  try {
    rmSync(cur, { recursive: true, force: true })
  } catch {}
  symlinkSync(join(root, 'bundles', rev), cur)
}
function promptsDirVia(root: string): string {
  return join(root, 'current', 'prompts')
}

const sample = (tag: string): Record<PlatformPromptKey, string> => ({
  'platform-capabilities': `CAP-${tag}`,
  'memory-instructions': `MEM-${tag}`,
  'codex-preamble': `CODEX-${tag}`,
})

const roots: string[] = []
let origEnv: string | undefined
let errorLogs: string[] = []
let origError: typeof console.error

beforeEach(() => {
  origEnv = process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
  delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
  _internals.resetForTests()
  errorLogs = []
  origError = console.error
  console.error = (...args: unknown[]) => {
    errorLogs.push(args.map((a) => String(a)).join(' '))
  }
})
afterEach(() => {
  console.error = origError
  if (origEnv === undefined) delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR
  else process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = origEnv
  _internals.resetForTests()
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {}
  }
})

describe('platformPrompts LKG 加载器', () => {
  it('env 未设 → 恒回落 fallback,且不建立快照(不起轮询)', () => {
    assert.equal(getPlatformPrompt('codex-preamble', 'FB'), 'FB')
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB2'), 'FB2')
    assert.equal(_internals.hasSnapshot(), false, 'env 未设不该建立快照')
    assert.equal(_internals.currentRev(), null)
  })

  it('三文件齐全+合法 → 整套生效,返回文件内容而非 fallback', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    for (const k of KEYS) {
      assert.equal(getPlatformPrompt(k, `FB-${k}`), `${sample('r1')[k]}`)
    }
    assert.equal(_internals.hasSnapshot(), true)
    assert.equal(errorLogs.length, 0, '成功加载不应告警')
  })

  it('缺一个文件 → 整套不生效(首次失败回落 fallback)+ 告警', () => {
    const root = makeBundleRoot()
    roots.push(root)
    const revDir = join(root, 'bundles', 'r1', 'prompts')
    mkdirSync(revDir, { recursive: true })
    // 只写两个,故意缺 codex-preamble
    writeFileSync(join(revDir, FILES['platform-capabilities']), 'CAP', 'utf8')
    writeFileSync(join(revDir, FILES['memory-instructions']), 'MEM', 'utf8')
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    // 半套不生效:连齐全的两个也回落 fallback
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB-CAP'), 'FB-CAP')
    assert.equal(getPlatformPrompt('codex-preamble', 'FB-CODEX'), 'FB-CODEX')
    assert.equal(_internals.hasSnapshot(), false)
    assert.ok(errorLogs.some((l) => l.includes('platform-prompts')), '缺文件必须 console.error 告警')
  })

  it('单文件超 256KB → 整套拒(回落 fallback)+ 告警', () => {
    const root = makeBundleRoot()
    roots.push(root)
    const big = sample('big')
    big['platform-capabilities'] = 'x'.repeat(_internals.MAX_PROMPT_BYTES + 1)
    writeBundle(root, 'r1', big)
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('memory-instructions', 'FB-MEM'), 'FB-MEM')
    assert.equal(_internals.hasSnapshot(), false)
    assert.ok(errorLogs.some((l) => l.includes('platform-prompts')))
  })

  it('空文件 → 整套拒 + 告警', () => {
    const root = makeBundleRoot()
    roots.push(root)
    const c = sample('e')
    c['memory-instructions'] = '   \n\t  '
    writeBundle(root, 'r1', c)
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'FB')
    assert.ok(errorLogs.some((l) => l.includes('platform-prompts')))
  })

  it('先成功后缺文件 → 保留 last-known-good(不回落 fallback)+ 告警', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('codex-preamble', 'FB'), 'CODEX-r1', '首轮应加载成功')

    // 翻到一个残缺的新 rev(缺 codex-preamble)
    const revDir = join(root, 'bundles', 'r2', 'prompts')
    mkdirSync(revDir, { recursive: true })
    writeFileSync(join(revDir, FILES['platform-capabilities']), 'CAP-r2', 'utf8')
    writeFileSync(join(revDir, FILES['memory-instructions']), 'MEM-r2', 'utf8')
    pointCurrent(root, 'r2')
    _internals.pollNow()
    // LKG:仍返回 r1 的值,而非 fallback、也不是半套 r2
    assert.equal(getPlatformPrompt('codex-preamble', 'FB'), 'CODEX-r1')
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'CAP-r1')
    assert.ok(errorLogs.some((l) => l.includes('platform-prompts')))
  })

  it('翻转 current symlink → rev 变化触发整套重读', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    writeBundle(root, 'r2', sample('r2'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'CAP-r1')
    const rev1 = _internals.currentRev()

    pointCurrent(root, 'r2')
    _internals.pollNow()
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'CAP-r2', '翻转后应读到新 rev')
    assert.notEqual(_internals.currentRev(), rev1, 'rev 应随 current 翻转而变')
  })

  it('TTL 未到不重读(翻转后立即访问仍是旧值)', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    writeBundle(root, 'r2', sample('r2'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'CAP-r1')

    // 翻到 r2 但不越过 TTL:普通 get 不应重读(仍 r1)
    pointCurrent(root, 'r2')
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'CAP-r1', 'TTL 内不该重读')
    // 越过 TTL(pollNow 绕过门控)后才拾取 r2
    _internals.pollNow()
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), 'CAP-r2')
  })
})

describe('fallback 常量 === bundle 文件(逐字同步门)', () => {
  const dir = 'packages/commercial/agent-sandbox/platform-runtime/prompts'
  it('platform-capabilities.md === PLATFORM_CAPABILITIES_FALLBACK', () => {
    assert.equal(
      readFileSync(join(dir, 'platform-capabilities.md'), 'utf8'),
      _platformPromptFallbacks.PLATFORM_CAPABILITIES_FALLBACK,
    )
    // 占位符必须双向存在(注入契约不被无意改掉)
    assert.ok(
      _platformPromptFallbacks.PLATFORM_CAPABILITIES_FALLBACK.includes(
        _platformPromptFallbacks.WECHAT_VISION_HINT_PLACEHOLDER,
      ),
    )
  })
  it('memory-instructions.md === MEMORY_INSTRUCTIONS_FALLBACK', () => {
    const fb = _platformPromptFallbacks.MEMORY_INSTRUCTIONS_FALLBACK
    assert.equal(readFileSync(join(dir, 'memory-instructions.md'), 'utf8'), fb)
    for (const ph of ['{{MEMORY_DIR}}', '{{MEMORY_MD}}', '{{MEMORY_INDEX}}']) {
      assert.ok(fb.includes(ph), `memory 模板必须含占位符 ${ph}`)
    }
  })
  it('codex-preamble.md === CODEX_PREAMBLE', () => {
    assert.equal(
      readFileSync(join(dir, 'codex-preamble.md'), 'utf8'),
      codexInternals.CODEX_PREAMBLE,
    )
  })
})
