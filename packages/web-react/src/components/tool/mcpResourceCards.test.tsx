/**
 * codex MCP 资源清单卡单测:空态友好文案(不裸 JSON)、非空行卡、解析失败回退 null。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LIST_MCP_RESOURCES_TEXT, LIST_MCP_RESOURCE_TEMPLATES_TEXT } from "./__fixtures__/sessionToolTexts";
import { parseMcpResources, renderMcpResourcesCard } from "./mcpResourceCards";

afterEach(cleanup);

describe("parseMcpResources", () => {
  test("空 resources / templates 数组仍解析成功(空态由渲染层出)", () => {
    expect(parseMcpResources(LIST_MCP_RESOURCES_TEXT)).toEqual({ kind: "resources", items: [] });
    expect(parseMcpResources(LIST_MCP_RESOURCE_TEMPLATES_TEXT)).toEqual({ kind: "templates", items: [] });
  });

  test("非资源 JSON / 非 JSON → null", () => {
    expect(parseMcpResources('{"foo":1}')).toBeNull();
    expect(parseMcpResources("plain text")).toBeNull();
    expect(parseMcpResources("")).toBeNull();
  });
});

describe("renderMcpResourcesCard", () => {
  test("空 resources → 友好空态(不裸露 {\"resources\":[]})", () => {
    const { container } = render(<div>{renderMcpResourcesCard(LIST_MCP_RESOURCES_TEXT)}</div>);
    expect(screen.getByText("没有已注册的 MCP 资源")).toBeInTheDocument();
    expect(container.textContent).not.toContain("resources");
  });

  test("空 templates → 模板专属空态文案", () => {
    render(<div>{renderMcpResourcesCard(LIST_MCP_RESOURCE_TEMPLATES_TEXT)}</div>);
    expect(screen.getByText("没有可用的 MCP 资源模板")).toBeInTheDocument();
  });

  test("非空:逐条资源行卡(name/uri/description)", () => {
    const text = JSON.stringify({
      resources: [{ name: "项目文档", uri: "file:///docs/readme.md", description: "仓库说明" }],
    });
    render(<div>{renderMcpResourcesCard(text)}</div>);
    expect(screen.getByText("项目文档")).toBeInTheDocument();
    expect(screen.getByText("file:///docs/readme.md")).toBeInTheDocument();
    expect(screen.getByText("仓库说明")).toBeInTheDocument();
  });

  test("解析失败 → null(回退 OutputBlock)", () => {
    expect(renderMcpResourcesCard("not json")).toBeNull();
  });
});
