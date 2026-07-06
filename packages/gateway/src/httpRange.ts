/**
 * httpRange — 容器侧文件下载的 HTTP Range(断点续传)支持。
 *
 * D1 背景:大文件下载慢的主因是跨境带宽(不归本模块管),但容器 gateway 的
 * `/api/file` / `/api/media` 之前**不支持 Range**:带 `Range` 头也返回 200 全量。
 * 跨境抖动下,下到 90% 断线只能从头重下,体验雪上加霜。master 下载代理层
 * (commercial/containerFileProxy)早已转发 `range` 请求头、透传 `accept-ranges`/
 * `content-range` 响应头 —— 缺的只是容器这一端真正产出 206。补齐后浏览器/下载器
 * 就能断点续传,只补丢失的字节区间。
 *
 * 设计:
 *   - `parseByteRange` 是**纯函数**(header + size → 区间 | null),单测锁死边界。
 *   - 只支持单段 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`;多段(逗号)、
 *     非 bytes 单位、语法非法、越界/不可满足 → null。
 *   - null(含越界)时调用方退回 200 全量并补 `Accept-Ranges: bytes` 头,让客户端
 *     知道该资源可续传(下次请求可带 Range)。这是比 416 更宽容的选择:即便本次
 *     Range 不可满足,用户仍能拿到完整文件。
 *   - If-Range **不实现**:缺 validator(ETag/Last-Modified 语义)时,浏览器发现无
 *     法校验会自动回退整段下载,不会拿到错拼接的文件,所以省掉这层复杂度是安全的。
 */
import { createReadStream } from 'node:fs'
import type { ServerResponse } from 'node:http'

export interface ByteRange {
  /** 起始字节(含),0-based。 */
  start: number
  /** 结束字节(含),0-based,已按 size 收敛到 <= size-1。 */
  end: number
}

/**
 * 解析单段 HTTP `Range` 请求头。
 *
 * @param header 原始 `Range` 头值(如 `bytes=0-499`);undefined/null/空 → null。
 * @param size   文件总字节数(fstat().size)。
 * @returns 合法且可满足的单段区间 {start,end}(闭区间,end 已收敛),否则 null。
 *
 * 支持的三种形式(RFC 7233 单段):
 *   - `bytes=start-end`   显式区间;end 超过文件末尾则收敛到 size-1。
 *   - `bytes=start-`      从 start 到文件末尾。
 *   - `bytes=-suffix`     文件末尾 suffix 个字节;suffix >= size 时收敛为整段。
 *
 * 一律返回 null(→ 调用方 200 全量)的情况:
 *   - 非 `bytes=` 单位;多段(含逗号);缺 `-`;start/end 非纯数字或为负。
 *   - `bytes=-`(start、end 都缺);`bytes=-0`(suffix 为 0,不可满足)。
 *   - start >= size(越界不可满足);start > end(区间倒置)。
 *   - size <= 0(空文件,任何 Range 都不可满足)。
 */
export function parseByteRange(
  header: string | undefined | null,
  size: number,
): ByteRange | null {
  if (typeof header !== 'string') return null
  if (!Number.isFinite(size) || size <= 0) return null

  const trimmed = header.trim()
  const eq = trimmed.indexOf('=')
  if (eq < 0) return null
  // 单位必须恰为 bytes(大小写不敏感);其它单位(如自定义)不支持。
  if (trimmed.slice(0, eq).trim().toLowerCase() !== 'bytes') return null

  const spec = trimmed.slice(eq + 1).trim()
  // 多段(逗号分隔)不支持 —— 直接退回全量,避免 multipart/byteranges 复杂度。
  if (spec.includes(',')) return null

  const dash = spec.indexOf('-')
  if (dash < 0) return null
  const startRaw = spec.slice(0, dash).trim()
  const endRaw = spec.slice(dash + 1).trim()

  // 纯数字(非负整数)校验:允许空串(表示该侧缺省),但非空时必须全为数字。
  const DIGITS = /^[0-9]+$/
  const hasStart = startRaw.length > 0
  const hasEnd = endRaw.length > 0
  if (hasStart && !DIGITS.test(startRaw)) return null
  if (hasEnd && !DIGITS.test(endRaw)) return null

  if (!hasStart) {
    // suffix 形式:bytes=-N → 末尾 N 字节。
    if (!hasEnd) return null // `bytes=-` 两侧全缺
    const suffix = Number(endRaw)
    if (suffix <= 0) return null // `bytes=-0` 不可满足
    const start = suffix >= size ? 0 : size - suffix
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  if (start >= size) return null // 越界不可满足 → 调用方退 200 全量

  if (!hasEnd) {
    // bytes=start- → 到文件末尾
    return { start, end: size - 1 }
  }

  let end = Number(endRaw)
  if (end < start) return null // 区间倒置非法
  if (end >= size) end = size - 1 // end 超尾则收敛
  return { start, end }
}

/**
 * 用已打开的 fd 把文件写回 res,自动处理 Range → 206 / 无 Range → 200 全量。
 *
 * 收口 `/api/file` 与 `/api/media` 两个同构下载出口(DRY + fd 生命周期只一处),
 * 避免两边各写一份 206 逻辑漂移。
 *
 * fd 所有权:createReadStream(..., { fd, autoClose: true }) 接管 fd,流结束/出错时
 * 由流负责 close —— 与改造前 `createReadStream(fd,{autoClose:true})` 语义一致,不
 * 引入 fd 泄漏。带 {start,end} 时 Node 用 pread 从 start 读到 end(含),单流独占该
 * fd,无并发读位竞争。
 *
 * @param baseHeaders 调用方已算好的 Content-Type / Content-Disposition / Cache-Control
 *                    等**不含 Content-Length** 的头;本函数按 200/206 追加
 *                    Content-Length、Accept-Ranges,206 再加 Content-Range。
 * @param opts.rangeHeader 请求的 Range 头(GET 才解析)。
 * @param opts.isHead HEAD 请求:206 语义只对 GET,HEAD 维持全量头行为(现状)。
 */
export function serveFileFdWithRange(
  res: ServerResponse,
  fd: number,
  size: number,
  baseHeaders: Record<string, string | number>,
  opts: { rangeHeader?: string | null; isHead?: boolean } = {},
): void {
  const range = opts.isHead ? null : parseByteRange(opts.rangeHeader, size)
  if (range) {
    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...baseHeaders,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': length,
    })
    createReadStream(null as unknown as string, {
      fd,
      start: range.start,
      end: range.end,
      autoClose: true,
    }).pipe(res)
    return
  }
  // 无 / 非法 / 越界 Range → 200 全量,但仍宣告 Accept-Ranges 让客户端知道可续传。
  res.writeHead(200, {
    ...baseHeaders,
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
  })
  createReadStream(null as unknown as string, { fd, autoClose: true }).pipe(res)
}
