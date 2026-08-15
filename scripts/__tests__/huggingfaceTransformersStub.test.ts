/**
 * @huggingface/transformers 类型桩的红绿对照。
 *
 * 背景:该包在 package.json 里声明了,但多个 worktree(含 canonical aurora)
 * 的 node_modules 里经常没装上。tsc 对 `import('@huggingface/transformers')`
 * 报 TS2307,全量 typecheck 白烧约 57 分钟 / 12 次。
 *
 * 本测试证明:
 *   ① 桩在时,隔离 tsc(没有该包)对动态 import 绿;
 *   ② 桩不在时,同一 importer 稳定 TS2307(门本身没坏);
 *   ③ 运行时调用点仍是动态 import,没有改成静态 import。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUB = join(
  REPO_ROOT,
  "packages/commercial/src/types/huggingface-transformers.d.ts",
);
const RANKER = join(
  REPO_ROOT,
  "packages/commercial/src/http/coreMemoryLocalRanker.ts",
);

const IMPORTER = `
export {};
const transformers = await import("@huggingface/transformers");
transformers.env.allowLocalModels = true;
transformers.env.allowRemoteModels = false;
transformers.env.useBrowserCache = false;
void transformers.pipeline("feature-extraction", "/tmp/model", { dtype: "q8" });
`;

function tscBin(): string {
  const candidate = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
  if (existsSync(candidate)) return candidate;
  return "npx";
}

function runIsolatedTsc(includeStub: boolean): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "hf-stub-"));
  try {
    writeFileSync(join(dir, "importer.ts"), IMPORTER);
    if (includeStub) {
      writeFileSync(join(dir, "stub.d.ts"), readFileSync(STUB, "utf8"));
    }
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          include: includeStub ? ["importer.ts", "stub.d.ts"] : ["importer.ts"],
        },
        null,
        2,
      ),
    );
    const bin = tscBin();
    const args = bin.endsWith("tsc")
      ? ["-p", join(dir, "tsconfig.json"), "--pretty", "false"]
      : ["tsc", "-p", join(dir, "tsconfig.json"), "--pretty", "false"];
    const r = spawnSync(bin, args, { encoding: "utf8", cwd: dir });
    return { status: r.status ?? 1, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("huggingface transformers type stub", () => {
  test("桩文件存在且是 declare module,覆盖 ranker 用到的 env/pipeline", () => {
    const text = readFileSync(STUB, "utf8");
    assert.match(text, /declare module ['"]@huggingface\/transformers['"]/);
    assert.match(text, /allowLocalModels/);
    assert.match(text, /allowRemoteModels/);
    assert.match(text, /useBrowserCache/);
    assert.match(text, /pipeline/);
  });

  test("ranker 仍用动态 import,运行时解析走 node_modules 而不是类型桩", () => {
    const src = readFileSync(RANKER, "utf8");
    assert.match(src, /await import\(['"]@huggingface\/transformers['"]\)/);
    assert.equal(src.includes('from "@huggingface/transformers"'), false);
    assert.equal(src.includes("from '@huggingface/transformers'"), false);
  });

  test("有桩:隔离 tsc 对动态 import 绿(包未安装也不报 TS2307)", () => {
    const { status, out } = runIsolatedTsc(true);
    assert.equal(status, 0, `expected green, got ${status}:\n${out}`);
    assert.equal(out.includes("TS2307"), false, out);
  });

  test("无桩:隔离 tsc 稳定 TS2307(证明门会红,不是 testdouble)", () => {
    const { status, out } = runIsolatedTsc(false);
    assert.notEqual(status, 0);
    assert.match(out, /TS2307/);
    assert.match(out, /@huggingface\/transformers/);
  });
});
