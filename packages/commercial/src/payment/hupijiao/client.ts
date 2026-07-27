/**
 * T-24 — 虎皮椒 HTTP 客户端。
 *
 * 只实现 "创建预支付订单 → 拿 qrcode_url" 一个接口:
 *   POST https://<endpoint>/api/payment/do.html
 *   form-urlencoded: version=1.1, appid, trade_order_id, total_fee, title, time, notify_url, nonce_str, type=wechat, hash
 *   resp JSON: { errcode:0, hash, ... , url_qrcode?, url? }
 *
 * 同时实现一次性全额退款。虎皮椒退款接口以原商户订单号定位订单，
 * 不接受退款金额，因此这里只暴露全额退款，不伪造部分退款语义。
 *
 * 本模块把具体 HTTP 调用抽成一个 interface `HupijiaoClient`,让上层 handler 能:
 *   - 生产:用 `createHttpHupijiaoClient(cfg)` 真调外部
 *   - 测试:注入一个返回固定 `qrcode_url` 的 mock(避免依赖 sandbox)
 *
 * 签名算法见 `./sign.ts`。
 */

import { randomBytes } from "node:crypto";
import type { Dispatcher } from "undici";
import { directEgressDispatcher } from "../../account-pool/egressDispatcher.js";
import { signHupijiao, verifyHupijiao, type SignParams } from "./sign.js";

export interface HupijiaoConfig {
  /** 虎皮椒后台申请的 app_id */
  appId: string;
  /** AppSecret,只放内存 / 环境变量,绝不日志 */
  appSecret: string;
  /** 异步回调 URL(虎皮椒 POST 到这里通知支付结果) */
  notifyUrl: string;
  /** 用户扫码付款后的跳转 URL(非必须) */
  returnUrl?: string;
  /**
   * API endpoint base。默认 `https://api.xunhupay.com`;自托管 / sandbox 可覆盖。
   * 末尾不带 `/`。
   */
  endpoint?: string;
}

/** 创建订单的业务输入。 */
export interface CreateQrInput {
  /** 本地订单号(唯一),虎皮椒字段名 `trade_order_id` */
  orderNo: string;
  /** 订单金额,单位:分(人民币);虎皮椒接口要求 "元",内部做换算 */
  amountCents: bigint;
  /** 订单标题(会显示在支付页,如 "充值 ¥10") */
  title: string;
  /** 附加字段,回传到 notify 中;业务可填 user_id 便于追查 */
  attach?: string;
}

export interface CreateQrResult {
  /**
   * PC 扫码用图片 URL。虎皮椒返回的 `url_qrcode` 本身就是一张 QR PNG —— 这张 QR
   * 编码的才是真正的 `weixin://wxpay/bizpayurl?...`。前端直接 `<img src=...>` 即可。
   * 如果客户端再把这个 URL 字符串二维码化,微信扫到的将是 url 链接而非 weixin 协议,
   * 用户被迫扫两次(2026-04-19 实测复现)。
   */
  qrcodeUrl: string;
  /** 移动端直接拉起微信支付的 H5 链接(虎皮椒返回的 `url`),手机端可 location.href 过去 */
  mobileUrl: string | null;
  /** 虎皮椒平台订单号(provider_order),便于跨系统对账 */
  providerOrder?: string | null;
  /** 原始响应 JSON,测试 / 审计 / 告警用 */
  raw: Record<string, unknown>;
}

export interface RefundInput {
  /** 本地商户订单号。退款接口不提供调用方幂等键，同一订单上层只可外呼一次。 */
  orderNo: string;
  /** 退款原因，虎皮椒官方上限 80 字符。 */
  reason: string;
}

export type HupijiaoRefundStatus = "OD" | "CD" | "RD" | "UD";

export interface RefundResult {
  orderNo: string;
  status: HupijiaoRefundStatus;
  providerRefundNo: string | null;
  /** 渠道确认的全额退款金额（分）；缺失/格式非法为 null，CD 完成会 fail-closed。 */
  refundAmountCents: bigint | null;
  /** 仅持久化所需的脱敏白名单字段；不包含 hash。 */
  safePayload: Record<string, string | number | null>;
}

