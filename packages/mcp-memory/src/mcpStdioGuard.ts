/**
 * MCP stdio 传输护栏 —— 2026-07-07「半天没响应」事故的根因防护。
 *
 * codex 的 rmcp 客户端对本 server 的 **stdout 只接受 JSON-RPC**:任何非 JSON-RPC 字节
 * (本进程或**任一依赖**的 `console.log`/启动打印)都会让它反序列化失败并
 * **fatal 丢弃整条传输**;进程一旦因未捕获异常/rejection 退出,stdout 关闭同样杀死传输。
 * 传输死后,codex 对本 server 的所有工具调用(memory/delegate/cron/skill…)会一直挂起,
 * 直到被 15min turn idle-timeout 掐死 → 用户观感「半天没响应」。
 *
 * 本模块必须是 server 入口的**第一个 import**(ESM 按序执行 import 副作用),在其它 import
 * 的加载期副作用之前就位:
 *   1. `console.*` 全部改写到 stderr —— stdout 永远只留给 StdioServerTransport 的 JSON-RPC,
 *      任何依赖偷偷 console.log 也污染不了协议流。
 *   2. `unhandledRejection` / `uncaughtException` 记 stderr 并**不退出** —— 工具处理里漏网的
 *      异步错误只失败当次调用,不再拖垮整条传输。对**请求/响应式**工具 server,存活远好于
 *      崩溃(后者会让 codex 死等);单次调用的坏状态由 MCP SDK 逐请求隔离。
 */
import { format } from 'node:util'

const writeErr = (line: string): void => {
  try {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`)
  } catch {
    /* best-effort:stderr 不可写时静默,绝不回落 stdout */
  }
}

for (const level of ['log', 'info', 'debug', 'trace', 'dir', 'warn', 'error'] as const) {
  ;(console as unknown as Record<string, (...a: unknown[]) => void>)[level] = (...args) =>
    writeErr(format(...args))
}

process.on('unhandledRejection', (reason) => {
  writeErr(`[mcp-guard] unhandledRejection (kept alive): ${format(reason)}`)
})
process.on('uncaughtException', (err) => {
  writeErr(`[mcp-guard] uncaughtException (kept alive): ${format(err)}`)
})
