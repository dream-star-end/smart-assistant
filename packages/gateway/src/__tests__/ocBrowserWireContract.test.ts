/**
 * oc-browser **三处同源**契约门(#230 根治)。
 *
 * ── 它红了,用户会看到什么 ────────────────────────────────────────────────────
 * `oc-browser <verb>` 的一次调用要穿过三个各自独立声明的面:
 *   ① CLI flag 表     — ocBrowserCli.ts 的 SUBCOMMANDS(`--ref` → wire 参数 `target`)
 *   ② daemon 工具闸   — ocBrowserShared.ts 的 OC_BROWSER_TOOLS(daemon 既拿它做启动
 *                       自检,也拿它做请求 allowlist)
 *   ③ 上游工具 schema — @playwright/mcp 的 inputSchema(镜像按版本钉死)
 * 任意两处漂开,agent 的每一次点击/输入都会失败:
 *   · ① vs ③ 漂 → 上游返 "Invalid arguments for tool …" (#230 的主 bug:参数名还是
 *     旧的 `ref`,上游 0.0.76 要 `target`,于是 click/type **每次必失败**);
 *   · ① vs ② 漂 → daemon 直接以 "unsupported tool" 拒掉,子命令等于不存在。
 * 两种都表现为"AI 说它点了按钮,其实什么都没发生",而且 agent 会带着错误的世界模型
 * 继续往下做 —— 这正是引擎适配类事故的共同形态(错误以正常返回值出现)。
 *
 * ── 契约 ─────────────────────────────────────────────────────────────────────
 *   ① SUBCOMMANDS 用到的 tool ⊆ OC_BROWSER_TOOLS(否则 daemon 拒收)
 *   ② OC_BROWSER_TOOLS ⊆ 上游真实工具名(否则 daemon 启动自检直接抛,oc-browser 全死)
 *   ③ CLI 发出的每个 wire 参数名 ∈ 上游该工具的 properties(#230 主 bug 的正面拦截)
 *   ④ 上游 required 的参数,必须由某个 required flag 保证送达(或登记在实测确认的
 *      REQUIRED_BUT_DEFAULTED 里)
 *   ⑤ 钉版一致:镜像 Dockerfile 的 OC_PLAYWRIGHT_MCP_VERSION == 快照的 PINNED_VERSION
 *      —— 升版必红,逼人重抓上游 schema(#230 就是跟着版本升级漂掉的)
 *
 * 注:`isError: true` 必须映射到非零退出码(#230 的第二个 bug)已由
 * `ocControlCliE2e.test.ts` 的 "MCP tool-level errors fail the shell command without
 * losing structured JSON" 在真 Unix socket 上覆盖(text/--json 两种模式都断言 exit 1),
 * 本文件不重复。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { OC_BROWSER_TOOLS } from '../ocBrowserShared.js'
import {
  ALL_TOOL_NAMES,
  PINNED_VERSION,
  REQUIRED_BUT_DEFAULTED,
  UPSTREAM_TOOL_SCHEMAS,
} from './helpers/playwrightMcpToolSchema.js'

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, '..', 'ocBrowserCli.ts')
const dockerfilePath = join(
  here,
  '..',
  '..',
  '..',
  'commercial',
  'agent-sandbox',
  'Dockerfile.openclaude-runtime',
)

interface CliFlag {
  readonly flag: string
  /** 送到 wire 上的参数名。 */
  readonly arg: string
  readonly required: boolean
}
interface CliSubcommand {
  readonly name: string
  readonly tool: string
  readonly flags: readonly CliFlag[]
}

/**
 * 解析 ocBrowserCli.ts 的 SUBCOMMANDS 表。
 *
 * 解析对象是"子命令声明了哪个 tool / 哪些 flag 映射到哪个 wire 参数",即**声明的契约**;
 * 参数解析实现、usage 文案、报错措辞怎么改都不影响本文件。
 */
