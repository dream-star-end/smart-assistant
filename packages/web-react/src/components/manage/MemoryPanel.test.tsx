import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession, AutoDreamReportResponse, MemoryFileMeta } from "../../lib/types";
import { MemoryPanel } from "./MemoryPanel";

const auth = {
  getToken: () => "tok",
  setToken: () => {},
  onExpired: () => {},
} as AuthSession;

const agents = [{ id: "main", name: "全能助手" }];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

/** 造用户画像响应（GET .../memory/user）——每个用例都要 mock,否则画像区会真 fetch。 */
function mockUser(text = "") {
  return vi.spyOn(api, "getMemory").mockResolvedValue({ target: "user", text, version: "u1", limit: 4000 });
}

describe("MemoryPanel · 核心记忆文件列表", () => {
  test("渲染为文件列表：name / description / type 徽标 / 相对时间 / 条数", async () => {
    mockUser();
    mockIndex([
      { file: "dark-mode.md", name: "深色模式偏好", description: "喜欢深色模式与简洁回答", type: "user", mtimeMs: Date.now() - 3_600_000 },
      { file: "proj-aurora.md", name: "Aurora 项目", description: "v5 商业版重构", type: "project", mtimeMs: Date.now() - 2 * 86_400_000 },
    ]);

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);

    expect(await screen.findByText("深色模式偏好")).toBeInTheDocument();
    expect(screen.getByText("喜欢深色模式与简洁回答")).toBeInTheDocument();
    expect(screen.getByText("Aurora 项目")).toBeInTheDocument();
    // type 徽标
    expect(screen.getByText("用户偏好")).toBeInTheDocument();
    expect(screen.getByText("项目")).toBeInTheDocument();
    // 文件名 + 条数
    expect(screen.getByText("dark-mode.md")).toBeInTheDocument();
    expect(screen.getByText("2 条记忆")).toBeInTheDocument();
    // 相对时间(1 小时前)
    expect(screen.getByText(/1 小时前/)).toBeInTheDocument();
  });

  test("索引原文可展开为只读预览", async () => {
    mockUser();
    mockIndex([{ file: "a.md", name: "A" }], "<!-- oc-memdir-index v1 -->\n- [A](memory/a.md) — 钩子一句话");

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    fireEvent.click(await screen.findByText(/索引原文/));
    expect(screen.getByText(/- \[A\]\(memory\/a\.md\) — 钩子一句话/)).toBeInTheDocument();
  });

  test("空记忆显示空状态与新建入口", async () => {
    mockUser();
    mockIndex([]);
    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    expect(await screen.findByText(/暂无核心记忆/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建记忆/ })).toBeInTheDocument();
  });

  test("梦境报告显示实际变化、会话数与进度，且可直达仍存在的记忆", async () => {
    mockUser();
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

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);

    const report = await screen.findByRole("region", { name: "Auto-Dream 梦境报告" });
    expect(within(report).getByText(/新增 1 条、更新 1 条、清理 1 条/)).toBeInTheDocument();
    expect(within(report).getByText(/已参考 5 个近期会话/)).toBeInTheDocument();
    expect(within(report).getByText(/已积累 2 个新会话/)).toBeInTheDocument();
    expect(within(report).getByText("updated")).toBeInTheDocument();
    expect(within(report).getByText("deleted")).toBeInTheDocument();
    expect(report).not.toHaveTextContent(/DeepSeek|整理模型|model/i);

    fireEvent.click(within(report).getByRole("button", { name: /updated/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.getMemoryFile).toHaveBeenCalledWith(auth, "main", "updated.md");
  });

  test("无变化的成功报告也明确说明未扣出一堆不可见结果", async () => {
    mockUser();
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

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    const report = await screen.findByRole("region", { name: "Auto-Dream 梦境报告" });
    expect(within(report).getByText(/没有发现值得长期保存的新信息/)).toBeInTheDocument();
  });

  test("中断且结果不确定时不谎称记忆一定没有改动", async () => {
    mockUser();
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

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    const report = await screen.findByRole("region", { name: "Auto-Dream 梦境报告" });
    expect(within(report).getByText(/无法确认记忆是否发生变化/)).toBeInTheDocument();
    expect(within(report).queryByText(/记忆没有改动/)).not.toBeInTheDocument();
  });
});

