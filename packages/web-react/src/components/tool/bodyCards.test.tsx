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
