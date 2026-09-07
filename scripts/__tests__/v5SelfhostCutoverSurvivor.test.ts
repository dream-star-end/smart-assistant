import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

// OCV5-161 fail-closed: ss 失败/空/无效集合不得当「零孤儿」成功;watch 关旧 .socket
// 失败不得继续 stop service,也不得继续 restart master。测真实抽出的函数 + PATH fixture,
// 不改上面已有契约断言。
function extractBashFunction(src: string, name: string): string {
  const start = src.search(new RegExp(`^${name}\\(\\) \\{`, "m"));
  if (start < 0) throw new Error(`function ${name} not found`);
  const rest = src.slice(start);
  const end = rest.search(/\n\}\n/);
  if (end < 0) throw new Error(`function ${name} closing brace not found`);
  return rest.slice(0, end + 2);
}

function withTempDir(prefix: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeExec(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o755 });
}

function runBash(script: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", `set -Eeuo pipefail\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const NODE_LISTEN = 'LISTEN 0      4096       172.31.0.1:18892      0.0.0.0:*    users:(("node",pid=4242,fd=20))';
const SYSTEMD_BIND_LISTEN = 'LISTEN 0      4096       172.31.0.1:18892      0.0.0.0:*    users:(("systemd",pid=1,fd=23))';
const SYSTEMD_STAR_LISTEN = 'LISTEN 0      4096                 *:18892            0.0.0.0:*    users:(("systemd",pid=1,fd=23))';
const NODE_AND_SYSTEMD_SAME = 'LISTEN 0      4096       172.31.0.1:18892      0.0.0.0:*    users:(("node",pid=4242,fd=20),("systemd",pid=1,fd=80))';

describe("OCV5-161 egress fail-closed behavior", () => {
  test("egress_assert_no_orphan_listener fail-closes ss rc2/empty/malformed/systemd-only/mixed, passes node holders", () => {
    const fn = extractBashFunction(deploy(), "egress_assert_no_orphan_listener");
    const cases: Array<{ name: string; rc: string; out: string; wantOk: boolean }> = [
      { name: "ss-rc2", rc: "2", out: "", wantOk: false },
      { name: "empty", rc: "0", out: "", wantOk: false },
      { name: "malformed", rc: "0", out: "not-a-listener-table\n", wantOk: false },
      { name: "systemd-only", rc: "0", out: `${SYSTEMD_STAR_LISTEN}\n`, wantOk: false },
      { name: "node", rc: "0", out: `${NODE_LISTEN}\n`, wantOk: true },
      { name: "node+systemd-same-line", rc: "0", out: `${NODE_AND_SYSTEMD_SAME}\n`, wantOk: true },
      { name: "mixed-orphan", rc: "0", out: `${NODE_LISTEN}\n${SYSTEMD_STAR_LISTEN}\n`, wantOk: false },
      { name: "systemd-on-bind", rc: "0", out: `${SYSTEMD_BIND_LISTEN}\n`, wantOk: false },
    ];
    withTempDir("ocv5-161-orphan-", (dir) => {
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      const outFile = path.join(dir, "ss.out");
      writeExec(
        path.join(bin, "ss"),
        `#!/bin/sh\ncat "\${SS_OUT_FILE}"\nexit "\${SS_RC}"\n`,
      );
      const failed: string[] = [];
      for (const c of cases) {
        writeFileSync(outFile, c.out);
        const got = runBash(
          `${fn}\negress_assert_no_orphan_listener\n`,
          {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
            SS_OUT_FILE: outFile,
            SS_RC: c.rc,
            V5_EGRESS_BIND: "172.31.0.1",
            V5_EGRESS_PORT: "18892",
          },
        );
        const ok = got.status === 0;
        if (ok !== c.wantOk) {
          failed.push(
            `${c.name}: wantOk=${c.wantOk} got status=${got.status} stdout=${got.stdout} stderr=${got.stderr}`,
          );
        }
        if (!c.wantOk) {
          // 过滤后 zero-orphan 不得当成功:失败路径必须非 0,不能靠 grep -vc 得到 0。
          assert.notEqual(got.status, 0, `${c.name} must fail-closed`);
        }
      }
      assert.equal(failed.join("\n"), "", failed.join("\n"));
    });
  });

  test("restart_egress_for_live: socket stop rc=5 does not call service-stop", () => {
    const fn = extractBashFunction(
      readFileSync(path.join(root, "scripts/v5-selfhost-watch.sh"), "utf8"),
      "restart_egress_for_live",
    );
    withTempDir("ocv5-161-watch-sock-", (dir) => {
      const live = path.join(dir, "live");
      mkdirSync(path.join(live, "deploy/v5-selfhost"), { recursive: true });
      writeFileSync(path.join(live, "deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service"), "# fixture\n");
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      const log = path.join(dir, "systemctl.log");
      writeFileSync(log, "");
      writeExec(
        path.join(bin, "systemctl"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$1" = "is-active" ]; then
  if [ "$2" = "openclaude-v5-selfhost-egress@A.service" ]; then
    echo active
    exit 0
  fi
  echo inactive
  exit 3
fi
if [ "$1" = "stop" ]; then
  case " $* " in
    *" --job-mode=ignore-dependencies "*) exit "\${SOCKET_STOP_RC:-0}" ;;
  esac
  exit 0
fi
exit 0
`,
      );
      writeExec(path.join(bin, "timeout"), "#!/bin/sh\nexit 0\n");
      const got = runBash(
        `wlog() { echo "$*"; }\n${fn}\nrestart_egress_for_live\n`,
        {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
          SYSTEMCTL_LOG: log,
          SOCKET_STOP_RC: "5",
          WATCH_LIVE: live,
          WATCH_EGRESS_SLOT_TPL: "openclaude-v5-selfhost-egress@.service",
          WATCH_EGRESS_UNIT: "openclaude-v5-selfhost-egress.service",
        },
      );
      const logged = readFileSync(log, "utf8");
      assert.notEqual(got.status, 0, `socket stop rc=5 must fail; status=${got.status} log=${logged} err=${got.stderr}`);
      assert.match(logged, /stop --job-mode=ignore-dependencies openclaude-v5-selfhost-egress@A\.socket/);
      assert.doesNotMatch(logged, /stop --no-block /, "first-step socket failure must not stop the service");
    });
  });

  test("restart_egress_for_live: happy path stops socket then --no-block service", () => {
    const fn = extractBashFunction(
      readFileSync(path.join(root, "scripts/v5-selfhost-watch.sh"), "utf8"),
      "restart_egress_for_live",
    );
    withTempDir("ocv5-161-watch-ok-", (dir) => {
      const live = path.join(dir, "live");
      mkdirSync(path.join(live, "deploy/v5-selfhost"), { recursive: true });
      writeFileSync(path.join(live, "deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service"), "# fixture\n");
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      const log = path.join(dir, "systemctl.log");
      writeFileSync(log, "");
      writeExec(
        path.join(bin, "systemctl"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$1" = "is-active" ]; then
  if [ "$2" = "openclaude-v5-selfhost-egress@A.service" ]; then
    echo active
    exit 0
  fi
  echo inactive
  exit 3
fi
exit 0
`,
      );
      writeExec(path.join(bin, "timeout"), "#!/bin/sh\nexit 0\n");
      const got = runBash(
        `wlog() { echo "$*"; }\n${fn}\nrestart_egress_for_live\n`,
        {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
          SYSTEMCTL_LOG: log,
          WATCH_LIVE: live,
          WATCH_EGRESS_SLOT_TPL: "openclaude-v5-selfhost-egress@.service",
          WATCH_EGRESS_UNIT: "openclaude-v5-selfhost-egress.service",
        },
      );
      const logged = readFileSync(log, "utf8");
      assert.equal(got.status, 0, `happy path rc; status=${got.status} log=${logged} err=${got.stderr}`);
      const sock = logged.indexOf("stop --job-mode=ignore-dependencies openclaude-v5-selfhost-egress@A.socket");
      const svc = logged.indexOf("stop --no-block openclaude-v5-selfhost-egress@A.service");
      assert.ok(sock >= 0, `missing socket stop: ${logged}`);
      assert.ok(svc > sock, `service stop must follow socket stop: ${logged}`);
    });
  });

  test("tier1_rollback: restart_egress_for_live failure does not restart master", () => {
    const watch = readFileSync(path.join(root, "scripts/v5-selfhost-watch.sh"), "utf8");
    const tier1 = extractBashFunction(watch, "tier1_rollback");
    const restart = extractBashFunction(watch, "restart_egress_for_live");
    withTempDir("ocv5-161-tier1-", (dir) => {
      const live = path.join(dir, "live");
      mkdirSync(path.join(live, "deploy/v5-selfhost"), { recursive: true });
      writeFileSync(path.join(live, "deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service"), "# fixture\n");
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      const log = path.join(dir, "systemctl.log");
      writeFileSync(log, "");
      writeExec(
        path.join(bin, "systemctl"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "$1" = "is-active" ]; then
  if [ "$2" = "openclaude-v5-selfhost-egress@A.service" ]; then
    echo active
    exit 0
  fi
  echo inactive
  exit 3
fi
if [ "$1" = "stop" ]; then
  case " $* " in
    *" --job-mode=ignore-dependencies "*) exit "\${SOCKET_STOP_RC:-0}" ;;
  esac
  exit 0
fi
exit 0
`,
      );
      writeExec(path.join(bin, "timeout"), "#!/bin/sh\nexit 0\n");
      const got = runBash(
        [
          "prev_release_is_valid() { return 0; }",
          "is_true_dry() { return 1; }",
          'wlog() { echo "$*"; }',
          "write_grace() { :; }",
          "atomic_flip_live() { :; }",
          restart,
          tier1,
          "tier1_rollback",
        ].join("\n"),
        {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
          SYSTEMCTL_LOG: log,
          SOCKET_STOP_RC: "5",
          WATCH_DRY: "0",
          WATCH_SKIP_ACTIONS: "0",
          WATCH_RELEASES_ROOT: dir,
          WATCH_LIVE: live,
          WATCH_EGRESS_SLOT_TPL: "openclaude-v5-selfhost-egress@.service",
          WATCH_EGRESS_UNIT: "openclaude-v5-selfhost-egress.service",
          WATCH_MASTER_UNIT: "openclaude-v5-selfhost.service",
        },
      );
      const logged = readFileSync(log, "utf8");
      assert.notEqual(got.status, 0, `upper layer must propagate; status=${got.status} log=${logged}`);
      assert.match(logged, /stop --job-mode=ignore-dependencies openclaude-v5-selfhost-egress@A\.socket/);
      assert.doesNotMatch(logged, /stop --no-block /, `must not drain service after socket fail: ${logged}`);
      assert.doesNotMatch(logged, /restart openclaude-v5-selfhost\.service/, `must not restart master: ${logged}`);
    });
  });
});


