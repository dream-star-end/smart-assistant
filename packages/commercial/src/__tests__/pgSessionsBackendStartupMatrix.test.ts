// sessionsStoreAuthority 启动规则矩阵穷举测试(RFC-v5-sessions-pg D1;纯函数,无需 PG)。
//
// 覆盖 env{unset,sqlite,pg,invalid} × pg{null,prepared,pg_authoritative,sqlite_disaster_recovered}
// × manifest{null,matching,mismatching} 全组合,逐格断言"选 sqlite / 选 pg / 拒起",含"矩阵之外
// 默认拒起"。这是 sqlite/pg 二选一的唯一裁决源,穷举锁死不留静默退化窗口。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { paths } from "@openclaude/storage";
import {
  decideSessionsStore,
  decideSessionsStorePgUnreachable,
  defaultManifestPath,
  parseSessionsStoreEnv,
  resolveSessionsStoreAuthority,
  SessionsStoreAuthorityError,
  type SessionsStoreDisasterNonce,
  type SessionsStoreEnvIntent,
  type SessionsStoreManifest,
  type SessionsStoreStateRow,
} from "../db/sessionsStoreAuthority.js";

const GEN = 7;
const CUT = "cut-1";

function stateRow(authority: SessionsStoreStateRow["authority"]): SessionsStoreStateRow {
  return { authority, generation: GEN, cutoverId: CUT };
}
function matchingManifest(authority: string): SessionsStoreManifest {
  return { authority, generation: GEN, cutoverId: CUT };
}
function mismatchManifest(authority: string): SessionsStoreManifest {
  // generation 不同 → 与 PG 不一致。
  return { authority, generation: GEN + 1, cutoverId: CUT };
}
function matchingNonce(): SessionsStoreDisasterNonce {
  return { cutoverId: CUT, ts: 1, reason: "test" };
}
function mismatchNonce(): SessionsStoreDisasterNonce {
  return { cutoverId: "cut-OTHER", ts: 1, reason: "test" };
}

type Expect = { store: "sqlite" } | { store: "pg"; generation: number } | "reject";

function check(
  env: SessionsStoreEnvIntent,
  pg: SessionsStoreStateRow | null,
  manifest: SessionsStoreManifest | null,
  expect: Expect,
  label: string,
  nonce: SessionsStoreDisasterNonce | null = null,
): void {
  if (expect === "reject") {
    assert.throws(() => decideSessionsStore(env, pg, manifest, nonce), SessionsStoreAuthorityError, label);
  } else {
    assert.deepEqual(decideSessionsStore(env, pg, manifest, nonce), expect, label);
  }
}

describe("parseSessionsStoreEnv", () => {
  test("归一化", () => {
    assert.equal(parseSessionsStoreEnv(undefined), "unset");
    assert.equal(parseSessionsStoreEnv(""), "unset");
    assert.equal(parseSessionsStoreEnv("  "), "unset");
    assert.equal(parseSessionsStoreEnv("sqlite"), "sqlite");
    assert.equal(parseSessionsStoreEnv(" SQLite "), "sqlite");
    assert.equal(parseSessionsStoreEnv("pg"), "pg");
    assert.equal(parseSessionsStoreEnv("PG"), "pg");
    assert.equal(parseSessionsStoreEnv("postgres"), "invalid");
    assert.equal(parseSessionsStoreEnv("1"), "invalid");
  });
});

describe("defaultManifestPath", () => {
  test("显式共享路径优先；空白覆盖回退 OPENCLAUDE_HOME 默认", () => {
    assert.equal(
      defaultManifestPath({ OC_SESSIONS_MANIFEST_PATH: "  /root/.openclaude-v5/sessions-store-authority.json  " }),
      "/root/.openclaude-v5/sessions-store-authority.json",
    );
    assert.equal(defaultManifestPath({}), join(paths.home, "sessions-store-authority.json"));
    assert.equal(
      defaultManifestPath({ OC_SESSIONS_MANIFEST_PATH: "   " }),
      defaultManifestPath({}),
    );
  });
});

