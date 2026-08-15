/**
 * check-migration-order.ts 的纯规则单测。
 *
 * 跑法: npx tsx --test scripts/__tests__/migrationOrderGate.test.ts
 *
 * 覆盖四件事:存量重号/缺口不被追溯(否则新门一上线就把无关分支变红)、新迁移的重号与
 * 未声明缺口必须红、新迁移不得占用历史编号(否则用编号就能绕过前三条)、
 * requiredMigrations 登记漂移必须红。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  type Baseline,
  type MigrationFile,
  checkBaselineInsertion,
  checkDuplicateNumbers,
  checkOrderDeclarations,
  checkRequiredMigrations,
  listMigrationFiles,
  loadBaseline,
} from "../check-migration-order.js";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function mf(version: string): MigrationFile {
  return { version, number: version.slice(0, 4), file: `${version}.sql` };
}

/** 测试用基线:0130 那对是存量重号,0170/0173 是存量缺口,最高号 0219。 */
function baselineOf(...versions: string[]): Baseline {
  return {
    versions: new Set(versions),
    maxNumber: versions.sort().at(-1)!.slice(0, 4),
  };
}

const LEGACY = baselineOf(
  "0130_connectors",
  "0130_skill_usage",
  "0170_a",
  "0173_b",
  "0219_x",
);

/** 空基线:一切都是新迁移。用在只关心「新迁移」行为的用例里。 */
const FRESH: Baseline = { versions: new Set(["0219_x"]), maxNumber: "0219" };

const NO_SQL = () => "SELECT 1;\n";

describe("listMigrationFiles", () => {
  test("非 .sql 忽略;文件名不合规 → R1", () => {
    const dir = mkdtempSync(join(tmpdir(), "migorder-"));
    writeFileSync(join(dir, "0220_ok.sql"), NO_SQL());
    writeFileSync(join(dir, "README.md"), "x");
    writeFileSync(join(dir, "220_bad.sql"), NO_SQL());
    const { files, problems } = listMigrationFiles(dir);
    assert.deepEqual(
      files.map((f) => f.version),
      ["0220_ok"],
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.rule, "R1");
  });
});

describe("checkDuplicateNumbers", () => {
  test("整组都是基线存量的重号不追溯", () => {
    assert.deepEqual(
      checkDuplicateNumbers([mf("0130_connectors"), mf("0130_skill_usage")], LEGACY),
      [],
    );
  });

  test("新迁移之间重号 → R2", () => {
    const p = checkDuplicateNumbers([mf("0221_a"), mf("0221_b")], LEGACY);
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R2");
    assert.match(p[0]!.message, /0221_a 与 0221_b/);
  });

  test("新迁移撞上历史编号 → R2(组里只要有一支是新的就报)", () => {
    const p = checkDuplicateNumbers(
      [mf("0130_connectors"), mf("0130_skill_usage"), mf("0130_sneaked_in")],
      LEGACY,
    );
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R2");
    assert.match(p[0]!.message, /0130_sneaked_in/);
  });
});

describe("checkBaselineInsertion", () => {
  test("基线内的文件不报", () => {
    assert.deepEqual(checkBaselineInsertion([mf("0170_a"), mf("0219_x")], LEGACY), []);
  });

  test("新迁移高于基线最高号 → 通过", () => {
    assert.deepEqual(checkBaselineInsertion([mf("0220_new")], LEGACY), []);
  });

  test("新迁移填历史空洞 → R8(R2/R3 都看不见这一类)", () => {
    const files = [mf("0170_a"), mf("0171_filler"), mf("0173_b")];
    assert.deepEqual(checkDuplicateNumbers(files, LEGACY), []);
    const p = checkBaselineInsertion(files, LEGACY);
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R8");
    assert.match(p[0]!.message, /0171_filler/);
  });

  test("新迁移取基线最高号以下的号 → R8(这正是编号阈值豁免留下的绕过口)", () => {
    const p = checkBaselineInsertion([mf("0219_second_taker")], LEGACY);
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R8");
  });
});

