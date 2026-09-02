import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deploy = () => readFileSync(path.join(root, "scripts/deploy-v5-selfhost.sh"), "utf8");
const lib = () => readFileSync(path.join(root, "scripts/v5-selfhost-master-release-lib.sh"), "utf8");
const hotcfg = () => readFileSync(path.join(root, "scripts/v5-runtime-release-lib.sh"), "utf8");
const survivor = () => readFileSync(path.join(root, "scripts/v5-selfhost-cutover-survivor.sh"), "utf8");
const pg = () =>
  readFileSync(path.join(root, "packages/commercial/src/db/pgSessionsBackend.ts"), "utf8");

describe("v5 selfhost cutover survivor / saga contract", () => {
  test("this-cutover forensics is the backup dest, not stale worktree-current", () => {
    const src = lib();
    assert.match(src, /本次切流备份,不改 worktree-current/);
    assert.equal(src.includes("二级回滚仍用工作树备份"), false);
  });

  test("tier2 restore refuses worktree unit backups", () => {
    const src = deploy();
    assert.match(src, /禁止装工作树 unit/);
    assert.match(src, /cutover_backup_units_are_live_wd/);
  });

  test("compensate always disarms the survivor", () => {
    const src = deploy();
    assert.match(src, /无论补偿成败都必须解除幸存者布防/);
  });

  test("rollback smoke does not compare new dist after HOTCFG_SAGA_ROLLING_BACK", () => {
    const src = deploy();
    assert.match(src, /HOTCFG_SAGA_ROLLING_BACK/);
    assert.match(src, /cutover_smoke_healthz_only/);
    assert.match(hotcfg(), /export HOTCFG_SAGA_ROLLING_BACK=1/);
    assert.match(hotcfg(), /restart_cmd 失败;摘录 egress\/master 最近日志/);
  });

  test("survivor alarms instead of restoring a healthy live rel", () => {
    const src = survivor();
    assert.match(src, /只报警不恢复/);
    assert.match(src, /master_cwd_is_live_rel/);
    assert.equal(src.includes("无视健康直接二级恢复"), false);
  });

  test("tsx selfcheck transforms pgSessionsBackend and egress entry", () => {
    const src = lib();
    assert.match(src, /packages\/commercial\/src\/db\/pgSessionsBackend\.ts/);
    assert.match(src, /packages\/commercial\/src\/egress\/main\.ts/);
  });

  test("unified timeline stamp chain is parseable by esbuild", () => {
    const src = pg();
    assert.match(
      src,
      /_timelineUnitKey: timelineTapeKey\(header\.tapeId, head\.ordinal, logicalIndex, record\.id\),\n    \}\)\)\.map\(\(record\) => \{/,
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const {transformSync}=require(${JSON.stringify(path.join(root, "node_modules/esbuild"))});
         const {readFileSync}=require("fs");
         transformSync(readFileSync(${JSON.stringify(path.join(root, "packages/commercial/src/db/pgSessionsBackend.ts"))},"utf8"),{loader:"ts",format:"esm",target:"es2022"});
         console.log("transform-ok");`,
      ],
      { encoding: "utf8", cwd: root },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(`${result.stdout}`, /transform-ok/);
  });
});
