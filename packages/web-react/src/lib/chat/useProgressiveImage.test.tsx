/**
 * useProgressiveImage 行为断言 —— 分级(w)、流式进度、字节复用(二开零 fetch)、
 * 原图预览(缩略先渲)、本地字节零网络、失败态。jsdom 无 IntersectionObserver → 立即拉。
 */
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useProgressiveImage } from "./useProgressiveImage";
import { byteCacheKey, imageByteCache } from "./imageBytes";

let objUrlSeq = 0;

beforeEach(() => {
  imageByteCache.clear();
  objUrlSeq = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => `blob:mock-${++objUrlSeq}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 流式 Response mock:分块吐字节,带 content-length。 */
function streamResponse(
  chunks: number[],
  opts: { status?: number; total?: number | null; contentType?: string } = {},
): Response {
  const { status = 200, contentType = "image/webp" } = opts;
  const total = opts.total === undefined ? chunks.reduce((a, b) => a + b, 0) : opts.total;
  let i = 0;
  const headers = new Headers();
  if (total != null) headers.set("content-length", String(total));
  headers.set("content-type", contentType);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: new Uint8Array(chunks[i++]!) }
              : { done: true, value: undefined },
        };
      },
    },
  } as unknown as Response;
}

describe("useProgressiveImage", () => {
  test("localSrc / 直链本地字节在手 → 零网络透传,不 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useProgressiveImage({ src: "blob:local-preview", width: 640, cacheIdentity: "/p", lazy: false }),
    );
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.objectUrl).toBe("blob:local-preview");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("签名 URL 缩略 → fetch 追加 ?w=640,进度到 100%,objectUrl 变 blob", async () => {
    const fetchMock = vi.fn(async () => streamResponse([300, 200, 500], { total: 1000 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useProgressiveImage({
        src: "/api/media-signed?t=v1",
        width: 640,
        cacheIdentity: "/home/agent/chart.png",
        lazy: false,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    // 追加了缩略宽度(渲染参数)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/media-signed?t=v1&w=640");
    expect(result.current.percent).toBe(100);
    expect(result.current.objectUrl?.startsWith("blob:")).toBe(true);
    // 字节已写回共享缓存(二开可复用)
    expect(imageByteCache.get(byteCacheKey("/home/agent/chart.png", 640))).not.toBeNull();
  });

  test("字节缓存命中 → 二开零 fetch、零 loading 闪(直接 loaded)", async () => {
    // 预置缩略缓存(模拟气泡已载)
    imageByteCache.set(byteCacheKey("/home/agent/chart.png", 640), new Blob(["x".repeat(50)]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useProgressiveImage({
        src: "/api/media-signed?t=v2",
        width: 640,
        cacheIdentity: "/home/agent/chart.png",
        lazy: false,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(fetchMock).not.toHaveBeenCalled(); // 命中缓存 → 零请求
    expect(result.current.objectUrl?.startsWith("blob:")).toBe(true);
  });

  test("查看器原图(width=null)miss → 先复用气泡缩略做即时预览,再拉原图无缝换", async () => {
    // 气泡已载 w1280 缩略
    imageByteCache.set(byteCacheKey("/home/agent/chart.png", 1280), new Blob(["thumb"]));
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useProgressiveImage({
        src: "/api/media-signed?t=orig",
        width: null,
        cacheIdentity: "/home/agent/chart.png",
        lazy: false,
      }),
    );
    // 原图未到,但缩略预览已即时铺上(objectUrl 有值),状态仍 loading(顶部进度)。
    await waitFor(() => expect(result.current.objectUrl).not.toBeNull());
    expect(result.current.status).toBe("loading");
    const previewUrl = result.current.objectUrl;
    // 原图无 w(取原图)
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/media-signed?t=orig");
    // 原图到达 → 无缝换到原图(objectUrl 变、状态 loaded)
    await act(async () => {
      resolveFetch(streamResponse([100], { total: 100, contentType: "image/png" }));
    });
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(result.current.objectUrl).not.toBe(previewUrl);
  });

  test("HTTP 错误(非 2xx,不可重签)→ error 态", async () => {
    const fetchMock = vi.fn(async () => streamResponse([], { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useProgressiveImage({ src: "/api/media-signed?t=v1", width: 640, cacheIdentity: "/p", lazy: false }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  test("403 → 强制重签一次再拉成功", async () => {
    const resolveSrc = vi.fn(async () => "/api/media-signed?t=fresh");
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("t=stale") ? streamResponse([], { status: 403 }) : streamResponse([10], { total: 10 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useProgressiveImage({
        src: "/api/media-signed?t=stale",
        width: 640,
        cacheIdentity: "/p",
        resolveSrc,
        lazy: false,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("loaded"));
    expect(resolveSrc).toHaveBeenCalledWith({ forceResign: true });
    // 第二次 fetch 用重签后的 URL + w
    expect((fetchMock.mock.calls[1] as unknown[])[0]).toBe("/api/media-signed?t=fresh&w=640");
  });
});