describe("decideSessionsStore 矩阵穷举", () => {
  const ALL_ENV: SessionsStoreEnvIntent[] = ["unset", "sqlite", "pg", "invalid"];

  test("env=invalid → 一切组合拒起", () => {
    for (const pg of [null, stateRow("prepared"), stateRow("pg_authoritative"), stateRow("sqlite_disaster_recovered")]) {
      for (const man of [null, matchingManifest("pg_authoritative")]) {
        check("invalid", pg, man, "reject", `invalid × ${pg?.authority ?? "null"}`);
      }
    }
  });

  test("无状态行穷举:pg=null × manifest{null,matching} × env{unset,sqlite,pg}", () => {
    // manifest=null → 真·首次基建先行期:env=pg→拒(未割接);env∈{unset,sqlite}→SQLite。
    check("unset", null, null, { store: "sqlite" }, "无行 × null manifest × unset");
    check("sqlite", null, null, { store: "sqlite" }, "无行 × null manifest × sqlite");
    check("pg", null, null, "reject", "无行 × null manifest × pg(未割接)");
    // manifest 存在 → 曾割接到 PG 但此刻 PG 无状态行 = 连错库 / 状态行被删 → 一律拒起(不看 env)。
    const man = matchingManifest("pg_authoritative");
    check("unset", null, man, "reject", "无行 × 残留 manifest × unset(连错库/状态被删)");
    check("sqlite", null, man, "reject", "无行 × 残留 manifest × sqlite(连错库/状态被删)");
    check("pg", null, man, "reject", "无行 × 残留 manifest × pg(连错库/状态被删)");
  });

  test("authority=prepared → 任意 env/manifest 拒起", () => {
    for (const env of ALL_ENV) {
      for (const man of [null, matchingManifest("prepared"), mismatchManifest("prepared")]) {
        check(env, stateRow("prepared"), man, "reject", `prepared × ${env}`);
      }
    }
  });

  test("authority=pg_authoritative", () => {
    const pg = stateRow("pg_authoritative");
    // env≠pg → 拒(env 同步遗漏不得静默退回 SQLite)
    check("unset", pg, matchingManifest("pg_authoritative"), "reject", "pg_auth × unset");
    check("sqlite", pg, matchingManifest("pg_authoritative"), "reject", "pg_auth × sqlite");
    // env=pg:manifest 必须存在且一致
    check("pg", pg, null, "reject", "pg_auth × pg × 无 manifest");
    check("pg", pg, mismatchManifest("pg_authoritative"), "reject", "pg_auth × pg × manifest gen 不一致");
    check("pg", pg, matchingManifest("pg_authoritative"), { store: "pg", generation: GEN }, "pg_auth × pg × 一致 → PG");
    // manifest authority 不一致也拒
    check("pg", pg, matchingManifest("prepared"), "reject", "pg_auth × pg × manifest authority 不一致");
  });

  test("authority=sqlite_disaster_recovered(含灾难 nonce 维度)", () => {
    const pg = stateRow("sqlite_disaster_recovered");
    const man = matchingManifest("sqlite_disaster_recovered");
    const nonce = matchingNonce();
    // env / manifest 维度(nonce 齐全时)
    check("pg", pg, man, "reject", "disaster × pg", nonce);
    check("unset", pg, man, "reject", "disaster × unset", nonce);
    check("sqlite", pg, null, "reject", "disaster × sqlite × 无 manifest", nonce);
    check("sqlite", pg, mismatchManifest("sqlite_disaster_recovered"), "reject", "disaster × sqlite × manifest gen 不匹配", nonce);
    // nonce 维度(BLOCKER-2 新增):manifest 匹配也须 nonce 存在且 cutover 一致才放行。
    check("sqlite", pg, man, "reject", "disaster × sqlite × manifest 匹配但 nonce 缺失", null);
    check("sqlite", pg, man, "reject", "disaster × sqlite × manifest 匹配但 nonce cutover 不匹配", mismatchNonce());
    check("sqlite", pg, man, { store: "sqlite" }, "disaster × sqlite × manifest+nonce 均匹配 → SQLite", nonce);
  });

  test("矩阵之外(未知 authority)→ 默认拒起", () => {
    const bogus = { authority: "bogus", generation: GEN, cutoverId: CUT } as unknown as SessionsStoreStateRow;
    check("pg", bogus, matchingManifest("bogus"), "reject", "未知 authority");
    check("sqlite", bogus, null, "reject", "未知 authority × sqlite");
  });
});

