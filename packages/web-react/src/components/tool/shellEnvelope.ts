/**
 * Cursor 引擎的 Bash 结果信封解包(纯函数,无 React)。
 *
 * Cursor CLI 把一次 shell 执行的结果包成
 *   `{ success: { command, exitCode, stdout, stderr, workingDirectory?, signal? }, isBackground?: boolean }`
 * 历史 tape 里也存在**裸** shell 结果对象(没有 success 外壳)。此前 ToolCard.tsx(状态判定)与
 * researchCards.tsx(oc-* 卡取流)各自写了一遍识别/解包逻辑,而 BashBody 根本没解包 —— 普通
 * 终端卡在 Cursor 引擎下把整段 JSON 当输出裸渲染(tools 审计 T-03)。这里收成唯一权威:
 *   - `parseShellEnvelope`:识别 + 解包 → {stdout, stderr, exitCode};不是信封 → null;
 *   - `cursorCliStreams`:oc-* 卡沿用的"取流"口径(命令回显/外部内容标记剥离后再解包)。
 *
 * 只有严格信封或 `isShellResultObject` 形状才解包;一个只带 `stdout` 键的普通 JSON 当不透明正文。
 */

export type ShellEnvelope = {
  stdout: string
  stderr: string
  /** 数字退出码;信封里没有 → null。 */
  exitCode: number | null
  /** 是否后台命令(Cursor 信封 isBackground)。 */
  background: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll('_', '').replaceAll(' ', '')
}

/** 严格 Cursor 信封:`{ success: <object>, isBackground?: boolean }`,顶层不得有其它键。 */
export function isCursorShellEnvelope(value: Record<string, unknown>): boolean {
  if (!isRecord(value.success)) return false
  const keys = Object.keys(value)
  if (keys.some((k) => k !== 'success' && k !== 'isBackground')) return false
  if ('isBackground' in value && typeof value.isBackground !== 'boolean') return false
  return true
}

/** 剥掉 Cursor 信封外壳;不是信封原样返回。 */
export function unwrapCursorShellEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  if (!isCursorShellEnvelope(value)) return value
  return value.success as Record<string, unknown>
}

/** 裸 shell 结果对象:{command, exitCode|exit_code, stderr, stdout, …}(键名大小写/下划线容错)。 */
export function isShellResultObject(value: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(value).map(normalizeKey))
  return keys.has('command') && (keys.has('exitcode') || keys.has('stderr') || keys.has('stdout'))
}

/** 按归一化键名取字符串字段(stdout / stderr / command …),非字符串或空白 → ""。 */
export function shellResultString(value: Record<string, unknown>, field: string): string {
  const want = normalizeKey(field)
  for (const key of Object.keys(value)) {
    if (normalizeKey(key) === want) {
      const v = value[key]
      return typeof v === 'string' && v.trim() ? v : ''
    }
  }
  return ''
}

function shellResultExitCode(value: Record<string, unknown>): number | null {
  for (const key of Object.keys(value)) {
    if (normalizeKey(key) === 'exitcode') {
      const v = value[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
  }
  return null
}

/** 解析一个已 JSON.parse 的对象;不是 Cursor 信封 / 裸 shell 结果 → null。 */
export function shellEnvelopeFromObject(parsed: unknown): ShellEnvelope | null {
  if (!isRecord(parsed)) return null
  const enveloped = isCursorShellEnvelope(parsed)
  const inner = enveloped ? (parsed.success as Record<string, unknown>) : parsed
  if (!enveloped && !isShellResultObject(inner)) return null
  return {
    stdout: shellResultString(inner, 'stdout'),
    stderr: shellResultString(inner, 'stderr'),
    exitCode: shellResultExitCode(inner),
    background: enveloped && parsed.isBackground === true,
  }
}

/**
 * 从工具输出文本识别并解包 Cursor shell 信封。非 `{` 开头 / 解析失败 / 不是信封形状 → null,
 * 调用方按普通文本处理。
 */
export function parseShellEnvelope(output: string | null | undefined): ShellEnvelope | null {
  if (typeof output !== 'string') return null
  const trimmed = output.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return shellEnvelopeFromObject(JSON.parse(trimmed) as unknown)
  } catch {
    return null
  }
}

/** 历史 tape 兜底:可解析的 Cursor shell 信封里,只有数字且非 0 的 exitCode 才算错误。 */
export function shellOutputReportsNonzeroExit(output: string): boolean {
  const env = parseShellEnvelope(output)
  return !!env && env.exitCode !== null && env.exitCode !== 0
}

/** 防御:即便工具输出里混入了 `$ command` 回显行,也剥掉首行 —— 卡片内绝不暴露命令本身。 */
export function stripCommandEcho(text: string): string {
  return text.replace(/^\s*\$ .*(?:\r?\n|$)/, '').replace(/^\s+/, '')
}

/** 剥掉 gateway 给外部内容加的 `[外部内容开始 …]` / `[外部内容结束]` 标记。 */
export function stripExternalEnvelope(text: string): string {
  return text
    .replace(/^\[外部内容开始[^\n]*\]\s*/u, '')
    .replace(/\s*\[外部内容结束\]\s*$/u, '')
    .trim()
}

/**
 * oc-* 卡取流口径:从 stdout / Cursor 信封 / 裸 shell JSON 取出可展示的 CLI 流。
 * 不是信封 → 整段清理后的文本作 stdout。
 */
export function cursorCliStreams(raw: string | null): { stdout: string; stderr: string } {
  if (!raw) return { stdout: '', stderr: '' }
  const clean = stripExternalEnvelope(stripCommandEcho(raw)).trim()
  if (!clean) return { stdout: '', stderr: '' }
  const env = parseShellEnvelope(clean)
  if (env) return { stdout: env.stdout, stderr: env.stderr }
  return { stdout: clean, stderr: '' }
}
