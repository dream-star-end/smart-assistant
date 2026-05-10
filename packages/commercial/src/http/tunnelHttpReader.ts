/**
 * v3 file-proxy tunnel —— 从 raw TLS socket(`dialTunnelSocket` 返回)上手解 HTTP/1.x
 * 响应头。dialTunnelSocket 写完 request line + headers 后,我们读到的字节流就是裸
 * HTTP response,Node 没现成的 "feed bytes to a stream parser" API,只能手写一个
 * 极小的状态行 + headers 解析器。
 *
 * **范围**:只解到 `\r\n\r\n` 为止;之后的字节(可能是 body 起点)以 `leftover`
 * Buffer 回传,caller 决定怎么处理(file-proxy 直接 res.write(leftover) + 然后
 * socket.pipe(res);healthz probe 把 leftover 当 body 起点继续 readBodyCapped)。
 *
 * **为什么不复用 node:http 的内部 parser**:那是私有 API,签名跨版本变化,
 * 上线后维护成本高。代码不复杂,自己写更稳。
 *
 * **Hard caps**:
 *   - timeoutMs:整个 head 必须在此时间内读完(read inactivity 也算);超时 → null
 *   - maxHeaderBytes:防 attacker 灌爆 buffer;超 → null
 *
 * 不处理 response continuation。trailer 在 chunked decoder 里 skip,chunk
 * extension(`size;ext=v\r\n`)从 size 行解析时被 split(';')[0] 容忍。
 *
 * **历史**:之前 file-proxy 用 `socket.pipe(res)` 等容器 close 收尾,但 node-agent
 * tunnel 会剥 hop-by-hop header(包括 Connection: close),容器收不到关连接信号
 * → master 永远等不到 EOF。所以 file-proxy 改为按 Content-Length / chunked 边界
 * 主动 destroy socket(下面 pipeBodyByContentLength / pipeBodyChunked)。
 */

import type { Writable } from "node:stream";
import type { Socket } from "node:net";

/**
 * 接受 res 的鸭子类型 —— write/end/destroy/writableEnded + drain 事件订阅,
 * 兼容 node:http ServerResponse 和 stream.Writable / 测试 mock。
 *
 * `write` 返回 false = 内部 buffer 满,caller 应 socket.pause();等 'drain'
 * 事件再 resume。这是 Node stream 的 backpressure 协议,手写 pipe 必须遵守
 * 否则慢客户端会让 socket 继续读、ServerResponse 无限堆 buffer。
 */
export interface ResWritable {
  write(chunk: Buffer): boolean;
  end(): unknown;
  destroy?: (e?: Error) => void | Writable;
  writableEnded?: boolean;
  once?(event: "drain", listener: () => void): unknown;
  removeListener?(event: "drain", listener: () => void): unknown;
}

export interface TunnelResponseHead {
  statusCode: number;
  /** 解析后的 status text(可空);仅用于诊断 */
  statusText: string;
  /**
   * 头字段名小写。同名多值用 `, ` 拼接(Set-Cookie 不该出现在 file-proxy 响应里;
   * 出现也按拼接处理 —— 浏览器侧本就 set-cookie no-store 拒收)。
   */
  headers: Record<string, string>;
  /** 头解析完后还残留在 buffer 里的 body 起点字节(可能为空 Buffer) */
  leftover: Buffer;
}

/**
 * 从 socket 读到 `\r\n\r\n`,解析状态行 + headers。
 *
 * 返回 null 的失败语义:
 *   - 超时(timeoutMs 内未读完 head)
 *   - 超 maxHeaderBytes
 *   - socket 提前关闭/错误
 *   - 状态行格式非法
 *
 * 成功路径:caller 拿到 leftover,后续可继续从 socket 读 body 或直接 pipe。
 * 注意 caller 必须在调用前把 socket 上的 'data' / 'error' / 'close' listener
 * 都视为该函数独占;函数返回时会 removeAllListeners 这三个事件,后续 caller
 * 可以重新挂上(file-proxy 会重新挂以驱动 pipe)。
 */
