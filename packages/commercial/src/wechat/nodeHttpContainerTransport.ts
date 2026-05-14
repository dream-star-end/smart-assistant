/**
 * v3 commercial WeChat broker — self-host ContainerTransport 实装。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.2 + inboundDispatcher.ts:165 (ContainerTransport interface)。
 *
 * **职责**:把 dispatcher 的 transport 抽象坐实为 `node:http.request` 调用。
 *
 *   - self-host 默认实装:直拨 `${host}:${port}${path}`,走 keep-alive Agent 复连
 *   - **不**支持 remote-host tunnel:`supportsTunnel:false`,dispatcher 看到 endpoint.tunnel 时
 *     会先走 `tunnel_unsupported` 路径,不会调到本 transport(slice 7b 限定 self-host)
 *
 * **SSRF 边界**:`endpoint.host` 必须是 `172.30.0.0/16`(docker bridge gateway 的 CIDR;与
 * `containerFileProxy.isBoundIpAllowed` 同源)— 这是生产里 broker 仅允许打的网段。`isHostAllowed`
 * 是注入点便于本地 127.0.0.1 测试,但默认实装关死,production 走 strict check。
 *
 * **timeout 模型**:dispatcher 传入的 `timeoutMs` 是 **绝对 deadline**(wall-clock),不是 socket
 * 空闲 timeout。connect / TLS handshake / 服务端 read body / response 流式 drip 全程一把 ruler
 * 量。实装 `setTimeout(timeoutMs)` 在 promise 起步即启,settle 时清掉;`req.setTimeout` 是 socket
 * idle timeout 在 slowloris (服务端每 timeoutMs-1 ms 滴 1 byte 但不超 64 KB cap)下会被 reset
 * 而永不触发 — 那条单测在 slowDripDoesNotResetAbsoluteDeadline 里兜底。
 *
 * **body 上限**:64 KB(retry-after / 错误体小 JSON 而已;远超 64 KB 是容器侧异常或被注入)。
 * 实装是"达到 cap 后停止累积 + destroy req",绝不允许 Buffer 越界。dispatcher 上层只 slice 256
 * chars,truncate 不丢精度。
 */

import { Agent, request as defaultHttpRequest } from "node:http"
import type { IncomingMessage } from "node:http"
import { isIPv4 } from "node:net"

import { rootLogger, type Logger } from "../logging/logger.js"
import type { ContainerTransport } from "./inboundDispatcher.js"

/** Response body 截断上限。dispatcher 上层只取 256 chars,绝不可能用满。 */
const RESPONSE_BODY_CAP_BYTES = 64 * 1024

/** Default keep-alive `keepAliveMsecs` — 与 outbound http 模块一致(60s 心跳保活)。 */
const DEFAULT_KEEP_ALIVE_MSECS = 60_000

/**
 * 默认 SSRF 白名单:`172.30.0.0/16`。
 *
 * 与 `packages/commercial/src/http/containerFileProxy.ts:isBoundIpAllowed` 同源 — broker 仅允许
 * 打 docker bridge 段的容器 endpoint。`endpoint.host` 缺失 / 非 IPv4 / 网段不对均直接拒。
 *
 * **不放开**: 不接受 hostname(DNS resolve) — 防止 host 配置漂移时 broker 打到错误目标;
 * dispatcher 上游(resolveContainerEndpoint)已保证 host = 容器 bound_ip 字符串,合同里就是 IP。
 */
export function defaultIsHostAllowed(host: string): boolean {
  if (!isIPv4(host)) return false
  const p = host.split(".").map(Number)
  return p[0] === 172 && p[1] === 30
}

/** node:http.request 的最小 typing(默认 `import {request}` 即可,测试可注入 mock)。 */
export type HttpRequestImpl = typeof defaultHttpRequest

export interface MakeNodeHttpContainerTransportOptions {
  /**
   * SSRF 白名单注入点。**production 不传**(默认 `defaultIsHostAllowed` = 172.30/16);
   * 测试本地 `127.0.0.1` 时注入 `() => true` 即可。
   *
   * 实现层故意把这个做成注入点而不是 env / config — broker prod 路径没有任何理由放开 strict
   * check,只有单测 createServer 才需要绕,attack surface 不存在。
   */
  isHostAllowed?: (host: string) => boolean
  /**
   * node:http.request 注入点(同上理由,production 不传)。
   *
   * 用于 fake clock / 死链测试,默认走 `node:http` 真实 module。
   */
  httpRequestImpl?: HttpRequestImpl
  /** keep-alive Agent `keepAliveMsecs`。默认 60s。 */
  keepAliveMsecs?: number
  /** 单 host 最大并发连接(per-Agent maxSockets)。默认 16 — broker 单 master 不应打爆。 */
  maxSockets?: number
  logger?: Logger
}

/** body cap exceeded 的统一错误信息(测试可断言)。 */
export const TRANSPORT_BODY_CAP_ERROR = "response body exceeded cap"
/** SSRF reject 的统一错误信息。 */
export const TRANSPORT_HOST_BLOCKED_ERROR = "container host blocked by SSRF policy"
/** timeout reject 的统一错误信息。 */
export const TRANSPORT_TIMEOUT_ERROR = "container transport timeout"

/**
 * 构造 self-host ContainerTransport。一次实例,broker 全生命周期复用。
 */
