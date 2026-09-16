import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProjectScopeProvider } from "../../hooks/useProjectScope";
import { ApiError, api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, CronJob } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { CronPanel } from "./CronPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
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

/** 冲干净整条 promise 链（对账里 async 包装的 await 有多个微任务跳）后再断言。 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
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

/**
 * 后台对账是**整表覆盖**，而它在飞的时候界面还能继续变。没有顺序栅栏时，一张过期快照
 * 既能复活已删任务，也能把更早的状态盖回更新的乐观值上。
 */
describe("CronPanel 后台对账的顺序栅栏", () => {
  test("启停后删除：迟到的旧对账快照不得把已删任务写回列表", async () => {
    const stale = deferred<CronJob[]>();
    let calls = 0;
    const list = vi.spyOn(api, "listCron").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [ACTIVE];
      // 第 2 次 = 启停成功后发出的对账，慢；它拍到的还是「删除之前」的表。
      if (calls === 2) return stale.promise;
      return [];
    });
    vi.spyOn(api, "updateCron").mockResolvedValue({ ok: true });
    const del = vi.spyOn(api, "deleteCron").mockResolvedValue({ ok: true });
    mountPanel();

    // ① 启停成功 → 发出慢速对账
    fireEvent.click(await screen.findByRole("switch", { name: "启用「每日早报」" }));
    expect(await screen.findByText("已停用「每日早报」")).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    // ② 用户随即删除该任务，行正确移除
    fireEvent.click(screen.getByRole("button", { name: "删除「每日早报」" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(auth, "j1"));
    await waitFor(() => expect(screen.queryByText("每日早报")).not.toBeInTheDocument());

    // ③ 旧对账这才返回：栅栏必须整体丢弃它，任务不得复活
    stale.resolve([ACTIVE]);
    await flush();
    expect(screen.queryByText("每日早报")).not.toBeInTheDocument();
    expect(screen.getByText("还没有定时任务")).toBeInTheDocument();
  });

  test("两次启停的对账响应乱序：先发的旧快照不得盖掉较新的结果", async () => {
    const firstReconcile = deferred<CronJob[]>();
    const secondReconcile = deferred<CronJob[]>();
    let calls = 0;
    const list = vi.spyOn(api, "listCron").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [ACTIVE];
      if (calls === 2) return firstReconcile.promise;
      if (calls === 3) return secondReconcile.promise;
      return [ACTIVE];
    });
    vi.spyOn(api, "updateCron").mockResolvedValue({ ok: true });
    mountPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "启用「每日早报」" }));
    expect(await screen.findByText("已停用「每日早报」")).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("switch", { name: "启用「每日早报」" }));
    expect(await screen.findByText("已启用「每日早报」")).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

    // 较新的那次对账先落地：这是当前真值
    secondReconcile.resolve([{ ...ACTIVE, enabled: true }]);
    await flush();
    expect(screen.getByText("启用中")).toBeInTheDocument();

    // 较早发出的对账后到（乱序）：必须被丢弃，不能把状态倒回「已停用」
    firstReconcile.resolve([{ ...ACTIVE, enabled: false }]);
    await flush();
    expect(screen.getByText("启用中")).toBeInTheDocument();
    expect(screen.queryByText("已停用")).not.toBeInTheDocument();
  });
});

/**
 * 「会话组」（未绑定看板的聊天项目）作用域下没有可查的任务表。改造前 cronBlocked 只用来跳过
 * 请求，主体区照常落进「还没有定时任务 / 创建第一个」—— 把用户的任务表渲染成"不存在"（P1）。
 */
