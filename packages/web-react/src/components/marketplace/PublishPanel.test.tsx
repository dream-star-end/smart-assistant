import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthSession } from "../../lib/types";

const listSkills = vi.fn();
const listMarketplaceMyPublishes = vi.fn();
const publishMarketplace = vi.fn();
vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listSkills: (...a: unknown[]) => listSkills(...a),
    listMarketplaceMyPublishes: (...a: unknown[]) => listMarketplaceMyPublishes(...a),
    publishMarketplace: (...a: unknown[]) => publishMarketplace(...a),
  },
}));

import { PublishPanel } from "./PublishPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = { getToken: () => "tok", setToken: () => {}, onExpired: () => {} };

/** 填好会阻塞人向元数据校验之前的所有基础字段(slug 由英文名联动、正文、描述)。 */
function fillBaseFields() {
  fireEvent.change(screen.getByPlaceholderText("例：学术翻译"), { target: { value: "translate" } });
  fireEvent.change(screen.getByPlaceholderText(/把中文学术论文翻译成地道英文/), {
    target: { value: "把论文翻译成英文" },
  });
  fireEvent.change(screen.getByPlaceholderText(/描述这个技能何时触发/), {
    target: { value: "技能正文内容" },
  });
}

test("缺分类时禁止提交:报错且不调用发布接口", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);

  render(<PublishPanel auth={auth} />);
  // 等表单挂载(listSkills 完成)
  await screen.findByPlaceholderText("例：学术翻译");
  fillBaseFields();
  // 不选分类 → 点发布
  fireEvent.click(screen.getByRole("button", { name: /发布到市场/ }));

  expect(await screen.findByText("请为它选择一个分类")).toBeInTheDocument();
  expect(publishMarketplace).not.toHaveBeenCalled();
});

test("选了分类但没填适用场景 → 报错且不提交", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);

  render(<PublishPanel auth={auth} />);
  await screen.findByPlaceholderText("例：学术翻译");
  fillBaseFields();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "coding-dev" } });
  // 适用场景留空
  fireEvent.click(screen.getByRole("button", { name: /发布到市场/ }));

  expect(await screen.findByText("请至少填写 1 条适用场景")).toBeInTheDocument();
  expect(publishMarketplace).not.toHaveBeenCalled();
});

test("填齐必填(分类+适用场景)→ 提交,请求体带 category/useCases", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);
  publishMarketplace.mockResolvedValue({ ok: true, versionId: "v1", status: "pending", riskFlags: [], note: "" });

  render(<PublishPanel auth={auth} />);
  await screen.findByPlaceholderText("例：学术翻译");
  fillBaseFields();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "coding-dev" } });
  fireEvent.change(screen.getByPlaceholderText(/把中文论文摘要翻译成地道英文并保留术语/), {
    target: { value: "把一段代码重构得更可读" },
  });
  fireEvent.click(screen.getByRole("button", { name: /发布到市场/ }));

  await waitFor(() => expect(publishMarketplace).toHaveBeenCalled());
  const body = publishMarketplace.mock.calls[0][1] as { category?: string; useCases?: string[] };
  expect(body.category).toBe("coding-dev");
  expect(body.useCases).toEqual(["把一段代码重构得更可读"]);
  // 成功后进入完成态
  expect(await screen.findByText("已提交，等待平台审核")).toBeInTheDocument();
});

test("API 插件展示 AI 创建入口，同时保持 connector kind 的旧调用兼容", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);
  const onCreateInChat = vi.fn();
  render(<PublishPanel auth={auth} onCreateInChat={onCreateInChat} />);
  await screen.findByPlaceholderText("例：学术翻译");

  fireEvent.click(screen.getByRole("button", { name: "发布插件" }));
  const create = screen.getByRole("button", { name: /在对话中创建 API 连接插件/ });
  expect(create).toBeInTheDocument();
  fireEvent.click(create);
  expect(onCreateInChat).toHaveBeenCalledWith("connector");
  expect(screen.getByText("API 连接插件 · AI 自动审核")).toBeInTheDocument();
  expect(screen.getByText(/当前支持无需运行自定义代码的声明式 API 连接插件/)).toBeInTheDocument();
});
