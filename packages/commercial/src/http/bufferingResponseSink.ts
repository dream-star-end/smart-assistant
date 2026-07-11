/**
 * BufferingResponseSink —— 把 `containerFileProxy` 的流式输出**缓冲成 Buffer**的输出适配器。
 *
 * **为什么需要它**:缩略图必须先拿到原图完整字节才能 sharp resize,且 spec 要求
 * 「Content-Length 必须正确(缓存后已知)」—— 这排除了流式 Transform(sharp 流式无法预知
 * 输出长度,只能 chunked)。所以缓存 miss 时要把原图**缓冲**下来再缩。
 *
 * **为什么不改 containerFileProxy**:proxy 是容器取字节的**唯一权威**(SSRF 白名单 /
 * capability 探测 / 本地·tunnel 双路由 / per-uid 并发闸),安全攸关。与其在其中开一条
 * capture 分支(4 处 + 所有 error 路径都要顾及),不如把「缓冲」做成一个**正交的输出
 * 适配器**:proxy 代码零改动,仍只有一条取字节路径。本 sink 实现 proxy 用到的
 * `ServerResponse` 子集(它本就把 body 走鸭子类型 `ResWritable` 写出,见 tunnelHttpReader),
 * 把 statusCode / headers / body 收集起来,`completion` Promise 在写完 / 中断时 resolve。
 *
 * **proxy 用到的 res 面**(本类逐一覆盖):
 *   - `on("close")` / `headersSent` / `writableEnded` / `destroy()`(顶层客户端断连检测)
 *   - `writeHead(status, headers)`(本类新增;Writable 无此方法)
 *   - `write` / `end` / `once("drain")` / `removeListener`(pipe / pipeBody* 的 backpressure)
 * write/end/destroy/writableEnded/once/removeListener/on 全部由 `stream.Writable` 原生提供,
 * 手写面只剩 `writeHead` + `headersSent` + 完成语义 —— 面小、可隔离单测。
 *
 * **completion 只 resolve、不 reject**:调用方 `await sink.completion` 拿 CapturedResponse,
 * 据 `errored` / `truncated` 判失败。sink 内部**不发 'error' 事件**(proxy 只挂了 'close'
 * 不挂 'error',发了会 unhandled throw)—— 超限/中断都走 `destroy()`(仅 'close')。
 */

import { Writable } from 'node:stream'

export interface CapturedResponse {
  statusCode: number
  /** proxy 写入的响应头(大小写混合:buildClientResponseHead 用 `Content-Type` 等,
   * passthrough 字段小写 `content-length`)。读取方须大小写不敏感。 */
  headers: Record<string, string | string[] | number>
  body: Buffer
  /** 未 end 就被 destroy(客户端断 / upstream error)→ 上层视为失败,不缓存。 */
  errored: boolean
  /** body 超 maxBytes,已停止缓冲并中止 → 上层应透传/降级,绝不缩不完整字节。 */
  truncated: boolean
}

export class BufferingResponseSink extends Writable {
  private chunks: Buffer[] = []
  private total = 0
  private capturedStatus = 200
  private capturedHeaders: Record<string, string | string[] | number> = {}
  private headersWritten = false
  private truncated = false
  private settled = false
  private resolveCompletion!: (r: CapturedResponse) => void
  readonly completion: Promise<CapturedResponse>

  constructor(private readonly maxBytes: number) {
    // highWaterMark 拉高:_write 同步 cb → 内部 buffer 立即排空,write() 恒返 true,
    // backpressure 基本不触发(缩略路径本就要把原图整个入内存)。
    super({ highWaterMark: 1 << 24 })
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve
    })
    // Writable 正常 end→'finish'→'close';destroy(无 error)→'close'(不发 'error')。
    // 用 'close' 作兜底 settle:destroy 路径由此 resolve(errored=true)。
    this.once('close', () => this.settle(true))
  }

  /** ServerResponse 兼容:proxy 在 writeHead 前用它判是否已发头。 */
  get headersSent(): boolean {
    return this.headersWritten
  }

  /** ServerResponse.writeHead 的最小实现:记下 status + headers(首次为准)。 */
  writeHead(statusCode: number, headers?: Record<string, string | string[] | number>): this {
    if (!this.headersWritten) {
      this.capturedStatus = statusCode
      if (headers) this.capturedHeaders = { ...headers }
      this.headersWritten = true
    }
    return this
  }

  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    if (this.truncated || this.destroyed) {
      cb()
      return
    }
    this.total += chunk.length
    if (this.total > this.maxBytes) {
      // 超限:停止缓冲,cb() 正常返回(不发 error),再 destroy() 中止 → 'close' 兜底
      // settle(truncated=true)。destroy 会经 proxy 的 res.on('close') 反向 destroy upstream。
      this.truncated = true
      cb()
      this.destroy()
      return
    }
    this.chunks.push(Buffer.from(chunk))
    cb()
  }

  private settle(errored: boolean): void {
    if (this.settled) return
    this.settled = true
    this.resolveCompletion({
      statusCode: this.capturedStatus,
      headers: this.capturedHeaders,
      body: Buffer.concat(this.chunks),
      errored: errored || this.truncated,
      truncated: this.truncated,
    })
  }

  /** end() 正常收尾 → 干净 settle(errored=false)。 */
  override _final(cb: (err?: Error | null) => void): void {
    this.settle(false)
    cb()
  }
}
