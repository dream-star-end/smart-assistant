/**
 * Codex app-server MCP (rmcp) 把 chatgpt_base_url 指到容器 loopback relay 后,
 * 不在 allowlist 的 HTTP MCP/遥测路径会被 master 打回 PATH_NOT_ALLOWED。
 * rmcp worker 退出再重连,stderr 一直刷,若把这些行当成 lastActivityAt,
 * idle timeout 永不触发,taskboard 就会空转撞 50min 租约墙。
 *
 * 本模块按完整行分类,不负责杀进程。abort 仅在 caller 打开 abortEnabled
 * (阶段 / 巡检会话)时成立。
 */

export const CODEX_RELAY_PATH_DENIED_CODE = 'PATH_NOT_ALLOWED'
export const CODEX_RELAY_PATH_DENIED_MESSAGE = 'codex relay path not allowed'
/** 连续拒绝几次后中止当前 turn,避免空转耗租约。 */
export const CODEX_RELAY_PATH_DENIED_ABORT_AFTER = 3

export function isCodexRelayPathDeniedLine(line: string): boolean {
  if (!line) return false
  return (
    line.includes(CODEX_RELAY_PATH_DENIED_CODE) &&
    line.includes(CODEX_RELAY_PATH_DENIED_MESSAGE)
  )
}

export function shouldAbortOnRelayPathDenied(consecutiveDenied: number): boolean {
  return consecutiveDenied >= CODEX_RELAY_PATH_DENIED_ABORT_AFTER
}

export interface RelayDeniedConsumeResult {
  completeLines: string[]
  deniedLines: number
  activityLines: number
  consecutiveDenied: number
  abort: boolean
}

/**
 * 按行缓冲解析 stderr。拆包必须拼成完整行才分类;合包按行分别计数。
 * 普通日志清零连续拒绝计数。abortEnabled=false 时只分类,永不 abort。
 */
export class CodexRelayPathDeniedTracker {
  private buf = ''
  private consecutive = 0

  constructor(private readonly abortEnabled: boolean) {}

  consume(chunk: string): RelayDeniedConsumeResult {
    this.buf += chunk
    const completeLines: string[] = []
    let deniedLines = 0
    let activityLines = 0
    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const raw = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      const line = raw.trim()
      nl = this.buf.indexOf('\n')
      if (!line) continue
      completeLines.push(line)
      if (isCodexRelayPathDeniedLine(line)) {
        deniedLines += 1
        this.consecutive += 1
      } else {
        activityLines += 1
        this.consecutive = 0
      }
    }
    return {
      completeLines,
      deniedLines,
      activityLines,
      consecutiveDenied: this.consecutive,
      abort: this.abortEnabled && shouldAbortOnRelayPathDenied(this.consecutive),
    }
  }

  /** Process leftover bytes without a trailing newline (proc close). */
  flush(): RelayDeniedConsumeResult {
    if (!this.buf) {
      return {
        completeLines: [],
        deniedLines: 0,
        activityLines: 0,
        consecutiveDenied: this.consecutive,
        abort: this.abortEnabled && shouldAbortOnRelayPathDenied(this.consecutive),
      }
    }
    const leftover = this.buf
    this.buf = ''
    return this.consume(`${leftover}\n`)
  }

  reset(): void {
    this.buf = ''
    this.consecutive = 0
  }
}
