import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, CronJob } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { CronPanel } from "./CronPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** TimeAgo / Tooltip 需要 Provider 祖先;Toast 是本面板写成功的唯一回执,必须真挂。 */
function mountPanel() {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <CronPanel auth={auth} />
      </TooltipProvider>
    </ToastProvider>,
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const ACTIVE: CronJob = {
  id: "j1",
  label: "每日早报",
  prompt: "汇总昨天进展",
  schedule: "0 8 * * *",
  deliver: "webchat",
  enabled: true,
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  lastRunAt: new Date(Date.now() - 3_600_000).toISOString(),
};
const DONE: CronJob = {
  id: "j2",
  label: "提醒我开会",
  prompt: "提醒我开会",
  schedule: "30 9 26 7 *",
  oneshot: true,
  enabled: false,
  lastRunAt: new Date(Date.now() - 7_200_000).toISOString(),
};
const PAUSED: CronJob = {
  id: "j3",
  label: "周报",
  prompt: "汇总本周",
  schedule: "0 10 * * 1",
  enabled: false,
};

describe("CronPanel 写路径:乐观更新 + 局部替换 + Toast(不再整表塌回加载态)", () => {
  test("启停期间列表不塌回骨架,开关立即落态,成功后有 Toast 回执", async () => {
    const list = vi.spyOn(api, "listCron").mockResolvedValue([ACTIVE]);
    const pending = deferred<{ ok: boolean }>();
    const update = vi.spyOn(api, "updateCron").mockReturnValue(pending.promise);
    mountPanel();

    expect(await screen.findByText("每日早报")).toBeInTheDocument();
    expect(screen.getByText("启用中")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "启用「每日早报」" }));

    // 乐观:请求还没回来,状态已经变;且整张列表仍在(没有骨架、没有行消失)。
    expect(await screen.findByText("已停用")).toBeInTheDocument();
    expect(screen.getByText("每日早报")).toBeInTheDocument();
    expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(auth, "j1", { enabled: false });

    pending.resolve({ ok: true });
    // 写成功的回执 = Toast(留在原地的写操作),而不是"什么都没发生"。
    expect(await screen.findByText("已停用「每日早报」")).toBeInTheDocument();
    // 后台对账重拉一次,用于回填后端算的 nextRunAt —— 但全程不进 loading 分支。
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
  });

  test("启停失败:乐观值回滚 + 错误走 Toast(不再挂在几屏之外的顶部横幅)", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([ACTIVE]);
    vi.spyOn(api, "updateCron").mockRejectedValue(
      new ApiError({ status: 500, message: "boom（追踪号 req-x）", requestId: "req-x" }),
    );
    mountPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "启用「每日早报」" }));

    expect(await screen.findByText("操作失败（追踪号 req-x）")).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("启用中")).toBeInTheDocument());
  });
});

describe("CronPanel 状态与信息层次", () => {
  test("三态可辨:启用中 / 已停用 / 已完成,且列表不再甩裸 cron", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([ACTIVE, DONE, PAUSED]);
    mountPanel();

    expect(await screen.findByText("每日早报")).toBeInTheDocument();
    expect(screen.getByText("启用中")).toBeInTheDocument();
    // 中文排程可读,cron 原串收进 Tooltip(未悬停时不在文档里)。
    expect(screen.getByText("每天 08:00")).toBeInTheDocument();
    expect(screen.queryByText("0 8 * * *")).not.toBeInTheDocument();

    // 停用/已完成默认收进折叠分组;展开后两者语义分得开。
    fireEvent.click(screen.getByRole("button", { name: /已停用 \/ 已完成 · 2/ }));
    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("已停用")).toBeInTheDocument();
    // 已完成的一次性任务不给"把开关拨回去"这种假出口,给「再跑一次」。
    expect(screen.getByRole("button", { name: "再跑一次" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "启用「提醒我开会」" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "启用「周报」" })).toBeInTheDocument();
  });

  test("删除确认带后果说明,成功后行局部消失并给 Toast", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([ACTIVE]);
    const del = vi.spyOn(api, "deleteCron").mockResolvedValue({ ok: true });
    mountPanel();

    fireEvent.click(await screen.findByRole("button", { name: "删除「每日早报」" }));
    expect(await screen.findByText("删除定时任务「每日早报」？")).toBeInTheDocument();
    expect(screen.getByText("删除后该任务不再执行，且无法恢复。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(auth, "j1"));
    expect(await screen.findByText("已删除「每日早报」")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("每日早报")).not.toBeInTheDocument());
  });
});

describe("CronPanel 空态与表单", () => {
  test("空态给可点 CTA 与预设 chips,点 chip 直接预填表单", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    mountPanel();

    expect(await screen.findByText("还没有定时任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "每天 9:00 日报" }));

    expect(await screen.findByDisplayValue("每日早报")).toBeInTheDocument();
    expect(screen.getByDisplayValue("汇总我昨天的进展与今天要做的事，简明推送给我。")).toBeInTheDocument();
    // 预览是"将创建：<每天 09:00> · 重复执行",结果值单独成槽(升到 text-fg)。
    expect(screen.getByText("每天 09:00")).toBeInTheDocument();
  });

  test("表单控件走 Input/Select/Textarea 原语:字号锁 text-base md:text-sm(防 iOS 聚焦缩放)", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    mountPanel();

    fireEvent.click(await screen.findByRole("button", { name: "创建第一个定时任务" }));
    const title = await screen.findByPlaceholderText("周报提醒");
    expect(title.className).toContain("text-base");
    expect(title.className).toContain("md:text-sm");
    const prompt = screen.getByPlaceholderText(/到点要智能体做什么/);
    expect(prompt.className).toContain("text-base");
    // 裸 <select> 已被 Select 原语取代,同样继承该字号。
    for (const el of document.querySelectorAll("select")) {
      expect(el.className).toContain("text-base");
    }
  });

  test("创建失败:错误内联渲染在发起它的表单里,不再飞到面板顶部", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    vi.spyOn(api, "createCron").mockRejectedValue(
      new ApiError({ status: 500, message: "nope（追踪号 req-y）", requestId: "req-y" }),
    );
    const { container } = mountPanel();

    fireEvent.click(await screen.findByRole("button", { name: "每天 9:00 日报" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建任务" }));

    const msg = await screen.findByText("创建失败（追踪号 req-y）");
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(form?.contains(msg)).toBe(true);
    expect(within(msg.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "关闭提示" })).toBeInTheDocument();
  });

  test("创建成功:表单收起 + Toast 回执,列表不塌回加载态", async () => {
    const list = vi.spyOn(api, "listCron").mockResolvedValue([]);
    const create = vi
      .spyOn(api, "createCron")
      .mockResolvedValue({ ok: true, job: { ...ACTIVE, id: "new1", label: "每日早报" } });
    mountPanel();

    fireEvent.click(await screen.findByRole("button", { name: "每天 9:00 日报" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toMatchObject({ schedule: "0 9 * * *", oneshot: false });
    expect(await screen.findByText("已创建定时任务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建任务" })).not.toBeInTheDocument();
    expect(screen.queryByText("加载中…")).not.toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