export function readResponseHead(
  socket: Socket,
  timeoutMs: number,
  maxHeaderBytes = 64 * 1024,
): Promise<TunnelResponseHead | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      try { socket.removeListener("data", onData); } catch { /* */ }
      try { socket.removeListener("error", onErr); } catch { /* */ }
      try { socket.removeListener("close", onClose); } catch { /* */ }
      clearTimeout(timer);
    };
    const finish = (v: TunnelResponseHead | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const onErr = (): void => finish(null);
    const onClose = (): void => finish(null);
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
      if (total > maxHeaderBytes) {
        finish(null);
        return;
      }
      // 拼接增量 buffer,搜 \r\n\r\n。注意 \r\n\r\n 可能跨 chunk,所以每次
      // 都把整个 concat buffer 扫一遍。性能可接受 —— head 通常 < 4 KB。
      const buf = Buffer.concat(chunks, total);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const headPart = buf.subarray(0, sep).toString("utf8");
      const leftover = buf.subarray(sep + 4);
      const parsed = parseHead(headPart);
      finish(parsed === null ? null : { ...parsed, leftover });
    };

    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("close", onClose);
  });
}

/** "HTTP/1.1 200 OK\r\nA: b\r\nC: d" → TunnelResponseHead w/o leftover */
function parseHead(text: string): Omit<TunnelResponseHead, "leftover"> | null {
  const lines = text.split("\r\n");
  const statusLine = lines[0] ?? "";
  // RFC 7230: HTTP-version SP status-code SP reason-phrase
  const m = /^HTTP\/\d\.\d (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!m) return null;
  const statusCode = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(statusCode)) return null;
  const statusText = m[2] ?? "";

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln === "") continue;
    const colon = ln.indexOf(":");
    if (colon <= 0) continue; // skip malformed line silently
    const name = ln.slice(0, colon).trim().toLowerCase();
    const value = ln.slice(colon + 1).trim();
    if (!name) continue;
    if (headers[name] !== undefined) {
      headers[name] = `${headers[name]}, ${value}`;
    } else {
      headers[name] = value;
    }
  }
  return { statusCode, statusText, headers };
}

/**
 * 按 Content-Length 精确读 N 字节,读够即返。比 readBodyCapped 适合健全的服务
 * (容器返 fixed-size response,我们不必等 close)。
 *
 * 关键背景:node-agent tunnel 会剥 hop-by-hop header(包括 Connection),
 * 所以容器看不到 master 端的 `Connection: close`,不会主动关连接;node-agent
 * 双向 io.Copy 等 EOF。master 侧必须按 Content-Length 边界主动 destroy socket
 * 让 close 反向 propagate(node-agent 端 client→upstream Copy 立刻 EOF)。
 *
 * - 读够 expectedBytes → resolve {body, consumedFromInitial}(consumed 用来判
 *   leftover 中是否还残留 _额外_ 字节,通常容器不会多发,但安全起见报告)
 * - timeoutMs / error / 提前 close → resolve null
 */
export function readBodyByContentLength(
  socket: Socket,
  initial: Buffer,
  expectedBytes: number,
  timeoutMs: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (expectedBytes < 0) {
      resolve(null);
      return;
    }
    let written = 0;
    const parts: Buffer[] = [];
    if (initial.length > 0) {
      const slice = initial.length > expectedBytes ? initial.subarray(0, expectedBytes) : initial;
      parts.push(slice);
      written = slice.length;
    }
    if (written >= expectedBytes) {
      resolve(Buffer.concat(parts, written));
      return;
    }
    let settled = false;
    const cleanup = (): void => {
      try { socket.removeListener("data", onData); } catch { /* */ }
      try { socket.removeListener("error", onErr); } catch { /* */ }
      try { socket.removeListener("close", onClose); } catch { /* */ }
      clearTimeout(timer);
    };
    const finish = (v: Buffer | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onErr = (): void => finish(null);
    const onClose = (): void => finish(null); // 提前 close = 没读够
    const onData = (chunk: Buffer): void => {
      const remaining = expectedBytes - written;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      parts.push(slice);
      written += slice.length;
      if (written >= expectedBytes) {
        finish(Buffer.concat(parts, written));
      }
    };
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("close", onClose);
  });
}