export interface HupijiaoClient {
  createQr(input: CreateQrInput): Promise<CreateQrResult>;
  /**
   * 可选是为了兼容只参与建单的测试/注入实现；生产 HTTP client 恒实现。
   * 上层退款端点在缺失时 fail-closed 为 PAYMENT_NOT_READY。
   */
  refund?(input: RefundInput): Promise<RefundResult>;
}

/**
 * 虎皮椒 API 错误。调用方通常映射到 502(上游错)或 400(如参数错),
 * `code` 取虎皮椒返回的 errcode(字符串化后 UPSTREAM_ 前缀),便于前端提示。
 */
export class HupijiaoError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly raw?: unknown;
  constructor(code: string, message: string, raw?: unknown, httpStatus?: number) {
    super(message);
    this.name = "HupijiaoError";
    this.code = code;
    this.raw = raw;
    this.httpStatus = httpStatus;
  }
}

function parseRefundFeeToCents(raw: unknown): bigint | null {
  const value =
    typeof raw === "number" && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === "string"
        ? raw
        : "";
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [yuan, fraction = ""] = value.split(".");
  return BigInt(yuan) * 100n + BigInt((fraction + "00").slice(0, 2));
}

/**
 * 生产用 HTTP 客户端。默认 endpoint = https://api.xunhupay.com
 *
 * 注入 `fetchImpl` 便于集成测试用 mock fetch(否则在 CI 里没法联外网)。
 */