describe("MemoryPanel · 单文件查看/编辑", () => {
  test("点开记忆卡 → 编辑正文并带 version 保存", async () => {
    mockUser();
    mockIndex([{ file: "note.md", name: "笔记", description: "d" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "---\nname: 笔记\n---\n正文A", version: "fv1" });
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "fv2" });

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    fireEvent.click(await screen.findByText("笔记"));

    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByDisplayValue(/正文A/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "---\nname: 笔记\n---\n正文B" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("note.md");
    expect(put.mock.calls[0][3]).toContain("正文B");
    expect(put.mock.calls[0][4]).toBe("fv1"); // 载入版本作乐观锁令牌
  });

  test("保存 409 → 提示已被别处修改 + 刷新按钮，保留未保存文本，刷新后重存以最新 version", async () => {
    mockUser();
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "原始", version: "fv1" });
    const put = vi
      .spyOn(api, "putMemoryFile")
      .mockResolvedValueOnce({ ok: false, conflict: { content: "别处改的内容", version: "fv9" } })
      .mockResolvedValueOnce({ ok: true, version: "fv10" });

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    fireEvent.click(await screen.findByText("笔记"));

    const dialog = await screen.findByRole("dialog");
    const box = (await within(dialog).findByDisplayValue("原始")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "我的修改" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(await within(dialog).findByText(/已被智能体或其他页面修改/)).toBeInTheDocument();
    // 用户未保存文本仍保留
    expect(within(dialog).getByDisplayValue("我的修改")).toBeInTheDocument();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][4]).toBe("fv1");
    // 冲突未刷新前保存禁用,须先点刷新
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "刷新" }));
    const saveBtn = within(dialog).getByRole("button", { name: "保存" });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][3]).toBe("我的修改");
    expect(put.mock.calls[1][4]).toBe("fv9"); // 采纳服务端最新 version
  });

  test("删除记忆 → 确认弹层后 DELETE 并回调刷新", async () => {
    mockUser();
    mockIndex([{ file: "note.md", name: "笔记" }]);
    vi.spyOn(api, "getMemoryFile").mockResolvedValue({ content: "正文", version: "fv1" });
    const del = vi.spyOn(api, "deleteMemoryFile").mockResolvedValue(true);

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    fireEvent.click(await screen.findByText("笔记"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /删除/ }));

    // 确认弹层(confirmText="确认删除",与编辑器触发钮"删除"不撞名)
    expect(await screen.findByText(/删除记忆「笔记」/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(del).toHaveBeenCalledWith(auth, "main", "note.md"));
  });
});

describe("MemoryPanel · 新建记忆", () => {
  test("文件名前端校验 + 模板预填 + 新建（不带 version）", async () => {
    mockUser();
    mockIndex([{ file: "existing.md", name: "已有" }]);
    const put = vi.spyOn(api, "putMemoryFile").mockResolvedValue({ ok: true, version: "nv1" });

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    await screen.findByText("已有");
    fireEvent.click(screen.getByRole("button", { name: /新建记忆/ }));

    const dialog = await screen.findByRole("dialog");
    const slug = within(dialog).getByLabelText("文件名") as HTMLInputElement;
    const createBtn = within(dialog).getByRole("button", { name: "创建" });

    // 非法名 → 禁用 + 报错
    fireEvent.change(slug, { target: { value: "非法.txt" } });
    expect(within(dialog).getByText(/需以字母或数字开头/)).toBeInTheDocument();
    expect(createBtn).toBeDisabled();

    // 撞名 → 禁用 + 报错
    fireEvent.change(slug, { target: { value: "existing" } });
    expect(within(dialog).getByText(/已存在同名记忆文件/)).toBeInTheDocument();
    expect(createBtn).toBeDisabled();

    // 合法名 → 骨架 name 自动填 + 解析文件名提示 + 可创建
    fireEvent.change(slug, { target: { value: "new-note" } });
    const body = within(dialog).getByLabelText("正文") as HTMLTextAreaElement;
    expect(body.value).toContain("name: new-note");
    expect(within(dialog).getByText("memory/new-note.md")).toBeInTheDocument();
    expect(createBtn).not.toBeDisabled();

    fireEvent.click(createBtn);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("new-note.md"); // 自动补 .md
    expect(put.mock.calls[0][3]).toContain("name: new-note");
    expect(put.mock.calls[0][4]).toBeUndefined(); // 新建不带 version
  });
});

describe("MemoryPanel · 用户画像（单文本编辑）", () => {
  test("单文本编辑并带 version 保存", async () => {
    mockIndex([]);
    vi.spyOn(api, "getMemory").mockResolvedValue({ target: "user", text: "称呼：dx", version: "u1", limit: 4000 });
    const put = vi.spyOn(api, "putMemory").mockResolvedValue({ ok: true, version: "u2" });

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    const box = (await screen.findByDisplayValue("称呼：dx")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "称呼：邓萱" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("user");
    expect(put.mock.calls[0][3]).toBe("称呼：邓萱");
    expect(put.mock.calls[0][4]).toBe("u1");
  });

  test("409 → 刷新基线保留本地文本，重存以用户版本为准", async () => {
    mockIndex([]);
    vi.spyOn(api, "getMemory").mockResolvedValue({ target: "user", text: "A", version: "u1", limit: 4000 });
    const put = vi
      .spyOn(api, "putMemory")
      .mockResolvedValueOnce({ ok: false, conflict: { text: "服务端B", version: "u2", charCount: 3, limit: 4000 } })
      .mockResolvedValueOnce({ ok: true, version: "u3" });

    render(<MemoryPanel auth={auth} agentId="main" agents={agents} />);
    const box = (await screen.findByDisplayValue("A")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "我的A" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/已刷新基线/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("我的A")).toBeInTheDocument();
    expect(put).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][3]).toBe("我的A");
    expect(put.mock.calls[1][4]).toBe("u2"); // 冲突刷新出的最新 version
  });
});
