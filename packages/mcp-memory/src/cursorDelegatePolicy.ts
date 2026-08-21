/** Cursor hides sync MCP delegate tools; the blocking path is `oc-memory delegate`. */

export const CURSOR_HIDDEN_DELEGATE_TOOLS = [
  'delegate_task',
  'delegate_tasks',
  'request_review',
] as const

export type CursorHiddenDelegateTool = (typeof CURSOR_HIDDEN_DELEGATE_TOOLS)[number]

const HIDDEN = new Set<string>(CURSOR_HIDDEN_DELEGATE_TOOLS)

export function isCursorEngine(engine: string | undefined = process.env.OPENCLAUDE_ENGINE): boolean {
  return (engine || '').trim().toLowerCase() === 'cursor'
}

export function isCursorHiddenDelegateTool(
  name: string,
  engine: string | undefined = process.env.OPENCLAUDE_ENGINE,
): boolean {
  return isCursorEngine(engine) && HIDDEN.has(name)
}

export function cursorDelegateCliHint(name = 'delegate_task'): string {
  if (name === 'request_review') {
    return [
      'Cursor MCP 已不再提供 request_review（60 秒硬超时，模型经常不等就交卷）。',
      '请立刻用 Bash 阻塞送审，不要再调 MCP：',
      '  oc-memory request-review --draft "<完整答复草稿>"',
    ].join('\n')
  }
  if (name === 'delegate_tasks') {
    return [
      'Cursor MCP 已不再提供 delegate_tasks。',
      '请在同一回合并行发起多条 Bash（每条阻塞到结束）：',
      '  oc-memory delegate --goal "<子任务>" [--agent-id <成员>] [--model <型号>]',
    ].join('\n')
  }
  return [
    'Cursor MCP 已不再提供 delegate_task（tools/call 60 秒硬超时，不能在 MCP 里等子任务）。',
    '请立刻用 Bash 阻塞委派，不要再调 MCP，也不要先交卷：',
    '  oc-memory delegate --goal "<任务>" [--agent-id <成员>] [--model <型号>] [--context "<上下文>"]',
    '该命令会开工并等到子任务完成（或平台硬上限），把结果打印到 stdout。',
  ].join('\n')
}