/**
 * 增量 pipe Content-Length-bounded body 到 res。读够 N 字节就主动 destroy socket
 * + res.end()(不等 close,避免被 node-agent hop-by-hop strip 卡死)。
 *
 * callbacks:
 *   - onDone(): body 写完(含正常 end),释放 inflight slot
 *   - onError(reason): body 阶段 error / 提前 close 等异常
 *
 * 不返 Promise —— caller 已经 writeHead 了,后续是 fire-and-forget,通过 callback
 * 拿生命周期信号。
 */
export function pipeBodyByContentLength(
  socket: Socket,
  initial: Buffer,
  res: ResWritable,
  expectedBytes: number,
  idleTimeoutMs: number,
  callbacks: { onDone: () => void; onError: (why: string) => void },
): void {
  if (expectedBytes < 0) {
    callbacks.onError("negative_expected_bytes");
    return;
  }
  let written = 0;
  let settled = false;
  let drainHandler: (() => void) | null = null;
  const cleanupSocket = (): void => {
    try { socket.removeListener("data", onData); } catch { /* */ }
    try { socket.removeListener("error", onErr); } catch { /* */ }
    try { socket.removeListener("close", onClose); } catch { /* */ }
    if (drainHandler && res.removeListener) {
      try { res.removeListener("drain", drainHandler); } catch { /* */ }
      drainHandler = null;
    }
  };
  const finishOk = (): void => {
    if (settled) return;
    settled = true;
    cleanupSocket();
    try { socket.destroy(); } catch { /* */ }
    if (!res.writableEnded) try { res.end(); } catch { /* */ }
    callbacks.onDone();
  };
  const finishErr = (why: string): void => {
    if (settled) return;
    settled = true;
    cleanupSocket();
    try { socket.destroy(); } catch { /* */ }
    if (!res.writableEnded && res.destroy) try { res.destroy(); } catch { /* */ }
    callbacks.onError(why);
  };
  // 写一段 chunk 到 res;若 res.write 返 false → 暂停 socket,挂 drain 后 resume
  const writeWithBackpressure = (slice: Buffer): boolean => {
    if (slice.length === 0) return true;
    let ok: boolean;
    try {
      ok = res.write(slice);
    } catch {
      finishErr("res_write");
      return false;
    }
    if (!ok && res.once) {
      try { socket.pause?.(); } catch { /* */ }
      if (!drainHandler) {
        drainHandler = (): void => {
          drainHandler = null;
          if (settled) return;
          try { socket.resume?.(); } catch { /* */ }
        };
        try { res.once("drain", drainHandler); } catch {
          drainHandler = null;
          // 兜底:本来就没法挂 drain → 直接 resume(行为退化为旧版)
          try { socket.resume?.(); } catch { /* */ }
        }
      }
    }
    return true;
  };
  // initial chunk(可能含全 body 或部分)
  if (initial.length > 0) {
    const slice = initial.length > expectedBytes ? initial.subarray(0, expectedBytes) : initial;
    if (!writeWithBackpressure(slice)) return;
    written += slice.length;
  }
  if (written >= expectedBytes) {
    finishOk();
    return;
  }
  socket.setTimeout?.(idleTimeoutMs, () => finishErr("idle_timeout"));
  const onErr = (): void => finishErr("socket_error");
  const onClose = (): void => {
    if (written < expectedBytes) finishErr("premature_close");
    else finishOk();
  };
  const onData = (chunk: Buffer): void => {
    if (settled) return;
    const remaining = expectedBytes - written;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    if (!writeWithBackpressure(slice)) return;
    written += slice.length;
    if (written >= expectedBytes) {
      finishOk();
    }
  };
  socket.on("data", onData);
  socket.on("error", onErr);
  socket.on("close", onClose);
}

