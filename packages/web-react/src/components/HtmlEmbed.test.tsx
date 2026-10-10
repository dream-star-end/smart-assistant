import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.fn(async (p: string) => `/api/media/signed?p=${encodeURIComponent(p)}`);
const invalidate = vi.fn();
vi.mock("./chat/media", () => ({
  useMediaSigner: () => ({ resolve, invalidate }),
  useSignedSrc: (src: string | null) => ({ url: src ? `/api/media/signed?p=${encodeURIComponent(src)}` : null, onError: () => {} }),
  SignedFileCard: ({ filename }: { filename?: string }) => <span data-testid="filecard">{filename}</span>,
}));

import { HtmlFileEmbed, HtmlPreview, isSelfContainedHtml } from "./HtmlEmbed";
import {
  embedCsp,
  embedFileName,
  injectHead,
  isBridgeablePath,
  isHeavyEmbed,
  usesFileBridge,
  wrapEmbedHtml,
} from "./embedDoc";

const PAGE = "<!DOCTYPE html><html><head><title>户型</title></head><body><div id=a>hi</div></body></html>";

function frame(container: HTMLElement): HTMLIFrameElement {
  const f = container.querySelector("iframe");
  if (!f) throw new Error("no iframe");
  return f as HTMLIFrameElement;
}
function tokenOf(f: HTMLIFrameElement): string {
  const m = /T="([0-9a-f]+)"/.exec(f.getAttribute("srcdoc") ?? "");
  if (!m) throw new Error("no token");
  return m[1]!;
}
function fromFrame(f: HTMLIFrameElement, data: unknown, source: Window | null = f.contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

beforeEach(() => {
  resolve.mockClear();
  invalidate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.classList.remove("dark");
});

describe("embedDoc 注入", () => {
  it("CSP、套件和引导脚本放在模型代码之前;有 <head> 就放进 head,doctype 保持在最前", () => {
    const out = wrapEmbedHtml(PAGE, { token: "ab", dark: false, vars: { "--oc-fg": "#111" } });
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    const csp = out.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(out.indexOf("<head>"));
    expect(csp).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain('id="oc-kit"');
    expect(out).toContain(":root{--oc-fg:#111}");
    expect(out).toContain('<html data-theme="light">');
  });

  it("片段 / 只有 doctype / 只有 html 三种写法都能放对位置", () => {
    const frag = injectHead("<div>x</div>", "<meta x>", true);
    expect(frag).toBe('<!DOCTYPE html><html data-theme="dark"><head><meta x></head><body><div>x</div></body></html>');
    expect(injectHead("<!doctype html><div>x</div>", "<meta x>", false)).toBe("<!doctype html><head><meta x></head><div>x</div>");
    expect(injectHead('<html lang="zh"><body>x</body></html>', "<meta x>", false)).toBe(
      '<html data-theme="light" lang="zh"><head><meta x></head><body>x</body></html>',
    );
  });

  it("CSP:脚本 / 网络只认固定 CDN,禁止提交表单和改 base", () => {
    const csp = embedCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
    expect(csp).toMatch(/connect-src data: blob: https:\/\/cdn\.jsdelivr\.net/);
    expect(csp).not.toMatch(/connect-src[^;]*https:(?!\/\/)/);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("主题变量值去掉能逃出样式块的字符", () => {
    const out = wrapEmbedHtml("<div/>", { token: "ab", dark: false, vars: { "--oc-fg": "red}</style><script>x()</script>" } });
    expect(out).not.toContain("</style><script>x()");
  });

  it("文件桥只在模型代码静态用到时启用,只给生成目录", () => {
    expect(usesFileBridge('<img data-oc-src="/root/.openclaude/generated/a.png">')).toBe(true);
    expect(usesFileBridge("const u = await ocFile('/x')")).toBe(true);
    expect(usesFileBridge("<div>no bridge</div>")).toBe(false);
    expect(wrapEmbedHtml("<div/>", { token: "ab", dark: false, vars: {} })).not.toContain("window.ocFile");
    expect(isBridgeablePath("/home/agent/.openclaude/generated/house.glb")).toBe(true);
    expect(isBridgeablePath("/root/.openclaude/generated/sub/a.png")).toBe(true);
    expect(isBridgeablePath("/home/agent/.openclaude/uploads/id.png")).toBe(false);
    expect(isBridgeablePath("/home/agent/.openclaude/generated/../credentials.json")).toBe(false);
    expect(isBridgeablePath("/etc/passwd")).toBe(false);
    expect(isBridgeablePath(42)).toBe(false);
  });

  it("canvas / three.js 内容算重内容;文件名取 <title>", () => {
    expect(isHeavyEmbed("<canvas></canvas>")).toBe(true);
    expect(isHeavyEmbed('import * as THREE from "three"')).toBe(true);
    expect(isHeavyEmbed("<div>hi</div>")).toBe(false);
    expect(embedFileName(PAGE)).toBe("户型.html");
    expect(embedFileName("<div/>")).toBe("interactive.html");
  });

  it("引用相对路径资源的 HTML 文件不算自包含", () => {
    expect(isSelfContainedHtml(PAGE)).toBe(true);
    expect(isSelfContainedHtml('<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"></script>')).toBe(true);
    expect(isSelfContainedHtml('<script src="app.js"></script>')).toBe(false);
    expect(isSelfContainedHtml('<link href="./style.css" rel="stylesheet">')).toBe(false);
    expect(isSelfContainedHtml('<a href="other.html">x</a>')).toBe(true);
  });
});

describe("HtmlPreview 无缝嵌入", () => {
  it("没有标题栏;iframe 只开 allow-scripts,srcdoc 带 CSP;下方一行写明是沙盒里的交互内容", () => {
    const { container } = render(<HtmlPreview code={PAGE} />);
    const f = frame(container);
    expect(f).toHaveAttribute("sandbox", "allow-scripts");
    expect(f).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(f.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(container.textContent).not.toContain("HTML 预览");
    expect(container.textContent).toContain("交互内容 · 沙盒运行");
    expect(container.querySelector(".oc-embed-frame")).toHaveStyle({ height: "360px" });
  });

  it("流式期间 HTML 没写完先显示占位,写完才挂载一次(不再逐段重载)", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<HtmlPreview code="<!DOCTYPE html><html><body><canvas" live />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("正在生成交互内容");
    rerender(<HtmlPreview code={PAGE} live />);
    const first = frame(container);
    const doc = first.getAttribute("srcdoc");
    expect(doc).toContain("<div id=a>hi</div>");
    rerender(<HtmlPreview code={PAGE} />);
    expect(frame(container).getAttribute("srcdoc")).toBe(doc);
  });

  it("没有 </html> 收尾的片段:停止变化 1.5 秒后挂载;流式结束后换成最终版本", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<HtmlPreview code="<div>A</div>" live />);
    expect(container.querySelector("iframe")).toBeNull();
    act(() => vi.advanceTimersByTime(1500));
    expect(frame(container).getAttribute("srcdoc")).toContain("<div>A</div>");
    rerender(<HtmlPreview code="<div>AB</div>" live />);
    expect(frame(container).getAttribute("srcdoc")).not.toContain("<div>AB</div>");
    rerender(<HtmlPreview code="<div>AB</div>" />);
    expect(frame(container).getAttribute("srcdoc")).toContain("<div>AB</div>");
  });

  it("高度随内容:只认本 iframe 且带本次 token 的消息,并限制在上下限之间", () => {
    const { container } = render(<HtmlPreview code={PAGE} />);
    const f = frame(container);
    const token = tokenOf(f);
    const box = () => container.querySelector(".oc-embed-frame") as HTMLElement;
    fromFrame(f, { oc: "embed", token, type: "size", h: 540 });
    expect(box()).toHaveStyle({ height: "540px" });
    fromFrame(f, { oc: "embed", token: "forged", type: "size", h: 200 });
    expect(box()).toHaveStyle({ height: "540px" });
    fromFrame(f, { oc: "embed", token, type: "size", h: 200 }, window);
    expect(box()).toHaveStyle({ height: "540px" });
    fromFrame(f, { oc: "embed", token, type: "size", h: 99999 });
    expect(Number.parseInt(box().style.height, 10)).toBeLessThanOrEqual(900);
    fromFrame(f, { oc: "embed", token, type: "size", h: 10 });
    expect(box()).toHaveStyle({ height: "120px" });
  });

  it("进入视口附近才挂载;挂上之后观察器再报「离开」也不卸载(整页截图 / 打印时会误报)", () => {
    let cb: ((e: { isIntersecting: boolean }[]) => void) | null = null;
    const observe = vi.fn();
    class IO {
      constructor(fn: (e: { isIntersecting: boolean }[]) => void) {
        cb = fn;
      }
      observe = observe;
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", IO);
    try {
      const { container } = render(<HtmlPreview code={"<canvas></canvas>"} />);
      expect(container.querySelector("iframe")).toBeNull();
      act(() => cb?.([{ isIntersecting: true }]));
      expect(container.querySelector("iframe")).toBeTruthy();
      act(() => cb?.([{ isIntersecting: false }]));
      expect(container.querySelector("iframe")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("就绪和切换明暗时把主题推给 iframe,不重载", () => {
    const { container } = render(<HtmlPreview code={PAGE} />);
    const f = frame(container);
    const token = tokenOf(f);
    const post = vi.spyOn(f.contentWindow as Window, "postMessage");
    const doc = f.getAttribute("srcdoc");
    fromFrame(f, { oc: "embed", token, type: "ready" });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ oc: "host", token, type: "theme", dark: false }), "*");
    act(() => document.documentElement.classList.add("dark"));
    return waitFor(() => {
      expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "theme", dark: true }), "*");
      expect(frame(container).getAttribute("srcdoc")).toBe(doc);
    });
  });

  it("iframe 被导航到别的页面(第二次 load)就停止运行,可以重新运行", () => {
    const { container } = render(<HtmlPreview code={PAGE} />);
    fireEvent.load(frame(container));
    fireEvent.load(frame(container));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("尝试打开其它页面,已停止运行");
    fireEvent.click(screen.getAllByRole("button", { name: /重新运行/ })[0]!);
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("看源码 / 下载 HTML", () => {
    const { container } = render(<HtmlPreview code={PAGE} />);
    fireEvent.click(screen.getByRole("button", { name: "看源码" }));
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("<div id=a>hi</div>");
    fireEvent.click(screen.getByRole("button", { name: "看预览" }));
    expect(container.querySelector("iframe")).toBeTruthy();
    const create = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "下载 HTML 文件" }));
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
  });
});

