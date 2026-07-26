import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "../ui";
import type { AuthSession, MarketplaceMyPublish } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";

const listSkills = vi.fn();
const listMarketplaceMyPublishes = vi.fn();
const publishMarketplace = vi.fn();
const getPublicModels = vi.fn();
const listMarketplaceInstalled = vi.fn();
const getDeclarativeManagement = vi.fn();
const publishMarketplaceAgent = vi.fn();
const getSkill = vi.fn();
const getSkillFile = vi.fn();
const getSkillEvals = vi.fn();
vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    listSkills: (...a: unknown[]) => listSkills(...a),
    listMarketplaceMyPublishes: (...a: unknown[]) => listMarketplaceMyPublishes(...a),
    publishMarketplace: (...a: unknown[]) => publishMarketplace(...a),
    getPublicModels: (...a: unknown[]) => getPublicModels(...a),
    listMarketplaceInstalled: (...a: unknown[]) => listMarketplaceInstalled(...a),
    getDeclarativeManagement: (...a: unknown[]) => getDeclarativeManagement(...a),
    publishMarketplaceAgent: (...a: unknown[]) => publishMarketplaceAgent(...a),
    getSkill: (...a: unknown[]) => getSkill(...a),
    getSkillFile: (...a: unknown[]) => getSkillFile(...a),
    getSkillEvals: (...a: unknown[]) => getSkillEvals(...a),
  },
}));

import { PublishPanel } from "./PublishPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  getDeclarativeManagement.mockResolvedValue({ connectors: [], connections: [] });
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

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

test("校验失败的错误落在出错字段上(aria-invalid),而不是只在表单顶部飘一条 Alert", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);

  render(<PublishPanel auth={auth} />);
  await screen.findByPlaceholderText("例：学术翻译");
  fillBaseFields();
  fireEvent.click(screen.getByRole("button", { name: /发布到市场/ }));

  // 分类没选 → 分类控件自身被标记为 invalid,且错误文案与它 aria-describedby 关联。
  const category = await screen.findByRole("combobox");
  await waitFor(() => expect(category).toHaveAttribute("aria-invalid", "true"));
  const message = screen.getByText("请为它选择一个分类");
  expect(category.getAttribute("aria-describedby") ?? "").toContain(message.id);
});

test("切换发布类型不丢草稿:写好的 SKILL.md 正文切走再切回仍在", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);
  getPublicModels.mockResolvedValue([{ id: "glm-5.2", displayName: "GLM" }]);
  listMarketplaceInstalled.mockResolvedValue([]);

  render(<PublishPanel auth={auth} />);
  await screen.findByPlaceholderText("例：学术翻译");
  fireEvent.change(screen.getByPlaceholderText(/描述这个技能何时触发/), {
    target: { value: "# 我的技能正文" },
  });

  fireEvent.click(screen.getByRole("tab", { name: "发布智能体" }));
  await screen.findByPlaceholderText("例：法律顾问");
  fireEvent.click(screen.getByRole("tab", { name: "发布技能" }));

  expect(await screen.findByPlaceholderText(/描述这个技能何时触发/)).toHaveValue("# 我的技能正文");
});

test("API 插件展示 AI 创建入口，同时保持 connector kind 的旧调用兼容", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);
  const onCreateInChat = vi.fn();
  render(<PublishPanel auth={auth} onCreateInChat={onCreateInChat} />);
  await screen.findByPlaceholderText("例：学术翻译");

  // 发布类型切换已改用 Tabs 原语(role=tab + roving tabindex + 44px 触控靶),不再是裸 button。
  fireEvent.click(screen.getByRole("tab", { name: "发布插件" }));
  const create = screen.getByRole("button", { name: /在对话中创建 API 连接插件/ });
  expect(create).toBeInTheDocument();
  fireEvent.click(create);
  expect(onCreateInChat).toHaveBeenCalledWith("connector");
  expect(screen.getByText("API 连接插件 · AI 自动审核")).toBeInTheDocument();
  expect(screen.getByText(/当前支持无需运行自定义代码的声明式 API 连接插件/)).toBeInTheDocument();
});

