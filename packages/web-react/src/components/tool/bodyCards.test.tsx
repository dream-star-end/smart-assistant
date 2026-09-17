/**
 * ToolBody 三处 codex 卡的行为单测(真实会话 payload fixture):
 *   - subAgentActivity:kind 全中文映射 + 用途说明,未知 kind 不外露英文。
 *   - imageView:缩略图带最小显示尺寸(1×1 微图不隐形)。
 *   - imageGeneration:status==='failed' 显式「生成失败」,绝不「图片已生成」。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MediaSignProvider } from "../chat/media";
import { ToolBody } from "./bodies";
import type { ToolLike } from "./format";
import {
  IMAGE_GENERATION_FAILED_PAYLOAD,
  IMAGE_VIEW_PAYLOAD,
  SUB_AGENT_INTERACTED_PAYLOAD,
  SUB_AGENT_STARTED_PAYLOAD,
} from "./__fixtures__/sessionToolTexts";

afterEach(cleanup);

function tool(partial: Partial<ToolLike>): ToolLike {
  return { output: null, error: false, _completed: true, ...partial } as ToolLike;
}

describe("subAgentActivity 卡", () => {
  test("kind=started → 已启动 + 用途说明(不显英文原词)", () => {
    render(<ToolBody name="codex:subAgentActivity" input={{ ...SUB_AGENT_STARTED_PAYLOAD }} tool={tool({})} />);
    expect(screen.getByText("已启动")).toBeInTheDocument();
    expect(screen.getByText(/后台协作线程/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("started");
  });

  test("kind=interacted → 协作中(此前直显英文 interacted)", () => {
    render(<ToolBody name="codex:subAgentActivity" input={{ ...SUB_AGENT_INTERACTED_PAYLOAD }} tool={tool({})} />);
    expect(screen.getByText("协作中")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("interacted");
  });

  test("未知 kind → 「子代理活动」兜底,不外露英文", () => {
    render(<ToolBody name="codex:subAgentActivity" input={{ kind: "some_new_kind" }} tool={tool({})} />);
    expect(screen.getByText("子代理活动")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("some_new_kind");
  });
});

describe("imageView 缩略图最小显示尺寸", () => {
  test("1×1 像素图仍以最小尺寸 + object-contain 渲染(不隐形)", async () => {
    render(
      <MediaSignProvider sign={async (paths) => Object.fromEntries(paths.map((p) => [p, `https://x.test${p}`]))}>
        <ToolBody name="codex:imageView" input={{ ...IMAGE_VIEW_PAYLOAD }} tool={tool({})} />
      </MediaSignProvider>,
    );
    const img = await screen.findByAltText("查看的图片");
    expect(img).toHaveClass("min-h-16", "min-w-16", "object-contain");
  });
});

describe("consult_advisor 卡", () => {
  test("保留型号/人话状态/提问与建议，未知用量不填 0", () => {
    render(
      <ToolBody
        name="mcp__openclaude-memory__consult_advisor"
        input={{ question: "why red?" }}
        tool={tool({
          output: JSON.stringify({
            advice: "partial advice",
            status: "failed",
            advisorModel: "gpt-6-astra",
            error: "quota exceeded",
            durationMs: 45000,
          }),
        })}
      />,
    );
    // 合并取舍(发布预演 t-1279):卡片文案以 canonical OCV5-220 为准(顾问 <型号> · 失败 · 45 秒);
    // 审计 T-27「内部状态词不外露」的断言保留(不出现 failed / settled 原词)。
    expect(screen.getByText("why red?")).toBeInTheDocument();
    expect(screen.getByText(/顾问 gpt-6-astra/)).toBeInTheDocument();
    expect(screen.getByText(/失败/)).toBeInTheDocument();
    expect(screen.getByText(/45 秒/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/状态 failed|\bfailed\b/);
    expect(screen.getByText("partial advice")).toBeInTheDocument();
    expect(screen.getByText("quota exceeded")).toBeInTheDocument();
    expect(screen.getByText(/用量未返回/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("settled");
    expect(document.body.textContent).not.toContain("状态 failed");
    expect(document.body.textContent).not.toMatch(/input_tokens["']?\s*[:=]\s*0/);
  });

  test("进行中显示思考中+已用时+提问，不写未返回", () => {
    render(
      <ToolBody
        name="mcp__openclaude-memory__consult_advisor"
        input={{ question: "边界对吗？", concern: "事务范围" }}
        tool={tool({ _completed: false, output: null, durationMs: 12000 })}
      />,
    );
    expect(screen.getByText("边界对吗？")).toBeInTheDocument();
    expect(screen.getByText(/关注点：事务范围/)).toBeInTheDocument();
    expect(screen.getByText(/顾问思考中/)).toBeInTheDocument();
    expect(screen.getByText(/已用时 12 秒/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("未随工具结果返回");
    expect(document.body.textContent).not.toContain("用量未返回");
  });

  test("settled 显示已完成；无 status 时错误仍可见", () => {
    const { rerender } = render(
      <ToolBody
        name="mcp__openclaude-memory__consult_advisor"
        input={{ question: "ok?" }}
        tool={tool({
          output: JSON.stringify({
            advice: "ship it",
            status: "settled",
            advisorModel: "gpt-6-astra",
            durationMs: 90000,
          }),
        })}
      />,
    );
    expect(screen.getByText(/已完成/)).toBeInTheDocument();
    expect(screen.getByText(/1 分 30 秒/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("settled");
    rerender(
      <ToolBody
        name="mcp__openclaude-memory__consult_advisor"
        input={{ question: "ok?" }}
        tool={tool({
          output: JSON.stringify({ error: "upstream 429" }),
        })}
      />,
    );
    expect(screen.getByText("upstream 429")).toBeInTheDocument();
  });
});

describe("imageGeneration 失败态", () => {
  test("status=failed → 生成失败 danger 行,绝不「图片已生成」", () => {
    render(
      <ToolBody
        name="codex:imageGeneration"
        input={{ ...IMAGE_GENERATION_FAILED_PAYLOAD }}
        tool={tool({ error: true, output: "" })}
      />,
    );
    expect(screen.getByText("生成失败")).toBeInTheDocument();
    expect(screen.queryByText("图片已生成")).toBeNull();
  });

  test("失败原因文本(有则显示)", () => {
    render(
      <ToolBody
        name="codex:imageGeneration"
        input={{ type: "imageGeneration", status: "failed" }}
        tool={tool({ error: true, output: "image generation failed: quota exceeded" })}
      />,
    );
    expect(screen.getByText("生成失败")).toBeInTheDocument();
    expect(screen.getByText(/quota exceeded/)).toBeInTheDocument();
  });
});

describe("TaskBody 隐藏内部指令", () => {
  test("正文只显示短 description，不含 prompt 键名", () => {
    render(
      <ToolBody
        name="Task"
        input={{
          description: "实现会话显示层根治修复",
          prompt: "You are running inside OpenClaude\n/home/agent/.local/bin/host",
          subagentType: { unspecified: {} },
        }}
        tool={tool({})}
      />,
    );
    expect(screen.getByText("实现会话显示层根治修复")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("You are running inside OpenClaude");
    expect(document.body.textContent).not.toContain("subagentType");
    expect(document.body.textContent).not.toContain("/home/agent/.local/bin/host");
  });

  test("没有安全标题时回落「运行子任务」，结果仍可见", () => {
    render(
      <ToolBody
        name="Agent"
        input={{
          prompt: "INTERNAL\nuid=3 HOME=/home/agent",
          subagentType: "generalPurpose",
        }}
        tool={tool({ output: "已完成分析" })}
      />,
    );
    expect(screen.getByText("运行子任务")).toBeInTheDocument();
    expect(screen.getByText("已完成分析")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("INTERNAL");
    expect(document.body.textContent).not.toContain("HOME=");
  });

  test("TaskOutput 空 description → 等待后台命令,不外露内部 call-id(T-27)", () => {
    render(
      <ToolBody
        name="TaskOutput"
        input={{
          task_ids: ["call-7fc87448-146b-411e-973e-a9271d19fe32-63"],
          description: "",
        }}
        tool={tool({ output: "" })}
      />,
    );
    expect(screen.getByText("等待后台命令")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("call-7fc87448");
    expect(document.body.textContent).not.toContain("运行子任务");
  });

  test("Task 有输出时展开体不重复表头那句 description(T-20)", () => {
    render(
      <ToolBody
        name="Task"
        input={{ description: "调研登录流程", prompt: "internal" }}
        tool={tool({ output: "结论:根因在 reducer" })}
      />,
    );
    expect(screen.getByText("结论:根因在 reducer")).toBeInTheDocument();
    expect(screen.queryByText("调研登录流程")).not.toBeInTheDocument();
  });
});
