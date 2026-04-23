/**
 * V3 容器生命周期事件订阅 —— 当前只抽 OOM 信号 → `container.oom_exited` 告警。
 *
 * 架构:
 *   - 连 `docker.getEvents({ filters: type=container, event=oom|die })`
 *     (NDJSON stream,dockerode 返 Readable)
 *   - 每行 parse 成 DockerEvent,routing 到 `handleContainerEvent`
 *   - 过滤:容器名以 `oc-v3-u<uid>` 起(v3supervisor.v3ContainerNameFor),
 *     其它容器(CI / v2 / 基础设施)一律跳过
 *   - 判定 OOM:
 *       * action='oom' → 直接信(docker daemon 从 kernel OOM 翻译,高置信)
 *       * action='die' + exitCode=137 → 必须再 inspect 容器 State.OOMKilled
 *         为 true 才信;否则等价于 `docker kill` / `stop --force` / supervisor
 *         cleanup 发的 SIGKILL,不是 OOM
 *   - dedupe_key:`container.oom_exited:uid:<10min bucket>` —— restart loop 不刷屏
 *     注:outbox 层的 partial unique 只挡 pending/failed,一旦 sent 同 key 能再插,
 *     所以在 worker 里额外维护 in-memory TTL cache 作 best-effort 兜底(见
 *     `DedupeCache` / `rememberDedupe`)。
 *
 * 为啥不轮询 docker ps:
 *   - v3 容器 OOM 后 docker-daemon 很快会再被 idle sweep / restart policy 搬走,
 *     轮询扫不到;event stream 是唯一的无损抓手
 *   - oom 事件发生率低(正常应该是 0),订阅成本远低于跑周期任务
 *
 * 重连:
 *   - stream 任意 end / error → 1s 起指数退避重连,上限 60s
 *   - stop() 翻 `stopped=true` 并 destroy 活跃 stream,for-await 退出
 *   - stop() 还会 `await loopPromise`,并在 openEventsStream 返回后二次检查
 *     `stopped`,防止 shutdown 时恰好 pending connect callback 返回造成的
 *     stream 泄漏
 *
 * 测试:
 *   - 核心判定抽在 `handleContainerEvent`(同步 + inspect callback 可 mock),
 *     stream loop 只做 IO + NDJSON 拆分
 */

import type Docker from "dockerode";
import type { IncomingMessage } from "node:http";

import { EVENTS } from "../admin/alertEvents.js";
import { safeEnqueueAlert } from "../admin/alertOutbox.js";

/**
 * 容器名前缀 — 与 v3supervisor.v3ContainerNameFor 保持同步。
 * 故意 hardcode 不 import,避免 admin 侧和 agent-sandbox 侧循环 import。
 */
const CONTAINER_NAME_PREFIX = "oc-v3-u";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DEDUPE_BUCKET_MS = 10 * 60 * 1000;
/**
 * 进程内 dedupe cache TTL。比 bucket 稍长一点,保证同一 bucket 被一次
 * worker 进程处理时内部幂等。重启 / 崩溃后 cache 丢失 → outbox partial
 * unique 还能挡"新事件尚未被 sent"这段窗口,最坏情况多发一条 OOM 告警,
 * 可接受。
 */
const DEDUPE_CACHE_TTL_MS = DEDUPE_BUCKET_MS + 60_000;

export interface ContainerEventsLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface StartV3ContainerEventsWorkerOptions {
  docker: Docker;
  logger?: ContainerEventsLogger;
}

export interface V3ContainerEventsWorker {
  /** 终止订阅。已在传输中的 event 会被丢弃;loop 会退出不再重连。 */
  stop: () => Promise<void>;
}

/** dockerode event 对象(仅取本文件关心的字段)。 */
export interface DockerContainerEvent {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  /** docker 发出的 unix epoch(秒) */
  time?: number;
  /** 老字段:某些 docker 版本仅填 status,action 为空 */
  status?: string;
  id?: string;
}

