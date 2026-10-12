import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeLanguageOf,
  decodeText,
  extBadgeOf,
  fenceCode,
  fetchSignedCapped,
  knownTooLarge,
  looksLikePdf,
  previewKindOf,
  snippetOf,
} from "./outputPreview";

afterEach(() => {
  vi.unstubAllGlobals();
});

const enc = (s: string) => new TextEncoder().encode(s);

describe("previewKindOf", () => {
  it("按扩展名优先、mime 兜底选预览形态", () => {
    const k = (name: string, mime: string | null = null) => previewKindOf({ name, mime });
    expect(k("PROPOSAL.md")).toBe("markdown");
    expect(k("notes", "text/markdown")).toBe("markdown");
    expect(k("chart.PNG")).toBe("image");
    expect(k("logo.svg")).toBe("image");
    expect(k("noext", "image/webp")).toBe("image");
    expect(k("report.pdf")).toBe("pdf");
    expect(k("noext", "application/pdf")).toBe("pdf");
    expect(k("main.ts")).toBe("code");
    expect(k("landing/index.html")).toBe("code");
    expect(k("data.json")).toBe("code");
    expect(k("readme.txt")).toBe("text");
    expect(k("usage.csv")).toBe("text");
    expect(k("noext", "text/plain")).toBe("text");
    expect(k("v5-offline-all-amd64.zip", "application/zip")).toBe("file");
    expect(k("deck.pptx")).toBe("file");
    expect(k("usage.xlsx")).toBe("file");
    // 已知二进制扩展名不因 mime 声称 text 而被当文本读。
    expect(k("archive.zip", "text/plain")).toBe("file");
    expect(k("noext", "application/octet-stream")).toBe("file");
  });

  it("代码语言名与扩展名标记", () => {
    expect(codeLanguageOf("a.ts")).toBe("typescript");
    expect(codeLanguageOf("run.sh")).toBe("bash");
    expect(codeLanguageOf("x.go")).toBe("go");
    expect(extBadgeOf("v5-offline.tar.gz")).toBe("GZ");
    expect(extBadgeOf("Makefile")).toBe("FILE");
    expect(extBadgeOf("a.markdown")).toBe("MARK");
  });
});

describe("文本处理", () => {
  it("围栏比正文最长的反引号串多一个，正文不能提前闭合", () => {
    const code = "const a = `x`;\n```\nnot a fence end\n";
    const md = fenceCode(code, "ts");
    expect(md.startsWith("````ts\n")).toBe(true);
    expect(md.endsWith("\n````")).toBe(true);
    // 语言名只允许安全字符
    expect(fenceCode("x", "a b<c").startsWith("```\n")).toBe(true);
  });

  it("decodeText：UTF-8 文本原样（去 BOM），二进制返回 null", () => {
    expect(decodeText(enc("﻿你好 world"))).toBe("你好 world");
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff]))).toBeNull();
  });

  it("looksLikePdf 只认 %PDF- 魔数", () => {
    expect(looksLikePdf(enc("%PDF-1.7\n..."))).toBe(true);
    expect(looksLikePdf(enc("<html><script>alert(1)</script>"))).toBe(false);
  });

  it("snippetOf：跳过空行与分隔线，Markdown 去掉行首记号，按行数与字数截断", () => {
    const md = "# 周报\n\n---\n> 本周完成\n- 侧栏搜索\n- 第四行";
    expect(snippetOf(md, "markdown")).toBe("周报\n本周完成\n侧栏搜索");
    expect(snippetOf("x".repeat(200), "text", 3, 10)).toBe(`${"x".repeat(10)}…`);
    expect(snippetOf("  indent()\n", "code")).toBe("  indent()");
  });

  it("knownTooLarge 只在大小已知且超限时为真", () => {
    expect(knownTooLarge(2_000_000, 1_000_000)).toBe(true);
    expect(knownTooLarge(null, 1)).toBe(false);
    expect(knownTooLarge(10, 100)).toBe(false);
  });
});

describe("fetchSignedCapped", () => {
  const get = vi.fn(async (opts?: { forceResign?: boolean }) =>
    opts?.forceResign ? "/api/media-signed?t=fresh" : "/api/media-signed?t=old",
  );
  afterEach(() => get.mockClear());

  it("Content-Length 超过上限直接返回 too-large，不读正文", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(10), { headers: { "content-length": "5000000" } })),
    );
    const r = await fetchSignedCapped(get, 1024);
    expect(r).toEqual({ kind: "too-large", total: 5_000_000 });
  });

  it("没有 Content-Length 时边读边数，超过上限中止", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 3; i++) c.enqueue(enc("y".repeat(1000)));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const r = await fetchSignedCapped(get, 1024);
    expect(r.kind).toBe("too-large");
  });

  it("签名过期（403）强制重签一次再取", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 403 }))
      .mockResolvedValueOnce(new Response("hello"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchSignedCapped(get, 1024);
    expect(r.kind).toBe("ok");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/media-signed?t=fresh");
    expect(get).toHaveBeenCalledWith({ forceResign: true });
    if (r.kind === "ok") expect(new TextDecoder().decode(r.bytes)).toBe("hello");
  });

  it("truncate：带 Range 头，只保留前 cap 字节", async () => {
    const fetchMock = vi.fn(async () => new Response("abcdefghij"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchSignedCapped(get, 4, { truncate: true });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(new TextDecoder().decode(r.bytes)).toBe("abcd");
      expect(r.truncated).toBe(true);
    }
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ Range: "bytes=0-3" });
  });

  it("签不出 URL 时报错，不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSignedCapped(async () => null, 10)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