describe("HtmlPreview 文件桥", () => {
  const BRIDGE = `<!DOCTYPE html><html><head></head><body><img data-oc-src="/home/agent/.openclaude/generated/plan.png"></body></html>`;

  it("生成目录里的文件:签名后取字节,经 postMessage 交给 iframe(不给 URL)", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "content-type": "image/png", "content-length": "3" } }),
    );
    const { container } = render(<HtmlPreview code={BRIDGE} />);
    const f = frame(container);
    expect(f.getAttribute("srcdoc")).toContain("window.ocFile");
    const token = tokenOf(f);
    const post = vi.spyOn(f.contentWindow as Window, "postMessage");
    fromFrame(f, { oc: "embed", token, type: "file", id: 7, path: "/home/agent/.openclaude/generated/plan.png" });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ oc: "host", token, type: "file", id: 7, ok: true, mime: "image/png" }),
        "*",
        expect.any(Array),
      ),
    );
    expect(resolve).toHaveBeenCalledWith("/home/agent/.openclaude/generated/plan.png");
    const sent = post.mock.calls.find((c) => (c[0] as { id?: number }).id === 7)?.[0] as Record<string, unknown>;
    expect(JSON.stringify(Object.keys(sent))).not.toContain("url");
  });

  it("生成目录以外的路径拒绝,不去签名", async () => {
    const { container } = render(<HtmlPreview code={BRIDGE} />);
    const f = frame(container);
    const token = tokenOf(f);
    const post = vi.spyOn(f.contentWindow as Window, "postMessage");
    fromFrame(f, { oc: "embed", token, type: "file", id: 1, path: "/home/agent/.openclaude/uploads/id.png" });
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 1, ok: false }), "*", []));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("代码里没用到文件桥的嵌入,文件请求一概不理", async () => {
    const { container } = render(<HtmlPreview code={PAGE} />);
    const f = frame(container);
    const token = tokenOf(f);
    const post = vi.spyOn(f.contentWindow as Window, "postMessage");
    fromFrame(f, { oc: "embed", token, type: "file", id: 2, path: "/home/agent/.openclaude/generated/plan.png" });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolve).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "file" }), "*", expect.anything());
  });

  it("超过大小上限的文件不交给 iframe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", { status: 200, headers: { "content-length": String(41 * 1024 * 1024) } }),
    );
    const { container } = render(<HtmlPreview code={BRIDGE} />);
    const f = frame(container);
    const token = tokenOf(f);
    const post = vi.spyOn(f.contentWindow as Window, "postMessage");
    fromFrame(f, { oc: "embed", token, type: "file", id: 3, path: "/home/agent/.openclaude/generated/big.glb" });
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: 3, ok: false }), "*", []));
  });
});

describe("HtmlFileEmbed", () => {
  it("自包含的 .html 文件:嵌入 + 下载卡", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(PAGE, { status: 200 }));
    const { container } = render(<HtmlFileEmbed src="/home/agent/.openclaude/generated/house.html" filename="house.html" />);
    expect(screen.getByTestId("filecard")).toHaveTextContent("house.html");
    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  });

  it("引用相对资源的 .html 文件只给下载卡", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<script src="app.js"></script>', { status: 200 }));
    const { container } = render(<HtmlFileEmbed src="/home/agent/.openclaude/generated/site.html" filename="site.html" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("filecard")).toBeInTheDocument();
  });
});