export function createHttpHupijiaoClient(
  cfg: HupijiaoConfig,
  fetchImpl: typeof fetch = fetch,
): HupijiaoClient {
  const endpoint = (cfg.endpoint ?? "https://api.xunhupay.com").replace(/\/+$/, "");

  return {
    async createQr(input: CreateQrInput): Promise<CreateQrResult> {
      const nonce = randomBytes(8).toString("hex");
      // 虎皮椒 total_fee 单位是 "元" 字符串,两位小数
      const yuan = (Number(input.amountCents) / 100).toFixed(2);
      const payload: Record<string, string> = {
        version: "1.1",
        appid: cfg.appId,
        trade_order_id: input.orderNo,
        total_fee: yuan,
        title: input.title,
        time: Math.floor(Date.now() / 1000).toString(),
        notify_url: cfg.notifyUrl,
        nonce_str: nonce,
        type: "wechat",
      };
      if (cfg.returnUrl) payload.return_url = cfg.returnUrl;
      if (input.attach) payload.attach = input.attach;

      payload.hash = signHupijiao(payload, cfg.appSecret);

      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) form.set(k, v);

      const resp = await fetchImpl(`${endpoint}/payment/do.html`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        // 虎皮椒/讯虎是**国内**支付网关，必须显式直连，绕开 gateway 全局 EnvHttpProxyAgent
        // (给 Anthropic/GPT 出海的日本 sing-box 代理) —— 否则国内域名经日本代理 fetch failed。
        // 同 minimax/marketplaceSearch 的直连模式（见 v3-egress-domestic-models-via-japan）。
        dispatcher: directEgressDispatcher(),
      } as RequestInit & { dispatcher: Dispatcher });

      if (!resp.ok) {
        let body: string | undefined;
        try { body = await resp.text(); } catch { /* */ }
        throw new HupijiaoError("UPSTREAM_HTTP_ERROR",
          `hupijiao http ${resp.status}`, body, resp.status);
      }
      let json: Record<string, unknown>;
      try {
        json = (await resp.json()) as Record<string, unknown>;
      } catch {
        throw new HupijiaoError("UPSTREAM_BAD_JSON", "hupijiao response is not JSON");
      }

      const errcode = json.errcode;
      // 虎皮椒 errcode: 0 成功,非 0 失败
      if (errcode !== 0 && errcode !== "0") {
        const msg = typeof json.errmsg === "string" ? json.errmsg : "unknown";
        throw new HupijiaoError(`UPSTREAM_${String(errcode)}`,
          `hupijiao create failed: ${msg}`, json);
      }
      const qrcodeUrl = typeof json.url_qrcode === "string" && json.url_qrcode.length > 0
        ? json.url_qrcode
        : typeof json.url === "string" ? json.url : "";
      if (!qrcodeUrl) {
        throw new HupijiaoError("UPSTREAM_NO_QRCODE",
          "hupijiao response missing url_qrcode/url", json);
      }
      const mobileUrl = typeof json.url === "string" && json.url.length > 0 ? json.url : null;
      const providerOrder = typeof json.open_order_id === "string" ? json.open_order_id : null;
      return { qrcodeUrl, mobileUrl, providerOrder, raw: json };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      if (typeof input.orderNo !== "string" || input.orderNo.length === 0) {
        throw new TypeError("refund: orderNo is required");
      }
      if (
        typeof input.reason !== "string"
        || input.reason.trim().length === 0
        || input.reason.length > 80
      ) {
        throw new TypeError("refund: reason must be 1..80 characters");
      }
      const payload: Record<string, string> = {
        appid: cfg.appId,
        trade_order_id: input.orderNo,
        reason: input.reason,
        time: Math.floor(Date.now() / 1000).toString(),
        nonce_str: randomBytes(8).toString("hex"),
      };
      payload.hash = signHupijiao(payload, cfg.appSecret);

      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) form.set(key, value);

      const resp = await fetchImpl(`${endpoint}/payment/refund.html`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        dispatcher: directEgressDispatcher(),
      } as RequestInit & { dispatcher: Dispatcher });

      if (!resp.ok) {
        let body: string | undefined;
        try { body = await resp.text(); } catch { /* ignore body read failure */ }
        throw new HupijiaoError(
          "UPSTREAM_HTTP_ERROR",
          `hupijiao refund http ${resp.status}`,
          body,
          resp.status,
        );
      }

      let json: Record<string, unknown>;
      try {
        json = (await resp.json()) as Record<string, unknown>;
      } catch {
        throw new HupijiaoError("UPSTREAM_BAD_JSON", "hupijiao refund response is not JSON");
      }

      const signParams: SignParams = {};
      for (const [key, value] of Object.entries(json)) {
        if (
          typeof value === "string"
          || typeof value === "number"
          || typeof value === "boolean"
          || value === null
        ) {
          signParams[key] = value;
        }
      }
      if (!verifyHupijiao(signParams, cfg.appSecret)) {
        throw new HupijiaoError(
          "UPSTREAM_SIGNATURE_INVALID",
          "hupijiao refund response signature mismatch",
        );
      }

      const errcode = json.errcode;
      if (errcode !== 0 && errcode !== "0") {
        const msg = typeof json.errmsg === "string" ? json.errmsg : "unknown";
        throw new HupijiaoError(
          `UPSTREAM_${String(errcode)}`,
          `hupijiao refund failed: ${msg}`,
        );
      }

      const orderNo = typeof json.trade_order_id === "string" ? json.trade_order_id : "";
      if (orderNo !== input.orderNo) {
        throw new HupijiaoError(
          "UPSTREAM_ORDER_MISMATCH",
          "hupijiao refund response order mismatch",
        );
      }
      const status = typeof json.refund_status === "string" ? json.refund_status : "";
      if (!["OD", "CD", "RD", "UD"].includes(status)) {
        throw new HupijiaoError(
          "UPSTREAM_REFUND_STATUS_INVALID",
          `hupijiao refund response has invalid status: ${status || "<missing>"}`,
        );
      }

      const providerRefundNo =
        typeof json.out_refund_no === "string" && json.out_refund_no.length > 0
          ? json.out_refund_no
          : null;
      const refundAmountCents = parseRefundFeeToCents(json.refund_fee);
      const safePayload: Record<string, string | number | null> = {
        trade_order_id: orderNo,
        transaction_id: typeof json.transaction_id === "string" ? json.transaction_id : null,
        out_refund_no: providerRefundNo,
        refund_fee:
          typeof json.refund_fee === "string" || typeof json.refund_fee === "number"
            ? json.refund_fee
            : null,
        reason: typeof json.reason === "string" ? json.reason : null,
        refund_status: status,
        refund_time: typeof json.refund_time === "string" ? json.refund_time : null,
        errcode: typeof errcode === "number" || typeof errcode === "string" ? errcode : 0,
        errmsg: typeof json.errmsg === "string" ? json.errmsg : null,
      };
      return {
        orderNo,
        status: status as HupijiaoRefundStatus,
        providerRefundNo,
        refundAmountCents,
        safePayload,
      };
    },
  };
}
