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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  DETACHED_ASK_USER_TTL_MS,
  PENDING_PERMISSION_TTL_MS,
  PermissionCard,
  resetPermissionAutoOpenMemory,
} from "./PermissionCard";

afterEach(() => {
  cleanup();
  resetPermissionAutoOpenMemory();
});

async function flushAutoOpenMemory(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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

  test("durable decision waiting for Master receipt cannot be submitted twice", () => {
    render(
      <PermissionCard
        msg={askMsg({ _controlPending: true })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("正在提交…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  });

  test("readOnly surface（管理端会话查看）永不弹框", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} readOnly />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("detached ask_user 超过 30min 仍自动弹（24h TTL,换设备回来仍可作答）", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "ask-user:abc123",
          _detachedAskUser: true,
          ts: Date.now() - PENDING_PERMISSION_TTL_MS - 3 * 60 * 60_000,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("detached ask_user 超过 24h 不再自动弹,但手动回答入口仍在", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "ask-user:abc123",
          _detachedAskUser: true,
          ts: Date.now() - DETACHED_ASK_USER_TTL_MS - 60_000,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("PermissionCard 自动弹窗：活提问 vs 历史 vs 重挂", () => {
  test("列表行重挂同一 requestId 不再自动弹，手动回答仍可用", async () => {
    const msg = askMsg({ requestId: "req-remount" });
    const { unmount } = render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await flushAutoOpenMemory();
    unmount();

    render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("历史行 livePrompt=false 永不自动弹，未答仍可点「回答」", () => {
    render(
      <PermissionCard
        msg={askMsg({ requestId: "req-history" })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("等待回答…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("活跃提问 livePrompt 仍会自动弹一次", () => {
    render(
      <PermissionCard
        msg={askMsg({ requestId: "req-live-once" })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("已作答卡展示答案摘要且不弹窗", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-answered",
          _resolved: true,
          _behavior: "allow",
          _answers: { "多人在线的玩法形态选哪种?": "组队合作割草" },
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("→ 组队合作割草")).toBeInTheDocument();
    expect(screen.getByText("已提交")).toBeInTheDocument();
  });

  test("不同 requestId 互不影响，各自仍能自动弹一次", async () => {
    const first = askMsg({ requestId: "req-a" });
    const { unmount } = render(<PermissionCard msg={first} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await flushAutoOpenMemory();
    unmount();

    render(<PermissionCard msg={askMsg({ requestId: "req-b" })} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("PermissionCard 过期判据 _askUserExpiresAt", () => {
  test("有 _askUserExpiresAt 且已过期 → 不自动弹，优先于新鲜 ts", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-exp-abs",
          ts: Date.now(),
          _askUserExpiresAt: Date.now() - 1000,
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("已过期")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("无 _askUserExpiresAt 的旧数据退回 ts+TTL", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-old-ttl",
          ts: Date.now() - PENDING_PERMISSION_TTL_MS - 60_000,
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
  });

  test("_askUserExpiresAt 未到点 → 即使 ts 超过 TTL 也不当过期", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-exp-future",
          _detachedAskUser: true,
          ts: Date.now() - DETACHED_ASK_USER_TTL_MS - 60_000,
          _askUserExpiresAt: Date.now() + 60_000,
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("历史过期卡只读展示，不提供作答按钮", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-hist-exp",
          ts: Date.now(),
          _askUserExpiresAt: Date.now() - 1000,
        })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("已过期")).toBeInTheDocument();
    expect(screen.getByText("提问已过期，无法再作答")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  });
});

function bashPermMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "perm-bash",
    role: "permission",
    text: "权限请求",
    ts: Date.now() - 1_000,
    requestId: "req-bash",
    toolName: "Bash",
    inputJson: { command: "npm run build" },
    inputPreview: '{"command":"npm run build"}',
    _resolved: false,
    ...overrides,
  } as ChatMessage;
}

describe("PermissionCard 工具展示(F5/M7)", () => {
  test("工具名走中文标签(Bash→终端),不再裸英文;状态不再用 emoji", () => {
    render(<PermissionCard msg={bashPermMsg()} onRespond={vi.fn()} livePrompt={false} />);
    expect(screen.getByText("终端")).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("⏳");
    expect(text).not.toContain("✓");
    expect(text).not.toContain("✗");
  });

  test("无 toolName → 「未知工具」而非 'unknown'", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ toolName: undefined, inputJson: undefined, inputPreview: undefined })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.getByText("未知工具")).toBeInTheDocument();
    expect(document.body.textContent || "").not.toContain("unknown");
  });

  test("审批 modal:Bash 结构化展示命令,原始 JSON 收进「查看完整参数」折叠", () => {
    render(<PermissionCard msg={bashPermMsg()} onRespond={vi.fn()} livePrompt />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("npm run build");
    expect(screen.getAllByText("查看完整参数").length).toBeGreaterThanOrEqual(1);
    // 窄屏贴底 sheet(mobile="sheet" 的圆角特征类)
    expect(dialog.className).toContain("rounded-t-2xl");
  });

  test("已解决的卡:参数结构化摘要(命令),不再裸 dump inputPreview", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ _resolved: true, _behavior: "allow" })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(document.body.textContent || "").toContain("npm run build");
    expect(screen.getByText("已允许")).toBeInTheDocument();
  });

  test("mcp 工具名解析为中文标签(打开网页)", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({
          toolName: "mcp__browser__browser_navigate",
          inputJson: { url: "https://example.com" },
          inputPreview: undefined,
        })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    const text = document.body.textContent || "";
    expect(text).not.toContain("mcp__browser__browser_navigate");
    expect(text).toContain("打开网页");
  });
});

describe("AskUserQuestion 选项可及性(M12)", () => {
  test("单选题:radiogroup + role=radio + aria-checked 跟随选中", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(2);
    const first = screen.getByRole("radio", { name: /组队合作割草/ });
    expect(first).toHaveAttribute("aria-checked", "false");
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-checked", "true");
  });

  test("多选题:group + role=checkbox", () => {
    render(
      <PermissionCard
        msg={askMsg({
          inputJson: {
            questions: [
              {
                question: "选择要启用的能力",
                header: "能力",
                multiSelect: true,
                options: [{ label: "检索" }, { label: "生成" }],
              },
            ],
          },
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("checkbox", { name: /检索/ }));
    expect(screen.getByRole("checkbox", { name: /检索/ })).toHaveAttribute("aria-checked", "true");
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
