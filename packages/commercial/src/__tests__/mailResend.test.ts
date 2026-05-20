/**
 * createResendMailer 单测。
 *
 * 通过 ResendMailerOptions.fetchImpl 注入 fake fetch,验证:
 *   - 调用 URL = https://api.resend.com/emails
 *   - method = POST
 *   - Authorization header = Bearer <apiKey>
 *   - content-type = application/json
 *   - body schema:{ from, to: [msg.to], subject, text }
 *   - 200 → resolve(成功)
 *   - 4xx / 5xx → reject,错误信息含 status code
 *   - timeout 触发 AbortController.abort()(signal 被传入 fetch)
 *
 * 不真发 HTTP,不依赖 PG/Redis,unit 范畴。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createResendMailer } from "../auth/mail.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(response: Response): {
  fetchImpl: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({ url, init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { fetchImpl, captured };
}

describe("auth.mail.createResendMailer", () => {
  test("success: posts correct URL / headers / body and resolves", async () => {
    const { fetchImpl, captured } = makeFakeFetch(
      new Response(JSON.stringify({ id: "msg_abc123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const mailer = createResendMailer({
      apiKey: "re_test_key_xyz",
      from: "OpenClaude <auth@claudeai.chat>",
      fetchImpl,
    });

    await mailer.send({
      to: "user@example.com",
      subject: "Verify your email",
      text: "https://claudeai.chat/verify?token=abc",
    });

    assert.equal(captured.length, 1);
    const req = captured[0];

    assert.equal(req.url, "https://api.resend.com/emails");
    assert.equal(req.init.method, "POST");

    const headers = req.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer re_test_key_xyz");
    assert.equal(headers["content-type"], "application/json");

    assert.ok(typeof req.init.body === "string", "body should be a JSON string");
    const body = JSON.parse(req.init.body as string);
    assert.deepEqual(body, {
      from: "OpenClaude <auth@claudeai.chat>",
      to: ["user@example.com"],
      subject: "Verify your email",
      text: "https://claudeai.chat/verify?token=abc",
    });

    // AbortSignal 应被传入(由 AbortController 内部生成)
    assert.ok(req.init.signal, "fetch should be called with an AbortSignal");
  });

  test("4xx: rejects with status in message", async () => {
    const { fetchImpl } = makeFakeFetch(
      new Response("Invalid API key", {
        status: 401,
        statusText: "Unauthorized",
      }),
    );

    const mailer = createResendMailer({
      apiKey: "re_bad_key",
      from: "auth@claudeai.chat",
      fetchImpl,
    });

    await assert.rejects(
      mailer.send({ to: "u@example.com", subject: "s", text: "t" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /resend send failed: 401/);
        assert.match(err.message, /Invalid API key/);
        return true;
      },
    );
  });

  test("5xx: rejects with status in message", async () => {
    const { fetchImpl } = makeFakeFetch(
      new Response("upstream gateway error", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const mailer = createResendMailer({
      apiKey: "re_test",
      from: "auth@claudeai.chat",
      fetchImpl,
    });

    await assert.rejects(
      mailer.send({ to: "u@example.com", subject: "s", text: "t" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /resend send failed: 502/);
        return true;
      },
    );
  });

  test("timeout: AbortController aborts fetch when fetch never resolves", async () => {
    // fakeFetch 永不 resolve,但 signal.aborted 被设置时 reject AbortError
    const fetchImpl = ((_input: unknown, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as typeof fetch;

    const mailer = createResendMailer({
      apiKey: "re_test",
      from: "auth@claudeai.chat",
      fetchImpl,
      timeoutMs: 30, // 设极短 timeout 验证 abort 路径
    });

    await assert.rejects(
      mailer.send({ to: "u@example.com", subject: "s", text: "t" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, "AbortError");
        return true;
      },
    );
  });
});