test("智能体可从已安装 Skill / Plugin 选择必需或可选组合能力", async () => {
  listSkills.mockResolvedValue([]);
  listMarketplaceMyPublishes.mockResolvedValue([]);
  getPublicModels.mockResolvedValue([{ id: "glm-5.2", displayName: "GLM" }]);
  listMarketplaceInstalled.mockResolvedValue([
    { slug: "writer-skill", name: "写作 Skill", kind: "skill", listingState: "active" },
    { slug: "paper-plugin", name: "论文 Plugin", kind: "connector", listingState: "active" },
  ]);
  getDeclarativeManagement.mockResolvedValue({
    connectors: [
      {
        slug: "notion",
        label: "Notion",
        description: "官方知识库插件",
        installation: "default",
        official: true,
        available: true,
      },
    ],
    connections: [],
  });

  render(<PublishPanel auth={auth} />);
  await screen.findByPlaceholderText("例：学术翻译");
  fireEvent.click(screen.getByRole("tab", { name: "发布智能体" }));
  const plugin = await screen.findByRole("button", { name: /Plugin · 论文 Plugin/ });
  fireEvent.click(plugin);
  expect(plugin).toHaveTextContent("必需 · Plugin");
  fireEvent.click(plugin);
  expect(plugin).toHaveTextContent("可选 · Plugin");
  fireEvent.click(plugin);
  expect(plugin).not.toHaveTextContent("可选 ·");
  expect(screen.getByRole("button", { name: /Skill · 写作 Skill/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Plugin · Notion/ })).toBeInTheDocument();
});

// ── 覆盖草稿前的二次确认 ──────────────────────────────────────────────────────
// 旧实现用**手写字段白名单**判"草稿是否已被写过":skill 只看 name/description/body/files、
// agent 只看 name/description/persona/capabilityDeps、connector 只看两段 JSON。用户只改过
// 白名单外的字段(版本号 / 标签 / 模型 / 工具集 / 头像 / slug / benchmark…)时,「载入这次
// 提交继续修改」不弹确认、直接覆盖 —— 内容被静默吃掉。下面每条都锁一个当年漏掉的字段。

/** 覆盖确认弹层的正文:出现即代表"覆盖前问过用户"。 */
const OVERWRITE_CONFIRM = "当前表单里已填写的内容会被替换，不可撤销。";

/** 「我的发布」里的 TimeAgo 依赖 TooltipProvider(镜像 main.tsx 的根 Provider 树)。 */
function renderPanel(node: ReactElement) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

function rejectedRow(over: Partial<MarketplaceMyPublish>): MarketplaceMyPublish {
  return {
    versionId: "ver-1",
    slug: "academic-translate",
    kind: "skill",
    version: "1.0.0",
    name: "学术翻译",
    status: "rejected",
    reviewNote: "正文太短",
    createdAt: "2026-07-20T02:00:00.000Z",
    isCurrent: false,
    listingState: "active",
    ...over,
  };
}

test("技能:只改过版本号与标签,载入旧提交前也必须二次确认", async () => {
  listSkills.mockResolvedValue([]);

  renderPanel(<PublishPanel auth={auth} publishes={[rejectedRow({})]} />);
  await screen.findByPlaceholderText("例：学术翻译");

  // 白名单外的两个字段:版本号 + 标签。
  fireEvent.change(screen.getByPlaceholderText("1.0.0"), { target: { value: "2.3.0" } });
  fireEvent.change(screen.getByPlaceholderText("翻译, 学术"), { target: { value: "翻译, 学术" } });

  fireEvent.click(screen.getByRole("button", { name: "载入这次提交继续修改" }));

  expect(await screen.findByText(OVERWRITE_CONFIRM)).toBeInTheDocument();
  // 取消 = 一个字都不许动。
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.getByPlaceholderText("1.0.0")).toHaveValue("2.3.0"));
  expect(screen.getByPlaceholderText("翻译, 学术")).toHaveValue("翻译, 学术");
});

