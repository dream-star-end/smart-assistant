/**
 * validatePlatformSeedCli.ts — deploy prepare 期的**离线** platform seed 语义校验 CLI(runtime hotcfg R2-M2b)。
 *
 * 用法:
 *   npx tsx validatePlatformSeedCli.ts <bundle根>
 *
 * 职责(纯离线,不 spawn / 不写盘 / 不要求容器运行时):
 *   1. 解析 `<bundle根>/seed/platform-seed.yaml`,复用 validatePlatformSeed 做 schema 校验
 *      (含 slug / persona-ref / 未知字段 / banned 计费键 fail-loud);
 *   2. 复用 validateSeedAssetsExist 校验每个 persona 引用与 seed skill 文件在 bundle 内**实际存在**
 *      且 realpath 不逃逸 seed 子树。
 *   全过 → exit 0;任一失败 → stderr 打原因、exit 1;参数缺失 → exit 2。
 *
 * 与 entrypoint validate-only 模式**共用同一对纯函数**(validatePlatformSeed + validateSeedAssetsExist):
 * 本 CLI 是 host 侧离线门(deploy prepare,F2 接线),validate-only 是容器内 canary boot 冒烟门,
 * 二者对"seed 语义是否自洽"给出同一判据(单一权威,避免两套漂移)。
 *
 * 本文件**不进 commercial tsc 编译图**(与 entrypoint.ts / platformBundle.ts 同,在 agent-sandbox/
 * 而非 src/ 下),用 tsx 直跑。yaml 依赖经 createRequire 多锚点解析(deploy prepare 从 release/源码树
 * 跑,parent 链有 workspace 根 node_modules;/opt/openclaude 作兜底锚点)。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { validatePlatformSeed, validateSeedAssetsExist } from "./platformBundle.ts";

/** 多锚点解析 yaml(self parent 链优先,/opt/openclaude 兜底)。 */
function loadYaml(): typeof import("yaml") {
  const anchors = [import.meta.url, "/opt/openclaude/package.json"];
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)("yaml");
    } catch {
      /* 试下一个锚点 */
    }
  }
  throw new Error("cannot resolve 'yaml' module (tried self parent chain + /opt/openclaude)");
}

function fail(msg: string, code = 1): never {
  console.error(`[validate-platform-seed] FAILED: ${msg}`);
  process.exit(code);
}

function main(): void {
  const bundleRoot = process.argv[2];
  if (!bundleRoot || bundleRoot.trim() === "") {
    console.error("usage: validatePlatformSeedCli <bundleRoot>");
    process.exit(2);
  }
  const seedDir = join(bundleRoot, "seed");
  const seedYaml = join(seedDir, "platform-seed.yaml");
  if (!existsSync(seedYaml)) {
    fail(`no platform-seed.yaml at ${seedYaml}`);
  }

  const YAML = loadYaml();
  let doc;
  try {
    doc = validatePlatformSeed(YAML.parse(readFileSync(seedYaml, "utf8")));
  } catch (e) {
    fail(`platform-seed schema invalid: ${(e as Error).message}`);
  }

  // seedDir realpath 一次作 containment 基准(seed 根必存在 —— 上面 seedYaml 已在其下)。
  const seedDirReal = realpathSync(seedDir);
  const errors = validateSeedAssetsExist(seedDir, seedDirReal, doc, {
    exists: existsSync,
    realpath: realpathSync,
    join,
  });
  if (errors.length > 0) {
    fail(`platform-seed asset references unresolved:\n  ${errors.join("\n  ")}`);
  }

  console.error(
    `[validate-platform-seed] OK: ${doc.agents.length} agents, ` +
      `${Object.values(doc.seedSkills).reduce((n, arr) => n + arr.length, 0)} seed skills — all persona/skill refs resolved`,
  );
  process.exit(0);
}

main();