/**
 * 增量 pipe chunked transfer-encoding body 到 res。每个 chunk 头 hex-len\r\n,
 * payload\r\n,直到 size=0 chunk(可选 trailer + \r\n\r\n)结束。
 *
 * 解到 0-chunk 即 finishOk;trailer 不解(我们的容器不发)。安全限制:单 chunk
 * size <= maxChunkBytes,累计 <= maxTotalBytes,超即 onError。
 */
export function pipeBodyChunked(
  socket: Socket,
  initial: Buffer,
  res: ResWritable,
  idleTimeoutMs: number,
  maxTotalBytes: number,
  callbacks: { onDone: () => void; onError: (why: string) => void },
): void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let totalBody = 0;
  let settled = false;
  let paused = false;
  let drainHandler: (() => void) | null = null;
  // 简单状态机:'size' 等 hex+\r\n,'data' 读 N+\r\n,'trailer' 读 \r\n
  type State = "size" | "data" | "trailer" | "done";
  let state: State = "size";
  let needData = 0;
  const cleanup = (): void => {
    try { socket.removeListener("data", onData); } catch { /* */ }
    try { socket.removeListener("error", onErr); } catch { /* */ }
    try { socket.removeListener("close", onClose); } catch { /* */ }
    if (drainHandler && res.removeListener) {
      try { res.removeListener("drain", drainHandler); } catch { /* */ }
      drainHandler = null;
    }
  };
  const finishOk = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try { socket.destroy(); } catch { /* */ }
    if (!res.writableEnded) try { res.end(); } catch { /* */ }
    callbacks.onDone();
  };
  const finishErr = (why: string): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try { socket.destroy(); } catch { /* */ }
    if (!res.writableEnded && res.destroy) try { res.destroy(); } catch { /* */ }
    callbacks.onError(why);
  };
  /**
   * 写一段 chunk 到 res;若 res.write 返 false → 暂停 socket(buf 也不再 drive)
   * 等 'drain' 后 resume,drain handler 再次调 drive() 把 buf 里残留的 byte 处理完。
   * 返回 true=可继续 drive,false=已 paused / 已 settled,drive 应停。
   */
  const writeWithBackpressure = (slice: Buffer): boolean => {
    if (slice.length === 0) return true;
    let ok: boolean;
    try {
      ok = res.write(slice);
    } catch {
      finishErr("res_write");
      return false;
    }
    if (!ok && res.once) {
      paused = true;
      try { socket.pause?.(); } catch { /* */ }
      if (!drainHandler) {
        drainHandler = (): void => {
          drainHandler = null;
          if (settled) return;
          paused = false;
          try { socket.resume?.(); } catch { /* */ }
          drive(); // 残留 buf 继续解
        };
        try { res.once("drain", drainHandler); } catch {
          drainHandler = null;
          paused = false;
          try { socket.resume?.(); } catch { /* */ }
        }
      }
      return false;
    }
    return true;
  };
  const drive = (): void => {
    while (!settled && !paused) {
      if (state === "size") {
        const nl = buf.indexOf("\r\n");
        if (nl < 0) {
          if (buf.length > 32) { finishErr("chunk_size_too_long"); return; }
          return; // wait more
        }
        const sizeLine = buf.subarray(0, nl).toString("ascii");
        const sizeStr = sizeLine.split(";")[0]!.trim();
        const size = Number.parseInt(sizeStr, 16);
        if (!Number.isFinite(size) || size < 0) { finishErr("bad_chunk_size"); return; }
        buf = buf.subarray(nl + 2);
        if (size === 0) {
          state = "trailer";
          continue;
        }
        if (totalBody + size > maxTotalBytes) { finishErr("body_too_large"); return; }
        needData = size;
        state = "data";
        continue;
      }
      if (state === "data") {
        if (buf.length < needData + 2) {
          // partial:写出已缓存的部分,降低 buffer 占用,可能触发 backpressure
          if (needData > 0 && buf.length > 0) {
            const take = Math.min(needData, buf.length);
            const slice = buf.subarray(0, take);
            const cont = writeWithBackpressure(slice);
            // 不论 cont,buf 都要消费(数据已经入 res 内部 buffer)
            totalBody += take;
            needData -= take;
            buf = buf.subarray(take);
            if (!cont) return;
          }
          return; // wait more
        }
        // 全收齐了
        if (needData > 0) {
          const slice = buf.subarray(0, needData);
          const cont = writeWithBackpressure(slice);
          totalBody += needData;
          buf = buf.subarray(needData);
          needData = 0;
          if (!cont) return;
        }
        // 期待 \r\n
        if (buf[0] !== 0x0d || buf[1] !== 0x0a) { finishErr("missing_chunk_crlf"); return; }
        buf = buf.subarray(2);
        state = "size";
        continue;
      }
      if (state === "trailer") {
        // 等 \r\n(末尾空行)。trailer header 有就 skip 一行 + 继续。
        if (buf.length < 2) return;
        if (buf[0] === 0x0d && buf[1] === 0x0a) {
          state = "done";
          finishOk();
          return;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) {
          if (buf.length > 1024) { finishErr("trailer_too_long"); return; }
          return;
        }
        buf = buf.subarray(nl + 2);
        continue;
      }
      return; // done
    }
  };
  const onErr = (): void => finishErr("socket_error");
  const onClose = (): void => { if (state !== "done") finishErr("premature_close"); };
  const onData = (chunk: Buffer): void => {
    if (settled) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    drive();
  };
  socket.setTimeout?.(idleTimeoutMs, () => finishErr("idle_timeout"));
  socket.on("data", onData);
  socket.on("error", onErr);
  socket.on("close", onClose);
  if (initial.length > 0) {
    buf = initial;
    drive();
  }
}