test("智能体:只改过工具集,载入旧提交前也必须二次确认", async () => {
  listSkills.mockResolvedValue([]);
  getPublicModels.mockResolvedValue([{ id: "glm-5.2", displayName: "GLM" }]);
  listMarketplaceInstalled.mockResolvedValue([]);

  renderPanel(
    <PublishPanel auth={auth} publishes={[rejectedRow({ kind: "agent", name: "法律顾问" })]} />,
  );
  await screen.findByPlaceholderText("例：学术翻译");
  fireEvent.click(screen.getByRole("tab", { name: "发布智能体" }));
  await screen.findByPlaceholderText("例：法律顾问");

  fireEvent.click(screen.getByRole("checkbox", { name: /浏览器/ }));

  fireEvent.click(screen.getByRole("button", { name: "载入这次提交继续修改" }));

  expect(await screen.findByText(OVERWRITE_CONFIRM)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: /浏览器/ })).toBeChecked(),
  );
});

test("智能体:模型是系统自动选中的默认项,空白表单不该被当成「已填写」", async () => {
  listSkills.mockResolvedValue([]);
  getPublicModels.mockResolvedValue([{ id: "glm-5.2", displayName: "GLM" }]);
  listMarketplaceInstalled.mockResolvedValue([]);

  renderPanel(
    <PublishPanel auth={auth} publishes={[rejectedRow({ kind: "agent", name: "法律顾问" })]} />,
  );
  await screen.findByPlaceholderText("例：学术翻译");
  fireEvent.click(screen.getByRole("tab", { name: "发布智能体" }));
  // 模型下拉已被系统写入首项(seed) —— 这不是用户填的内容。
  await screen.findByRole("option", { name: "GLM" });

  fireEvent.click(screen.getByRole("button", { name: "载入这次提交继续修改" }));

  await waitFor(() =>
    expect(screen.getByPlaceholderText("例：法律顾问")).toHaveValue("法律顾问"),
  );
  expect(screen.queryByText(OVERWRITE_CONFIRM)).toBeNull();
});

test("插件:只改过版本号,载入旧提交前也必须二次确认", async () => {
  listSkills.mockResolvedValue([]);

  renderPanel(
    <PublishPanel auth={auth} publishes={[rejectedRow({ kind: "connector", name: "我的插件" })]} />,
  );
  await screen.findByPlaceholderText("例：学术翻译");
  fireEvent.click(screen.getByRole("tab", { name: "发布插件" }));

  fireEvent.change(await screen.findByPlaceholderText("1.0.0"), { target: { value: "1.4.2" } });

  fireEvent.click(screen.getByRole("button", { name: "载入这次提交继续修改" }));

  expect(await screen.findByText(OVERWRITE_CONFIRM)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.getByPlaceholderText("1.0.0")).toHaveValue("1.4.2"));
});

test("从我的技能导入:只填过一句话描述也必须先确认(导入会整份覆盖描述与标签)", async () => {
  listSkills.mockResolvedValue([
    { name: "学术翻译", description: "技能自带描述", tags: ["翻译"], writable: true },
  ]);
  getSkill.mockResolvedValue({ body: "# 导入的正文", files: [] });

  render(<PublishPanel auth={auth} />);
  await screen.findByRole("button", { name: "学术翻译" });

  fireEvent.change(screen.getByPlaceholderText(/把中文学术论文翻译成地道英文/), {
    target: { value: "我自己写的描述" },
  });

  fireEvent.click(screen.getByRole("button", { name: "学术翻译" }));

  expect(await screen.findByText(/已填写的名称/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(screen.getByPlaceholderText(/把中文学术论文翻译成地道英文/)).toHaveValue(
      "我自己写的描述",
    ),
  );
  expect(getSkill).not.toHaveBeenCalled();
});
