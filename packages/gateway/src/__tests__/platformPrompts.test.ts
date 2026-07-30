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

// 合法样本必须携带各 key 的必需占位符(m2 校验),否则整套加载失败(那正是占位符测试要单独构造的)。
const sample = (tag: string): Record<PlatformPromptKey, string> => ({
  'platform-capabilities': `CAP-${tag} {{WECHAT_VISION_HINT}}`,
  'memory-instructions': `MEM-${tag} {{MEMORY_DIR}} {{MEMORY_MD}} {{MEMORY_INDEX}}`,
  'codex-preamble': `CODEX-${tag}`,
})
// 便捷取样(替代早期硬编码的 'CAP-r1' 等 —— 现样本含占位符)。
const cap = (tag: string) => sample(tag)['platform-capabilities']

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
    // 只写两个(含合法占位符,确保失败点是「缺文件」而非「缺占位符」),故意缺 codex-preamble
    writeFileSync(join(revDir, FILES['platform-capabilities']), cap('r1'), 'utf8')
    writeFileSync(join(revDir, FILES['memory-instructions']), sample('r1')['memory-instructions'], 'utf8')
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
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), cap('r1'))
    assert.ok(errorLogs.some((l) => l.includes('platform-prompts')))
  })

  it('翻转 current symlink → rev 变化触发整套重读', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    writeBundle(root, 'r2', sample('r2'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), cap('r1'))
    const rev1 = _internals.currentRev()

    pointCurrent(root, 'r2')
    _internals.pollNow()
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), cap('r2'), '翻转后应读到新 rev')
    assert.notEqual(_internals.currentRev(), rev1, 'rev 应随 current 翻转而变')
  })

  it('M3 混 rev 防护:翻到内容全不同的 r2 → 三键整套一致来自 r2(无半套 / 无 r1 残留混读)', () => {
    // M3 修复:readValidatedSet 一次 realpath 得 resolved rev,三个文件全部从 resolved rev 读,
    // 翻转中途不会混用两版。此处以「翻到内容全不同的 r2 后三键必须整套一致」固化该整套读语义。
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    writeBundle(root, 'r2', sample('r2'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    for (const k of KEYS) assert.equal(getPlatformPrompt(k, `FB-${k}`), sample('r1')[k])

    pointCurrent(root, 'r2')
    _internals.pollNow()
    // 三键必须全部来自 r2(任一残留 r1 = 混 rev,视为回归)
    for (const k of KEYS) assert.equal(getPlatformPrompt(k, `FB-${k}`), sample('r2')[k], `${k} 必须整套翻到 r2`)
    assert.equal(_internals.hasSnapshot(), true)
  })

  it('TTL 未到不重读(翻转后立即访问仍是旧值)', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    writeBundle(root, 'r2', sample('r2'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), cap('r1'))

    // 翻到 r2 但不越过 TTL:普通 get 不应重读(仍 r1)
    pointCurrent(root, 'r2')
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), cap('r1'), 'TTL 内不该重读')
    // 越过 TTL(pollNow 绕过门控)后才拾取 r2
    _internals.pollNow()
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB'), cap('r2'))
  })

  it('m2 占位符缺失:启动即缺 → 首轮失败回落 fallback + 告警', () => {
    const root = makeBundleRoot()
    roots.push(root)
    const c = sample('r1')
    // platform-capabilities 去掉必需占位符(其余合法)→ 整套加载失败
    c['platform-capabilities'] = 'CAP-r1 without the required placeholder'
    writeBundle(root, 'r1', c)
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    // 半套不生效:连合法的 memory 也回落 fallback
    assert.equal(getPlatformPrompt('memory-instructions', 'FB-MEM'), 'FB-MEM')
    assert.equal(getPlatformPrompt('platform-capabilities', 'FB-CAP'), 'FB-CAP')
    assert.equal(_internals.hasSnapshot(), false)
    assert.ok(errorLogs.some((l) => l.includes('占位符')), '缺占位符必须告警')
  })

  it('m2 占位符缺失:先成功后翻到缺占位符的 r2 → 保留 LKG(不回落、不半套)+ 告警', () => {
    const root = makeBundleRoot()
    roots.push(root)
    writeBundle(root, 'r1', sample('r1'))
    pointCurrent(root, 'r1')
    process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR = promptsDirVia(root)
    assert.equal(getPlatformPrompt('memory-instructions', 'FB'), sample('r1')['memory-instructions'], '首轮加载成功')

    // r2:memory 去掉一个必需占位符 {{MEMORY_INDEX}}(其余合法)
    const c = sample('r2')
    c['memory-instructions'] = 'MEM-r2 {{MEMORY_DIR}} {{MEMORY_MD}} 缺 index 占位符'
    writeBundle(root, 'r2', c)
    pointCurrent(root, 'r2')
    _internals.pollNow()
    // LKG:三键仍是 r1(缺占位符的 r2 整套不生效)
    for (const k of KEYS) assert.equal(getPlatformPrompt(k, `FB-${k}`), sample('r1')[k], `${k} 应保 LKG=r1`)
    assert.ok(errorLogs.some((l) => l.includes('占位符')))
  })

  it('m2 占位符登记表:三 key 必需占位符与消费方注入契约一致', () => {
    const req = _internals.REQUIRED_PLACEHOLDERS
    assert.deepEqual([...req['platform-capabilities']], ['{{WECHAT_VISION_HINT}}'])
    assert.deepEqual([...req['memory-instructions']].sort(), ['{{MEMORY_DIR}}', '{{MEMORY_INDEX}}', '{{MEMORY_MD}}'])
    assert.deepEqual([...req['codex-preamble']], [])
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
  it('普通模式子 Agent 文案使用平台真实委派通道', () => {
    const prompt = _platformPromptFallbacks.PLATFORM_CAPABILITIES_FALLBACK
    for (const tool of ['delegate_task', 'delegate_tasks', 'send_to_agent']) {
      assert.ok(prompt.includes(tool), `普通模式提示缺真实委派工具: ${tool}`)
    }
    assert.ok(prompt.includes('即使未开启团队模式'))
    assert.ok(prompt.includes('按收益机会式委派'))
    // 这里只固化静态 prompt 契约;是否真的并行、质量和资源是否达标由
    // evals/v5-parallel-delegation 的双底座真 turn A/B 门验证。
    for (const rule of [
      '用户未明确要求单Agent',
      '平台已列出合适可用成员',
      '可拆为2–4个输入/产物互不依赖',
      '首轮必须恰好调用一次`delegate_tasks`',
      '通常同时≤3，其余由平台有界排队',
      '选匹配成员',
      '简单、强依赖、外部限流或CPU/内存饱和时保持单Agent',
      '依赖步骤串行',
      '为各分片写明边界与验收条件',
      '负责拆分、单写者、集成并逐项验证',
      '子Agent不得再委派',
      '禁止底座原生multi-agent及后台Bash fan-out',
      '返回后只重试失败或缺失分片',
    ]) {
      assert.ok(prompt.includes(rule), `普通模式提示缺受控并行契约: ${rule}`)
    }
    const evalRule = readFileSync(
      join(process.cwd(), 'evals/v5-parallel-delegation/candidate-rule.md'),
      'utf8',
    ).trim()
    assert.ok(prompt.includes(evalRule), '行为 A/B 注入的候选规则必须与正式 platform prompt 逐字一致')
    assert.match(prompt, /简单、强依赖[\s\S]*保持单Agent/)
    assert.ok(!prompt.includes('Agent 工具 spawn 子 agent'))
    assert.ok(!prompt.includes('multi_agent_v2'))
    assert.ok(!prompt.includes('子 agent 会继承你的全部工具和上下文'))
  })
  it('选择题使用运行时专用 Ask 工具，不再把 options 富块当交互入口', () => {
    const prompt = _platformPromptFallbacks.PLATFORM_CAPABILITIES_FALLBACK
    assert.ok(prompt.includes('AskUserQuestion'))
    assert.ok(prompt.includes('request_user_input'))
    assert.ok(prompt.includes('不要输出 fenced `options` 代码块'))
    assert.ok(prompt.includes('并等待回答'))
  })
  it('原生容器网站预览 SOP 覆盖常驻 prompt、Codex 基线与平台 skill', () => {
    const sources = {
      prompt: _platformPromptFallbacks.PLATFORM_CAPABILITIES_FALLBACK,
      codex: readFileSync('packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md', 'utf8'),
      skill: readFileSync(
        'packages/commercial/agent-sandbox/ccb-baseline/skills/platform-capabilities/SKILL.md',
        'utf8',
      ),
    }
    const required = [
      '单文件、自包含',
      '真实项目',
      'curl -fsSL --max-time 5',
      '[打开网站预览](http://localhost:3000/dashboard)',
    ]
    for (const [name, source] of Object.entries(sources)) {
      for (const fragment of required) {
        assert.ok(source.includes(fragment), `${name} 缺原生预览契约: ${fragment}`)
      }
    }

    const semanticContracts = [
      ['回复后保持服务', /回复后[^\n]*(?:不要结束服务|服务必须继续运行)/],
      ['禁止自建临时域名或隧道', /不要[^\n]*trycloudflare[^\n]*(?:域名|隧道)/],
      [
        '元素评论必须修改、测试、再次校验并返回同一预览',
        /(?:选择器[^\n]*视口|视口[^\n]*选择器)[^\n]*(?:修改|定位源码)[^\n]*测试[^\n]*再次校验[^\n]*预览链接/,
      ],
    ] as const
    for (const [name, source] of Object.entries(sources)) {
      for (const [contract, pattern] of semanticContracts) {
        assert.match(source, pattern, `${name} 缺原生预览语义契约: ${contract}`)
      }
    }

    const retiredBroadRules = [
      '用户要求界面预览、交互 demo、HTML Canvas、动画、小游戏、设计稿还原或可视化原型时,优先直接输出',
      '当用户要求界面预览、交互 demo、HTML Canvas、动画、小游戏、设计稿还原、可视化原型时,优先直接回复',
      '当用户要求可视化、界面预览、交互 demo、HTML Canvas、小游戏、设计稿还原时,**优先直接输出内联代码块**',
    ]
    for (const [name, source] of Object.entries(sources)) {
      for (const retired of retiredBroadRules) {
        assert.ok(!source.includes(retired), `${name} 仍含与原生预览冲突的 htmlpreview 广义规则`)
      }
    }
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
    assert.ok(
      codexInternals.CODEX_PREAMBLE.includes('`delegate_tasks` (parallel fan-out)'),
      'Codex preamble 必须明确列出平台并行委派工具',
    )
  })
})