async function readSubcommands(): Promise<CliSubcommand[]> {
  const source = await readFile(cliPath, 'utf8')
  const marker = 'const SUBCOMMANDS: Record<string, SubcommandSpec> = {'
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `ocBrowserCli.ts 缺少 ${marker} —— 契约锚点失效,请更新解析器`)
  let depth = 0
  let end = -1
  for (let i = start + marker.length - 1; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end > 0, 'SUBCOMMANDS 表未闭合')
  const block = source.slice(start, end + 1)

  const out: CliSubcommand[] = []
  // 每个子命令:`name: { tool: 'x', flags: { … } }`(name 可能带引号)。
  const entryRe = /(?:^|\n)\s{2}'?([a-z-]+)'?:\s*\{/g
  const entries: { name: string; from: number }[] = []
  for (const m of block.matchAll(entryRe)) entries.push({ name: m[1]!, from: m.index! })
  for (let i = 0; i < entries.length; i++) {
    const slice = block.slice(entries[i]!.from, entries[i + 1]?.from ?? block.length)
    const tool = /tool:\s*'([^']+)'/.exec(slice)?.[1]
    assert.ok(tool, `子命令 ${entries[i]!.name} 没解析到 tool 名`)
    const flags: CliFlag[] = []
    for (const fm of slice.matchAll(/'?([a-z-]+)'?:\s*\{\s*kind:\s*'[a-z]+'([^}]*)\}/g)) {
      const rest = fm[2]!
      const arg = /arg:\s*'([^']+)'/.exec(rest)?.[1]
      if (!arg) continue
      flags.push({ flag: fm[1]!, arg, required: /required:\s*true/.test(rest) })
    }
    out.push({ name: entries[i]!.name, tool, flags })
  }

  // 下界哨兵:2026-07-26 实测 7 个子命令。解析退化必须红,而不是让"全部满足"在空集上通过。
  assert.ok(
    out.length >= 7,
    `只解析到 ${out.length} 个子命令(低于历史下界 7),SUBCOMMANDS 写法可能变了`,
  )
  return out
}

