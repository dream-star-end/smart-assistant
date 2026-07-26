import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, AutoDreamReportResponse, MemoryFileMeta } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { MemoryPanel } from "./MemoryPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

const agents = [{ id: "main", name: "全能助手" }];

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

/** 镜像 main.tsx 的根 Provider 树：TimeAgo 走 Tooltip，写操作反馈走 useToast。 */
function renderPanel(ui: ReactElement = <MemoryPanel auth={auth} agentId="main" agents={agents} />) {
  return render(
    <TooltipProvider>
      <ToastProvider>{ui}</ToastProvider>
    </TooltipProvider>,
  );
}

/** 造核心记忆索引响应（GET .../memory/memory）。 */
function mockIndex(files: Partial<MemoryFileMeta>[], text = "<!-- oc-memdir-index v1 -->") {
  if (!vi.isMockFunction(api.getAutoDreamReport)) mockDream();
  return vi.spyOn(api, "getMemoryIndex").mockResolvedValue({
    kind: "index",
    text,
    files: files.map((f, i) => ({
      file: f.file ?? `mem-${i}.md`,
      name: f.name ?? "",
      description: f.description ?? "",
      type: f.type ?? "project",
      mtimeMs: f.mtimeMs ?? Date.now(),
      size: f.size ?? 100,
    })),
    version: "idx1",
  });
}

function mockDream(value: AutoDreamReportResponse = { status: "idle", pendingSessions: 0 }) {
  return vi.spyOn(api, "getAutoDreamReport").mockResolvedValue(value);
}

/** 造用户画像响应（GET .../memory/user）——只有切到「用户画像」分段才会真取。 */
function mockUser(text = "") {
  return vi.spyOn(api, "getMemory").mockResolvedValue({ target: "user", text, version: "u1", limit: 4000 });
}

/** 切到用户画像分段（二级 Tabs）。 */
function openProfileTab() {
  fireEvent.click(screen.getByRole("tab", { name: "用户画像" }));
}

