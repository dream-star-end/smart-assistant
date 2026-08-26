/**
 * Cursor adapter 侧 present_options 收敛器。
 * 与 packages/mcp-memory/src/presentOptions.ts 语义对齐 —— 两份实现分属
 * 不同包与不同信任域,不共享依赖,修改时必须同步。
 */

export type PresentOption = { label: string; desc?: string }
export type PresentOptionsPayload = {
  question?: string
  multi?: true
  options: PresentOption[]
}

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