// PG 不可达兜底纯函数(BLOCKER-2):仅"基建先行期"或"灾难过渡态(env=sqlite+manifest 灾难态+nonce cutover 匹配)"放行。
describe("decideSessionsStorePgUnreachable 穷举", () => {
  function u(
    env: SessionsStoreEnvIntent,
    manifest: SessionsStoreManifest | null,
    nonce: SessionsStoreDisasterNonce | null,
    expect: Expect,
    label: string,
  ): void {
    if (expect === "reject") {
      assert.throws(() => decideSessionsStorePgUnreachable(env, manifest, nonce), SessionsStoreAuthorityError, label);
    } else {
      assert.deepEqual(decideSessionsStorePgUnreachable(env, manifest, nonce), expect, label);
    }
  }

  test("放行 SQLite 的两种唯一情形", () => {
    // ① 真·基建先行期:无 manifest + env unset。
    u("unset", null, null, { store: "sqlite" }, "无 manifest × unset → SQLite");
    // ② 灾难过渡态:env=sqlite + manifest 灾难态 + nonce cutover 匹配。
    u("sqlite", matchingManifest("sqlite_disaster_recovered"), matchingNonce(), { store: "sqlite" }, "灾难过渡态 → SQLite");
  });

  test("灾难过渡态缺一不可 → 拒起", () => {
    const man = matchingManifest("sqlite_disaster_recovered");
    u("sqlite", man, null, "reject", "灾难 manifest 但 nonce 缺失");
    u("sqlite", man, mismatchNonce(), "reject", "灾难 manifest 但 nonce cutover 不匹配");
    u("unset", man, matchingNonce(), "reject", "灾难 manifest+nonce 但 env≠sqlite(unset)");
    u("pg", man, matchingNonce(), "reject", "灾难 manifest+nonce 但 env=pg");
    // manifest authority 不是灾难态(如 pg_authoritative)→ 即便 env=sqlite+nonce 也拒。
    u("sqlite", matchingManifest("pg_authoritative"), matchingNonce(), "reject", "manifest authority 非灾难态");
  });

  test("非法 env / 残留 manifest 无 nonce → 拒起", () => {
    u("invalid", null, null, "reject", "invalid env");
    u("sqlite", null, null, "reject", "无 manifest × sqlite(非基建先行期)");
    u("pg", null, null, "reject", "无 manifest × pg");
    u("sqlite", matchingManifest("pg_authoritative"), null, "reject", "残留 pg_auth manifest × sqlite");
  });
});