describe("MemoryPanel · 核心记忆文件列表", () => {
  test("渲染为文件列表：name / description / type 徽标 / 相对时间 / 条数，且不暴露文件名", async () => {
    mockIndex([
      { file: "dark-mode.md", name: "深色模式偏好", description: "喜欢深色模式与简洁回答", type: "user", mtimeMs: Date.now() - 3_600_000 },
      { file: "proj-aurora.md", name: "Aurora 项目", description: "v5 商业版重构", type: "project", mtimeMs: Date.now() - 2 * 86_400_000 },
    ]);

    renderPanel();

    expect(await screen.findByText("深色模式偏好")).toBeInTheDocument();
    expect(screen.getByText("喜欢深色模式与简洁回答")).toBeInTheDocument();
    expect(screen.getByText("Aurora 项目")).toBeInTheDocument();
    // type 徽标
    expect(screen.getByText("用户偏好")).toBeInTheDocument();
    expect(screen.getByText("项目")).toBeInTheDocument();
    expect(screen.getByText("2 条记忆")).toBeInTheDocument();
    // 相对时间(1 小时前)
    expect(screen.getByText(/1 小时前/)).toBeInTheDocument();
    // memdir 的文件心智不再透给终端用户：卡面不出现 .md 文件名
    expect(screen.queryByText("dark-mode.md")).not.toBeInTheDocument();
  });

  test("记忆索引以「智能体看到的记忆索引」呈现，且是可聚焦的只读区域", async () => {
    mockIndex([{ file: "a.md", name: "A" }], "<!-- oc-memdir-index v1 -->\n- [A](memory/a.md) — 钩子一句话");

    renderPanel();
    fireEvent.click(await screen.findByText(/智能体看到的记忆索引/));
    const pre = screen.getByLabelText("记忆索引原文");
    expect(pre).toHaveTextContent("钩子一句话");
    expect(pre).toHaveAttribute("tabindex", "0");
    // 文案层不再出现仓库实现词汇
    expect(screen.queryByText(/MEMORY\.md/)).not.toBeInTheDocument();
  });

  test("空记忆走 EmptyState：图标 + 说明 + 唯一的新建 CTA", async () => {
    mockIndex([]);
    renderPanel();
    expect(await screen.findByText("还没有核心记忆")).toBeInTheDocument();
    // 空态只留一个入口，不与列表头的「新建记忆」并列
    expect(screen.getAllByRole("button", { name: /新建记忆/ })).toHaveLength(1);
  });

  test("加载失败给出重试出口，且不并排渲染空列表", async () => {
    const index = vi.spyOn(api, "getMemoryIndex").mockRejectedValue(new ApiError({ status: 500, message: "boom" }));
    mockDream();

    renderPanel();
    const retry = await screen.findByRole("button", { name: "重试" });
    expect(screen.queryByText("还没有核心记忆")).not.toBeInTheDocument();

    index.mockResolvedValue({
      kind: "index",
      text: "",
      files: [{ file: "ok.md", name: "恢复", description: "", type: "project", mtimeMs: Date.now(), size: 1 }],
      version: "idx2",
    });
    fireEvent.click(retry);
    expect(await screen.findByText("恢复")).toBeInTheDocument();
  });

  test("超过 6 条时出现搜索与类型分组，过滤后计数改为 N / M", async () => {
    mockIndex([
      { file: "a.md", name: "偏好一", type: "user" },
      { file: "b.md", name: "偏好二", type: "user" },
      { file: "c.md", name: "项目一", type: "project" },
      { file: "d.md", name: "项目二", type: "project" },
      { file: "e.md", name: "参考一", type: "reference" },
      { file: "f.md", name: "参考二", type: "reference" },
      { file: "g.md", name: "反馈一", type: "feedback" },
    ]);

    renderPanel();
    expect(await screen.findByText("7 条记忆")).toBeInTheDocument();
    const box = screen.getByLabelText("搜索核心记忆");
    fireEvent.change(box, { target: { value: "项目" } });

    expect(await screen.findByText("2 / 7 条记忆")).toBeInTheDocument();
    expect(screen.getByText("项目一")).toBeInTheDocument();
    expect(screen.queryByText("偏好一")).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: "查无此忆" } });
    expect(await screen.findByText("没有匹配的记忆")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(await screen.findByText("7 条记忆")).toBeInTheDocument();
  });

  test("梦境报告显示实际变化、会话数与进度，且可直达仍存在的记忆", async () => {
    mockDream({
      status: "success",
      pendingSessions: 2,
      lastReport: {
        status: "success",
        finishedAt: new Date(Date.now() - 60_000).toISOString(),
        sessionsReviewed: 5,
        summary: "提炼长期偏好并清理重复信息",
        created: [
          {
            file: "created.md",
            action: "created",
            type: "project",
          },
        ],
        updated: [
          {
            file: "updated.md",
            action: "updated",
            type: "user",
          },
        ],
        deleted: [
          {
            file: "deleted.md",
            action: "deleted",
            type: "reference",
          },
        ],
      },
    });
    mockIndex([
      { file: "created.md", name: "新项目背景", type: "project" },
      { file: "updated.md", name: "当前偏好", type: "user" },
    ]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "偏好正文", version: "fv1" });

    renderPanel();

    const report = await screen.findByRole("region", { name: "Auto-Dream 梦境报告" });
    expect(within(report).getByText(/新增 1 条、更新 1 条、清理 1 条/)).toBeInTheDocument();
    expect(within(report).getByText(/已参考 5 个近期会话/)).toBeInTheDocument();
    expect(within(report).getByText(/已积累 2 个新会话/)).toBeInTheDocument();
    // 变更行按记忆**名称**呈现（存量记忆解析得到 name），不再打印 .md 文件名
    expect(within(report).getByText("当前偏好")).toBeInTheDocument();
    expect(within(report).getByText("deleted")).toBeInTheDocument();
    expect(report).not.toHaveTextContent(/DeepSeek|整理模型|model/i);

    fireEvent.click(within(report).getByRole("button", { name: /当前偏好/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.getMemoryFile).toHaveBeenCalledWith(auth, "main", "updated.md");
  });

  test("无变化的成功报告也明确说明未扣出一堆不可见结果", async () => {
    mockDream({
      status: "success",
      pendingSessions: 0,
      lastReport: {
        status: "success",
        finishedAt: new Date().toISOString(),
        sessionsReviewed: 5,
        summary: "没有新的稳定信息",
        created: [],
        updated: [],
        deleted: [],
      },
    });
    mockIndex([]);

    renderPanel();
    const report = await screen.findByRole("region", { name: "Auto-Dream 梦境报告" });
    expect(within(report).getByText(/没有发现值得长期保存的新信息/)).toBeInTheDocument();
  });

  test("中断且结果不确定时不谎称记忆一定没有改动", async () => {
    mockDream({
      status: "failed",
      pendingSessions: 5,
      lastReport: {
        status: "failed",
        finishedAt: new Date().toISOString(),
        sessionsReviewed: 4,
        summary: "整理被中断，无法确认记忆是否发生变化，请查看记忆列表。",
        created: [],
        updated: [],
        deleted: [],
      },
    });
    mockIndex([]);

    renderPanel();
    const report = await screen.findByRole("region", { name: "Auto-Dream 梦境报告" });
    expect(within(report).getByText(/无法确认记忆是否发生变化/)).toBeInTheDocument();
    expect(within(report).queryByText(/记忆没有改动/)).not.toBeInTheDocument();
  });

  test("容器冷启动连续两次 503 后按 3s + 7s 退避，等待期给出解释，记忆与梦境报告自动恢复", async () => {
    vi.useFakeTimers();
    const transient = () => new ApiError({ status: 503, message: "container starting", retryAfterSec: 0 });
    const index = vi
      .spyOn(api, "getMemoryIndex")
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue({
        kind: "index",
        text: "<!-- oc-memdir-index v1 -->",
        files: [
          {
            file: "recovered.md",
            name: "冷启动后恢复的记忆",
            description: "重试成功",
            type: "project",
            mtimeMs: Date.now(),
            size: 100,
          },
        ],
        version: "idx-recovered",
      });
    const dream = vi
      .spyOn(api, "getAutoDreamReport")
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue({ status: "idle", pendingSessions: 0 });

    renderPanel();
    await act(async () => Promise.resolve());
    expect(index).toHaveBeenCalledTimes(1);
    expect(dream).toHaveBeenCalledTimes(1);
    // 冷启等待不再是一个无解释的转圈
    expect(screen.getByText(/正在唤醒你的智能体/)).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(index).toHaveBeenCalledTimes(2);
    expect(dream).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(7_000));
    expect(index).toHaveBeenCalledTimes(3);
    expect(dream).toHaveBeenCalledTimes(3);
    expect(screen.getByText("冷启动后恢复的记忆")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Auto-Dream 梦境报告" })).toHaveTextContent(
      "还没有整理过",
    );
  });
});

