/**
 * oc-memory — 容器内长期记忆 CLI(Core / Recall / Archival 三层记忆的一次性入口)。
 *
 * 取代常驻 `openclaude_memory` MCP 里的 memory / session_search / archival_add /
 * archival_search / archival_delete 五个工具。常驻 stdio 传输脆弱(被 console 污染 /
 * 崩溃即整条传输死掉、codex 死等 turn 被掐);一次性进程 —— stdout 是结果文本,无
 * 协议可污染,进程退出即结束。delegate / cron / skill 工具仍留在 MCP server。
 *
 * 用法(memory-management baseline skill 文档化):
 *   oc-memory memory --action <add|replace|remove|read> --target <memory|user> [--content "..."] [--needle "..."]
 *   oc-memory session-search "<query>" [--limit N] [--agent-id ID] [--summarize]
 *   oc-memory archival-add "<text>" [--tags a,b,c]
 *   oc-memory archival-search "<query>" [--limit N]
 *   oc-memory archival-delete <id>
 *
 * 参数字段严格对齐旧 MCP 工具 inputSchema(content / needle / query / tags / id /
 * limit / agentId / summarize)。输出:handler 返回的 content[0].text 写 stdout;
 * handler 报错(isError)或参数错误 → stderr + exit 1。
 *
 * env:agent 身份 CCB 路径取 ambient OPENCLAUDE_AGENT_ID(与旧 MCP 同源);codex 路径
 * 该 env 被 buildCodexEnv scrub,改取非 scrub 的 OC_AGENT_ID(codexAppServerRunner spawn
 * 时按本 agent 显式注入)。两者皆缺才回落 'main'(与旧 MCP `?? 'main'` 一致)。记忆文件位置
 * 由 OPENCLAUDE_HOME 决定(容器内 = /home/agent/.openclaude;未设时 paths.ts 回落
 * homedir()/.openclaude,容器内两者同路径)。
 */
import {
  createMemoryToolsContext,
  drainPendingEmbeds,
  handleArchivalAdd,
  handleArchivalDelete,
  handleArchivalSearch,
  handleMemory,
  handleSessionSearch,
  type MemoryToolResult,
} from './memoryTools.js'

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

const USAGE = [
  'usage:',
  '  oc-memory memory --action <add|replace|remove|read> --target <memory|user> [--content "..."] [--needle "..."]',
  '  oc-memory session-search "<query>" [--limit N] [--agent-id ID] [--summarize]',
  '  oc-memory archival-add "<text>" [--tags a,b,c]',
  '  oc-memory archival-search "<query>" [--limit N]',
  '  oc-memory archival-delete <id>',
].join('\n')

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
  const ctx = await createMemoryToolsContext(agentId)

  const { positional, flags } = parseFlags(rest)

  switch (cmd) {
    case 'memory': {
      const action = flags.action
      const target = flags.target
      if (!action || !['add', 'replace', 'remove', 'read'].includes(action)) {
        fail('memory --action must be one of add|replace|remove|read')
      }
      if (target !== 'memory' && target !== 'user') {
        fail('memory --target must be "memory" or "user"')
      }
      const res = await handleMemory(ctx, {
        action,
        target,
        content: flags.content,
        needle: flags.needle,
      })
      emit(res)
      break
    }
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
