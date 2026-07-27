import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createHttpHupijiaoClient,
  HupijiaoError,
} from "../payment/hupijiao/client.js";
import { signHupijiao } from "../payment/hupijiao/sign.js";

const SECRET = "refund-client-test-secret";

function signedResponse(fields: Record<string, string | number>): Response {
  const body = { ...fields, hash: signHupijiao(fields, SECRET) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Hupijiao refund client", () => {
  test("按官方字段签名并解析 CD，安全 payload 不含 hash", async () => {
    let requestBody = "";
    const client = createHttpHupijiaoClient(
      {
        appId: "app-1",
        appSecret: SECRET,
        notifyUrl: "https://example.test/callback",
        endpoint: "https://pay.example.test",
      },
      async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return signedResponse({
          errcode: 0,
          errmsg: "success",
          trade_order_id: "ORDER-1",
          transaction_id: "TX-1",
          out_refund_no: "RF-1",
          refund_fee: "10.00",
          refund_status: "CD",
          refund_time: "2026-07-27 09:00",
        });
      },
    );

    const result = await client.refund!({ orderNo: "ORDER-1", reason: "用户申请退款" });
    const form = new URLSearchParams(requestBody);
    assert.equal(form.get("appid"), "app-1");
    assert.equal(form.get("trade_order_id"), "ORDER-1");
    assert.equal(form.get("reason"), "用户申请退款");
    assert.equal(form.get("hash")?.length, 32);
    assert.equal(result.status, "CD");
    assert.equal(result.providerRefundNo, "RF-1");
    assert.equal("hash" in result.safePayload, false);
  });

  test("响应签名不匹配 fail-closed", async () => {
    const client = createHttpHupijiaoClient(
      {
        appId: "app-1",
        appSecret: SECRET,
        notifyUrl: "https://example.test/callback",
      },
      async () =>
        new Response(
          JSON.stringify({
            errcode: 0,
            trade_order_id: "ORDER-1",
            refund_status: "CD",
            hash: "0".repeat(32),
          }),
          { status: 200 },
        ),
    );

    await assert.rejects(
      client.refund!({ orderNo: "ORDER-1", reason: "退款" }),
      (err: unknown) =>
        err instanceof HupijiaoError && err.code === "UPSTREAM_SIGNATURE_INVALID",
    );
  });

  test("签名有效但订单号不匹配仍 fail-closed", async () => {
    const client = createHttpHupijiaoClient(
      {
        appId: "app-1",
        appSecret: SECRET,
        notifyUrl: "https://example.test/callback",
      },
      async () =>
        signedResponse({
          errcode: 0,
          trade_order_id: "OTHER",
          refund_status: "CD",
        }),
    );

    await assert.rejects(
      client.refund!({ orderNo: "ORDER-1", reason: "退款" }),
      (err: unknown) =>
        err instanceof HupijiaoError && err.code === "UPSTREAM_ORDER_MISMATCH",
    );
  });
});
