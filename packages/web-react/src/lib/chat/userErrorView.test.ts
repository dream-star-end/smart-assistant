import { USER_ERROR_CATALOG } from "@openclaude/protocol/browser";
import { describe, expect, test, vi } from "vitest";
import { resolveUserError } from "./userErrorLookup";
import { errorTechnicalDetails, pickErrorActions, standaloneErrorTitle } from "./userErrorNotice";
import {
  knownUserError,
  readUserError,
} from "./userErrorView";

const wire = {
  code: "model_capacity",
  category: "capacity",
  retryable: true,
  userMessageKey: "errors.model_capacity",
  message: "当前模型访问量较大，请稍后重试，或切换其他模型继续。",
  actions: ["retry", "switch_model"],
};

describe("错误目录映射", () => {
  test("回包带 userError 时正文用它", () => {
    expect(resolveUserError(wire, "something_else").message).toBe(wire.message);
  });

  test("旧服务只给错误码:按 protocol 目录兜底", () => {
    expect(resolveUserError(undefined, "model_capacity")).toEqual(USER_ERROR_CATALOG.model_capacity);
    // 旧网关的大写码 / 展示别名走同一张目录。
    expect(resolveUserError(undefined, "MODEL_CAPACITY").code).toBe("model_capacity");
    expect(resolveUserError(undefined, "PROMPT_TOO_LONG").code).toBe("context_too_long");
  });

  test("残缺的 userError 不采信,退回错误码", () => {
    expect(readUserError({ code: "x", message: "" , actions: [] })).toBeUndefined();
    expect(readUserError({ code: "x", message: "y" })).toBeUndefined();
    expect(resolveUserError({ message: "半截" }, "upstream_timeout")).toEqual(USER_ERROR_CATALOG.upstream_timeout);
  });

  test("未知动作被丢掉,其余字段保留", () => {
    const read = readUserError({ ...wire, actions: ["retry", "rm_rf"] });
    expect(read?.actions).toEqual(["retry"]);
    expect(read?.message).toBe(wire.message);
  });

  test("未知码得到通用人话,正文里没有原始码", () => {
    const ue = resolveUserError(undefined, "ANTIGRAVITY_SAND_SESSION_EXPIRED_X");
    expect(ue.code).toBe("unexpected_error");
    expect(ue.message).not.toMatch(/ANTIGRAVITY|SAND|_/);
  });

  test("HTTP:回包的 userError 才用;通用文案(未知码)不顶替调用方的说法", () => {
    expect(knownUserError(wire)?.message).toBe(wire.message);
    expect(knownUserError(USER_ERROR_CATALOG.unexpected_error)).toBeUndefined();
    expect(knownUserError(undefined)).toBeUndefined();
  });

  test("自动重试终态卡的标题", () => {
    expect(standaloneErrorTitle(USER_ERROR_CATALOG.automatic_retry_exhausted!)).toBe("自动重试已停止");
    expect(standaloneErrorTitle(USER_ERROR_CATALOG.engine_error!)).toBe("这一轮没有完成");
  });
});

describe("建议动作", () => {
  test("按目录顺序取能执行的,最多两个", () => {
    const retry = vi.fn();
    const switchModel = vi.fn();
    const admin = vi.fn();
    const picked = pickErrorActions(["switch_model", "wait", "retry", "contact_admin"], {
      retry: { label: "重试", onClick: retry },
      switch_model: { label: "切换模型", onClick: switchModel },
      contact_admin: { label: "联系管理员", onClick: admin },
    });
    expect(picked.map((a) => a.label)).toEqual(["切换模型", "重试"]);
    picked[1]!.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("没有执行入口的建议不出按钮;同名按钮不重复", () => {
    const go = vi.fn();
    expect(pickErrorActions(["wait", "check_settings"], { retry: { label: "重试", onClick: go } })).toEqual([]);
    expect(pickErrorActions(["retry", "retry"], { retry: { label: "从断点继续", onClick: go } }))
      .toEqual([{ label: "从断点继续", onClick: go }]);
  });
});

describe("技术详情", () => {
  test("码、请求 ID、消息 ID 各一行,重复的请求 ID 不再写一遍", () => {
    expect(errorTechnicalDetails({
      code: "UPSTREAM_FAILED",
      requestId: "0123456789abcdef0123456789abcdef",
      clientMessageId: "m-1",
      detail: "请求 ID：0123456789abcdef0123456789abcdef\n[turn failed: upstream]",
    })).toBe([
      "错误码：UPSTREAM_FAILED",
      "请求 ID：0123456789abcdef0123456789abcdef",
      "消息 ID：m-1",
      "[turn failed: upstream]",
    ].join("\n"));
  });

  test("什么都没有就不出详情", () => {
    expect(errorTechnicalDetails({})).toBeUndefined();
  });
});
