/**
 * imageBytes 纯逻辑单测 —— 分级宽度、签名 URL 追加 w、规范化键、LRU 字节缓存、缩略复用。
 */
import { describe, expect, test, beforeEach } from "vitest";
import {
  ImageByteCache,
  appendThumbnailWidth,
  byteCacheKey,
  byteCacheVariant,
  getCachedThumbnail,
  imageByteCache,
  isMediaSignedUrl,
  pickThumbnailWidth,
} from "./imageBytes";

function blobOf(n: number): Blob {
  return new Blob(["x".repeat(n)]);
}

describe("pickThumbnailWidth", () => {
  test("标屏(dpr1)小容器 → 640;retina/大容器 → 1280", () => {
    expect(pickThumbnailWidth(400, 1)).toBe(640);
    expect(pickThumbnailWidth(640, 1)).toBe(640);
    expect(pickThumbnailWidth(400, 2)).toBe(1280); // 400*2=800 > 640
    expect(pickThumbnailWidth(1000, 1)).toBe(1280);
  });
  test("非法入参回退 640", () => {
    expect(pickThumbnailWidth(0, 1)).toBe(640);
    expect(pickThumbnailWidth(Number.NaN, 1)).toBe(640);
    expect(pickThumbnailWidth(400, 0)).toBe(640);
  });
});

describe("isMediaSignedUrl / appendThumbnailWidth", () => {
  test("仅签名 URL 追加 w(渲染参数,不进签名)", () => {
    expect(isMediaSignedUrl("/api/media-signed?t=abc")).toBe(true);
    expect(isMediaSignedUrl("blob:xyz")).toBe(false);
    expect(appendThumbnailWidth("/api/media-signed?t=abc", 640)).toBe("/api/media-signed?t=abc&w=640");
    // 非签名 / null width → 原样
    expect(appendThumbnailWidth("blob:xyz", 640)).toBe("blob:xyz");
    expect(appendThumbnailWidth("/api/media-signed?t=abc", null)).toBe("/api/media-signed?t=abc");
    expect(appendThumbnailWidth("https://x/y.png", 640)).toBe("https://x/y.png");
  });
});

describe("byteCacheKey / variant — 变体隔离", () => {
  test("width → wN;null → orig;identity 空 → null(不缓存)", () => {
    expect(byteCacheVariant(640)).toBe("w640");
    expect(byteCacheVariant(null)).toBe("orig");
    // 键 = identity ∥ variant(分隔符对调用方不透明);断言含身份 + 变体、确定性、分尺寸不串。
    const k640 = byteCacheKey("/home/a.png", 640);
    expect(k640).not.toBeNull();
    expect(k640!.startsWith("/home/a.png")).toBe(true);
    expect(k640!.endsWith("w640")).toBe(true);
    expect(byteCacheKey("/home/a.png", null)!.endsWith("orig")).toBe(true);
    expect(byteCacheKey(null, 640)).toBeNull();
    expect(byteCacheKey("/x", 640)).toBe(byteCacheKey("/x", 640));
    expect(byteCacheKey("/x", 640)).not.toBe(byteCacheKey("/x", null));
    expect(byteCacheKey("/x", 640)).not.toBe(byteCacheKey("/y", 640));
  });
});

describe("ImageByteCache — LRU", () => {
  test("put→get 往返;null 键不缓存", () => {
    const c = new ImageByteCache(3, 1024);
    const b = blobOf(10);
    c.set("k1", b);
    expect(c.get("k1")).toBe(b);
    expect(c.get("miss")).toBeNull();
    c.set(null, b);
    expect(c.size).toBe(1);
  });

  test("超单条上限不缓存(超大原图不占内存)", () => {
    const c = new ImageByteCache(3, 8);
    c.set("big", blobOf(16)); // 16 > 8
    expect(c.get("big")).toBeNull();
    expect(c.size).toBe(0);
  });

  test("超条数上限逐 LRU;get 命中重排到 MRU 保命", () => {
    const c = new ImageByteCache(2, 1024);
    c.set("a", blobOf(1));
    c.set("b", blobOf(1));
    // 命中 a → a 成 MRU;插 c → 逐最久未用 b
    expect(c.get("a")).not.toBeNull();
    c.set("c", blobOf(1));
    expect(c.get("a")).not.toBeNull(); // 保住
    expect(c.get("b")).toBeNull(); // 被逐
    expect(c.get("c")).not.toBeNull();
    expect(c.size).toBe(2);
  });
});

describe("getCachedThumbnail — 复用缩略(优先高清)", () => {
  beforeEach(() => imageByteCache.clear());
  test("命中 w1280 优先于 w640;无缩略 → null", () => {
    const id = "/home/agent/chart.png";
    expect(getCachedThumbnail(id)).toBeNull();
    const b640 = blobOf(5);
    imageByteCache.set(byteCacheKey(id, 640), b640);
    expect(getCachedThumbnail(id)).toBe(b640);
    const b1280 = blobOf(9);
    imageByteCache.set(byteCacheKey(id, 1280), b1280);
    expect(getCachedThumbnail(id)).toBe(b1280); // 优先高清
    // orig 不算缩略
    imageByteCache.clear();
    imageByteCache.set(byteCacheKey(id, null), blobOf(3));
    expect(getCachedThumbnail(id)).toBeNull();
  });
  test("identity 空 → null", () => {
    expect(getCachedThumbnail(null)).toBeNull();
    expect(getCachedThumbnail(undefined)).toBeNull();
  });
});