export function makeNodeHttpContainerTransport(
  opts: MakeNodeHttpContainerTransportOptions = {},
): ContainerTransport {
  const log = (opts.logger ?? rootLogger).child({ subsys: "wechatContainerTransport" })
  const isHostAllowed = opts.isHostAllowed ?? defaultIsHostAllowed
  const httpRequestImpl = opts.httpRequestImpl ?? defaultHttpRequest
  const keepAliveMsecs = opts.keepAliveMsecs ?? DEFAULT_KEEP_ALIVE_MSECS
  const maxSockets = opts.maxSockets ?? 16

  // node:http.Agent 的 keep-alive 池由 transport 实例持有,master 进程生命周期复用。
  const agent = new Agent({ keepAlive: true, keepAliveMsecs, maxSockets })

  return {
    supportsTunnel: false,
    async post(
      endpoint: { host: string; port: number; tunnel?: unknown },
      path: string,
      headers: Record<string, string>,
      bodyJson: string,
      timeoutMs: number,
    ): Promise<{ status: number; bodyText: string; headers?: Record<string, string> }> {
      if (endpoint.tunnel !== undefined) {
        // dispatcher 上游已经在 `endpoint.tunnel !== undefined && !supportsTunnel` 时返回了
        // tunnel_unsupported outcome,本 transport 不会被调到 — 留一道防线避免误用。
        throw new Error("nodeHttpContainerTransport does not support tunnel endpoints")
      }
      if (!isHostAllowed(endpoint.host)) {
        log.warn("ssrf_blocked", { host: endpoint.host, port: endpoint.port, path })
        throw new Error(TRANSPORT_HOST_BLOCKED_ERROR)
      }

      const bodyBuf = Buffer.from(bodyJson, "utf-8")
      const reqHeaders: Record<string, string> = {
        ...headers,
        "content-length": String(bodyBuf.length),
      }

      return new Promise((resolve, reject) => {
        let settled = false
        // 绝对 deadline timer:与 socket idle 无关,timeoutMs 后必然解锁 promise(不论
        // server 是否 drip 数据)。settle 清掉。slowloris 防护见 file header §timeout 模型。
        let absoluteTimer: ReturnType<typeof setTimeout> | null = null
        const settle = (
          fn: () => void,
          reqRef: ReturnType<typeof httpRequestImpl> | null,
        ): void => {
          if (settled) return
          settled = true
          if (absoluteTimer !== null) {
            clearTimeout(absoluteTimer)
            absoluteTimer = null
          }
          if (reqRef && !reqRef.destroyed) reqRef.destroy()
          fn()
        }

        const req = httpRequestImpl(
          {
            host: endpoint.host,
            port: endpoint.port,
            method: "POST",
            path,
            headers: reqHeaders,
            agent,
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = []
            let total = 0
            let truncated = false
            res.on("data", (chunk: Buffer) => {
              if (truncated) return
              if (total + chunk.length > RESPONSE_BODY_CAP_BYTES) {
                // 截断但不 throw — 拷贝至 cap 边界,后续 chunk 直接丢
                const remain = RESPONSE_BODY_CAP_BYTES - total
                if (remain > 0) {
                  chunks.push(chunk.subarray(0, remain))
                  total = RESPONSE_BODY_CAP_BYTES
                }
                truncated = true
                log.warn("body_truncated", {
                  host: endpoint.host,
                  port: endpoint.port,
                  path,
                  capBytes: RESPONSE_BODY_CAP_BYTES,
                })
                // 主动 destroy:阻止服务端继续传剩余 body + 让 socket 归 keep-alive 池
                res.destroy()
                return
              }
              chunks.push(chunk)
              total += chunk.length
            })
            res.on("end", () => {
              // headers 统一 lower-case 化(node:http 已经是 lower-case,但显式 toString 兼容
              // 异构 transport 后续接入;避免 dispatcher.parseRetryAfterSec 大小写脆弱)
              const lowerHeaders: Record<string, string> = {}
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === "string") lowerHeaders[k.toLowerCase()] = v
                else if (Array.isArray(v) && v.length > 0)
                  lowerHeaders[k.toLowerCase()] = v[0] as string
              }
              const bodyText = Buffer.concat(chunks).toString("utf-8")
              settle(
                () => resolve({ status: res.statusCode ?? 0, bodyText, headers: lowerHeaders }),
                null, // res.destroy already called if truncated
              )
            })
            res.on("error", (err: Error) => {
              settle(() => reject(new Error(`response error: ${err.message}`)), req)
            })
            // res.destroy() 触发的 close — truncated 时已经 resolve 过,settled 拦截二次回调
            res.on("close", () => {
              if (settled) return
              // 'end' 没触发就 close,服务端中途断 → 当 transport error 报上去
              settle(() => reject(new Error("response closed before end")), req)
            })
          },
        )

        // ★ 绝对 deadline:不依赖 socket activity。req.setTimeout 是 idle timeout,server 慢
        // drip 时会被 reset 而永不触发(Codex 7b r1 must-fix)。本计时器在 promise 起步即启,
        // settle 任何路径(成功 / 错误 / cap truncate)都会 clear。
        absoluteTimer = setTimeout(() => {
          settle(() => reject(new Error(TRANSPORT_TIMEOUT_ERROR)), req)
        }, timeoutMs)

        req.on("error", (err: Error) => {
          // 'error' 在 timeout 触发 req.destroy 之后也会冒;settled 拦截
          settle(() => reject(new Error(`request error: ${err.message}`)), null)
        })

        req.write(bodyBuf)
        req.end()
      })
    },
  }
}
