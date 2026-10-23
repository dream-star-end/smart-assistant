/**
 * 对话写博客（经验分享，OCV5-577 跟进）：blog_draft / blog_status / blog_published 的 schema、图片换算、
 * 发给 Agent 的话、Markdown 降级，以及卡片行为——预检、修复、确认投稿（浏览器侧上传 + 投稿）、
 * 状态卡只认服务端数据、旧版本只读、只读上下文不调接口。
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommunityTutorialMine } from "../../lib/types";
import { type CommunityBlogActions, ChatInteractionContext, ToolCardActionsContext } from "../tool/context";
import { IuiBlock } from "./IuiBlock";
import {
  __resetBlogChatForTests,
  composeFixMessage,
  composeRevisionMessage,
  composeSubmittedMessage,
  fixableIssues,
  latestSubmitted,
  rememberSubmitted,
  submittedFor,
} from "./blogChat";
import { bodyForPrecheck, draftImages, placeholderSha, replaceDraftImages } from "./blogSchema";
import { validateSpec } from "./schema";
import { specToMarkdown } from "./toMarkdown";

vi.mock("../tutorials/blog/blogLib", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tutorials/blog/blogLib")>();
  // jsdom 没有 canvas：压缩直接透传。
  return { ...mod, compressBlogImage: vi.fn(async (blob: Blob) => blob) };
});

afterEach(cleanup);
beforeEach(() => {
  __resetBlogChatForTests();
  localStorage.clear();
});

const SHA = "b".repeat(64);
const BODY = "## 场景\n\n每周一要给团队发数据周报，以前手动复制要四十分钟。\n\n![汇总](/home/agent/outputs/weekly.png)\n\n```md\n![示例](/not/an/image.png)\n```";
const DRAFT = { type: "blog_draft", draft_id: "weekly", version: 2, title: "用定时任务做周报", summary: "记录配置步骤和踩过的坑，供大家参考。", category: "编程", body: BODY, note: "删掉了手机号" };
const block = (o: unknown) => JSON.stringify(o);

function mine(over: Partial<CommunityTutorialMine> = {}): CommunityTutorialMine {
  return {
    id: "12",
    title: "用定时任务做周报",
    summary: "记录配置步骤和踩过的坑，供大家参考。",
    category: "coding",
    bodyMarkdown: "正文",
    status: "pending",
    reviewNote: null,
    createdAt: "2026-10-23T02:42:00Z",
    reviewedAt: null,
    publishedAt: null,
    needsHuman: false,
    ...over,
  };
}

function actionsMock(over: Partial<CommunityBlogActions> = {}): CommunityBlogActions {
  return {
    precheck: vi.fn(async () => ({ issues: [], quota: { pendingLeft: 3, dailyLeft: 5 } })),
    readContainerImage: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
    uploadImage: vi.fn(async () => ({ sha256: SHA })),
    submit: vi.fn(async () => ({ id: "12" })),
    getMine: vi.fn(async () => mine()),
    openPost: vi.fn(),
    openMine: vi.fn(),
    openEditor: vi.fn(),
    ...over,
  };
}

function wrap(node: ReactNode, actions?: CommunityBlogActions, sendUserText?: (t: string) => void) {
  return (
    <ToolCardActionsContext.Provider value={actions ? { communityBlog: actions } : {}}>
      <ChatInteractionContext.Provider value={sendUserText ? { sendUserText } : {}}>{node}</ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>
  );
}

describe("schema 与图片换算", () => {
  test("blog_draft：分类别名、版本、缺 id 时按标题生成稳定 id；缺标题或正文无效", () => {
    const v = validateSpec(DRAFT, false);
    expect(v.ok && v.spec).toMatchObject({ type: "blog_draft", draftId: "weekly", version: 2, category: "coding", note: "删掉了手机号" });
    const a = validateSpec({ ...DRAFT, draft_id: "坏 id!", version: "x" }, false);
    const b = validateSpec({ ...DRAFT, draft_id: undefined, version: 0 }, false);
    expect(a.ok && b.ok && a.spec.type === "blog_draft" && b.spec.type === "blog_draft" && a.spec.draftId === b.spec.draftId).toBe(true);
    expect(a.ok && a.spec.type === "blog_draft" && a.spec.version).toBe(1);
    expect(validateSpec({ ...DRAFT, title: "" }, false).ok).toBe(false);
    expect(validateSpec({ ...DRAFT, body: "  " }, false).ok).toBe(false);
  });

  test("blog_status / blog_published 只收正整数 id", () => {
    expect(validateSpec({ type: "blog_status", id: "#12" }, false)).toMatchObject({ ok: true, spec: { id: "12" } });
    expect(validateSpec({ type: "blog_published", id: 7 }, false)).toMatchObject({ ok: true, spec: { id: "7" } });
    expect(validateSpec({ type: "blog_status", id: "1;drop" }, false).ok).toBe(false);
  });

  test("行内代码里的图片写法不算图片，不上传也不改写（Codex D2 R1）", () => {
    const body = "正文写法示例：`![说明](/example.png)` 和 ``![双](/b.png)``。\n\n![真图](/home/agent/outputs/a.png)";
    expect(draftImages(body).map((i) => i.src)).toEqual(["/home/agent/outputs/a.png"]);
    const replaced = replaceDraftImages(body, () => SHA);
    expect(replaced).toContain("`![说明](/example.png)`");
    expect(replaced).toContain("``![双](/b.png)``");
    expect(replaced).toContain(`![真图](tutorial-blob:${SHA})`);
  });

  test("只认围栏外的容器路径图片；预检用占位 sha；投稿时换成真实 sha", () => {
    const body = `${BODY}\n\n![外链](https://e.com/a.png)\n\n![再引用](/home/agent/outputs/weekly.png)`;
    expect(draftImages(body)).toEqual([{ alt: "汇总", src: "/home/agent/outputs/weekly.png", index: 0 }]);
    const checked = bodyForPrecheck(body);
    expect(checked).toContain(`![汇总](tutorial-blob:${placeholderSha(0)})`);
    expect(checked).toContain("![示例](/not/an/image.png)");
    expect(checked).toContain("![外链](https://e.com/a.png)");
    expect(placeholderSha(0)).toMatch(/^[a-f0-9]{64}$/);
    expect(replaceDraftImages(body, () => SHA).match(new RegExp(SHA, "g"))?.length).toBe(2);
  });
});

describe("发给 Agent 的话 / 本机记录 / Markdown", () => {
  test("修复请求点名草稿与版本；额度问题不发给 Agent", () => {
    const issues = [
      { code: "leak_phone", level: "block" as const, field: "bodyMarkdown", message: "有手机号", where: "「怎么做的」一节" },
      { code: "quota_pending", level: "block" as const, field: "quota", message: "已有 3 篇在审核" },
      { code: "title_length", level: "block" as const, field: "title", message: "标题太短" },
    ];
    const fixable = fixableIssues(issues);
    expect(fixable.map((i) => i.code)).toEqual(["leak_phone", "title_length"]);
    expect(composeFixMessage({ draftId: "weekly", version: 2 }, fixable)).toBe(
      "请按以下修改点更新经验分享草稿（draft_id weekly，当前 v2），改完给我 v3：\n1. 「怎么做的」一节：有手机号\n2. 标题：标题太短",
    );
    expect(composeSubmittedMessage({ draftId: "weekly", version: 2 }, "12")).toContain("稿件 #12");
    expect(composeRevisionMessage("12", "内容包含站外联系方式")).toContain("理由：内容包含站外联系方式");
  });

  test("已投稿记录按草稿 + 版本分别存；存储坏了不抛错", () => {
    rememberSubmitted({ draftId: "a", version: 1, id: "3", at: 1 });
    rememberSubmitted({ draftId: "a", version: 2, id: "4", at: 2 });
    expect(submittedFor("a", 1)).toMatchObject({ id: "3" });
    expect(submittedFor("a", 2)).toMatchObject({ id: "4" });
    expect(latestSubmitted("a")).toMatchObject({ version: 2 });
    localStorage.setItem("oc-blog-chat-submitted", "{bad");
    expect(submittedFor("a", 2)).toBeNull();
  });

  test("降级 Markdown：草稿转文章，状态卡不编造状态", () => {
    const v = validateSpec(DRAFT, false);
    if (!v.ok) throw new Error(v.reason);
    const md = specToMarkdown(v.spec);
    expect(md).toContain("# 用定时任务做周报");
    expect(md).toContain("未投稿");
    const s = validateSpec({ type: "blog_status", id: "12" }, false);
    if (!s.ok) throw new Error(s.reason);
    expect(specToMarkdown(s.spec)).toBe("经验分享稿件 #12：到「经验分享 → 我的投稿」查看审核状态和链接。");
  });
});

describe("草稿卡", () => {
  test("自动预检（正文里的容器图片换成占位）；阻断问题禁用投稿，「修复」把修改点发给 Agent", async () => {
    const actions = actionsMock({
      precheck: vi.fn(async () => ({
        issues: [{ code: "leak_phone", level: "block" as const, field: "bodyMarkdown", message: "有手机号，公开内容里不能出现，删掉或打码", where: "「场景」一节" }],
        quota: { pendingLeft: 3, dailyLeft: 5 },
      })),
    });
    const send = vi.fn();
    render(wrap(<IuiBlock code={block(DRAFT)} />, actions, send));
    await screen.findByText("1 个修改点");
    expect(actions.precheck).toHaveBeenCalledWith(expect.objectContaining({ category: "coding", bodyMarkdown: expect.stringContaining(`tutorial-blob:${placeholderSha(0)}`) }));
    expect(screen.getByRole("button", { name: "确认投稿" })).toBeDisabled();
    expect(screen.getByText("先处理 1 个修改点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^修复：/ }));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("draft_id weekly，当前 v2"));
    expect(screen.getByText("已把修改点发给助手，新版本会出现在下面。")).toBeInTheDocument();
  });

  test("检查通过 → 二次确认 → 浏览器上传图片、换成本站图片后投稿 → 告诉 Agent 稿件号 → 卡片变成状态卡", async () => {
    const actions = actionsMock();
    const send = vi.fn();
    render(wrap(<IuiBlock code={block(DRAFT)} />, actions, send));
    await screen.findByText("检查通过");
    fireEvent.click(screen.getByRole("button", { name: "确认投稿" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("1 张（投稿时自动压缩上传）");
    fireEvent.click(screen.getAllByRole("button", { name: "确认投稿" }).at(-1)!);
    await waitFor(() => expect(actions.submit).toHaveBeenCalled());
    expect(actions.readContainerImage).toHaveBeenCalledWith("/home/agent/outputs/weekly.png");
    const submitted = vi.mocked(actions.submit).mock.calls[0]![0];
    expect(submitted.bodyMarkdown).toContain(`![汇总](tutorial-blob:${SHA})`);
    expect(submitted.bodyMarkdown).toContain("![示例](/not/an/image.png)");
    await waitFor(() => expect(send).toHaveBeenCalledWith(composeSubmittedMessage({ draftId: "weekly", version: 2 }, "12")));
    await screen.findByText("AI 审核中");
    expect(submittedFor("weekly", 2)).toMatchObject({ id: "12" });
  });

  test("投稿失败就地显示原因，不发消息、不记已投稿", async () => {
    const actions = actionsMock({ submit: vi.fn(async () => Promise.reject(new Error("24 小时内最多投稿 5 篇"))) });
    const send = vi.fn();
    render(wrap(<IuiBlock code={block(DRAFT)} />, actions, send));
    await screen.findByText("检查通过");
    fireEvent.click(screen.getByRole("button", { name: "确认投稿" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getAllByRole("button", { name: "确认投稿" }).at(-1)!);
    expect((await screen.findAllByRole("alert")).some((n) => n.textContent?.includes("24 小时内最多投稿 5 篇"))).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(submittedFor("weekly", 2)).toBeNull();
  });

  test("同一 draftId 出了新版本：旧卡只读、不预检；只读上下文和没有登录态时也不调接口", async () => {
    const actions = actionsMock();
    render(
      wrap(
        <>
          <IuiBlock code={block({ ...DRAFT, version: 1 })} />
          <IuiBlock code={block(DRAFT)} />
        </>,
        actions,
        vi.fn(),
      ),
    );
    await screen.findByText("检查通过");
    expect(screen.getByText("已有新版本")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "确认投稿" })).toHaveLength(1);
    expect(actions.precheck).toHaveBeenCalledTimes(1);
    cleanup();
    __resetBlogChatForTests();
    const readonlyActions = actionsMock();
    render(wrap(<IuiBlock code={block(DRAFT)} readOnly />, readonlyActions));
    expect(screen.queryByRole("button", { name: "确认投稿" })).toBeNull();
    expect(readonlyActions.precheck).not.toHaveBeenCalled();
    cleanup();
    render(wrap(<IuiBlock code={block(DRAFT)} />));
    expect(screen.getByText(/登录后可以一键投稿/)).toBeInTheDocument();
  });

  test("v1 投过（被驳回）后，Agent 按理由改的 v2 仍能投；v1 显示自己的状态，更旧的未投版本只读（Codex D2 R1）", async () => {
    rememberSubmitted({ draftId: "weekly", version: 1, id: "11", at: 1 });
    rememberSubmitted({ draftId: "old", version: 3, id: "9", at: 1 });
    const actions = actionsMock({ getMine: vi.fn(async () => mine({ id: "11", status: "rejected", reviewNote: "这里是驳回理由" })) });
    render(
      wrap(
        <>
          <IuiBlock code={block({ ...DRAFT, version: 1 })} />
          <IuiBlock code={block(DRAFT)} />
          <IuiBlock code={block({ ...DRAFT, draft_id: "old", version: 2 })} />
        </>,
        actions,
        vi.fn(),
      ),
    );
    await screen.findByText(/这里是驳回理由/);
    await screen.findByText("检查通过");
    expect(screen.getAllByRole("button", { name: "确认投稿" })).toHaveLength(1);
    expect(screen.getByText("v3 已投稿")).toBeInTheDocument();
  });

  test("只读上下文里已投稿的草稿：状态卡也不查接口、不能发消息（Codex D2 R1）", async () => {
    rememberSubmitted({ draftId: "weekly", version: 2, id: "12", at: 1 });
    const actions = actionsMock();
    render(wrap(<IuiBlock code={block(DRAFT)} readOnly />, actions, vi.fn()));
    await act(async () => {});
    expect(actions.getMine).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /按理由修改/ })).toBeNull();
  });

  test("流式未完成时只显示骨架", () => {
    const { container } = render(wrap(<IuiBlock code={block(DRAFT).slice(0, 80)} live />, actionsMock()));
    expect(container.querySelector(".oc-iui-skeleton")).not.toBeNull();
  });
});

describe("状态卡 / 链接卡只认服务端数据", () => {
  test("Agent 写 blog_published，但服务端说还在 AI 审核：显示审核中，不显示链接", async () => {
    const actions = actionsMock();
    render(wrap(<IuiBlock code={block({ type: "blog_published", id: "12" })} />, actions));
    await screen.findByText("AI 审核中");
    expect(screen.queryByText("已发布到经验分享")).toBeNull();
    expect(actions.getMine).toHaveBeenCalledWith("12");
  });

  test("未通过：显示服务端模板理由，「按理由修改」发给 Agent", async () => {
    const actions = actionsMock({ getMine: vi.fn(async () => mine({ status: "rejected", reviewNote: "内容包含站外联系方式、引流或推广信息。" })) });
    const send = vi.fn();
    render(wrap(<IuiBlock code={block({ type: "blog_status", id: "12" })} />, actions, send));
    await screen.findByText("内容包含站外联系方式、引流或推广信息。");
    fireEvent.click(screen.getByRole("button", { name: /按理由修改/ }));
    expect(send).toHaveBeenCalledWith(composeRevisionMessage("12", "内容包含站外联系方式、引流或推广信息。"));
  });

  test("已发布：链接卡，打开文章 / 查看我的投稿走 App 注入的动作", async () => {
    const actions = actionsMock({ getMine: vi.fn(async () => mine({ status: "approved", publishedAt: "2026-10-23T02:43:00Z" })) });
    render(wrap(<IuiBlock code={block({ type: "blog_status", id: "12" })} />, actions));
    await screen.findByText("已发布到经验分享");
    expect(screen.getByText(/tab=blog/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /打开文章/ }));
    expect(actions.openPost).toHaveBeenCalledWith("12");
    fireEvent.click(screen.getByRole("button", { name: "查看我的投稿" }));
    expect(actions.openMine).toHaveBeenCalled();
  });

  test("只读上下文不查状态", async () => {
    const actions = actionsMock();
    render(wrap(<IuiBlock code={block({ type: "blog_status", id: "12" })} readOnly />, actions));
    await act(async () => {});
    expect(actions.getMine).not.toHaveBeenCalled();
    expect(screen.getByText("经验分享稿件 #12")).toBeInTheDocument();
  });
});
