/**
 * T-24 — 虎皮椒 HTTP 客户端。
 *
 * 只实现 "创建预支付订单 → 拿 qrcode_url" 一个接口:
 *   POST https://<endpoint>/api/payment/do.html
 *   form-urlencoded: version=1.1, appid, trade_order_id, total_fee, title, time, notify_url, nonce_str, type=wechat, hash
 *   resp JSON: { errcode:0, hash, ... , url_qrcode?, url? }
 *
 * 退款 / 查询接口暂不接入(T-24 MVP 只需生成订单)。
 *
 * 本模块把具体 HTTP 调用抽成一个 interface `HupijiaoClient`,让上层 handler 能:
 *   - 生产:用 `createHttpHupijiaoClient(cfg)` 真调外部
 *   - 测试:注入一个返回固定 `qrcode_url` 的 mock(避免依赖 sandbox)
 *
 * 签名算法见 `./sign.ts`。
 */

import { randomBytes } from "node:crypto";
import { signHupijiao } from "./sign.js";

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
  /** 扫码链接(weixin://wxpay/bizpayurl?... 或 https://...) */
  qrcodeUrl: string;
  /** 虎皮椒平台订单号(provider_order),便于跨系统对账 */
  providerOrder?: string | null;
  /** 原始响应 JSON,测试 / 审计 / 告警用 */
  raw: Record<string, unknown>;
}

export interface HupijiaoClient {
  createQr(input: CreateQrInput): Promise<CreateQrResult>;
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
      });

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
      const providerOrder = typeof json.open_order_id === "string" ? json.open_order_id : null;
      return { qrcodeUrl, providerOrder, raw: json };
    },
  };
}
