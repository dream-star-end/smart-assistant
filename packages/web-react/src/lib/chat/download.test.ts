import { afterEach, describe, expect, test } from "vitest";
import {
  DOWNLOAD_STREAM_MAX_BYTES,
  DOWNLOAD_STREAM_MIN_BYTES,
  downloadPercent,
  fileCardSniffEnabled,
  formatBytes,
  OFFICE_PDF_MIN_BYTES,
  pickDownloadStrategy,
  sniffOfficeOrPdfMagic,
} from "./download";

afterEach(() => {
  delete (globalThis as { __OC_FILECARD_SNIFF?: string }).__OC_FILECARD_SNIFF;
});

describe("pickDownloadStrategy（按 Content-Length 选下载路径）", () => {
  test("未知 / 非法尺寸 → native（无法算百分比，交原生边下边写盘）", () => {
    expect(pickDownloadStrategy(null)).toBe("native");
    expect(pickDownloadStrategy(undefined)).toBe("native");
    expect(pickDownloadStrategy(0)).toBe("native");
    expect(pickDownloadStrategy(-5)).toBe("native");
    expect(pickDownloadStrategy(Number.NaN)).toBe("native");
  });

  test("小文件(<3MB) → native（原生更可靠，尤其 iOS blob）", () => {
    expect(pickDownloadStrategy(1)).toBe("native");
    expect(pickDownloadStrategy(DOWNLOAD_STREAM_MIN_BYTES - 1)).toBe("native");
  });

  test("边界：正好 3MB → stream（含下界）", () => {
    expect(pickDownloadStrategy(DOWNLOAD_STREAM_MIN_BYTES)).toBe("stream");
  });

  test("中间带(3MB~<100MB) → stream（流式进度）", () => {
    expect(pickDownloadStrategy(10 * 1024 * 1024)).toBe("stream");
    expect(pickDownloadStrategy(DOWNLOAD_STREAM_MAX_BYTES - 1)).toBe("stream");
  });

  test("边界：正好 100MB → native（防 Blob 全量驻内存 OOM）", () => {
    expect(pickDownloadStrategy(DOWNLOAD_STREAM_MAX_BYTES)).toBe("native");
    expect(pickDownloadStrategy(500 * 1024 * 1024)).toBe("native");
  });
});

describe("downloadPercent（流读进度百分比）", () => {
  test("total 未知/非法 → null（渲染不确定态）", () => {
    expect(downloadPercent(100, null)).toBeNull();
    expect(downloadPercent(100, undefined)).toBeNull();
    expect(downloadPercent(100, 0)).toBeNull();
    expect(downloadPercent(100, Number.NaN)).toBeNull();
  });

  test("常规百分比（四舍五入）", () => {
    expect(downloadPercent(0, 100)).toBe(0);
    expect(downloadPercent(50, 100)).toBe(50);
    expect(downloadPercent(100, 100)).toBe(100);
    expect(downloadPercent(1, 3)).toBe(33);
    expect(downloadPercent(2, 3)).toBe(67);
  });

  test("loaded 越界被夹紧到 [0, total]（防抖动越 100%）", () => {
    expect(downloadPercent(150, 100)).toBe(100);
    expect(downloadPercent(-10, 100)).toBe(0);
  });
});

describe("formatBytes", () => {
  test("分级：B / KB / MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
  test("非法值 → 空串", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("sniffOfficeOrPdfMagic", () => {
  const pk = new Uint8Array(OFFICE_PDF_MIN_BYTES);
  pk[0] = 0x50;
  pk[1] = 0x4b;
  pk[2] = 0x03;
  pk[3] = 0x04;
  const pdf = new Uint8Array(OFFICE_PDF_MIN_BYTES);
  const pdfHead = new TextEncoder().encode("%PDF-1.7");
  pdf.set(pdfHead);

  test("PK / %PDF- 合法", () => {
    expect(sniffOfficeOrPdfMagic(pk, "a.docx")).toEqual({ ok: true });
    expect(sniffOfficeOrPdfMagic(pk, "a.pptx")).toEqual({ ok: true });
    expect(sniffOfficeOrPdfMagic(pk, "a.xlsx")).toEqual({ ok: true });
    expect(sniffOfficeOrPdfMagic(pdf, "a.pdf")).toEqual({ ok: true });
  });

  test("`{` / `<!DOC` / 过短 → 拒", () => {
    const json = new TextEncoder().encode('{"error":{"code":"GONE"}}');
    expect(sniffOfficeOrPdfMagic(json, "a.docx")).toEqual({ ok: false, reason: "too-small" });
    const jsonPadded = new Uint8Array(OFFICE_PDF_MIN_BYTES);
    jsonPadded.set(new TextEncoder().encode('{"error":{"code":"GONE","message":"signed URL expired"}}'));
    expect(sniffOfficeOrPdfMagic(jsonPadded, "报表.docx")).toEqual({ ok: false, reason: "bad-magic" });
    const htmlPadded = new Uint8Array(OFFICE_PDF_MIN_BYTES);
    htmlPadded.set(new TextEncoder().encode("<!DOCTYPE html><html>"));
    expect(sniffOfficeOrPdfMagic(htmlPadded, "a.pdf")).toEqual({ ok: false, reason: "bad-magic" });
    expect(sniffOfficeOrPdfMagic(new Uint8Array(100), "a.docx")).toEqual({ ok: false, reason: "too-small" });
  });

  test("非 office/pdf 不嗅探", () => {
    expect(sniffOfficeOrPdfMagic(new TextEncoder().encode("hi"), "note.txt")).toEqual({ ok: true });
  });
});

describe("fileCardSniffEnabled（flag 默认关）", () => {
  test("未设置 → false（走旧 nativeDownload 路径）", () => {
    expect(fileCardSniffEnabled()).toBe(false);
  });
  test("__OC_FILECARD_SNIFF=1 → true", () => {
    (globalThis as { __OC_FILECARD_SNIFF?: string }).__OC_FILECARD_SNIFF = "1";
    expect(fileCardSniffEnabled()).toBe(true);
  });
});
