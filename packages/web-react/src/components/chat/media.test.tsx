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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MediaSignProvider, SignedFileCard, ZoomableImage } from "./media";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ZoomableImage 灯箱", () => {
  const src = "https://example.test/chart.png";

  test("缩略态渲染 img + 可访问的放大按钮", () => {
    render(<ZoomableImage src={src} alt="拟合曲线" imgClassName="max-h-72" />);
    const btn = screen.getByRole("button", { name: /放大查看 拟合曲线/ });
    expect(btn).toBeInTheDocument();
    const img = screen.getByAltText("拟合曲线");
    expect(img).toHaveAttribute("src", src);
    expect(img.className).toContain("max-h-72");
  });

  test("点击缩略图 → 打开全尺寸预览 + 新标签原图链接;关闭按钮收起", () => {
    render(<ZoomableImage src={src} alt="拟合曲线" />);
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    const imgs = screen.getAllByAltText("拟合曲线");
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    const link = screen.getByRole("link", { name: /新标签打开原图/ });
    expect(link).toHaveAttribute("href", src);
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("link", { name: /新标签打开原图/ })).not.toBeInTheDocument();
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
    expect(fetchMock.mock.calls[0][0]).toBe("/api/media-signed?t=v2");
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

describe("ZoomableImage 灯箱开启时刷新签名", () => {
  test("传 signPath → 开灯箱现场重签,原图链接用新 URL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sign = makeSignMock();
    render(
      <MediaSignProvider sign={sign}>
        <ZoomableImage src="/api/media-signed?t=stale" alt="图表" signPath="/home/agent/a.png" />
      </MediaSignProvider>,
    );
    vi.advanceTimersByTime(5 * 60_000); // 挂载 5 分钟后才点开大图
    fireEvent.click(screen.getByRole("button", { name: /放大查看/ }));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /新标签打开原图/ })).toHaveAttribute(
        "href",
        "/api/media-signed?t=v1",
      );
    });
  });
});