describe("CronPanel 未绑定聊天项目作用域", () => {
  const CHAT = { id: "chat_unbound_01", name: "momo 号日常", boardProjectId: null };

  function mountScoped(token: string) {
    // ProjectScopeProvider 自己拉工作项目列表（原生 fetch，不经 api 代理）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    // 作用域走 URL 深链：Provider 在 useState 初始化时同步读 ?project=，首次渲染就是该作用域；
    // localStorage 里的 token 要等一个 effect 才生效，首帧会以「全部项目」多发一次 listCron。
    window.history.replaceState({}, "", `/?project=${encodeURIComponent(token)}`);
    return render(
      <ToastProvider>
        <TooltipProvider>
          <ProjectScopeProvider auth={auth} chatProjects={[CHAT]} userId="u1">
            <CronPanel auth={auth} />
          </ProjectScopeProvider>
        </TooltipProvider>
      </ToastProvider>,
    );
  }

  test("不再渲染假空态：给出「没有绑定工作项目」的解释与切作用域出口，且不发 listCron", async () => {
    const list = vi.spyOn(api, "listCron").mockResolvedValue([ACTIVE]);
    mountScoped(CHAT.id);

    expect(await screen.findByText("这个会话组没有绑定工作项目")).toBeInTheDocument();
    expect(screen.queryByText("还没有定时任务")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建第一个定时任务" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新建/ })).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();

    // 出口：切回「全部项目」后才真正拉表并显示任务。
    fireEvent.click(screen.getByRole("button", { name: "查看全部项目的定时任务" }));
    expect(await screen.findByText("每日早报")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("CronPanel 行内信息可达性", () => {
  test("已翻译排程的触发器可聚焦且可访问名含 cron 原串；下次执行的精确时刻直接可见；心跳任务有标识", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([{ ...ACTIVE, heartbeat: true }]);
    mountPanel();

    const trigger = await screen.findByLabelText("每天 08:00，Cron 表达式 0 8 * * *");
    expect(trigger).toHaveAttribute("tabindex", "0");
    // 原串仍不作为可见文本铺在行上（保持列表可扫读），只进可访问名。
    expect(screen.queryByText("0 8 * * *")).not.toBeInTheDocument();
    // 精确时刻从 title 升为可见文本：MM-DD HH:mm。
    expect(screen.getByText(/（\d{2}-\d{2} \d{2}:\d{2}）/)).toBeInTheDocument();
    expect(screen.getByText("心跳探针")).toBeInTheDocument();
  });

  test("「某时一次」的日期时间控件带 min，过去的时刻在选择器里就被禁掉", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一个定时任务" }));
    // 切到「某时一次」：Select 原语渲染为原生 <select>。
    const modeSelect = document.querySelector("select") as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: "once" } });
    const input = await screen.findByLabelText("日期时间");
    expect(input).toHaveAttribute("type", "datetime-local");
    expect(input.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe("CronPanel 送达通道由后端下发", () => {
  test("挂载时拉 /api/cron/channels,不可用通道不展示", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    vi.spyOn(api, "listCronChannels").mockResolvedValue([
      { value: "webchat", available: true },
      { value: "local", available: true },
      { value: "telegram", available: false },
    ]);
    mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一个定时任务" }));
    await waitFor(() => {
      const values = [...document.querySelectorAll("select option")].map(
        (o) => (o as HTMLOptionElement).value,
      );
      expect(values).toContain("webchat");
      expect(values).toContain("local");
      expect(values).not.toContain("telegram");
    });
    expect(screen.queryByRole("option", { name: "Telegram" })).not.toBeInTheDocument();
  });

  test("拉取失败只回退网页对话 / 仅记录,不把没有绑定入口的 Telegram 写死摆出来(SET-05)", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    vi.spyOn(api, "listCronChannels").mockRejectedValue(new Error("offline"));
    mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一个定时任务" }));
    expect(await screen.findByRole("option", { name: "网页对话" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "仅记录" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Telegram" })).not.toBeInTheDocument();
  });

  test("后端明确下发 telegram 可用时才可选,hint 不再引导去已移除的偏好页开关", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([]);
    vi.spyOn(api, "listCronChannels").mockResolvedValue([
      { value: "webchat", available: true },
      { value: "telegram", available: true },
    ]);
    mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "创建第一个定时任务" }));
    const option = await screen.findByRole("option", { name: "Telegram" });
    fireEvent.change(option.closest("select") as HTMLSelectElement, {
      target: { value: "telegram" },
    });
    expect(await screen.findByText("结果推送到 Telegram。")).toBeInTheDocument();
    expect(screen.queryByText(/设置 → 偏好|Telegram 通知/)).not.toBeInTheDocument();
  });

  test("存量 deliver=telegram 的任务仍按中文标签回显,编辑时保留原值", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([{ ...ACTIVE, deliver: "telegram" }]);
    vi.spyOn(api, "listCronChannels").mockResolvedValue([
      { value: "webchat", available: true },
      { value: "local", available: true },
    ]);
    mountPanel();
    expect(await screen.findByText("Telegram")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `编辑「${ACTIVE.label}」` }));
    const option = await screen.findByRole("option", { name: "Telegram" });
    expect((option.closest("select") as HTMLSelectElement).value).toBe("telegram");
  });

  test("deliverLabel 对未知值原样回显", async () => {
    vi.spyOn(api, "listCron").mockResolvedValue([{ ...ACTIVE, deliver: "discord" }]);
    vi.spyOn(api, "listCronChannels").mockResolvedValue([
      { value: "webchat", available: true },
      { value: "local", available: true },
    ]);
    mountPanel();
    expect(await screen.findByText("discord")).toBeInTheDocument();
  });
});