/**
 * 读 body 字节,直到:
 *   - socket 'end'/'close' → resolve 已读 buffer
 *   - 超 maxBytes → resolve null(caller 视为失败)
 *   - 超 timeoutMs → resolve null
 *   - error → resolve null
 *
 * 不解 Content-Length / chunked。**调用方必须保证容器侧用 `Connection: close`**,
 * 这样 server 会在写完 body 后关 socket。**仅作为最后兜底**,优先用
 * readBodyByContentLength —— 它不需要 Connection: close 配合(node-agent
 * 会 strip 这个 hop-by-hop header)。
 */
/**
 * 按 Transfer-Encoding: chunked 解码并 collect body 到 Buffer。
 *
 * 用于 healthz probe 这种小响应场景:JSON 服务端常用 keep-alive + chunked,
 * 不能用 readBodyCapped(等 close 永远 hang)也不能用 readBodyByContentLength
 * (没 CL header)。
 *
 * State machine 跟 pipeBodyChunked 一致:
 *   - 'size': 累积直到 \r\n,parse hex(忽略 ; chunk extension)
 *   - 'data': 累积 N bytes
 *   - 'crlf-after-data': skip 2 bytes (\r\n after chunk data)
 *   - size=0 → 'trailer': skip 直到空行 \r\n\r\n
 *   - 任何阶段 maxBytes 超限或 timeout → null
 *
 * 不处理:non-hex size、负 size、size > maxBytes。任何这些 → 视为非法 → null。
 */