/**
 * 从容器名抽 uid。名字必须是 `oc-v3-u<正整数>`,否则返 null。
 * docker event Attributes.name 开头可能带 `/`(legacy),先剥除。
 *
 * 严格拒绝前导 0(`oc-v3-u01`),避免与 `oc-v3-u1` 混为一谈导致告警/dedupe
 * 跨两个身份。supervisor 一侧只会写无前导 0 的形式,任何前导 0 的出现都
 * 代表非 supervisor 产物或人工改名。
 */
export function uidFromContainerName(name: string | undefined): number | null {
  if (!name) return null;
  const trimmed = name.startsWith("/") ? name.slice(1) : name;
  if (!trimmed.startsWith(CONTAINER_NAME_PREFIX)) return null;
  const tail = trimmed.slice(CONTAINER_NAME_PREFIX.length);
  if (tail.length === 0) return null;
  // 只接 [1-9][0-9]* —— 拒绝前导 0 和非数字尾(避免 `oc-v3-u<uid>-tmp` 伪造)
  if (!/^[1-9]\d*$/.test(tail)) return null;
  const uid = Number.parseInt(tail, 10);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  return uid;
}

/**
 * 进程内 TTL dedupe cache。key 命中且未过期时跳过告警入队。
 *
 * 为啥需要:outbox partial unique 只挡 pending/failed,不挡 sent。
 * 重启 loop 同一 bucket 内发多次 OOM 时,本层额外兜底避免刷屏。
 */
interface DedupeCache {
  remember(key: string, now: number): boolean;
}

export function createDedupeCache(ttlMs: number = DEDUPE_CACHE_TTL_MS): DedupeCache {
  const map = new Map<string, number>();
  return {
    /**
     * 返回 true 表示"未命中"(调用方应发告警);false 表示"命中,跳过"。
     * 命中未过期 key 不续约。
     */
    remember(key: string, now: number): boolean {
      const exp = map.get(key);
      if (exp !== undefined && exp > now) return false;
      // 懒扫过期项(O(n)/N):N 很小(每 uid 一条,10min TTL)
      if (map.size > 256) {
        for (const [k, e] of map) if (e <= now) map.delete(k);
      }
      map.set(key, now + ttlMs);
      return true;
    },
  };
}

/** 查容器 State.OOMKilled(die+137 真正是 OOM 才为 true);inspect 失败返 null。 */
export type OomInspectFn = (containerId: string) => Promise<boolean | null>;

function makeDockerOomInspect(docker: Docker): OomInspectFn {
  return async (containerId) => {
    try {
      // dockerode 在 0 长度 id 时会直接 throw
      if (!containerId) return null;
      const info = await docker.getContainer(containerId).inspect();
      const state = (info as { State?: { OOMKilled?: boolean } }).State;
      if (!state || typeof state.OOMKilled !== "boolean") return null;
      return state.OOMKilled;
    } catch {
      // 容器已 rm、docker socket 挂了、id 不对 —— 都按"无法确认"处理
      return null;
    }
  };
}

export interface HandleResult {
  emitted: boolean;
  reason: string;
}

export interface HandleContainerEventDeps {
  logger?: ContainerEventsLogger;
  /** inspect 容器 State.OOMKilled;未传表示跳过 die+137 校验(测试用) */
  inspectOom?: OomInspectFn;
  /** 进程内 TTL dedupe cache;未传表示不缓存(测试用) */
  dedupeCache?: DedupeCache;
  /** 测试用:固定时间戳 */
  now?: () => number;
}

/**
 * 处理一条 docker event。只识别 v3 容器的 OOM → 发 `container.oom_exited` 告警。
 *
 * 判定路径:
 *   - `action='oom'` → 直接信(docker daemon 从 kernel OOM 翻译,置信度最高)
 *   - `action='die' && exitCode=137` → 必须再 inspect `State.OOMKilled === true`
 *     才信。否则可能是 `docker stop --force` / `docker kill` / supervisor cleanup
 *     发的 SIGKILL(都会落 exit 137),被误报为 OOM。
 *   - 其它 action 一律跳过(reason 标清楚便于日志)。
 *
 * 幂等性两层兜底:
 *   - dedupe_key `container.oom_exited:uid:<uid>:<10min bucket>` 走 outbox
 *     partial unique(挡 pending/failed 内的重复)
 *   - 进程内 dedupe cache(TTL ≈ 11min,挡 bucket 内 sent 后的重复)
 */
