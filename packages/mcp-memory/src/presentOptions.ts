/**
 * Cursor 引擎 detached 选项卡投递。
 * 只校验并立刻返回,不 POST 网关、不等待用户。卡面由 gateway cursorAdapter
 * 把合法参数注入 ```options 围栏;点选仍是下一条普通用户消息。
 *
 * normalize / format 与 packages/gateway/src/engine/presentOptions.ts
 * 语义对齐 —— 两份实现分属不同包,不共享依赖,修改时必须同步。
 */

export type PresentOption = { label: string; desc?: string }
export type PresentOptionsPayload = {
  question?: string
  multi?: true
  options: PresentOption[]
}

export type PresentOptionsHandleResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

const MAX_QUESTION = 2000
const MAX_LABEL = 300
const MAX_DESC = 1000
const MIN_OPTIONS = 1
const MAX_OPTIONS = 12

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function coercePresentOptionsRaw(raw: unknown): unknown {
  const rec = asRecord(raw)
  if (!rec) return raw
  if (Array.isArray(rec.options)) return raw
  if (Array.isArray(rec.questions) && rec.questions.length === 1) {
    const item = asRecord(rec.questions[0])
    if (!item) return raw
    return {
      question: item.question ?? rec.question,
      multi: item.multi === true || item.multiSelect === true ? true : undefined,
      options: item.options,
    }
  }
  return raw
}

export function normalizePresentOptions(raw: unknown): PresentOptionsPayload | null {
  const rec = asRecord(coercePresentOptionsRaw(raw))
  if (!rec) return null
  const optionsRaw = rec.options
  if (!Array.isArray(optionsRaw) || optionsRaw.length < MIN_OPTIONS || optionsRaw.length > MAX_OPTIONS) {
    return null
  }
  const options: PresentOption[] = []
  for (const item of optionsRaw) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (!label || label.length > MAX_LABEL) return null
      options.push({ label })
      continue
    }
    const opt = asRecord(item)
    if (!opt) return null
    if (typeof opt.label !== 'string') return null
    const label = opt.label.trim()
    if (!label || label.length > MAX_LABEL) return null
    const descRaw =
      typeof opt.desc === 'string'
        ? opt.desc
        : typeof opt.description === 'string'
          ? opt.description
          : undefined
    const desc = descRaw && descRaw.length > 0 && descRaw.length <= MAX_DESC ? descRaw : undefined
    options.push(desc ? { label, desc } : { label })
  }
  if (rec.question !== undefined && rec.question !== null && typeof rec.question !== 'string') {
    return null
  }
  const question =
    typeof rec.question === 'string' && rec.question.trim().length > 0 ? rec.question.trim() : undefined
  if (question && question.length > MAX_QUESTION) return null
  const multi = rec.multi === true || rec.multiSelect === true
  return {
    ...(question ? { question } : {}),
    ...(multi ? { multi: true as const } : {}),
    options,
  }
}

export function formatPresentOptionsFence(raw: unknown): string | null {
  const payload = normalizePresentOptions(raw)
  if (!payload) return null
  const json: Record<string, unknown> = {}
  if (payload.question) json.question = payload.question
  if (payload.multi) json.multi = true
  json.options = payload.options
  return '```options\n' + JSON.stringify(json) + '\n```'
}

export function shouldListPresentOptions(engineId: string, delegationDepth: number): boolean {
  return engineId === 'cursor' && delegationDepth <= 0
}

export function createPresentOptionsCallBudget(limit = 4): () => boolean {
  const maxCalls = Math.max(0, Math.floor(limit))
  let used = 0
  return () => {
    if (used >= maxCalls) return false
    used += 1
    return true
  }
}

export function handlePresentOptions(
  args: unknown,
  ctx: { engineId: string; delegationDepth: number },
): PresentOptionsHandleResult {
  if (ctx.delegationDepth > 0) {
    return {
      ok: true,
      message: JSON.stringify({
        status: 'skipped',
        reason:
          'subagent has no interactive user — decide yourself, or list numbered options in your final report',
      }),
    }
  }
  if (ctx.engineId !== 'cursor') {
    return {
      ok: false,
      message: 'present_options is only available on the Cursor engine; use the engine-native question tool',
    }
  }
  if (!normalizePresentOptions(args)) {
    return {
      ok: false,
      message: 'present_options 参数无效:需要 {question?, multi?, options:[{label, desc?}]}，options 1-12 项',
    }
  }
  return {
    ok: true,
    message:
      '选项卡已投递。立刻结束本回合，不要再写 ```options 围栏，不要轮询。用户点选会作为下一条普通消息到达。',
  }
}
