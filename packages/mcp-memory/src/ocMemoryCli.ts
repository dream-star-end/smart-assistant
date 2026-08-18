/**
 * oc-memory — 容器内长期记忆 CLI(Core / Recall / Archival 三层记忆的一次性入口)。
 *
 * 取代常驻 `openclaude_memory` MCP 里的 memory / session_search / archival_add /
 * archival_search / archival_delete 五个工具。常驻 stdio 传输脆弱(被 console 污染 /
 * 崩溃即整条传输死掉、codex 死等 turn 被掐);一次性进程 —— stdout 是结果文本,无
 * 协议可污染,进程退出即结束。delegate / cron / skill 工具仍留在 MCP server。
 *
 * 用法(memory-management baseline skill 文档化):
 *   oc-memory session-search "<query>" [--limit N] [--agent-id ID] [--summarize]
 *   oc-memory archival-add "<text>" [--tags a,b,c]
 *   oc-memory archival-search "<query>" [--limit N]
 *   oc-memory archival-delete <id>
 *
 * memdir 重构:Core 记忆(旧 `oc-memory memory --action ...`)已退役——Core 记忆改为
 * 「引擎原生直接编辑文件」(agents/<id>/memory/<slug>.md + MEMORY.md 索引)。仍拦截
 * `oc-memory memory ...` 打印中文迁移提示并 exit 2,防旧技能/旧习惯静默失败。
 *
 * 参数字段严格对齐旧 MCP 工具 inputSchema(query / tags / id / limit / agentId /
 * summarize)。输出:handler 返回的 content[0].text 写 stdout;
 * handler 报错(isError)或参数错误 → stderr + exit 1。
 *
 * env:agent 身份 CCB 路径取 ambient OPENCLAUDE_AGENT_ID(与旧 MCP 同源);codex 路径
 * 该 env 被 buildCodexEnv scrub,改取非 scrub 的 OC_AGENT_ID(codexAppServerRunner spawn
 * 时按本 agent 显式注入)。两者皆缺才回落 'main'(与旧 MCP `?? 'main'` 一致)。记忆文件位置
 * 由 OPENCLAUDE_HOME 决定(容器内 = /home/agent/.openclaude;未设时 paths.ts 回落
 * homedir()/.openclaude,容器内两者同路径)。
 */
import { paths } from '@openclaude/storage'
import {
  createMemoryToolsContext,
  drainPendingEmbeds,
  handleArchivalAdd,
  handleArchivalDelete,
  handleArchivalSearch,
  handleCoreSearch,
  handleSessionSearch,
  type MemoryToolResult,
} from './memoryTools.js'
import { gatewayAuthHeaders, gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway } from './gatewayClient.js'
import {
  resolveDelegateWaitHardMs,
  resolveDelegateWaitPollMs,
  runDelegateWaitLoop,
} from './delegateWaitCli.js'
import { normalizeDelegateAgentId, normalizeDelegateModel } from './delegateArgs.js'
import {
  readDelegateContextToken,
  requestReviewArgs,
  runDelegateStartAndWait,
  type DelegateCliArgs,
} from './delegateStartCli.js'
import { DELEGATE_CONTEXT_HEADER } from './gatewayClient.js'

const TOOL = 'oc-memory'

function fail(msg: string): never {
  process.stderr.write(`${TOOL}: ${msg}\n`)
  process.exit(1)
}

/** Minimal flag parser: `--key value` (value = next arg unless it starts with
 *  `--`, otherwise the flag is a bare boolean → "true"). Positionals collected
 *  in order. Mirrors gateway's ocResearchClient.parseFlags (can't be imported
 *  across the package boundary — mcp-memory does not depend on gateway). */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
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

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) fail(`--limit must be a positive integer (got "${raw}")`)
  return n
}

function parseOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) fail(`--offset must be a non-negative integer (got "${raw}")`)
  return n
}

