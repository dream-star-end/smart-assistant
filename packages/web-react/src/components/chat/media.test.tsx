/**
 * ZoomableImage(共享图片灯箱)行为测试 —— 2026-07-07 boss 反馈"agent 响应的
 * 图表不支持放大预览"。契约:缩略图是可聚焦按钮,点击开 Radix Dialog 全尺寸预览
 * (含"新标签打开原图"逃生口),关闭按钮收起。
 *
 * 签名 URL 点击时权威测试 —— 2026-07-10 用户 175 "下载不了文件" 410 死循环根因。
 * 契约:下载/开原图发生的那一刻解析签名 URL(缓存过期自动重签);fetch 拿到
 * 410/403 → 强制重签一次再试。禁止任何交互路径冻结挂载时的旧 URL。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ImageEditActionsContext } from "./imageEditActions";
import { MediaSignProvider, SignedFileCard, ZoomableImage } from "./media";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ZoomableImage 灯箱", () => {
  // 编辑入口的显隐单一权威 = ImageEditActionsContext.submitImageEdit(image2 门控)。
  const withEdit = (node: ReactNode, canEdit: boolean) => (
    <ImageEditActionsContext.Provider value={canEdit ? { submitImageEdit: vi.fn() } : {}}>
      <MediaSignProvider sign={null}>{node}</MediaSignProvider>
    </ImageEditActionsContext.Provider>
  );

  test("可编辑时缩略图左下角出现「编辑」入口,不可编辑时隐藏", () => {
    const { rerender } = render(withEdit(<ZoomableImage src={src} alt="拟合曲线" />, false));
    expect(screen.queryByRole("button", { name: "编辑图片" })).not.toBeInTheDocument();
    rerender(withEdit(<ZoomableImage src={src} alt="拟合曲线" />, true));
    expect(screen.getByRole("button", { name: "编辑图片" })).toBeInTheDocument();
    rerender(withEdit(<ZoomableImage src={src} alt="拟合曲线" />, false));
    expect(screen.queryByRole("button", { name: "编辑图片" })).not.toBeInTheDocument();
  });

  test("点「编辑」→ 直接开全屏查看器并进入圈选编辑器(需求 §3 单一入口)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response));
    render(withEdit(<ZoomableImage src={src} alt="拟合曲线" />, true));
    fireEvent.click(screen.getByRole("button", { name: "编辑图片" }));
    // 不经「先进查看器再点编辑」——直接落到圈选编辑器。
    expect(await screen.findByRole("button", { name: "关闭图片编辑器" })).toBeInTheDocument();
  });

  const src = "https://example.test/chart.png";

  test("缩略态渲染 img + 可访问的放大按钮", () => {
    render(<ZoomableImage src={src} alt="拟合曲线" imgClassName="max-h-72" />);
    const btn = screen.getByRole("button", { name: /放大查看 拟合曲线/ });
    expect(btn).toBeInTheDocument();
    const img = screen.getByAltText("拟合曲线");
    expect(img).toHaveAttribute("src", src);
    expect(img.className).toContain("max-h-72");
  });

  test("点击缩略图 → 打开全屏查看器:四动作条 + 更多菜单逃生口;关闭收起", () => {
    render(<ZoomableImage src={src} alt="拟合曲线" />);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    // 全屏查看器展示大图(缩略图 + 查看器两张同 alt)。
    expect(screen.getAllByAltText("拟合曲线").length).toBeGreaterThanOrEqual(2);
    // 底部三动作条(圆钮 + 中文标签;「移除」已下线)。
    for (const label of ["编辑", "评论", "调整大小"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    // 「新标签打开原图」逃生口收进更多菜单。
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("button", { name: /新标签打开原图/ })).toBeInTheDocument();
    // 关闭按钮收起查看器。
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  test("无 alt → 按钮名回退'放大查看图片'", () => {
    render(<ZoomableImage src={src} alt="" />);
    expect(screen.getByRole("button", { name: "放大查看图片" })).toBeInTheDocument();
  });
});

/** 递增签名 mock:每次调用签出新版本 URL,便于断言"点击时用的是第几版"。 */
function makeSignMock() {
  let n = 0;
  const sign = vi.fn(async (paths: string[]) => {
    n += 1;
    return Object.fromEntries(paths.map((p) => [p, `/api/media-signed?t=v${n}`]));
  });
  return sign;
}

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: null,
  } as unknown as Response;
}

