// slotRelay.ts — P3 双 master 私有槽通知 relay。
//
// userNoticeApproval 只在 lease leader 运行，但在线 WS 会分布在 A/B 两槽。relay 复用
// 每槽 loopback 私有控制口(A=18896/B=18897)，以 OC_EGRESS_SECRET 鉴权；不走 VIP，
// 因而 leader 交接期间仍可同时查询/投递两个槽。客户端硬超时、响应上限和批量上限保证
// approval 的 DB fence 事务与 LeaderBundle drain 都有界。

import { timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

export const SLOT_ONLINE_PATH = "/internal/v5/slot-online";
export const SLOT_BROADCAST_PATH = "/internal/v5/slot-broadcast";
export const SLOT_RELAY_BATCH = 256;
export const SLOT_RELAY_MAX_UIDS = 4096;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface SlotRelayLocal {
  onlineUserSubset(uids: string[]): string[];
  broadcastToUsers(uids: string[], payload: unknown): number;
}

export interface SlotRelayLogger {
  warn(message: string, meta?: unknown): void;
}

function validUid(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}

function normalizeUids(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > SLOT_RELAY_BATCH) return null;
  if (!value.every(validUid)) return null;
  return [...new Set(value)];
}

function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 命中 relay 路径返回 true；调用方据此不再进入 anthropic dispatcher。 */
export function handleSlotRelayRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { secret: string; local: SlotRelayLocal; logger?: SlotRelayLogger },
): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== SLOT_ONLINE_PATH && path !== SLOT_BROADCAST_PATH) return false;
  if (req.method !== "POST") {
    reply(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const presented = req.headers["x-oc-egress-secret"];
  if (!secretMatches(typeof presented === "string" ? presented : undefined, opts.secret)) {
    reply(res, 401, { ok: false, error: "UNAUTHORIZED" });
    return true;
  }
  void readJson(req)
    .then((body) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        reply(res, 400, { ok: false, error: "INVALID_BODY" });
        return;
      }
      const obj = body as { uids?: unknown; payload?: unknown };
      const uids = normalizeUids(obj.uids);
      if (!uids) {
        reply(res, 400, { ok: false, error: "INVALID_UIDS" });
        return;
      }
      if (path === SLOT_ONLINE_PATH) {
        const online = opts.local.onlineUserSubset(uids).filter(validUid);
        reply(res, 200, { ok: true, deliveredUids: [...new Set(online)] });
        return;
      }
      const delivered: string[] = [];
      for (const uid of uids) {
        if (opts.local.broadcastToUsers([uid], obj.payload) > 0) delivered.push(uid);
      }
      reply(res, 200, { ok: true, deliveredUids: delivered });
    })
    .catch((err) => {
      opts.logger?.warn("slot relay request rejected", { err: (err as Error).message });
      reply(res, (err as Error).message === "BODY_TOO_LARGE" ? 413 : 400, {
        ok: false,
        error: (err as Error).message === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON",
      });
    });
  return true;
}

export interface SlotRelayClient {
  onlineUserSubset(uids: string[]): Promise<string[]>;
  broadcastToUsers(uids: string[], payload: unknown): Promise<string[]>;
}

interface ClientOptions {
  secret: string;
  ports?: number[];
  requestTimeoutMs?: number;
  totalBudgetMs?: number;
  logger?: SlotRelayLogger;
}

export function createSlotRelayClient(opts: ClientOptions): SlotRelayClient {
  const ports = opts.ports ?? [18896, 18897];
  const requestTimeoutMs = opts.requestTimeoutMs ?? 500;
  const totalBudgetMs = opts.totalBudgetMs ?? 2_000;
  const log = opts.logger;

  async function post(
    port: number,
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string[]> {
    const data = Buffer.from(JSON.stringify(body));
    return new Promise<string[]>((resolve) => {
      let settled = false;
      const done = (uids: string[]): void => {
        if (settled) return;
        settled = true;
        resolve(uids);
      };
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          "x-oc-egress-secret": opts.secret,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (raw) => {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return done([]);
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              ok?: unknown;
              deliveredUids?: unknown;
            };
            const uids = Array.isArray(parsed.deliveredUids)
              ? parsed.deliveredUids.filter(validUid)
              : [];
            done(parsed.ok === true ? [...new Set(uids)] : []);
          } catch {
            done([]);
          }
        });
      });
      req.setTimeout(requestTimeoutMs, () => req.destroy(new Error("SLOT_RELAY_TIMEOUT")));
      req.on("error", (err) => {
        if (!signal.aborted) log?.warn("slot relay peer unavailable", { port, path, err: err.message });
        done([]);
      });
      req.end(data);
    });
  }

  async function fanout(path: string, uidsInput: string[], payload?: unknown): Promise<string[]> {
    const uids = [...new Set(uidsInput)];
    if (uids.length > SLOT_RELAY_MAX_UIDS || !uids.every(validUid)) {
      throw new Error(`slot relay uids invalid/out-of-range(count=${uids.length})`);
    }
    if (uids.length === 0) return [];
    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), totalBudgetMs);
    if (typeof budget === "object" && "unref" in budget) budget.unref();
    try {
      const calls: Array<Promise<string[]>> = [];
      for (let i = 0; i < uids.length; i += SLOT_RELAY_BATCH) {
        const batch = uids.slice(i, i + SLOT_RELAY_BATCH);
        for (const port of ports) {
          calls.push(post(port, path, { uids: batch, ...(path === SLOT_BROADCAST_PATH ? { payload } : {}) }, controller.signal));
        }
      }
      const rows = await Promise.all(calls);
      return [...new Set(rows.flat())];
    } finally {
      clearTimeout(budget);
      controller.abort();
    }
  }

  return {
    onlineUserSubset: (uids) => fanout(SLOT_ONLINE_PATH, uids),
    broadcastToUsers: (uids, payload) => fanout(SLOT_BROADCAST_PATH, uids, payload),
  };
}