describe('oc-browser 三处同源契约(#230)', () => {
  test('⑤ 镜像钉的 @playwright/mcp 版本与本地 schema 快照一致', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8')
    const pinned = /ARG OC_PLAYWRIGHT_MCP_VERSION=([0-9][0-9A-Za-z.-]*)/.exec(dockerfile)?.[1]
    assert.ok(pinned, 'Dockerfile.openclaude-runtime 里找不到 ARG OC_PLAYWRIGHT_MCP_VERSION')
    assert.equal(
      pinned,
      PINNED_VERSION,
      `镜像钉的 @playwright/mcp 版本(${pinned})与 helpers/playwrightMcpToolSchema.ts 的` +
        `快照版本(${PINNED_VERSION})不一致。上游改过参数名(0.0.7x 把 click/type 的 ` +
        '`ref` 改成 `target`,#230 就是没跟上),所以升版后必须重抓 schema:' +
        '按该文件头部的"重抓方式"跑一遍探针,更新 UPSTREAM_TOOL_SCHEMAS / ALL_TOOL_NAMES / ' +
        'PINNED_VERSION,并复核 REQUIRED_BUT_DEFAULTED 是否仍成立。',
    )
  })

  test('① CLI 子命令用到的 tool 都在 daemon 的 OC_BROWSER_TOOLS 闸内', async () => {
    const subcommands = await readSubcommands()
    const allowed = new Set<string>(OC_BROWSER_TOOLS)
    const strays = subcommands
      .filter((s) => !allowed.has(s.tool))
      .map((s) => `${s.name} → ${s.tool}`)
    assert.deepEqual(
      strays,
      [],
      '以下子命令调用的 tool 不在 OC_BROWSER_TOOLS 里,daemon 会直接以 "unsupported tool" ' +
        `拒收 —— 该子命令等于不存在:\n  ${strays.join('\n  ')}\n` +
        '修法:在 packages/gateway/src/ocBrowserShared.ts 的 OC_BROWSER_TOOLS 补登该工具名。',
    )
  })

  test('② OC_BROWSER_TOOLS 全部存在于上游工具表', () => {
    const upstream = new Set(ALL_TOOL_NAMES)
    const missing = OC_BROWSER_TOOLS.filter((t) => !upstream.has(t))
    assert.deepEqual(
      missing,
      [],
      `以下工具在上游 @playwright/mcp@${PINNED_VERSION} 里不存在。daemon 启动自检会直接抛 ` +
        `"missing expected tools" —— oc-browser 整体起不来,所有浏览器能力全失:\n  ${missing.join('\n  ')}`,
    )
    // 反向:快照里必须真的有 oc-browser 用到的工具 schema,否则 ③④ 是空转。
    const noSchema = OC_BROWSER_TOOLS.filter((t) => !(t in UPSTREAM_TOOL_SCHEMAS))
    assert.deepEqual(
      noSchema,
      [],
      `以下工具缺 schema 快照,③④ 两条对它形同虚设:\n  ${noSchema.join('\n  ')}`,
    )
  })

  test('③ CLI 送出的每个 wire 参数名都是上游声明的属性', async () => {
    const subcommands = await readSubcommands()
    const unknown: string[] = []
    for (const sub of subcommands) {
      const schema = UPSTREAM_TOOL_SCHEMAS[sub.tool]
      if (!schema) continue // ② 已经负责报这种情况
      for (const flag of sub.flags) {
        if (!schema.props.includes(flag.arg)) {
          unknown.push(`${sub.name} --${flag.flag} → ${sub.tool}.${flag.arg}`)
        }
      }
    }
    assert.deepEqual(
      unknown,
      [],
      `以下 CLI flag 映射到了上游 @playwright/mcp@${PINNED_VERSION} 不认识的参数名。` +
        '上游会把调用连同 "Invalid arguments for tool" 一起拒掉,agent 的点击/输入' +
        `每次都失败(#230 的原始形态就是 click/type 把 target 发成 ref):\n  ${unknown.join('\n  ')}\n` +
        '修法:按快照里该工具的 props 修正 ocBrowserCli.ts 的 arg 名。',
    )
  })

  test('④ 上游必填参数都有 required flag 保证送达', async () => {
    const subcommands = await readSubcommands()
    const waived = new Set(REQUIRED_BUT_DEFAULTED.map((w) => `${w.tool}.${w.prop}`))
    const gaps: string[] = []
    for (const sub of subcommands) {
      const schema = UPSTREAM_TOOL_SCHEMAS[sub.tool]
      if (!schema) continue
      const guaranteed = new Set(sub.flags.filter((f) => f.required).map((f) => f.arg))
      for (const prop of schema.required) {
        if (guaranteed.has(prop)) continue
        if (waived.has(`${sub.tool}.${prop}`)) continue
        gaps.push(`${sub.name} → ${sub.tool} 缺必填参数 ${prop}`)
      }
    }
    assert.deepEqual(
      gaps,
      [],
      `以下子命令没有任何 required flag 能保证送出上游必填参数,调用会被 ` +
        `"Invalid arguments for tool" 拒掉(agent 侧表现为该动作永远失败):\n  ${gaps.join('\n  ')}\n` +
        '修法:给对应 flag 标 required:true;若上游虽声明 required 但实际带默认值,' +
        '实测确认后登记进 helpers/playwrightMcpToolSchema.ts 的 REQUIRED_BUT_DEFAULTED(必须写 evidence)。',
    )

    // 豁免簿卫生:条目必须仍对应"上游确实声明 required"的属性,否则是过期条目。
    const stale = REQUIRED_BUT_DEFAULTED.filter(
      (w) => !UPSTREAM_TOOL_SCHEMAS[w.tool]?.required.includes(w.prop),
    ).map((w) => `${w.tool}.${w.prop}`)
    assert.deepEqual(
      stale,
      [],
      `REQUIRED_BUT_DEFAULTED 里的条目在当前快照里已不是 required,属于过期豁免,请删:\n  ${stale.join('\n  ')}`,
    )
    for (const w of REQUIRED_BUT_DEFAULTED) {
      assert.ok(
        w.evidence.includes(PINNED_VERSION),
        `REQUIRED_BUT_DEFAULTED 的 ${w.tool}.${w.prop} 的 evidence 没提到当前钉版 ` +
          `${PINNED_VERSION} —— 豁免必须在当前版本上实测过,否则请重验后更新 evidence`,
      )
    }
  })
})
