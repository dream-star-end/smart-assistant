import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAsset } from "../../lib/types";
import { prefetchMarkdownImpl } from "../Markdown";
import { MediaSignProvider } from "../chat/media";
import { ToastProvider, TooltipProvider } from "../ui";
import { OutputRow, OutputViewer, __resetOutputSnippetCache } from "./OutputViewer";

const sign = async (paths: string[]) =>
  Object.fromEntries(paths.map((p) => [p, `/api/media-signed?t=${encodeURIComponent(p)}`]));

function wrap(children: ReactNode) {
  return (
    <ToastProvider>
      <TooltipProvider>
        <MediaSignProvider sign={sign} authKey="u1">
          {children}
        </MediaSignProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}

function out(over: Partial<ProjectAsset> & Pick<ProjectAsset, "id" | "name">): ProjectAsset {
  return {
    projectId: "p1",
    source: "output",
    sessionId: "s1",
    url: `/api/media/${"a".repeat(64)}`,
    containerPath: null,
    mime: null,
    sizeBytes: 100,
    excerpt: null,
    pinned: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function renderViewer(asset: ProjectAsset, sourceTitle: string | undefined = "周报会话") {
  const h = { onClose: vi.fn(), onOpenSession: vi.fn(), onShowVersions: vi.fn() };
  render(wrap(<OutputViewer asset={asset} sourceTitle={sourceTitle} {...h} />));
  return h;
}

// Markdown 渲染器是懒块：先热好，免得首个用例把冷启动时间算进超时。
beforeAll(async () => {
  await prefetchMarkdownImpl();
}, 60_000);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  __resetOutputSnippetCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OutputViewer", () => {
  it("纯文本按文字显示，内容里的 HTML 不会变成元素；可复制", async () => {
    const body = '<img src=x onerror="alert(1)"><b>粗体?</b>\n第二行';
    fetchMock.mockResolvedValue(new Response(body));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderViewer(out({ id: "t", name: "notes.txt" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("output-viewer")).toHaveAttribute("data-preview-kind", "text");
    const pre = await within(dialog).findByTestId("output-preview-text");
    expect(pre.textContent).toBe(body);
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("b")).toBeNull();
    // 只经签名 URL 取字节。
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^\/api\/media-signed\?t=/);
    fireEvent.click(await within(dialog).findByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
  });

  it("Markdown 用站内渲染器渲染，原始 HTML 不执行", async () => {
    fetchMock.mockResolvedValue(
      new Response("# 本周周报\n\n<script>window.__pwned = 1</script>\n<img src=x onerror=alert(1)>\n\n- 完成侧栏搜索"),
    );
    renderViewer(out({ id: "m", name: "weekly.md" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("heading", { name: "本周周报" }, { timeout: 5000 })).toBeInTheDocument();
    expect(within(dialog).getByText("完成侧栏搜索")).toBeInTheDocument();
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("代码用代码块显示（带语言名）", async () => {
    fetchMock.mockResolvedValue(new Response("export const a = 1;\n"));
    renderViewer(out({ id: "c", name: "main.ts" }));
    const dialog = await screen.findByRole("dialog");
    const code = await within(dialog).findByTestId("output-preview-code");
    await waitFor(() => expect(code).toHaveTextContent("export const a = 1;"), { timeout: 5000 });
    await waitFor(() => expect(code).toHaveTextContent("typescript"), { timeout: 5000 });
  });

  it("已知超过 1 MB 的文本不发请求，直接给下载", async () => {
    renderViewer(out({ id: "big", name: "huge.log", sizeBytes: 5 * 1024 * 1024 }));
    const dialog = await screen.findByRole("dialog");
    const fb = within(dialog).getByTestId("output-preview-fallback");
    expect(fb).toHaveTextContent("文件较大");
    expect(fb).toHaveTextContent("5.0 MB");
    expect(within(fb).getByRole("button", { name: /下载/ })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("大小未知但响应超过上限：中止并回落下载", async () => {
    fetchMock.mockResolvedValue(new Response("x", { headers: { "content-length": String(3 * 1024 * 1024) } }));
    renderViewer(out({ id: "big2", name: "dump.txt", sizeBytes: null }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("output-preview-fallback")).toHaveTextContent("文件较大");
  });

  it("二进制内容冒充文本：不显示乱码，给下载", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0xfe])));
    renderViewer(out({ id: "bin", name: "weird.txt" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("output-preview-fallback")).toHaveTextContent("这不是纯文本文件");
  });

  it("PDF：验过魔数后用 application/pdf 的 object URL 内嵌，可新标签页打开", async () => {
    fetchMock.mockResolvedValue(new Response("%PDF-1.7\n1 0 obj\n"));
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      created.push(b as Blob);
      return "blob:pdf-1";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    renderViewer(out({ id: "pdf", name: "report.pdf" }));
    const dialog = await screen.findByRole("dialog");
    const frame = await within(dialog).findByTestId("output-preview-pdf");
    expect(frame).toHaveAttribute("src", "blob:pdf-1");
    expect(frame).toHaveAttribute("title", "report.pdf 预览");
    expect(created[0]!.type).toBe("application/pdf");
    expect(await within(dialog).findByRole("button", { name: /新标签页打开/ })).toBeInTheDocument();
  });

  it("不是 PDF 的 .pdf 不交给浏览器 PDF 查看器", async () => {
    fetchMock.mockResolvedValue(new Response("<html><script>alert(1)</script></html>"));
    renderViewer(out({ id: "fake", name: "fake.pdf" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByTestId("output-preview-fallback")).toHaveTextContent("不是有效的 PDF");
    expect(dialog.querySelector("iframe")).toBeNull();
  });

  it("超大 Markdown（90 万字符的无语言围栏）不走富文本解析与高亮，按纯文本显示", async () => {
    const body = `\`\`\`\n${"a".repeat(900_000)}\n\`\`\`\n`;
    fetchMock.mockResolvedValue(new Response(body));
    renderViewer(out({ id: "huge", name: "huge.md", sizeBytes: body.length }));
    const dialog = await screen.findByRole("dialog");
    const pre = await within(dialog).findByTestId("output-preview-text");
    expect(pre.textContent).toHaveLength(body.length);
    expect(within(dialog).getByTestId("output-preview-plain-note")).toHaveTextContent("按纯文本显示");
    expect(within(dialog).queryByTestId("output-preview-markdown")).toBeNull();
    expect(dialog.querySelector(".hljs")).toBeNull();
  });

  it("超大或大小未知的图片不自动加载：先给下载 /「仍要预览」，点了才取", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:img-big");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    renderViewer(out({ id: "big-img", name: "huge.png", url: "/api/media/big-img", sizeBytes: 512 * 1024 * 1024 }));
    let dialog = await screen.findByRole("dialog");
    const fb = within(dialog).getByTestId("output-preview-fallback");
    expect(fb).toHaveTextContent("图片较大");
    expect(fb).toHaveTextContent("512.0 MB");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }));
    fireEvent.click(within(fb).getByRole("button", { name: "仍要预览" }));
    expect(await within(dialog).findByTestId("output-preview-image")).toHaveAttribute("src", "blob:img-big");
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/&w=1280$/);

    cleanup();
    fetchMock.mockClear();
    renderViewer(out({ id: "unk-img", name: "unknown.png", url: "/api/media/unk-img", sizeBytes: null }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("output-preview-fallback")).toHaveTextContent("图片大小未知");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("压缩包：详情 + 下载，不取字节；版本历史与「在会话中打开」是次要操作", async () => {
    const h = renderViewer(out({ id: "zip", name: "v5-offline-all-amd64.zip", sizeBytes: 3 * 1024 * 1024, versionCount: 3 }));
    const dialog = await screen.findByRole("dialog");
    const details = within(dialog).getByTestId("output-details");
    expect(details).toHaveTextContent("v5-offline-all-amd64.zip");
    expect(details).toHaveTextContent("3.0 MB");
    expect(details).toHaveTextContent("周报会话");
    expect(within(dialog).getByRole("button", { name: "下载 v5-offline-all-amd64.zip" })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "v5-offline-all-amd64.zip 共 3 个版本，查看版本历史" }));
    expect(h.onClose).toHaveBeenCalled();
    expect(h.onShowVersions).toHaveBeenCalledWith(expect.objectContaining({ id: "zip" }));
  });

  it("「在会话中打开」仍在：关掉查看器并跳到来源会话；没有来源会话就不显示", async () => {
    fetchMock.mockResolvedValue(new Response("hi"));
    const h = renderViewer(out({ id: "t2", name: "a.txt", sessionId: "s-9" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /在会话中打开/ }));
    expect(h.onClose).toHaveBeenCalled();
    expect(h.onOpenSession).toHaveBeenCalledWith("s-9");
    cleanup();
    renderViewer(out({ id: "t3", name: "b.txt", sessionId: null }), undefined);
    const d2 = await screen.findByRole("dialog");
    expect(within(d2).queryByRole("button", { name: /在会话中打开/ })).toBeNull();
  });

  it("Esc 关闭", async () => {
    fetchMock.mockResolvedValue(new Response("hi"));
    const h = renderViewer(out({ id: "t4", name: "c.txt" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(h.onClose).toHaveBeenCalled());
  });

  it("图片：走签名 + 缩略档取字节显示，可放大", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:img-1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    renderViewer(out({ id: "img", name: "chart.png" }));
    const dialog = await screen.findByRole("dialog");
    const img = await within(dialog).findByTestId("output-preview-image");
    expect(img).toHaveAttribute("src", "blob:img-1");
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^\/api\/media-signed\?t=.*&w=1280$/);
    expect(within(dialog).getByRole("button", { name: "放大查看 chart.png" })).toBeInTheDocument();
  });
});

describe("OutputRow", () => {
  it("整行一个按钮；文本类取头部 4 KB（Range）显示首几行，并缓存", async () => {
    fetchMock.mockResolvedValue(new Response("# 周报\n\n本周完成侧栏搜索\n下周计划"));
    const onOpen = vi.fn();
    const a = out({ id: "r1", name: "weekly.md", versionCount: 2 });
    render(wrap(<OutputRow asset={a} sourceTitle="周报会话" onOpen={onOpen} />));
    const row = screen.getByRole("button", { name: "查看 weekly.md" });
    expect(row.className).toMatch(/min-h-12/);
    expect(await screen.findByTestId("output-snippet")).toHaveTextContent("周报 本周完成侧栏搜索 下周计划");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ Range: "bytes=0-4095" });
    expect(within(row).getByTestId("output-version-badge")).toHaveTextContent("v2");
    expect(within(row).getByText(/来自「周报会话」/)).toBeInTheDocument();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(a);

    cleanup();
    render(wrap(<OutputRow asset={a} onOpen={onOpen} />));
    expect(await screen.findByTestId("output-snippet")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("列表缩略图只给大小已知且不大的图片自动加载（640 档）；超大或大小未知只显示类型标记", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumb");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(
      wrap(
        <>
          <OutputRow asset={out({ id: "huge", name: "huge.png", url: "/api/media/huge", sizeBytes: 512 * 1024 * 1024 })} onOpen={vi.fn()} />
          <OutputRow asset={out({ id: "unk", name: "unknown.png", url: "/api/media/unk", sizeBytes: null })} onOpen={vi.fn()} />
          <OutputRow asset={out({ id: "ok", name: "chart.png", url: "/api/media/ok", sizeBytes: 48_000 })} onOpen={vi.fn()} />
        </>,
      ),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/media%2Fok.*&w=640$/);
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const thumbs = screen.getAllByTestId("output-thumb");
    expect(thumbs[0]!.querySelector("img")).toBeNull();
    expect(thumbs[1]!.querySelector("img")).toBeNull();
    await waitFor(() => expect(thumbs[2]!.querySelector("img")).toHaveAttribute("src", "blob:thumb"));
  });

  it("有服务端摘要直接用；大文件、压缩包不取字节，只显示扩展名标记", async () => {
    render(
      wrap(
        <>
          <OutputRow asset={out({ id: "e", name: "brief.md", excerpt: "## 背景\n项目说明" })} onOpen={vi.fn()} />
          <OutputRow asset={out({ id: "z", name: "bundle.zip", sizeBytes: 9_000_000 })} onOpen={vi.fn()} />
          <OutputRow asset={out({ id: "l", name: "big.log", sizeBytes: 900_000 })} onOpen={vi.fn()} />
        </>,
      ),
    );
    expect(screen.getByTestId("output-snippet")).toHaveTextContent("背景 项目说明");
    expect(screen.getByText("ZIP")).toBeInTheDocument();
    expect(screen.getByText("LOG")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
