import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, MarketplaceMyAgent, SkillDetail } from "../../lib/types";
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

function mount(detail: SkillDetail = DETAIL, agents: MarketplaceMyAgent[] = []) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const getSkill = vi.spyOn(api, "getSkill").mockResolvedValue(detail);
  vi.spyOn(api, "listMyAgents").mockResolvedValue(agents);
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
  return { onClose, onChanged, getFile, getSkill };
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

/** 手动控制 resolve 时机的 promise —— 用来把"请求在途"这一段真正撑开。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 等这一轮保存彻底走完(footer 保存按钮退出忙态),不预设"走完之后按钮该是什么文案"。
 * 名字必须锚定开头:左树里"a.md 有未保存的修改"也含「保存」二字。
 */
async function settleSave() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^(保存|已保存)/ })).not.toHaveAttribute("aria-busy"),
  );
}

describe("技能工作台保存竞态(请求在途继续编辑)", () => {
  test("正文:旧请求成功既不清 dirty、也不让 refresh 用旧服务端内容覆盖新输入", async () => {
    const d = deferred<{ ok: boolean }>();
    const update = vi.spyOn(api, "updateSkill").mockReturnValue(d.promise);
    const { getSkill } = mount();

    fireEvent.change(await screen.findByDisplayValue("原始正文"), { target: { value: "第一版" } });
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // 提交的是点保存那一刻的快照。
    expect(update).toHaveBeenCalledWith(
      auth,
      "写作助手",
      expect.objectContaining({ body: "第一版" }),
    );

    // 请求还在途中,用户继续敲(编辑器刻意不冻结)。
    fireEvent.change(screen.getByDisplayValue("第一版"), { target: { value: "第二版" } });
    const getSkillCalls = getSkill.mock.calls.length;
    d.resolve({ ok: true });
    await settleSave();

    // 「第二版」从未提交过 → 必须仍然是脏的,而不是被标成"已保存"。
    expect(screen.getByRole("button", { name: "保存（1）" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "已保存" })).not.toBeInTheDocument();
    // 保存后的 refresh(服务端仍是「原始正文」)绝不能把在途输入冲掉。
    await waitFor(() => expect(getSkill.mock.calls.length).toBeGreaterThan(getSkillCalls));
    expect(screen.getByDisplayValue("第二版")).toBeInTheDocument();
  });

  test("辅助文件:旧请求成功不把请求期间敲进去的新内容标成已保存", async () => {
    const d = deferred<{ ok: boolean }>();
    const putFile = vi.spyOn(api, "putSkillFile").mockReturnValue(d.promise);
    mount();

    await pickAux(/^a\.md/);
    fireEvent.change(await screen.findByDisplayValue("references/a.md 服务端内容"), {
      target: { value: "第一版 a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));
    await waitFor(() =>
      expect(putFile).toHaveBeenCalledWith(auth, "写作助手", "references/a.md", "第一版 a"),
    );

    fireEvent.change(screen.getByDisplayValue("第一版 a"), { target: { value: "第二版 a" } });
    d.resolve({ ok: true });
    await settleSave();

    expect(screen.getByRole("button", { name: "保存（1）" })).toBeEnabled();
    // 左树圆点(读屏可访问名)也必须继续标脏。
    expect(screen.getByRole("button", { name: "a.md 有未保存的修改" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("第二版 a")).toBeInTheDocument();
  });

  test("适用智能体:旧请求成功不清掉请求期间改出来的新归属", async () => {
    const d = deferred<{ ok: boolean }>();
    const update = vi.spyOn(api, "updateSkill").mockReturnValue(d.promise);
    mount(DETAIL, [
      { id: "main", slug: "main", name: "全能助手", description: "", installed: true, isDefault: true },
      { id: "writer", slug: "writer", name: "写手", description: "", installed: true },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: /写手/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        auth,
        "写作助手",
        expect.objectContaining({ agentIds: ["main", "writer"] }),
      ),
    );

    // 请求在途时又改回去 → 与已提交的快照不一致。
    fireEvent.click(screen.getByRole("button", { name: /写手/ }));
    d.resolve({ ok: true });
    await settleSave();

    expect(screen.getByRole("button", { name: "保存（1）" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /写手/ })).toHaveAttribute("aria-pressed", "false");
  });

  test("并发 refresh 乱序返回:只认最后一次发起的那份服务端快照", async () => {
    vi.spyOn(api, "updateSkill").mockResolvedValue({ ok: true });
    mount();
    await screen.findByDisplayValue("原始正文");

    // 初次加载已完成 → 接管后续 refresh 的 getSkill,手动控制返回顺序。
    const pending: Array<(d: SkillDetail) => void> = [];
    vi.spyOn(api, "getSkill").mockImplementation(
      () => new Promise<SkillDetail>((res) => pending.push(res)),
    );

    fireEvent.change(screen.getByDisplayValue("原始正文"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));
    await waitFor(() => expect(pending).toHaveLength(1)); // 保存后的 refresh #1

    fireEvent.change(await screen.findByDisplayValue("A"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));
    await waitFor(() => expect(pending).toHaveLength(2)); // 保存后的 refresh #2

    // 后发的先回,先发的后回(慢链路上很常见)。
    pending[1]({ ...DETAIL, version: "5", body: "服务端 v5" });
    await screen.findByDisplayValue("服务端 v5");
    pending[0]({ ...DETAIL, version: "4", body: "服务端 v4" });

    await settleSave();
    expect(screen.getByDisplayValue("服务端 v5")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("服务端 v4")).not.toBeInTheDocument();
    expect(screen.getByText(/正文\(v5;/)).toBeInTheDocument();
  });

  test("保存期间没再动过的路径照常清干净(不因为加了快照校验就永远脏)", async () => {
    const d = deferred<{ ok: boolean }>();
    const update = vi.spyOn(api, "updateSkill").mockReturnValue(d.promise);
    mount();

    fireEvent.change(await screen.findByDisplayValue("原始正文"), { target: { value: "只改一次" } });
    fireEvent.click(screen.getByRole("button", { name: "保存（1）" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    d.resolve({ ok: true });

    expect(await screen.findByRole("button", { name: "已保存" })).toBeDisabled();
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