export async function handleContainerEvent(
  ev: DockerContainerEvent,
  deps: HandleContainerEventDeps = {},
): Promise<HandleResult> {
  const { logger, inspectOom, dedupeCache, now = () => Date.now() } = deps;

  if (ev.Type && ev.Type !== "container") return { emitted: false, reason: "not_container" };
  // action 字段兼容:新 API 在 Action,老 API 在 status
  const action = (ev.Action ?? ev.status ?? "").toLowerCase();

  const attrs = ev.Actor?.Attributes ?? {};
  const name = attrs.name;
  const uid = uidFromContainerName(name);
  if (uid === null) return { emitted: false, reason: "not_v3_container" };

  const exitCodeRaw = attrs.exitCode ?? attrs.exitcode ?? "";
  const exitCode = Number.parseInt(exitCodeRaw, 10);

  // 一级过滤:必须是 oom 或 die+137
  const isOomAction = action === "oom";
  const isDie137 = action === "die" && Number.isFinite(exitCode) && exitCode === 137;
  if (!isOomAction && !isDie137) return { emitted: false, reason: `action=${action}` };

  // 二级过滤:die+137 必须 inspect 确认 OOMKilled=true
  //   - inspectOom 没给 → 退化成不信(避免在没 docker client 的环境误报)
  //   - OOMKilled=true → 信
  //   - OOMKilled=false → 是 supervisor cleanup / docker kill,跳过
  //   - OOMKilled=null(容器已 rm / inspect 失败)→ 保守跳过(不发误报告警)
  let trigger: string;
  if (isOomAction) {
    trigger = "docker oom event";
  } else {
    const containerId = ev.Actor?.ID ?? ev.id ?? "";
    if (!inspectOom) {
      return { emitted: false, reason: "die_137_no_inspect" };
    }
    const oomKilled = await inspectOom(containerId);
    if (oomKilled !== true) {
      logger?.debug?.("[v3/containerEvents] die 137 but not OOMKilled, skip", {
        uid,
        container_id: containerId,
        oom_killed: oomKilled,
      });
      return { emitted: false, reason: `die_137_not_oom_killed(${oomKilled})` };
    }
    trigger = "docker die exitCode=137 + OOMKilled=true";
  }

  const bucket = Math.floor(now() / DEDUPE_BUCKET_MS) * DEDUPE_BUCKET_MS;
  const dedupe_key = `${EVENTS.CONTAINER_OOM_EXITED}:uid:${uid}:${bucket}`;

  // 进程内 dedupe:同 bucket 内只发一次
  if (dedupeCache && !dedupeCache.remember(dedupe_key, now())) {
    logger?.debug?.("[v3/containerEvents] in-memory dedupe hit, skip", {
      uid,
      dedupe_key,
    });
    return { emitted: false, reason: "in_memory_dedupe" };
  }

  safeEnqueueAlert({
    event_type: EVENTS.CONTAINER_OOM_EXITED,
    severity: "warning",
    title: `[WARN] 用户容器 OOM:uid=${uid}`,
    body:
      `v3 容器 \`${name}\`(uid=${uid})被 kernel OOM 杀(${trigger})。\n` +
      "用户会看到聊天断线,下次 provision 时会重建容器。" +
      "如果 10min 桶内此 uid 反复 OOM,排查 memory limit 或该用户工作负载。",
    payload: {
      uid,
      container_name: name ?? null,
      container_id: ev.Actor?.ID ?? ev.id ?? null,
      action,
      exit_code: Number.isFinite(exitCode) ? exitCode : null,
      event_time_sec: typeof ev.time === "number" ? ev.time : null,
    },
    dedupe_key,
  });

  logger?.info?.("[v3/containerEvents] OOM alert enqueued", {
    uid,
    container_name: name,
    action,
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    trigger,
  });

  return { emitted: true, reason: trigger };
}