describe("checkOrderDeclarations", () => {
  test("连号 → 无需声明", () => {
    assert.deepEqual(checkOrderDeclarations([mf("0219_x"), mf("0220_y")], NO_SQL, LEGACY), []);
  });

  test("缺口且未声明 → R3", () => {
    const p = checkOrderDeclarations([mf("0219_x"), mf("0221_y")], NO_SQL, LEGACY);
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R3");
    assert.match(p[0]!.message, /order-dependency/);
  });

  test("缺口但已声明 → 通过", () => {
    const p = checkOrderDeclarations(
      [mf("0219_x"), mf("0221_y")],
      (f) => (f === "0221_y.sql" ? "-- order-dependency: 0220_other\nSELECT 1;\n" : NO_SQL()),
      LEGACY,
    );
    assert.deepEqual(p, []);
  });

  test("缺口声明 none 也算显式表态 → 通过", () => {
    const p = checkOrderDeclarations(
      [mf("0219_x"), mf("0221_y")],
      (f) =>
        f === "0221_y.sql" ? "-- order-dependency: none (0220 已放弃)\nSELECT 1;\n" : NO_SQL(),
      LEGACY,
    );
    assert.deepEqual(p, []);
  });

  test("基线里的历史缺口不追溯", () => {
    assert.deepEqual(checkOrderDeclarations([mf("0170_a"), mf("0173_b")], NO_SQL, LEGACY), []);
  });

  test("重号不额外报 R3(由 R2 单独负责,免得一个错出两种说法)", () => {
    assert.deepEqual(checkOrderDeclarations([mf("0221_a"), mf("0221_b")], NO_SQL, LEGACY), []);
  });

  test("声明语法错 → R4", () => {
    const p = checkOrderDeclarations(
      [mf("0220_x")],
      () => "-- order-dependency: 220!\nSELECT 1;\n",
      FRESH,
    );
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R4");
  });

  test("依赖编号大于自身 → R4(不能等到部署期才被 migrate.ts 拒)", () => {
    const p = checkOrderDeclarations(
      [mf("0220_x")],
      () => "-- order-dependency: 9999_future\nSELECT 1;\n",
      FRESH,
    );
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R4");
    assert.match(p[0]!.message, /9999_future/);
  });

  test("依赖等于自身 → R4", () => {
    const p = checkOrderDeclarations(
      [mf("0220_x")],
      () => "-- order-dependency: 0220_x\nS;\n",
      FRESH,
    );
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R4");
  });

  test("基线存量的坏声明也要报 R4 —— 写坏的依赖不会因为年代久远就能被满足", () => {
    const p = checkOrderDeclarations(
      [mf("0170_a")],
      () => "-- order-dependency: 9999_future\nS;\n",
      LEGACY,
    );
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R4");
  });

  test("依赖尚未合并(不在目录里)不算违规 —— 那正是这条声明存在的理由", () => {
    const p = checkOrderDeclarations(
      [mf("0219_x"), mf("0221_y")],
      (f) => (f === "0221_y.sql" ? "-- order-dependency: 0220_elsewhere\nS;\n" : NO_SQL()),
      LEGACY,
    );
    assert.deepEqual(p, []);
  });
});

/**
 * 真实仓库状态断言 —— 这一条才是 CI 里的实际门。
 *
 * `npm run lint:migration-order` 目前没挂进 lint job:改 `.github/workflows/*` 需要
 * `workflow` scope,当前 token 没有。把同一套规则对真实仓库跑一遍放在这里,由已经在
 * CI 里的 `test:v5:ops` 执行,强制力等价(报错落在 v5-ops job 而不是 lint job)。
 * 后续拿到 workflow scope,可以把 npm 脚本直接加进 lint job 与 `check:v5`(两处必须
 * 同时加,否则 check:ci-parity 红),这条断言可以保留作为快速回归。
 */
describe("真实仓库状态", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const migrationsDir = join(repoRoot, "packages/commercial/src/db/migrations");
  const metadataPath = join(repoRoot, "deploy/v5/release-metadata.json");
  const baselinePath = join(repoRoot, "scripts/migration-order-baseline.json");

  test("迁移编号 / order-dependency 声明 / requiredMigrations 登记全部合规", () => {
    const { files, problems } = listMigrationFiles(migrationsDir);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      minimumRequiredMigration: string;
      requiredMigrations: string[];
    };
    const baseline = loadBaseline(baselinePath);
    const all = [
      ...problems,
      ...checkDuplicateNumbers(files, baseline),
      ...checkOrderDeclarations(
        files,
        (f) => readFileSync(join(migrationsDir, f), "utf8"),
        baseline,
      ),
      ...checkBaselineInsertion(files, baseline),
      ...checkRequiredMigrations(files, metadata),
    ];
    assert.deepEqual(
      all.map((p) => `[${p.rule}] ${p.message}`),
      [],
      "本仓迁移违反编号/声明/登记规则;细节见 npm run lint:migration-order",
    );
    assert.ok(files.length > 200, "迁移目录看起来没扫到(路径漂了?)");
  });

  test("基线快照仍与磁盘对得上 —— 名单里的文件不能凭空消失", () => {
    const baseline = loadBaseline(baselinePath);
    const { files } = listMigrationFiles(migrationsDir);
    const onDisk = new Set(files.map((f) => f.version));
    const missing = [...baseline.versions].filter((v) => !onDisk.has(v));
    assert.deepEqual(
      missing,
      [],
      "基线登记的迁移在磁盘上不存在:要么迁移被改名/删除,要么有人在改基线快照",
    );
  });
});

describe("checkRequiredMigrations", () => {
  const files = [mf("0122_old"), mf("0123_base"), mf("0124_next")];

  test("登记完整且有序 → 通过;低于 minimum 的不要求登记", () => {
    const p = checkRequiredMigrations(files, {
      minimumRequiredMigration: "0123_base",
      requiredMigrations: ["0123_base", "0124_next"],
    });
    assert.deepEqual(p, []);
  });

  test("漏登记 → R5", () => {
    const p = checkRequiredMigrations(files, {
      minimumRequiredMigration: "0123_base",
      requiredMigrations: ["0123_base"],
    });
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R5");
    assert.match(p[0]!.message, /0124_next/);
  });

  test("登记了磁盘上不存在的迁移 → R6", () => {
    const p = checkRequiredMigrations(files, {
      minimumRequiredMigration: "0123_base",
      requiredMigrations: ["0123_base", "0124_next", "0125_ghost"],
    });
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R6");
    assert.match(p[0]!.message, /0125_ghost/);
  });

  test("乱序 → R7", () => {
    const p = checkRequiredMigrations(files, {
      minimumRequiredMigration: "0123_base",
      requiredMigrations: ["0124_next", "0123_base"],
    });
    assert.equal(p.length, 1);
    assert.equal(p[0]!.rule, "R7");
  });
});