describe("MemoryPanel · 单文件查看/编辑", () => {
  test("点开记忆卡 → 表单化字段（frontmatter 不外露）并带 version 保存", async () => {
    mockIndex([{ file: "note.md", name: "笔记", description: "d" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({
      content: "---\nname: 笔记\ndescription: 何时召回\ntype: project\n---\n\n正文A",
      version: "fv1",
    });
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "fv2" });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));

    const dialog = await screen.findByRole("dialog");
    // 结构化字段：名称 / 召回描述 / 类型芯片 / 正文；正文框里没有 --- 前置块
    expect((await within(dialog).findByLabelText(/记忆名称/)) as HTMLInputElement).toHaveValue("笔记");
    expect(within(dialog).getByLabelText(/什么时候该想起它/)).toHaveValue("何时召回");
    expect(within(dialog).getByRole("button", { name: "项目" })).toHaveAttribute("aria-pressed", "true");
    const box = within(dialog).getByLabelText(/记忆内容/) as HTMLTextAreaElement;
    expect(box.value).toBe("正文A");
    expect(dialog).not.toHaveTextContent("frontmatter");

    fireEvent.change(box, { target: { value: "正文B" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("note.md");
    expect(put.mock.calls[0][3]).toContain("正文B");
    expect(put.mock.calls[0][3]).toContain("name: 笔记");
    expect(put.mock.calls[0][4]).toBe("fv1"); // 载入版本作乐观锁令牌
  });

  test("「编辑源码」开关切回整份 md（高级出口，默认不暴露）", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({
      content: "---\nname: 笔记\n---\n\n正文A",
      version: "fv1",
    });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByLabelText(/记忆名称/);

    expect(within(dialog).queryByLabelText("记忆源码")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText("编辑源码"));
    expect(within(dialog).getByLabelText("记忆源码")).toHaveValue("---\nname: 笔记\n---\n\n正文A");
  });

  test("P0：正文加载失败不渲染编辑器，只给重试出口，且不发出 PUT", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    const get = vi.spyOn(api, "getMemoryFile").mockRejectedValue(new ApiError({ status: 503, message: "cold" }));
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "fv2" });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText(/没能读到这条记忆的内容/)).toBeInTheDocument();
    // 编辑器整体不渲染：没有任何可编辑控件可以敲进内容
    expect(within(dialog).queryByLabelText(/记忆内容/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("记忆源码")).not.toBeInTheDocument();
    // 保存钮禁用，点了也不会发 PUT
    const saveBtn = within(dialog).getByRole("button", { name: "保存" });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(put).not.toHaveBeenCalled();

    // 重试出口可用
    get.mockResolvedValue({ content: "真实正文", version: "fv1" });
    fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
    expect(await within(dialog).findByDisplayValue("真实正文")).toBeInTheDocument();
  });

  test("P0：version 缺失时敲字并点保存也绝不发出 PUT（无 If-Match 写入 = 覆盖真实记忆）", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    // 正文读到了但服务端没给 version（乐观锁令牌缺失）——此时任何写入都是盲覆盖。
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "服务端真实正文", version: "" });
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "fv2" });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));
    const dialog = await screen.findByRole("dialog");

    const box = (await within(dialog).findByDisplayValue("服务端真实正文")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "刚敲的几个字" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(within(dialog).getByText(/内容尚未加载完成/)).toBeInTheDocument(),
    );
    expect(put).not.toHaveBeenCalled();
  });

  test("保存 409 → 两个明确出口：用我的版本覆盖 / 放弃我的修改载入最新", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "原始", version: "fv1" });
    const put = vi
      .spyOn(api, "putMemoryFile")
      .mockResolvedValueOnce({ ok: false, conflict: { content: "别处改的内容", version: "fv9" } })
      .mockResolvedValueOnce({ ok: true, version: "fv10" });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));

    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByDisplayValue("原始")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "我的修改" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(await within(dialog).findByText(/在你编辑期间被智能体更新了/)).toBeInTheDocument();
    // 用户未保存文本仍保留
    expect(within(dialog).getByDisplayValue("我的修改")).toBeInTheDocument();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][4]).toBe("fv1");
    // 冲突未决前保存禁用，必须显式选一个出口
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "用我的版本覆盖" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][3]).toBe("我的修改");
    expect(put.mock.calls[1][4]).toBe("fv9"); // 采纳服务端最新 version
  });

  test("409 后可放弃自己的修改、载入服务端最新内容", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "原始", version: "fv1" });
    const put = vi
      .spyOn(api, "putMemoryFile")
      .mockResolvedValue({ ok: false, conflict: { content: "别处改的内容", version: "fv9" } });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));
    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByDisplayValue("原始")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "我的修改" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByRole("button", { name: /放弃我的修改/ });

    fireEvent.click(within(dialog).getByRole("button", { name: /放弃我的修改/ }));
    expect(within(dialog).getByDisplayValue("别处改的内容")).toBeInTheDocument();
    // 载入最新后与基线一致 → 无未保存修改
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("有未保存修改时关闭编辑器要先确认", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "原始", version: "fv1" });

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));
    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByDisplayValue("原始")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "写了很久的正文" } });
    expect(within(dialog).getByText("有未保存的修改")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(await screen.findByText(/放弃未保存的修改/)).toBeInTheDocument();
    // 选择「继续编辑」→ 内容仍在
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByText(/放弃未保存的修改/)).not.toBeInTheDocument());
    expect(screen.getByDisplayValue("写了很久的正文")).toBeInTheDocument();
  });

  test("删除记忆 → 确认弹层后 DELETE、关闭编辑器并 toast", async () => {
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "正文", version: "fv1" });
    const del = vi.spyOn(api, "deleteMemoryFile").mockResolvedValue(true);

    renderPanel();
    fireEvent.click(await screen.findByText("笔记"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /删除/ }));

    // 确认弹层(confirmText="确认删除",与编辑器触发钮"删除"不撞名)
    expect(await screen.findByText(/删除记忆「笔记」/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(auth, "main", "note.md"));
    // 离开当前上下文（编辑器关闭 + 行消失）→ 反馈走 toast
    expect(await screen.findByText("记忆已删除")).toBeInTheDocument();
  });
});