/**
 * 从 dockerode getEvents 拿 stream(callback-style API,包一层 promise)。
 *
 * filters 必须 JSON.stringify —— docker engine API 要求字符串,
 * dockerode 只对 object 做浅 stringify,不会递归 serialize Array,
 * 保险直接自己 stringify。
 */
function openEventsStream(docker: Docker): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const opts = {
      filters: JSON.stringify({
        type: ["container"],
        event: ["oom", "die"],
      }),
    };
    // dockerode 的 types 上 callback 签名不完整,cast 成 any 绕过
    (docker.getEvents as unknown as (
      o: unknown,
      cb: (err: Error | null, stream: IncomingMessage) => void,
    ) => void)(opts, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

/**
 * 启动 docker event stream 订阅。自动重连 + 可停止。
 *
 * 返回 worker 句柄;调用 `stop()` 终止并等待 loop 退出(避免泄漏 event stream)。
 *
 * stop race 防护:
 *   - 保留 loopPromise,stop 时 `await` 它
 *   - openEventsStream 返回后,**立刻再检查一次 stopped**,是的话直接 destroy
 *     刚拿到的 stream。这挡住「stop 翻 stopped 时 connect callback 还在 pending,
 *     stop 看到 activeStream=null 直接返回,然后 callback resolve,loop 继续
 *     attach」的竞态。
 */
export function startV3ContainerEventsWorker(
  opts: StartV3ContainerEventsWorkerOptions,
): V3ContainerEventsWorker {
  const log = opts.logger;
  let stopped = false;
  let activeStream: IncomingMessage | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectResolve: (() => void) | null = null;
  let backoffMs = MIN_BACKOFF_MS;

  const inspectOom = makeDockerOomInspect(opts.docker);
  const dedupeCache = createDedupeCache();

  async function consumeStream(stream: IncomingMessage): Promise<void> {
    let carry = "";
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      if (stopped) break;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      carry += text;
      let idx: number;
      while ((idx = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, idx).trim();
        carry = carry.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          const ev = JSON.parse(line) as DockerContainerEvent;
          // handleContainerEvent 内部已全部 swallow;await 保证 inspect 串行
          await handleContainerEvent(ev, { logger: log, inspectOom, dedupeCache });
        } catch (err) {
          log?.warn?.("[v3/containerEvents] bad event line", {
            err: err instanceof Error ? err.message : String(err),
            line: line.slice(0, 200),
          });
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const stream = await openEventsStream(opts.docker);
        // stop race 闸门:若 stop 已调,立刻 destroy 刚拿到的 stream 退出
        if (stopped) {
          try {
            stream.destroy();
          } catch {
            /* best-effort */
          }
          return;
        }
        activeStream = stream;
        log?.info?.("[v3/containerEvents] event stream attached");
        backoffMs = MIN_BACKOFF_MS;
        await consumeStream(stream);
        activeStream = null;
        if (!stopped) {
          log?.warn?.("[v3/containerEvents] event stream ended; will reconnect");
        }
      } catch (err) {
        activeStream = null;
        if (stopped) return;
        log?.error?.("[v3/containerEvents] event stream error", {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      if (stopped) return;
      await new Promise<void>((resolve) => {
        reconnectResolve = resolve;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          reconnectResolve = null;
          resolve();
        }, backoffMs);
        if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
      });
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  const loopPromise = loop().catch((err) => {
    log?.error?.("[v3/containerEvents] loop fatal", {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    stop: async () => {
      stopped = true;
      // 先把 reconnect sleep 唤醒,避免 stop 多等一个 backoff 窗口
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (reconnectResolve) {
        const r = reconnectResolve;
        reconnectResolve = null;
        try {
          r();
        } catch {
          /* noop */
        }
      }
      const s = activeStream;
      activeStream = null;
      if (s) {
        try {
          s.destroy();
        } catch {
          /* best-effort */
        }
      }
      // 等 loop 真正退出再 resolve(防 stream 泄漏 / 进程不退)
      await loopPromise;
    },
  };
}
