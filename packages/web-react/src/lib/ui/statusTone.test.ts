import { describe, expect, it } from "vitest";
import {
  NOTICE_TONES,
  SIDEBAR_DOT_STATUS,
  STATUS,
  doneLabel,
  failedLabel,
  needsYouLabel,
  retryingLabel,
  runningLabel,
} from "./statusTone";

describe("状态语义表(UI-SPEC §4.3)", () => {
  it("色调与规格一致", () => {
    expect(
      Object.fromEntries(Object.entries(STATUS).map(([kind, spec]) => [kind, spec.tone])),
    ).toEqual({
      queued: "idle",
      running: "running",
      background: "running",
      needs_you: "attention",
      retrying: "attention",
      done: "idle",
      stopped: "idle",
      failed: "failed",
      disconnected: "attention",
      unread: "running",
      service_restart: "attention",
    });
    expect(STATUS.done.iconTone).toBe("done");
    expect(STATUS.stopped.filled).toBe(true);
  });

  it("带变量的文案", () => {
    expect(runningLabel("写 Q4 汇报.pptx")).toBe("正在写 Q4 汇报.pptx");
    expect(runningLabel("  ")).toBe("运行中");
    expect(needsYouLabel("answer")).toBe("等你回答");
    expect(needsYouLabel("approval")).toBe("等你批准");
    expect(retryingLabel(2, 3)).toBe("正在自动重试（第 2 次，共 3 次）");
    expect(doneLabel("3 分 04 秒")).toBe("完成 · 3 分 04 秒");
    expect(doneLabel()).toBe("完成");
    expect(failedLabel("模型服务暂时不可用")).toBe("没完成：模型服务暂时不可用");
  });

  it("侧栏点映射到语义状态", () => {
    expect(SIDEBAR_DOT_STATUS).toEqual({
      running: "running",
      unread: "unread",
      error: "failed",
      service_restart: "service_restart",
    });
  });

  it("Notice 语气与状态表同源", () => {
    expect(NOTICE_TONES.failed.icon).toBe(STATUS.failed.icon);
    expect(NOTICE_TONES.stopped.icon).toBe(STATUS.stopped.icon);
    expect(NOTICE_TONES.stopped.filled).toBe(true);
    expect(NOTICE_TONES.progress).toMatchObject({ tone: "running", icon: null, breathe: true });
  });
});