describe("MemoryPanel · 新建记忆", () => {
  test("表单化创建：名称 / 召回描述 / 类型芯片 / 正文，文件名与 frontmatter 由前端拼装", async () => {
    mockIndex([{ file: "existing.md", name: "已有" }]);
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "nv1" });

    renderPanel();
    await screen.findByText("已有");
    fireEvent.click(screen.getByRole("button", { name: /新建记忆/ }));

    const dialog = await screen.findByRole("dialog");
    const createBtn = within(dialog).getByRole("button", { name: "创建" });
    expect(createBtn).toBeDisabled();
    // 开发者词汇不出现在用户面前
    expect(dialog).not.toHaveTextContent("frontmatter");
    expect(dialog).not.toHaveTextContent("MEMORY.md");

    fireEvent.change(within(dialog).getByLabelText(/记忆名称/), { target: { value: "New Note" } });
    fireEvent.change(within(dialog).getByLabelText(/什么时候该想起它/), {
      target: { value: "何时召回" },
    });
    fireEvent.change(within(dialog).getByLabelText(/记忆内容/), { target: { value: "正文" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "用户偏好" }));
    expect(createBtn).not.toBeDisabled();

    fireEvent.click(createBtn);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("new-note.md"); // 由名称派生 + 自动补 .md
    const content = put.mock.calls[0][3];
    expect(content).toContain("name: New Note");
    expect(content).toContain("description: 何时召回");
    expect(content).toContain("type: user");
    expect(content).toContain("正文");
    expect(put.mock.calls[0][4]).toBeUndefined(); // 新建不带 version

    // 成功后关闭对话框并 toast（离开当前上下文）
    expect(await screen.findByText("记忆已创建")).toBeInTheDocument();
  });

  test("纯中文名与撞名都能自动落到合法且唯一的文件名", async () => {
    mockIndex([{ file: "note.md", name: "已有" }]);
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "nv1" });

    renderPanel();
    await screen.findByText("已有");
    fireEvent.click(screen.getByRole("button", { name: /新建记忆/ }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/记忆名称/), { target: { value: "写作偏好" } });
    fireEvent.change(within(dialog).getByLabelText(/什么时候该想起它/), { target: { value: "写东西时" } });
    fireEvent.change(within(dialog).getByLabelText(/记忆内容/), { target: { value: "简洁" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toMatch(/^memory-\d+\.md$/);
  });

  test("高级里可覆写存储标识，非法值就地报错并挡住创建", async () => {
    mockIndex([{ file: "existing.md", name: "已有" }]);
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "nv1" });

    renderPanel();
    await screen.findByText("已有");
    fireEvent.click(screen.getByRole("button", { name: /新建记忆/ }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/记忆名称/), { target: { value: "Note" } });
    fireEvent.change(within(dialog).getByLabelText(/什么时候该想起它/), { target: { value: "何时" } });
    fireEvent.change(within(dialog).getByLabelText(/记忆内容/), { target: { value: "正文" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "高级" }));
    const slug = within(dialog).getByLabelText(/存储标识/);
    fireEvent.change(slug, { target: { value: "非法!!" } });
    expect(within(dialog).getByText(/只能含字母、数字/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "创建" })).toBeDisabled();

    fireEvent.change(slug, { target: { value: "existing" } });
    expect(within(dialog).getByText(/已存在同名记忆/)).toBeInTheDocument();

    fireEvent.change(slug, { target: { value: "my-note" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("my-note.md");
  });
});

