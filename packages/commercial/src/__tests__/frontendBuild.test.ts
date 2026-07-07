/**
 * 版本握手服务端探针(ws/frontendBuild.ts)单测。
 * 跑法: npx tsx --test src/__tests__/frontendBuild.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrontendBuildProbe } from "../ws/frontendBuild.js";

function writeIndex(dir: string, id: string | null): void {
  const meta = id ? `<meta name="oc-build" content="${id}">` : "";
  writeFileSync(join(dir, "index.html"), `<!doctype html><html><head>${meta}</head><body></body></html>`);
}

describe("createFrontendBuildProbe", () => {
  test("读出 oc-build meta;缺文件/缺 meta/形态非法 → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "fe-build-"));
    writeIndex(dir, "a1b2c3d4e5f60718");
    assert.equal(createFrontendBuildProbe(dir)(), "a1b2c3d4e5f60718");

    const dirNoMeta = mkdtempSync(join(tmpdir(), "fe-build-"));
    writeIndex(dirNoMeta, null);
    assert.equal(createFrontendBuildProbe(dirNoMeta)(), null);

    const dirBad = mkdtempSync(join(tmpdir(), "fe-build-"));
    writeIndex(dirBad, "NOT-HEX-!!");
    assert.equal(createFrontendBuildProbe(dirBad)(), null);

    assert.equal(createFrontendBuildProbe(join(tmpdir(), "fe-build-missing-xyz"))(), null);
  });

  test("TTL 内走缓存;TTL 过后按 mtime 感知 dist 更新", () => {
    const dir = mkdtempSync(join(tmpdir(), "fe-build-"));
    writeIndex(dir, "aaaaaaaaaaaaaaaa");
    let t = 1_000_000;
    const probe = createFrontendBuildProbe(dir, { ttlMs: 5_000, now: () => t });
    assert.equal(probe(), "aaaaaaaaaaaaaaaa");

    // TTL 内改文件:仍返回缓存(不 stat)
    writeIndex(dir, "bbbbbbbbbbbbbbbb");
    utimesSync(join(dir, "index.html"), new Date(2_000_000), new Date(2_000_000));
    t += 4_999;
    assert.equal(probe(), "aaaaaaaaaaaaaaaa");

    // TTL 过后:stat 发现 mtime 变 → 重读到新值
    t += 2;
    assert.equal(probe(), "bbbbbbbbbbbbbbbb");
  });
});
