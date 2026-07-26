import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, SkillDetail } from "../../lib/types";
import { SkillEditor } from "./SkillEditor";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DETAIL: SkillDetail = {
  name: "写作助手",
  description: "写作",
  version: "3",
  writable: true,
  layer: "shared",
  agentIds: ["main"],
  body: "原始正文",
  files: ["SKILL.md", "references/a.md", "references/b.md"],
};

function mount(detail: SkillDetail = DETAIL) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  vi.spyOn(api, "getSkill").mockResolvedValue(detail);
  vi.spyOn(api, "listMyAgents").mockResolvedValue([]);
  vi.spyOn(api, "getSkillHistory").mockResolvedValue({ history: [], writable: true });
  const getFile = vi
    .spyOn(api, "getSkillFile")
    .mockImplementation(async (_a, _n, path) => ({ path, content: `${path} 服务端内容` }));
  render(
    <SkillEditor
      auth={auth}
      skillName={detail.name}
      open
      onClose={onClose}
      onChanged={onChanged}
    />,
  );
  return { onClose, onChanged, getFile };
}

/** 切到「文件」页签并选中一个辅助文件。 */
async function pickAux(label: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name: /文件/ }));
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

describe("技能工作台 per-path 草稿模型(P0:改动不再静默丢失)", () => {
  test("切换文件只切视图:正文与辅助文件的草稿都保留,保存计数累加", async () => {
    const { getFile } = mount();

    // 正文改一半 → 保存按钮立刻可用且带计数。
    fireEvent.change(await screen.findByDisplayValue("原始正文"), {
      target: { value: "改过的正文" },
    });
    expect(screen.getByRole("button", { name: "保存（1）" })).toBeEnabled();

    // 切到辅助文件 a.md 改一半 → 计数变 2(正文的 dirty 没被清掉)。
    await pickAux(/^a\.md/);
    fireEvent.change(await screen.findByDisplayValue("references/a.md 服务端内容"), {
      target: { value: "改过的 a" },
    });
    expect(screen.getByRole("button", { name: "保存（2）" })).toBeEnabled();

    // 切去 b.md 再切回 a.md:草稿仍在,且**不重新拉取**(重拉正是原先覆盖用户输入的根因)。
    fireEvent.click(screen.getByRole("button", { name: /^b\.md/ }));
    await screen.findByDisplayValue("references/b.md 服务端内容");
    fireEvent.click(screen.getByRole("button", { name: /^a\.md/ }));
    expect(await screen.findByDisplayValue("改过的 a")).toBeInTheDocument();
    expect(getFile).toHaveBeenCalledTimes(2);

    // 切回正文:改动仍在,保存按钮仍然可用(原先这里是「内容改过、按钮是灰的」)。
    fireEvent.click(screen.getByRole("tab", { name: "正文" }));
    expect(await screen.findByDisplayValue("改过的正文")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存（2）" })).toBeEnabled();
  });

  test("有草稿的文件在左树带「未保存」圆点", async () => {
    mount();
    await pickAux(/^a\.md/);
    fireEvent.change(await screen.findByDisplayValue("references/a.md 服务端内容"), {
      target: { value: "x" },
    });
    // 圆点是带可访问名的标记,读屏用户也能知道哪份没存。
    expect(await screen.findByRole("button", { name: "a.md 有未保存的修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "b.md" })).toBeInTheDocument();
  });

  test("保存一次提交全部脏路径,成功后计数归零", async () => {
    const update = vi.spyOn(api, "updateSkill").mockResolvedValue({ ok: true });
    const putFile = vi.spyOn(api, "putSkillFile").mockResolvedValue({ ok: true });
    const { onChanged } = mount();

    fireEvent.change(await screen.findByDisplayValue("原始正文"), { target: { value: "新正文" } });
    await pickAux(/^a\.md/);
    fireEvent.change(await screen.findByDisplayValue("references/a.md 服务端内容"), {
      target: { value: "新 a" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存（2）" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        auth,
        "写作助手",
        expect.objectContaining({ body: "新正文", description: "写作" }),
      ),
    );
    expect(putFile).toHaveBeenCalledWith(auth, "写作助手", "references/a.md", "新 a");
    expect(await screen.findByRole("button", { name: "已保存" })).toBeDisabled();
    expect(onChanged).toHaveBeenCalled();
  });

  test("保存失败:错误贴在 footer 上方,失败路径仍保持脏", async () => {
    vi.spyOn(api, "updateSkill").mockRejectedValue(new Error("boom"));
    mount();
    fireEvent.change(await screen.findByDisplayValue("原始正文"), { target: { value: "新正文" } });
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));

    expect(await screen.findByText(/仍未保存/)).toBeInTheDocument();
    // 仍然脏 → 保存按钮继续可用,用户可原地重试。
    expect(screen.getByRole("button", { name: "保存（1）" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重试保存" })).toBeInTheDocument();
  });
});

describe("技能工作台关闭拦截", () => {
  test("有未保存改动时关闭先确认:取消不关,确认才关", async () => {
    const { onClose } = mount();
    fireEvent.change(await screen.findByDisplayValue("原始正文"), { target: { value: "改了" } });

    // 标题栏 X 与 footer「关闭」同名,取 DOM 中先出现的 X —— 走的是 Radix 的关闭路径。
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]);
    expect(await screen.findByText("放弃未保存的修改?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("放弃未保存的修改?")).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "放弃" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("没有未保存改动时直接关闭,不弹确认", async () => {
    const { onClose } = mount();
    await screen.findByDisplayValue("原始正文");
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("放弃未保存的修改?")).not.toBeInTheDocument();
  });
});

describe("技能工作台只读态与触屏可达性", () => {
  test("只读技能:给出「为什么不能改 + 下一步」的说明,不给保存按钮与训练页签", async () => {
    mount({ ...DETAIL, name: "市场技能", writable: false, layer: "hub" });
    expect(await screen.findByText(/内容由作者维护,不可编辑/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^保存/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "训练优化" })).not.toBeInTheDocument();
    // 只读技能仍可评测。
    expect(screen.getByRole("tab", { name: "评测" })).toBeInTheDocument();
  });

  test("辅助文件删除按钮常驻 DOM(不再靠 hover 才出现 → 触屏可达)", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: /文件/ }));
    const del = await screen.findByRole("button", { name: "删除 a.md" });
    expect(del).toBeInTheDocument();
    expect(del.className).not.toContain("hidden");
  });
});