const USAGE = [
  'usage:',
  '  oc-memory core-search "<query>" [--limit N] [--offset N]',
  '  oc-memory session-search "<query>" [--limit N] [--agent-id ID] [--summarize]',
  '  oc-memory archival-add "<text>" [--tags a,b,c]',
  '  oc-memory archival-search "<query>" [--limit N]',
  '  oc-memory archival-delete <id>',
  '  oc-memory delegate-wait <jobId> [<jobId>...]',
  '  oc-memory delegate --goal "<text>" [--agent-id ID] [--model SLUG] [--context "..."] [--effort low|medium|high] [--toolsets a,b] [--resume-session-key KEY]',
  '  oc-memory request-review --draft "<text>" [--revision-note "..."] [--resume-session-key KEY]',
].join('\n')

/**
 * `oc-memory memory ...` 退役后的中文迁移提示(memdir)。Core 记忆改为直接编辑文件,
 * 这里给出本 agent 的记忆目录与索引绝对路径(容器内由 OPENCLAUDE_HOME 决定)。
 */
function coreMemoryMigrationNotice(agentId: string): string {
  const dir = paths.agentMemoryDir(agentId)
  const index = paths.agentMemoryMd(agentId)
  return [
    'Core 记忆已改为「直接编辑文件」范式,`oc-memory memory` 子命令已退役。',
    '请改用文件操作:',
    `  • 新增/更新一条记忆 → 直接写文件 ${dir}/<slug>.md`,
    '      (frontmatter 三字段:name / description / type,正文写事实)',
    `  • 查看已有记忆 → 先 Read 索引 ${index},再按需 Read 具体记忆文件`,
    '  • 删除错误记忆 → 删除对应文件即可(索引会自动对账)',
    '详见系统提示 # Memory 段。session-search / archival 子命令不受影响。',
    '',
  ].join('\n')
}