describe("SignedFileCard 点击时签名(410 死循环根因)", () => {
  const path = "/home/agent/.openclaude/generated/报表.html";

  beforeEach(() => {
    // 只假 Date(缓存 TTL 判定用),timer/微任务保持真实,waitFor 才能正常推进。
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  test("挂载后缓存已过期 → 点击下载现场重签,fetch 用的是新 URL", async () => {
    const sign = makeSignMock();
    const fetchMock = vi.fn(async () => mockResponse(200, { "content-length": "10" }));
    vi.stubGlobal("fetch", fetchMock);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <MediaSignProvider sign={sign}>
        <SignedFileCard src={path} filename="报表.html" />
      </MediaSignProvider>,
    );
    const card = await screen.findByRole("link", { name: /报表\.html/ });
    expect(sign).toHaveBeenCalledTimes(1); // 挂载态签 v1

    // 用户看回复 5 分钟后才点下载:前端缓存(4min)已过期
    vi.advanceTimersByTime(5 * 60_000);
    fireEvent.click(card);

    await waitFor(() => expect(anchorClick).toHaveBeenCalled());
    expect(sign).toHaveBeenCalledTimes(2); // 点击时重签 v2,而不是复用挂载时的 v1
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls as unknown[][])[0]?.[0]).toBe("/api/media-signed?t=v2");
  });

  test("本地缓存未过期但服务端 410 → 强制重签一次重试成功", async () => {
    const sign = makeSignMock();
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("t=v1") ? mockResponse(410) : mockResponse(200, { "content-length": "10" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(
      <MediaSignProvider sign={sign}>
        <SignedFileCard src={path} filename="报表.html" />
      </MediaSignProvider>,
    );
    const card = await screen.findByRole("link", { name: /报表\.html/ });
    fireEvent.click(card); // 缓存命中 v1 → 服务端裁决 410 → 重签 v2 → 成功

    await waitFor(() => expect(anchorClick).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/media-signed?t=v1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/media-signed?t=v2");
    expect(screen.queryByText("下载失败")).not.toBeInTheDocument();
  });

  test("重签后仍失败 → error 态(重试 + 直接下载兜底可见)", async () => {
    const sign = makeSignMock();
    const fetchMock = vi.fn(async () => mockResponse(410));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MediaSignProvider sign={sign}>
        <SignedFileCard src={path} filename="报表.html" />
      </MediaSignProvider>,
    );
    fireEvent.click(await screen.findByRole("link", { name: /报表\.html/ }));

    expect(await screen.findByText("下载失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "直接下载" })).toBeInTheDocument();
  });
});

describe("ImageViewer 开启/下载时刷新签名(点击时签名不回归)", () => {
  test("传 signPath → 开查看器现场重签,大图 src 用新 URL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sign = makeSignMock();
    render(
      <MediaSignProvider sign={sign}>
        <ZoomableImage src="/api/media-signed?t=stale" alt="图表" signPath="/home/agent/a.png" />
      </MediaSignProvider>,
    );
    vi.advanceTimersByTime(5 * 60_000); // 挂载 5 分钟后才点开大图,挂载缓存已过期
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    await waitFor(() => {
      const imgs = screen.getAllByAltText("图表") as HTMLImageElement[];
      expect(imgs.some((im) => im.getAttribute("src") === "/api/media-signed?t=v1")).toBe(true);
    });
  });

  test("点下载 → 手势内现签,交原生下载用最新签名 URL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sign = makeSignMock();
    const hrefs: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href);
    });
    render(
      <MediaSignProvider sign={sign}>
        <ZoomableImage src="/api/media-signed?t=stale" alt="图表" signPath="/home/agent/a.png" />
      </MediaSignProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ })); // 开查看器 → 现签 v1
    fireEvent.click(screen.getByRole("button", { name: "下载" })); // 点下载 → 复用/重签后交原生下载
    await waitFor(() => expect(hrefs.length).toBeGreaterThan(0));
    expect(hrefs.some((h) => h.includes("/api/media-signed?t=v"))).toBe(true);
  });
});