export function readBodyChunked(
  socket: Socket,
  initial: Buffer,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let buf: Buffer<ArrayBufferLike> = initial.length > 0 ? Buffer.from(initial) : Buffer.alloc(0);
    const out: Buffer[] = [];
    let outBytes = 0;
    type State = "size" | "data" | "crlf-after-data" | "trailer" | "done";
    let state: State = "size";
    let dataRemaining = 0;
    let settled = false;

    const cleanup = (): void => {
      try { socket.removeListener("data", onData); } catch { /* */ }
      try { socket.removeListener("error", onErr); } catch { /* */ }
      try { socket.removeListener("close", onClose); } catch { /* */ }
      clearTimeout(timer);
    };
    const finish = (v: Buffer | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const drive = (): void => {
      while (!settled) {
        if (state === "size") {
          const idx = buf.indexOf("\r\n");
          if (idx < 0) return; // 等更多数据
          const line = buf.subarray(0, idx).toString("utf8");
          buf = buf.subarray(idx + 2);
          // 去掉 chunk extension(`; key=val`)
          const semi = line.indexOf(";");
          const sizeHex = (semi >= 0 ? line.slice(0, semi) : line).trim();
          if (!/^[0-9a-fA-F]+$/.test(sizeHex)) {
            finish(null);
            return;
          }
          const sz = Number.parseInt(sizeHex, 16);
          if (!Number.isFinite(sz) || sz < 0) {
            finish(null);
            return;
          }
          if (sz === 0) {
            state = "trailer";
            continue;
          }
          if (outBytes + sz > maxBytes) {
            finish(null);
            return;
          }
          dataRemaining = sz;
          state = "data";
          continue;
        }
        if (state === "data") {
          if (buf.length === 0) return;
          const take = Math.min(dataRemaining, buf.length);
          out.push(buf.subarray(0, take));
          outBytes += take;
          buf = buf.subarray(take);
          dataRemaining -= take;
          if (dataRemaining === 0) state = "crlf-after-data";
          continue;
        }
        if (state === "crlf-after-data") {
          if (buf.length < 2) return;
          // 严格点:这两字节必须是 \r\n。否则视为协议异常。
          if (buf[0] !== 0x0d || buf[1] !== 0x0a) {
            finish(null);
            return;
          }
          buf = buf.subarray(2);
          state = "size";
          continue;
        }
        if (state === "trailer") {
          // 找 \r\n\r\n(空 trailer 头部) 或 \r\n(无 trailer,直接结束)
          // RFC 7230 §4.1.2: trailer 之后是 last-chunk 的最终 CRLF。
          // 简化:只要见到 \r\n 就认为结束(常见服务端 0\r\n\r\n)。
          if (buf.length < 2) return;
          if (buf[0] === 0x0d && buf[1] === 0x0a) {
            state = "done";
            finish(Buffer.concat(out, outBytes));
            return;
          }
          // 有 trailer header → 找下个 \r\n 跳过它
          const idx = buf.indexOf("\r\n");
          if (idx < 0) return;
          buf = buf.subarray(idx + 2);
          continue;
        }
        return; // done
      }
    };

    const onErr = (): void => finish(null);
    const onClose = (): void => finish(null); // chunked 不该靠 close 收尾
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      drive();
    };

    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("close", onClose);

    // initial buffer 可能已经包含完整 chunked body
    drive();
  });
}

export function readBodyCapped(
  socket: Socket,
  initial: Buffer,
  timeoutMs: number,
  maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let total = initial.length;
    if (total > maxBytes) {
      resolve(null);
      return;
    }
    const parts: Buffer[] = initial.length > 0 ? [initial] : [];
    let settled = false;
    const cleanup = (): void => {
      try { socket.removeListener("data", onData); } catch { /* */ }
      try { socket.removeListener("error", onErr); } catch { /* */ }
      try { socket.removeListener("end", onEnd); } catch { /* */ }
      try { socket.removeListener("close", onClose); } catch { /* */ }
      clearTimeout(timer);
    };
    const finish = (v: Buffer | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onErr = (): void => finish(null);
    const onEnd = (): void => finish(Buffer.concat(parts, total));
    const onClose = (): void => finish(Buffer.concat(parts, total));
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(null);
        return;
      }
      parts.push(chunk);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("end", onEnd);
    socket.on("close", onClose);
  });
}
