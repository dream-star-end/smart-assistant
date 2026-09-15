/**
 * 工具消息的**单一权威状态**(纯函数,无 React)。
 *
 * 此前 ToolCard.tsx(四态 + 受阻 + 取消 + 三条 Bash 启发式)与 InspectorPanel.tsx(只看
 * `tool.error`)各算一遍:同一条消息卡片标「受阻/未成功」、面板却标「完成/已结束」(tools
 * 审计 T-05)。这里收成一处,卡片与面板都只消费 {@link resolveToolStatus} 的结果。
 *
 * 状态语义(F1 口径):
 *   - running   运行中(spinner)
 *   - error     未成功 —— 单次工具异常属于助手内部执行过程,用淡危险色如实标记,不用「失败」恐吓
 *   - blocked   受阻(网页反爬等外因)
 *   - cancelled 已取消(用户/系统中止,中性终态)
 *   - done      完成
 */
import type { ToolLike } from './format'
import { isRecord, parseShellEnvelope, shellOutputReportsNonzeroExit } from './shellEnvelope'

export type ToolStatusKind = 'running' | 'error' | 'blocked' | 'cancelled' | 'done'
export type ToolStatusTone = 'accent' | 'danger' | 'warning' | 'neutral' | 'success'

export type ToolStatus = {
  kind: ToolStatusKind
  /** 用户可见徽标文案:运行中 / 未成功 / 受阻 / 已取消 / 完成。 */
  label: string
  tone: ToolStatusTone
  completed: boolean
  hasError: boolean
  isBlocked: boolean
  isRunning: boolean
  isCancelled: boolean
  /** 输出里带 confirmation_required(oc-connect / oc-plugin 写操作待确认)。 */
  isConfirmation: boolean
  /** 字符串化的 output(非字符串 → "")。 */
  outputText: string
  /** 表头用的错误摘要(已解 JSON 信封、剥 markdown 标头,≤120 字);非错误态 → ""。 */
  errorFirstLine: string
}

const STATUS_LABEL: Record<ToolStatusKind, string> = {
  running: '运行中',
  error: '未成功',
  blocked: '受阻',
  cancelled: '已取消',
  done: '完成',
}

const STATUS_TONE: Record<ToolStatusKind, ToolStatusTone> = {
  running: 'accent',
  error: 'danger',
  blocked: 'warning',
  cancelled: 'neutral',
  done: 'success',
}

const ERROR_LINE_MAX = 120

/** 首个有信息量的行:优先跳过 `### Error` 这类 markdown 标头(标头下一行才是原因),全是标头才退回标头文字。 */
function firstMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const body = lines.find((l) => !/^#{1,6}\s/.test(l))
  const pick = body ?? lines[0] ?? ''
  return pick
    .replace(/^#{1,6}\s*/, '')
    .replace(/^error:\s*/i, '')
    .trim()
}

function clampLine(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > ERROR_LINE_MAX ? `${one.slice(0, ERROR_LINE_MAX)}…` : one
}

/** 常见 JSON 错误信封里取一句人话:{error:"…"} / {error:{message}} / {message}。 */
function structuredErrorMessage(obj: Record<string, unknown>): string {
  const err = obj.error
  if (typeof err === 'string' && err.trim()) return err
  if (isRecord(err) && typeof err.message === 'string' && err.message.trim()) return err.message
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message
  if (typeof obj.reason === 'string' && obj.reason.trim()) return obj.reason
  return ''
}

/**
 * 表头错误摘要(tools 审计 T-02):
 *   1. 带 confirmation_required(人机确认触发)→ 固定文案「待确认」,不露内部 JSON;
 *   2. Cursor shell 信封 / 裸 shell 结果 → stderr 首行,没有 stderr 则「退出码 N」;
 *   3. 其它 JSON 对象 → error / error.message / message / reason;认不出 → ""(宁可空,不露 JSON);
 *   4. 普通文本 → 首个非空行(剥 markdown # 前缀与 `error:` 前缀);
 *   统一夹到 120 字。
 */
export function errorSummaryLine(outputText: string): string {
  const trimmed = outputText.trim()
  if (!trimmed) return ''
  if (trimmed.includes('"confirmation_required"')) return '待确认'
  if (trimmed.startsWith('{')) {
    const env = parseShellEnvelope(trimmed)
    if (env) {
      const line = firstMeaningfulLine(env.stderr) || firstMeaningfulLine(env.stdout)
      if (line) return clampLine(line)
      return env.exitCode !== null && env.exitCode !== 0 ? `退出码 ${env.exitCode}` : ''
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isRecord(parsed)) {
        const msg = structuredErrorMessage(parsed)
        return msg ? clampLine(firstMeaningfulLine(msg) || msg) : ''
      }
    } catch {
      /* 半截 JSON:同样不把原始 `{"success":{…` 摆到表头 */
    }
    return ''
  }
  return clampLine(firstMeaningfulLine(trimmed))
}

/** 卡片与面板共用的状态求值。`name` 是归一化后的展示名(Bash 启发式只对终端卡生效)。 */
export function resolveToolStatus(display: { name: string; tool: ToolLike }): ToolStatus {
  const { name, tool } = display
  const completed = !!tool._completed
  const outputText = typeof tool.output === 'string' ? tool.output : ''
  // 部分 CLI 会以 exit 0 返回语义失败(Playwright 的 markdown Error、网页反爬阻断)。
  // 这些明确形状应进入用户可见状态,而不是显示绿色完成。
  // 新会话由 gateway 的 exitCode→isError 负责;历史 tape 只认信封里的非 0 exitCode。
  // 不把 `oc-*: ` 行首前缀当错误:多个 CLI 成功路径也会往 stderr 打这个前缀。
  const isBlocked = name === 'Bash' && /(?:^|\n)oc-web:\s*blocked:/i.test(outputText)
  const reportedError =
    name === 'Bash' &&
    !isBlocked &&
    (/^#{1,6}\s*Error\b/m.test(outputText) || shellOutputReportsNonzeroExit(outputText))
  const hasError = !!tool.error || reportedError
  // 历史 tape 是不可变真记录:turn 已中断时,未完成 tool 代表被取消,而不是仍在运行。
  const isInterruptedHistorical =
    !completed && tool._timelineRecord === true && tool._dispatchOutcome === 'interrupted'
  // 取消(如 Codex item status 'cancelled')是中性终态:≠ 失败(不红)、≠ 运行中(不转圈)。
  const isCancelled = !hasError && (!!tool.cancelled || isInterruptedHistorical)
  const isRunning = !completed && !hasError && !isBlocked && !isCancelled
  const kind: ToolStatusKind = isRunning
    ? 'running'
    : hasError
      ? 'error'
      : isBlocked
        ? 'blocked'
        : isCancelled
          ? 'cancelled'
          : 'done'
  return {
    kind,
    label: STATUS_LABEL[kind],
    tone: STATUS_TONE[kind],
    completed,
    hasError,
    isBlocked,
    isRunning,
    isCancelled,
    isConfirmation: outputText.includes('"confirmation_required"'),
    outputText,
    errorFirstLine: hasError ? errorSummaryLine(outputText) : '',
  }
}
