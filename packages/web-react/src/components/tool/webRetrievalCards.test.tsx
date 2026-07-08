/**
 * P2.5 检索富卡单测:
 *   - parseWebSearchResults 纯函数(解析后端结果文本 → 来源列表;失败/空/畸形回落 [])。
 *   - WebSearchResultsCard 渲染来源 + 解析失败回落 null(UX 铁律)。
 *   - oc-web 抽取卡:摘要 + 折叠全文 + JSON 模式元信息;空/出错回落 null。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolLike } from "./format";
import {
  parseWebSearchResults,
  researchToolCard,
  WebSearchResultsCard,
} from "./researchCards";

afterEach(cleanup);

function tool(partial: Partial<ToolLike>): ToolLike {
  return { output: undefined, error: false, ...partial } as ToolLike;
}

// 后端 WebSearchTool.mapToolResultToToolResultBlockParam 的真实文本形状。
const WEB_SEARCH_OUTPUT = `Web search results for query: "抖音运营"

Links:
  - [抖音起号技巧](https://www.toutiao.com/a/1): (2026-01-01) 1.定位账号
  - [算法解析](https://blog.csdn.net/x): 完播率退出核心
  - [无摘要来源](https://zhihu.com/q/9)

REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.`;

describe("parseWebSearchResults", () => {
  test("解析 `- [title](url): snippet` 行 → 来源列表", () => {
    const hits = parseWebSearchResults(WEB_SEARCH_OUTPUT);
    expect(hits).toEqual([
      { title: "抖音起号技巧", url: "https://www.toutiao.com/a/1", snippet: "(2026-01-01) 1.定位账号" },
      { title: "算法解析", url: "https://blog.csdn.net/x", snippet: "完播率退出核心" },
      { title: "无摘要来源", url: "https://zhihu.com/q/9", snippet: undefined },
    ]);
  });

  test("空 / 无结果 / 畸形 → [](回落信号)", () => {
    expect(parseWebSearchResults("")).toEqual([]);
    expect(parseWebSearchResults(null)).toEqual([]);
    expect(parseWebSearchResults("No search results found.")).toEqual([]);
    expect(parseWebSearchResults("随便一段没有链接行的文本\n第二行")).toEqual([]);
  });
});

describe("WebSearchResultsCard", () => {
  test("渲染来源标题 + 域名 + snippet", () => {
    const node = WebSearchResultsCard({ tool: tool({ output: WEB_SEARCH_OUTPUT }) });
    expect(node).not.toBeNull();
    render(<div>{node}</div>);
    expect(screen.getByText("网页搜索")).toBeInTheDocument();
    expect(screen.getByText("3 条来源")).toBeInTheDocument();
    expect(screen.getByText("抖音起号技巧")).toBeInTheDocument();
    // 域名去 www.
    expect(screen.getByText("toutiao.com")).toBeInTheDocument();
    expect(screen.getByText("(2026-01-01) 1.定位账号")).toBeInTheDocument();
    // 标题是可点外链
    const link = screen.getByText("抖音起号技巧").closest("a");
    expect(link).toHaveAttribute("href", "https://www.toutiao.com/a/1");
  });

  test("解析不出结果 → null(回落通用 OutputBlock)", () => {
    expect(WebSearchResultsCard({ tool: tool({ output: "No search results found." }) })).toBeNull();
    expect(WebSearchResultsCard({ tool: tool({ output: undefined }) })).toBeNull();
  });
});

describe("oc-web 抽取卡(researchToolCard)", () => {
  const MD = `# 页面标题\n\n这是抽取出的正文首段,用作摘要展示。\n\n后面还有很多内容段落 A。\n\n段落 B。`;

  test("默认 markdown 输出 → 摘要 + 折叠全文", () => {
    const node = researchToolCard("oc-web extract https://example.com", tool({ output: MD }));
    expect(node).not.toBeNull();
    render(<div>{node}</div>);
    expect(screen.getByText("网页/文档提取")).toBeInTheDocument();
    expect(screen.getByText("查看抽取全文")).toBeInTheDocument();
  });

  test("--json 输出 → 用 markdown 字段 + 域名 + 截断标记", () => {
    const json = JSON.stringify({
      ok: true,
      url: "https://docs.example.com/a",
      final_url: "https://docs.example.com/a",
      markdown: `# 文档\n\n首段摘要。\n\n更多正文。`,
      truncated: true,
    });
    const node = researchToolCard("oc-web extract --json https://docs.example.com/a", tool({ output: json }));
    expect(node).not.toBeNull();
    render(<div>{node}</div>);
    // 域名出现在副标题 + 可点 Chip 两处。
    expect(screen.getAllByText("docs.example.com").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("已截断")).toBeInTheDocument();
  });

  test("空输出 / 出错 → 通用卡兜底(不回落裸终端泄漏 $ command)", () => {
    // 兜底反转:oc-* 命令一律给干净卡(专属卡判空/出错 → GenericOcCard),绝不外露原始命令。
    const empty = researchToolCard("oc-web extract https://x.com", tool({ output: undefined }));
    expect(empty).not.toBeNull();
    const { container } = render(<div>{empty}</div>);
    expect(screen.getByText("网页/文档提取")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(container.textContent).not.toContain("oc-web extract");
    cleanup();
    const errored = researchToolCard("oc-web extract https://x.com", tool({ output: "x", error: true }));
    expect(errored).not.toBeNull();
    render(<div>{errored}</div>);
    expect(screen.getByText("执行失败")).toBeInTheDocument();
  });
});
