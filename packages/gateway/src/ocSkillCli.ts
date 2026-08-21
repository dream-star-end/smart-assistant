/**
 * oc-skill —— 对话内「技能训练优化 / 生成评测用例」的容器内 CLI。用户在对话里说
 * 「优化一下 XX 技能」,AI 在**取得用户明确同意后**用本 CLI 发起后台训练;训练完成
 * 用户会收到站内信,再到管理中心看 diff 并决定是否合并。用法与四条纪律见
 * `skill-management` baseline skill。
 *
 * 传输:只打**本容器 gateway 自己的**回环 relay(/internal/v3/skill-local/*,端口取自
 * openclaude.json,照 oc-market 的 resolveLocalGatewayBase 模式)。不走 master、不带
 * 容器 token —— 训练/评测生成是 gateway-local API,身份由 gateway 按回环解析(单租户
 * 容器 → 'default')。
 *
 * 安全门:train / evals-generate 会消耗积分,必须显式 `--confirm` 才真正发请求;缺
 * --confirm 只打印「需先取得用户同意」的提示并 exit 2(不发任何请求)。CLI **不做第二套
 * 领域校验**(技能是否存在/可写、是否已有训练在跑,一律由 train/eval-gen API 权威裁决)。
 *
 * 子命令:
 *   oc-skill train <name> --confirm [--focus <text>]   发起训练优化(--focus 可选:优化侧重)
 *   oc-skill train-status <runId>                       查训练进度/结果
 *   oc-skill evals-generate <name> --confirm            AI 生成评测用例(草稿,待用户在编辑器保存)
 *   oc-skill evals-gen-status <runId>                   查生成进度/结果
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function fail(msg: string): never {
  process.stderr.write(`oc-skill: ${msg}\n`)
  process.exit(1)
}

type FileReader = (path: string, encoding: BufferEncoding) => string

/**
 * 本容器 gateway 回环 relay base（照 ocMarketCli.resolveLocalGatewayBase）。读
 * openclaude.json 的 gateway.port,拼 http://127.0.0.1:<port>/internal/v3/skill-local。
 * 读不到 / 端口非法 → null。
 */
export function resolveLocalSkillBase(
  env: NodeJS.ProcessEnv = process.env,
  readFile: FileReader = readFileSync,
): string | null {
  const home = env.OPENCLAUDE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.openclaude')
  try {
    const cfg = JSON.parse(readFile(join(home, 'openclaude.json'), 'utf8')) as {
      gateway?: { port?: unknown }
    }
    const port = typeof cfg.gateway?.port === 'number' ? cfg.gateway.port : Number(cfg.gateway?.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return `http://127.0.0.1:${port}/internal/v3/skill-local`
  } catch {
    return null
  }
}

export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i += 1)] : 'true'
      flags[key] = val
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

/**
 * 纯决策(无 IO):把「命令 + 参数」翻译成要发的请求,或一个不发请求的终止态。
 *   - usage:参数用法错误 → stderr + exit 1。
 *   - confirm-required:消耗积分的操作但没带 --confirm → stderr + exit 2,**不发请求**。
 *   - request:实际请求。op 是相对 relay base 的路径段(如 skills/<name>/train)。
 */
export type SkillCliPlan =
  | { kind: 'usage'; message: string }
  | { kind: 'confirm-required'; message: string }
  | { kind: 'request'; method: 'GET' | 'POST'; op: string; body?: unknown }

/** train / evals-generate 缺 --confirm 时给 AI 的提示(引导它先征得用户同意)。 */
function confirmRequiredMessage(action: string): string {
  return (
    `「${action}」会消耗积分。请先明确告知用户这一点并取得用户同意,` +
    '得到同意后再带 --confirm 重新执行本命令。(未同意前不要发起)'
  )
}

export function planSkillCommand(argv: string[]): SkillCliPlan {
  const [cmd, ...rest] = argv
  const { positional, flags } = parseFlags(rest)
  const confirmed = flags.confirm === 'true'

  switch (cmd) {
    case 'train': {
      const name = positional[0]
      if (!name) return { kind: 'usage', message: 'train <name> --confirm [--focus <text>]' }
      if (!confirmed) return { kind: 'confirm-required', message: confirmRequiredMessage('技能训练优化') }
      const focus = flags.focus && flags.focus !== 'true' ? flags.focus.trim() : ''
      return {
        kind: 'request',
        method: 'POST',
        op: `skills/${name}/train`,
        body: focus ? { focus } : {},
      }
    }
    case 'train-status': {
      const runId = positional[0]
      if (!runId) return { kind: 'usage', message: 'train-status <runId>' }
      return { kind: 'request', method: 'GET', op: `skill-training/${runId}` }
    }
    case 'evals-generate': {
      const name = positional[0]
      if (!name) return { kind: 'usage', message: 'evals-generate <name> --confirm' }
      if (!confirmed)
        return { kind: 'confirm-required', message: confirmRequiredMessage('生成评测用例') }
      return { kind: 'request', method: 'POST', op: `skills/${name}/evals/generate`, body: {} }
    }
    case 'evals-gen-status': {
      const runId = positional[0]
      if (!runId) return { kind: 'usage', message: 'evals-gen-status <runId>' }
      return { kind: 'request', method: 'GET', op: `skill-eval-gen/${runId}` }
    }
    default:
      return {
        kind: 'usage',
        message: 'usage: oc-skill <train|train-status|evals-generate|evals-gen-status> ...',
      }
  }
}

async function call(method: 'GET' | 'POST', op: string, body?: unknown): Promise<unknown> {
  const base = resolveLocalSkillBase()
  if (!base) fail('not in a commercial container (no local gateway config)')
  const url = `${base.replace(/\/+$/, '')}/${op}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      const e = json?.error
      // train/eval-gen API 是权威:把它的 status/文案原样透出,不在 CLI 二次解释。
      fail(`${res.status} ${e?.code ?? ''} ${e?.message ?? (typeof e === 'string' ? e : text)}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(
      'usage: oc-skill <train|train-status|evals-generate|evals-gen-status> ...\n',
    )
    process.exit(0)
  }
  const plan = planSkillCommand(argv)
  const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)

  switch (plan.kind) {
    case 'usage':
      fail(plan.message)
      break
    case 'confirm-required':
      // 硬门:不发请求。exit 2 与用法错误(exit 1)区分,便于 AI 判「需先征得同意」。
      process.stderr.write(`oc-skill: ${plan.message}\n`)
      process.exit(2)
      break
    case 'request':
      out(await call(plan.method, plan.op, plan.body))
      break
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
}