// resolveSessionsStoreAuthority 装配壳:PG 读取失败(连接错误)不得静默走 sqlite(RFC D1)。
// 用 fake pool 的 query 抛错模拟"连不上",用临时目录的 manifest 文件构造有/无 manifest 两态。
describe("resolveSessionsStoreAuthority PG 读取失败兜底", () => {
  // query 恒抛带 code 的错误(ECONNREFUSED=连接错误;42P01=表不存在,readPgStateRow 内部吞成 null)。
  function throwingPool(code: string): Pool {
    return {
      query: async () => {
        throw Object.assign(new Error(code), { code });
      },
    } as unknown as Pool;
  }

  async function withTmpManifest(
    write: string | null,
    fn: (manifestPath: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "oc-sessions-authority-"));
    const manifestPath = join(dir, "sessions-store-authority.json");
    try {
      if (write !== null) await writeFile(manifestPath, write, "utf8");
      await fn(manifestPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const legalManifest = JSON.stringify({ authority: "pg_authoritative", generation: GEN, cutoverId: CUT });

  test("env 共享 manifest 覆盖贯穿真实 resolver 装配", async () => {
    await withTmpManifest(legalManifest, async (manifestPath) => {
      const pool = {
        query: async () => ({
          rows: [{ authority: "pg_authoritative", generation: String(GEN), cutover_id: CUT }],
        }),
      } as unknown as Pool;
      const decision = await resolveSessionsStoreAuthority({
        pool,
        env: {
          OC_SESSIONS_STORE: "pg",
          OC_SESSIONS_MANIFEST_PATH: `  ${manifestPath}  `,
        },
      });
      assert.deepEqual(decision, { store: "pg", generation: GEN });
    });
  });

  test("连接错误 + 无 manifest + env unset → SQLite(真·基建先行期,PG 未 provision)", async () => {
    await withTmpManifest(null, async (manifestPath) => {
      const decision = await resolveSessionsStoreAuthority({
        pool: throwingPool("ECONNREFUSED"),
        manifestPath,
        env: {},
      });
      assert.deepEqual(decision, { store: "sqlite" });
    });
  });

  test("连接错误 + 无 manifest + env=pg → 拒起", async () => {
    await withTmpManifest(null, async (manifestPath) => {
      await assert.rejects(
        resolveSessionsStoreAuthority({
          pool: throwingPool("ECONNREFUSED"),
          manifestPath,
          env: { OC_SESSIONS_STORE: "pg" },
        }),
        SessionsStoreAuthorityError,
      );
    });
  });

  test("连接错误 + 有 manifest + env unset → 拒起", async () => {
    await withTmpManifest(legalManifest, async (manifestPath) => {
      await assert.rejects(
        resolveSessionsStoreAuthority({
          pool: throwingPool("ECONNREFUSED"),
          manifestPath,
          env: {},
        }),
        SessionsStoreAuthorityError,
      );
    });
  });

  test("42P01(表不存在)仍视为无行 + 无 manifest + env unset → SQLite(走正常 decide 路径)", async () => {
    await withTmpManifest(null, async (manifestPath) => {
      const decision = await resolveSessionsStoreAuthority({
        pool: throwingPool("42P01"),
        manifestPath,
        env: {},
      });
      assert.deepEqual(decision, { store: "sqlite" });
    });
  });
});

// resolveSessionsStoreAuthority 灾难过渡态(PG 不可达):真读 manifest+nonce 文件,走 decideSessionsStorePgUnreachable。
// nonce 文件默认路径 = dirname(manifest)/sessions-disaster-nonce.json(与 backfill disaster-restore 写入约定一致)。
describe("resolveSessionsStoreAuthority 灾难过渡态(PG 不可达 + 本地 nonce)", () => {
  function throwingPool(code: string): Pool {
    return {
      query: async () => {
        throw Object.assign(new Error(code), { code });
      },
    } as unknown as Pool;
  }

  // 在临时目录写 manifest(+ 可选 nonce),manifestPath/noncePath 走默认同目录派生。
  async function withTmpFiles(
    manifestContent: string | null,
    nonceContent: string | null,
    fn: (manifestPath: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "oc-sessions-disaster-"));
    const manifestPath = join(dir, "sessions-store-authority.json");
    const noncePath = join(dir, "sessions-disaster-nonce.json");
    try {
      if (manifestContent !== null) await writeFile(manifestPath, manifestContent, "utf8");
      if (nonceContent !== null) await writeFile(noncePath, nonceContent, "utf8");
      await fn(manifestPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const disasterManifest = JSON.stringify({ authority: "sqlite_disaster_recovered", generation: GEN, cutoverId: CUT });
  const goodNonce = JSON.stringify({ cutoverId: CUT, ts: 123, reason: "disaster-restore-from-current-pg" });

  test("disaster manifest + 匹配 nonce + env=sqlite → 放行 SQLite(灾难过渡态)", async () => {
    await withTmpFiles(disasterManifest, goodNonce, async (manifestPath) => {
      const decision = await resolveSessionsStoreAuthority({
        pool: throwingPool("ECONNREFUSED"),
        manifestPath,
        env: { OC_SESSIONS_STORE: "sqlite" },
      });
      assert.deepEqual(decision, { store: "sqlite" });
    });
  });

  test("disaster manifest + nonce 缺失 + env=sqlite → 拒起", async () => {
    await withTmpFiles(disasterManifest, null, async (manifestPath) => {
      await assert.rejects(
        resolveSessionsStoreAuthority({ pool: throwingPool("ECONNREFUSED"), manifestPath, env: { OC_SESSIONS_STORE: "sqlite" } }),
        SessionsStoreAuthorityError,
      );
    });
  });

  test("disaster manifest + nonce cutover 不匹配 + env=sqlite → 拒起", async () => {
    const badCutNonce = JSON.stringify({ cutoverId: "cut-OTHER", ts: 1, reason: "x" });
    await withTmpFiles(disasterManifest, badCutNonce, async (manifestPath) => {
      await assert.rejects(
        resolveSessionsStoreAuthority({ pool: throwingPool("ECONNREFUSED"), manifestPath, env: { OC_SESSIONS_STORE: "sqlite" } }),
        SessionsStoreAuthorityError,
      );
    });
  });

  test("disaster manifest + nonce 损坏(非合法 JSON)+ env=sqlite → 拒起(读 nonce 即抛)", async () => {
    await withTmpFiles(disasterManifest, "{not-json", async (manifestPath) => {
      await assert.rejects(
        resolveSessionsStoreAuthority({ pool: throwingPool("ECONNREFUSED"), manifestPath, env: { OC_SESSIONS_STORE: "sqlite" } }),
        SessionsStoreAuthorityError,
      );
    });
  });

  test("manifest authority 非灾难态(pg_authoritative)+ 匹配 nonce + env=sqlite → 拒起", async () => {
    const pgAuthManifest = JSON.stringify({ authority: "pg_authoritative", generation: GEN, cutoverId: CUT });
    await withTmpFiles(pgAuthManifest, goodNonce, async (manifestPath) => {
      await assert.rejects(
        resolveSessionsStoreAuthority({ pool: throwingPool("ECONNREFUSED"), manifestPath, env: { OC_SESSIONS_STORE: "sqlite" } }),
        SessionsStoreAuthorityError,
      );
    });
  });
});