/** Print the handler's text to stdout and exit non-zero on isError. */
function emit(res: MemoryToolResult): never {
  const text = res.content?.[0]?.text ?? ''
  if (res.isError) {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
    process.exit(1)
  }
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  process.exit(0)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${USAGE}\n`)
    process.exit(cmd ? 0 : 1)
  }

  // CCB: OPENCLAUDE_AGENT_ID(ambient);codex: 该 env 被 scrub → OC_AGENT_ID(spawn 注入)。
  const agentId =
    process.env.OPENCLAUDE_AGENT_ID?.trim() || process.env.OC_AGENT_ID?.trim() || 'main'

  // memdir:Core 记忆改为引擎原生直接编辑文件,`memory` 子命令退役。在建 context(触发
  // sessions.db / embedding 初始化)之前就短路,迁移提示不依赖任何后端。exit 2(非 0),
  // 防旧技能/旧习惯静默失败——让调用方知道要改用文件编辑。
  if (cmd === 'memory') {
    process.stderr.write(coreMemoryMigrationNotice(agentId))
    process.exit(2)
  }

  const { positional, flags } = parseFlags(rest)


  if (cmd === 'delegate' || cmd === 'request-review') {
    const ctxTok = readDelegateContextToken()
    if (!ctxTok.ok) fail(ctxTok.error)
    const goal = flags.goal || (cmd === 'delegate' ? positional[0] : '')
    let args: DelegateCliArgs
    if (cmd === 'request-review') {
      const draft = flags.draft || positional[0]
      if (!draft) fail('request-review requires --draft "<完整答复草稿>"')
      args = requestReviewArgs(draft, flags['revision-note'], flags['resume-session-key'])
    } else {
      if (!goal) fail('delegate requires --goal "<text>" (or a positional goal)')
      const agentNorm = normalizeDelegateAgentId(flags['agent-id'] || flags.agentId)
      if (!agentNorm.ok) fail(agentNorm.error)
      const modelNorm = normalizeDelegateModel(flags.model)
      if (!modelNorm.ok) fail(modelNorm.error)
      const effortRaw = flags.effort
      const effort =
        effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high' ? effortRaw : undefined
      const toolsets = flags.toolsets
        ? flags.toolsets.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined
      args = {
        agentId: agentNorm.agentId || 'main',
        goal,
        context: flags.context,
        effort,
        model: modelNorm.model,
        toolsets,
        resumeSessionKey: flags['resume-session-key'],
      }
    }
    const base = gatewayBaseUrl()
    const headers = gatewayDelegateHeaders()
    headers[DELEGATE_CONTEXT_HEADER] = ctxTok.token
    const pollWaitMs = resolveDelegateWaitPollMs()
    const result = await runDelegateStartAndWait({
      args,
      contextToken: ctxTok.token,
      pollWaitMs,
      hardTimeoutMs: resolveDelegateWaitHardMs(),
      start: (agentId, body) =>
        postJsonToGateway(`${base}/api/agents/${encodeURIComponent(agentId)}/delegate`, {
          headers,
          body,
          timeoutMs: 15_000,
        }),
      waitOnce: (jobId, waitMs) =>
        postJsonToGateway(`${base}/api/delegate/wait`, {
          headers,
          body: JSON.stringify({ jobId, waitMs }),
          timeoutMs: waitMs + 15_000,
        }),
    })
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.stdout) process.stdout.write(result.stdout)
    process.exit(result.exitCode)
  }

  // Cursor MCP 60s 上限的委派长等待:走网关 /api/delegate/wait 长轮询,不碰记忆后端。
  if (cmd === 'delegate-wait') {
    if (positional.length === 0) fail('delegate-wait requires at least one <jobId> positional argument')
    const base = gatewayBaseUrl()
    const headers = gatewayDelegateHeaders()
    const result = await runDelegateWaitLoop({
      jobIds: positional,
      pollWaitMs: resolveDelegateWaitPollMs(),
      hardTimeoutMs: resolveDelegateWaitHardMs(),
      waitOnce: (jobId, waitMs) =>
        postJsonToGateway(`${base}/api/delegate/wait`, {
          headers,
          body: JSON.stringify({ jobId, waitMs }),
          timeoutMs: waitMs + 15_000,
        }),
    })
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.stdout) process.stdout.write(result.stdout)
    process.exit(result.exitCode)
  }
  if (cmd === 'core-search') {
    const query = positional[0]
    if (!query) fail('core-search requires a "<query>" positional argument')
    emit(await handleCoreSearch({
      agentId,
      query,
      limit: parseLimit(flags.limit),
      offset: parseOffset(flags.offset),
    }))
  }

  const ctx = await createMemoryToolsContext(agentId)

  switch (cmd) {
    case 'session-search': {
      const query = positional[0]
      if (!query) fail('session-search requires a "<query>" positional argument')
      const summarize = flags.summarize !== undefined && flags.summarize !== 'false'
      const res = await handleSessionSearch(ctx, {
        query,
        limit: parseLimit(flags.limit),
        agentId: flags['agent-id'],
        summarize,
      })
      emit(res)
      break
    }
    case 'archival-add': {
      const content = positional[0]
      if (!content) fail('archival-add requires a "<text>" positional argument')
      const res = await handleArchivalAdd(ctx, { content, tags: flags.tags })
      await drainPendingEmbeds(ctx)
      emit(res)
      break
    }
    case 'archival-search': {
      const query = positional[0]
      if (!query) fail('archival-search requires a "<query>" positional argument')
      const res = await handleArchivalSearch(ctx, { query, limit: parseLimit(flags.limit) })
      emit(res)
      break
    }
    case 'archival-delete': {
      const id = positional[0]
      if (!id) fail('archival-delete requires an <id> positional argument')
      const res = await handleArchivalDelete(ctx, { id })
      await drainPendingEmbeds(ctx)
      emit(res)
      break
    }
    default:
      fail(`unknown command "${cmd}"\n${USAGE}`)
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
