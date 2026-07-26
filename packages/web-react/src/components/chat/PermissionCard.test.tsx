/**
 * PermissionCard：孤儿待决卡不得再强行弹框。
 *
 * 背景（boss 07-26 实报「为什么反复弹这个问答」）：permission 卡被刻意排除在服务端 tape 之外
 * （persist.ts §⑦），只活在客户端 IndexedDB；而「是否已解决」的权威在 gateway 内存里，受
 * PENDING_PERMISSION_TTL_MS + session 回收约束。断线期间服务端 force-deny 广播的 settled 帧
 * 若没送达（ring 已轮转 / session 已回收），本地就永久留下一张 `_resolved=false` 的卡 ——
 * 此后每次挂载都被「挂载即弹」的 effect 强行打开，形成永久骚扰。
 *
 * 修法：超过服务端 TTL 的未决卡视为孤儿，不再自动弹；但手动回答入口必须保留（fail-safe）。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { PENDING_PERMISSION_TTL_MS, PermissionCard } from "./PermissionCard";

afterEach(cleanup);

function askMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "p1",
    role: "permission",
    text: "用户问答",
    ts: Date.now() - 1_000,
    requestId: "req-1",
    toolName: "AskUserQuestion",
    inputJson: {
      questions: [
        {
          question: "多人在线的玩法形态选哪种?",
          header: "多人模式",
          options: [{ label: "组队合作割草" }, { label: "PvPvE 竞技" }],
        },
      ],
    },
    _resolved: false,
    ...overrides,
  } as ChatMessage;
}

describe("PermissionCard 自动弹框的存活边界", () => {
  test("未决且在 TTL 内 → 挂载即自动弹（agent 确实还在等,不能不提醒）", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("用户问答", { selector: "h2, h3, [role='heading']" })).toBeInTheDocument();
  });

  test("未决但已超过服务端 TTL → 不再自动弹（孤儿卡,服务端早已 force-deny）", () => {
    render(
      <PermissionCard
        msg={askMsg({ ts: Date.now() - PENDING_PERMISSION_TTL_MS - 60_000 })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // 卡片本身与状态必须仍在 —— 只是不打断用户。
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
  });

  test("孤儿卡仍保留手动回答入口（本地时钟偏差误判时不能锁死用户）", () => {
    render(
      <PermissionCard
        msg={askMsg({ ts: Date.now() - PENDING_PERMISSION_TTL_MS - 60_000 })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("已解决的卡永不自动弹,不受时间影响", () => {
    render(
      <PermissionCard
        msg={askMsg({ _resolved: true, _behavior: "allow", ts: Date.now() - 1_000 })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("readOnly surface（管理端会话查看）永不弹框", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} readOnly />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("跨包契约", () => {
  // 前端改不动 gateway 常量（那是容器内源码面 / runtime release 轴），只能镜像。数值一旦漂移,
  // 孤儿判定就会与服务端 sweep 错位:偏大 → 骚扰窗口回来;偏小 → 真正在等的 agent 被静默。
  // 断言语义值相等,不锁字面排列（锁排列 = 重构必红 = 红灯贬值）。
  test("前端 TTL 必须等于 gateway 的 PENDING_PERMISSION_TTL_MS", () => {
    // vitest 下 import.meta.url 不是 file: scheme（vite 模块运行时），改从 cwd 向上找仓根 ——
    // CI 从仓根跑、本地从 packages/web-react 跑,两种 cwd 都要成立。
    const rel = join("packages", "gateway", "src", "server.ts");
    let dir = process.cwd();
    let serverPath = "";
    for (let i = 0; i < 6 && !serverPath; i += 1) {
      if (existsSync(join(dir, rel))) serverPath = join(dir, rel);
      else dir = dirname(dir);
    }
    expect(serverPath, `未能从 ${process.cwd()} 向上定位 ${rel}`).toBeTruthy();
    const serverSrc = readFileSync(serverPath, "utf8");
    const matched = /PENDING_PERMISSION_TTL_MS\s*=\s*([0-9_\s*]+)/.exec(serverSrc);
    expect(matched, "gateway 侧 PENDING_PERMISSION_TTL_MS 定义未找到（被改名?）").toBeTruthy();

    // 只支持乘法字面量（当前形态 `30 * 60_000`）。若 gateway 换成别的表达式,这里会红 —— 那是
    // 需要人工确认语义的信号,不是脆断言。
    const factors = matched![1].replace(/_/g, "").split("*").map((s) => Number(s.trim()));
    expect(factors.every((n) => Number.isFinite(n))).toBe(true);
    const serverTtl = factors.reduce((a, b) => a * b, 1);

    expect(serverTtl).toBe(PENDING_PERMISSION_TTL_MS);
  });
});
