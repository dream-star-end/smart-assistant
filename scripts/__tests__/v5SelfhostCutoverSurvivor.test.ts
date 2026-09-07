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

  // 2026-09-07:两班列车 `cutover smoke: egress-health 失败` 根因 —— 旧槽 service 与 .socket
  // 一条 `stop --no-block` 下去,Requires= 让 socket 的 stop 排在 service drain(≤31min)之后,
  // 期间 .socket 仍持有 reuseport 组里一个没人 accept 的 listener,约一半新连接被黑洞。
  // 契约:先阻塞关旧 .socket(ignore-dependencies),再 --no-block 停 service;翻转末尾断言
  // 共享口无孤儿 listener;smoke 的 egress-health 有界重试。deploy 与 watch 两处同语义。
  test("egress slot flip closes the old .socket before draining its service (no reuseport black hole)", () => {
    const src = deploy();
    const flip = src.match(/^egress_slot_flip\(\) \{([\s\S]*?)\n\}/m)?.[1] ?? "";
    assert.ok(flip.length > 0, "egress_slot_flip 函数缺失");
    assert.doesNotMatch(
      flip,
      /systemctl stop --no-block "\$old_sock" "\$old_svc"/,
      "旧槽 socket+service 不得一条 --no-block 合停:socket 会等 service drain 完才关",
    );
    const sockStop = flip.indexOf('systemctl stop --job-mode=ignore-dependencies "$old_sock"');
    const svcStop = flip.indexOf('systemctl stop --no-block "$old_svc"');
    assert.ok(sockStop > 0, "必须先阻塞关旧 .socket(ignore-dependencies)");
    assert.ok(svcStop > sockStop, "旧 service 的 --no-block stop 必须在 .socket 关闭之后");
    assert.ok(flip.indexOf("egress_assert_no_orphan_listener") > svcStop, "翻转末尾必须断言无孤儿 listener");
    assert.match(src, /^egress_assert_no_orphan_listener\(\) \{/m);
    const smoke = src.match(/^cutover_smoke_against_release\(\) \{([\s\S]*?)\n\}/m)?.[1] ?? "";
    assert.match(smoke, /for i in \$\(seq 1 5\); do\n\s*eg="\$\(curl[^\n]*egress-health/, "egress-health 需有界重试");

    const watch = readFileSync(path.join(root, "scripts/v5-selfhost-watch.sh"), "utf8");
    const wflip = watch.match(/^restart_egress_for_live\(\) \{([\s\S]*?)\n\}/m)?.[1] ?? "";
    const wSock = wflip.indexOf("systemctl stop --job-mode=ignore-dependencies");
    const wSvc = wflip.indexOf("systemctl stop --no-block");
    assert.ok(wSock > 0 && wSvc > wSock, "watch.sh 槽翻转须与 deploy 同序:先关旧 .socket 再 --no-block 停 service");
    assert.doesNotMatch(wflip, /stop --no-block "\$\{WATCH_EGRESS_SLOT_TPL\/@\.service\/@\$cur\.socket\}"/);
  });
});
