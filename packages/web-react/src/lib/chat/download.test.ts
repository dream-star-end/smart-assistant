import { describe, expect, test } from "vitest";
import {
  DOWNLOAD_STREAM_MAX_BYTES,
  DOWNLOAD_STREAM_MIN_BYTES,
  downloadPercent,
  formatBytes,
  pickDownloadStrategy,
} from "./download";

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