describe("MemoryPanel · 用户画像（单文本编辑）", () => {
  test("与核心记忆分段隔开，且切到画像时不再显示智能体切换器", async () => {
    mockIndex([]);
    mockUser("称呼：dx");
    render(
      <TooltipProvider>
        <ToastProvider>
          <MemoryPanel
            auth={auth}
            agentId="main"
            agents={[
              { id: "main", name: "全能助手" },
              { id: "coder", name: "编程助手" },
            ]}
          />
        </ToastProvider>
      </TooltipProvider>,
    );

    expect(await screen.findByLabelText("选择智能体")).toBeInTheDocument();
    openProfileTab();
    expect(await screen.findByDisplayValue("称呼：dx")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择智能体")).not.toBeInTheDocument();
    expect(screen.getByText("所有智能体共享")).toBeInTheDocument();
  });

  test("单文本编辑并带 version 保存", async () => {
    mockIndex([]);
    mockUser("称呼：dx");
    const put = vi.spyOn(api, "putMemory").mockResolvedValue({ ok: true, version: "u2" });

    renderPanel();
    openProfileTab();
    const box = (await screen.findByDisplayValue("称呼：dx")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "称呼：邓萱" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("user");
    expect(put.mock.calls[0][3]).toBe("称呼：邓萱");
    expect(put.mock.calls[0][4]).toBe("u1");
  });

  test("409 → 保留本地文本并给两个出口，重存以用户版本为准", async () => {
    mockIndex([]);
    mockUser("A");
    const put = vi
      .spyOn(api, "putMemory")
      .mockResolvedValueOnce({ ok: false, conflict: { text: "服务端B", version: "u2", charCount: 3, limit: 4000 } })
      .mockResolvedValueOnce({ ok: true, version: "u3" });

    renderPanel();
    openProfileTab();
    const box = (await screen.findByDisplayValue("A")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "我的A" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/在你编辑期间更新了用户画像/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("我的A")).toBeInTheDocument();
    expect(put).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "用我的版本覆盖" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][3]).toBe("我的A");
    expect(put.mock.calls[1][4]).toBe("u2"); // 冲突刷新出的最新 version
  });

  test("画像加载失败给出重试出口", async () => {
    mockIndex([]);
    const get = vi.spyOn(api, "getMemory").mockRejectedValue(new ApiError({ status: 500, message: "boom" }));

    renderPanel();
    openProfileTab();
    const retry = await screen.findByRole("button", { name: "重试" });

    get.mockResolvedValue({ target: "user", text: "恢复的画像", version: "u1", limit: 4000 });
    fireEvent.click(retry);
    expect(await screen.findByDisplayValue("恢复的画像")).toBeInTheDocument();
  });
});
