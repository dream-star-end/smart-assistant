/**
 * V3 multi-tenant media (uploads + generated) 路径解析器单测。
 *
 * 这一类测试是 2026-05-12 attachment "媒体不存在或不可读" + codex image_gen
 * 渲染 404 两次回归的护栏 —— 根因都是同一种 master/container 路径错位:某条
 * 路径在 master 视图 (`/root/.openclaude/<sub>/`) 和容器视图
 * (`/home/agent/.openclaude/<sub>/`) 指向不同物理目录,而多租户下两侧分别承担
 * 读/写角色。修复方案是把存储权威源搬到用户 docker volume 的宿主路径,这里
 * 测试该路径的所有解析分支 fail-closed,**uploads 和 generated 用单次 DB +
 * docker inspect 同时绑定**(同一 volume 两个 subdir)。
 *
 * 覆盖:
 *   - buildUserMediaHostDir(uid, kind)
 *       · uploads / generated 两个 kind 都正确派生
 *       · 非法 uid → 抛(委托给 v3VolumeNameFor)
 *   - parseCommercialUid
 *       · 合法 c:<digits>(1-19 位)→ number
 *       · "default" / 非 c: 前缀 / c:0 / c:001 / c:-1 / c:42/.. / 控制字符 / 空 → null
 *       · > MAX_SAFE_INTEGER → null (避免 lossy Number parse 破坏 identity)
 *   - createUserMediaResolver(deps) — 单次 DB+docker 解析两 dir
 *       · invalid-uid:userId 非 c:<digits> 形态
 *       · not-ready:DB 查无 active 容器
 *       · ambiguous:DB 查到 ≥2 active 容器
 *       · remote-host:host_name !== 'self'
 *       · volume-missing:docker getVolume 404
 *       · daemon-error:pg 查询 throw / docker inspect 抛非 404
 *       · ok:active+self+volume 存在 → kind:'ok',uploads/generated 双 dir
 *   - isUserVolumeMediaPath
 *       · 接受 uploads 目录本身、目录下文件
 *       · 接受 generated 目录本身、目录下文件
 *       · 拒绝相邻路径、缺斜杠、传统 paths.uploadsDir、嵌套子目录、其他 subdir
 *       · 拒绝 leading zero / uid=0 / 负数 / 超长 digits
 *   - 容器同物理路径契约:
 *       · resolver 在 master 端返回的 dir 在容器侧通过 docker mount 表现为
 *         `/home/agent/.openclaude/(uploads|generated)`(纯路径契约,不实际拉容器)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUserMediaHostDir,
  createUserMediaResolver,
  isUserVolumeMediaPath,
  parseCommercialUid,
  USER_VOLUME_MEDIA_HOST_PREFIX,
  USER_VOLUME_UPLOADS_SUBPATH,
  USER_VOLUME_GENERATED_SUBPATH,
  type DockerLike,
  type PoolLike,
} from "../agent-sandbox/userMedia.js";

// ── helpers ─────────────────────────────────────────────────────────────

function makePool(rows: Array<{ host_name: string; container_id: string }>): PoolLike {
  return {
    async query() {
      return { rows: rows as never };
    },
  };
}

function makeThrowingPool(err: unknown): PoolLike {
  return {
    async query() {
      throw err;
    },
  };
}

function makeDocker(
  inspectImpl: () => Promise<unknown>,
): DockerLike {
  return {
    getVolume() {
      return { inspect: inspectImpl };
    },
  };
}

function makeDockerOk(): DockerLike {
  return makeDocker(async () => ({ Name: "oc-v3-data-u42" }));
}

function makeDocker404(): DockerLike {
  const err = Object.assign(new Error("no such volume"), { statusCode: 404 });
  return makeDocker(async () => { throw err; });
}

function makeDocker500(): DockerLike {
  const err = Object.assign(new Error("daemon broken"), { statusCode: 500 });
  return makeDocker(async () => { throw err; });
}

// ── buildUserMediaHostDir ────────────────────────────────────────────────

describe("buildUserMediaHostDir", () => {
  test("uploads kind → 规范化目录路径", () => {
    assert.equal(
      buildUserMediaHostDir(42, "uploads"),
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads",
    );
    assert.equal(
      buildUserMediaHostDir(1, "uploads"),
      "/var/lib/docker/volumes/oc-v3-data-u1/_data/uploads",
    );
  });
  test("generated kind → 规范化目录路径", () => {
    assert.equal(
      buildUserMediaHostDir(42, "generated"),
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated",
    );
    assert.equal(
      buildUserMediaHostDir(1, "generated"),
      "/var/lib/docker/volumes/oc-v3-data-u1/_data/generated",
    );
  });
  test("非法 uid 0 / 负数 / 非整数 → 抛(委托 v3VolumeNameFor)", () => {
    assert.throws(() => buildUserMediaHostDir(0, "uploads"));
    assert.throws(() => buildUserMediaHostDir(-1, "uploads"));
    assert.throws(() => buildUserMediaHostDir(1.5, "uploads"));
    assert.throws(() => buildUserMediaHostDir(0, "generated"));
  });
  test("常量自洽", () => {
    assert.equal(USER_VOLUME_MEDIA_HOST_PREFIX, "/var/lib/docker/volumes");
    assert.equal(USER_VOLUME_UPLOADS_SUBPATH, "_data/uploads");
    assert.equal(USER_VOLUME_GENERATED_SUBPATH, "_data/generated");
  });
});

// ── parseCommercialUid ───────────────────────────────────────────────────

describe("parseCommercialUid", () => {
  test("合法 c:<digits> (<= MAX_SAFE_INTEGER)", () => {
    assert.equal(parseCommercialUid("c:1"), 1);
    assert.equal(parseCommercialUid("c:42"), 42);
    // MAX_SAFE_INTEGER = 2^53 - 1 = 9007199254740991 是 round-trip 安全的最大边界。
    assert.equal(
      parseCommercialUid("c:" + String(Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER,
    );
  });
  test("> MAX_SAFE_INTEGER 拒掉(避免 lossy Number parse 让 uid 与 JWT sub 不一致)", () => {
    // 2^53 = 9007199254740992 是第一个 lossy 的整数 (Number 后跟 2^53+1 一样)。
    assert.equal(parseCommercialUid("c:9007199254740992"), null);
    // 极端:19 位 BIGINT 上限。
    assert.equal(parseCommercialUid("c:9223372036854775807"), null);
  });
  test("非 c: 前缀 → null", () => {
    assert.equal(parseCommercialUid("default"), null);
    assert.equal(parseCommercialUid("42"), null);
    assert.equal(parseCommercialUid("u:42"), null);
    assert.equal(parseCommercialUid(""), null);
  });
  test("c: 后非法 sub → null", () => {
    assert.equal(parseCommercialUid("c:"), null);
    assert.equal(parseCommercialUid("c:0"), null, "uid=0 invalid");
    assert.equal(parseCommercialUid("c:001"), null, "leading zero ambiguity");
    assert.equal(parseCommercialUid("c:-1"), null, "sign char");
    assert.equal(parseCommercialUid("c:+42"), null);
    assert.equal(parseCommercialUid("c: 42"), null, "leading space");
    assert.equal(parseCommercialUid("c:42 "), null, "trailing space");
    assert.equal(parseCommercialUid("c:42\n"), null, "trailing newline");
    assert.equal(parseCommercialUid("c:42/../x"), null, "path traversal");
    assert.equal(parseCommercialUid("c:NaN"), null);
    assert.equal(parseCommercialUid("c:0x10"), null);
  });
  test("超长 digits → null (>19 位)", () => {
    assert.equal(parseCommercialUid("c:" + "1".repeat(20)), null);
  });
});

// ── createUserMediaResolver — invalid-uid ───────────────────────────────

describe("createUserMediaResolver — invalid-uid 分支", () => {
  test("'default' → invalid-uid (不走 legacy fallback;gateway 上游已先做 default 拦截)", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    const r = await resolve("default");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") assert.equal(r.reason, "invalid-uid");
  });
  test("'c:0' → invalid-uid", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:0");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") assert.equal(r.reason, "invalid-uid");
  });
  test("奇怪 prefix → invalid-uid", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    for (const bad of ["", "u:42", "C:42", "c:42x", "c:42\n", "c:-1"]) {
      const r = await resolve(bad);
      assert.equal(r.kind, "fail", `bad userId: ${JSON.stringify(bad)}`);
      if (r.kind === "fail") assert.equal(r.reason, "invalid-uid");
    }
  });
  test("invalid-uid logCtx 截断并去除控制字符", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:bad\n\x01x");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail" && r.reason === "invalid-uid") {
      const ctxUid = r.logCtx.userId as string;
      assert.ok(!/[\x00-\x1f]/.test(ctxUid), "no control chars in logged userId");
      assert.ok(ctxUid.length <= 64);
    }
  });
});

// ── createUserMediaResolver — DB / docker 分支 ──────────────────────────

describe("createUserMediaResolver — DB/docker 分支", () => {
  test("not-ready:无 active 容器", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.equal(r.reason, "not-ready");
      assert.equal(r.logCtx.uid, 42);
    }
  });

  test("ambiguous:多条 active 容器", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([
        { host_name: "self", container_id: "111" },
        { host_name: "self", container_id: "222" },
      ]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.equal(r.reason, "ambiguous");
      assert.equal(r.logCtx.activeCount, 2);
      assert.deepEqual(r.logCtx.containerIds, ["111", "222"]);
    }
  });

  test("remote-host:host_name !== 'self'", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([{ host_name: "boheyun-1", container_id: "111" }]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.equal(r.reason, "remote-host");
      assert.equal(r.logCtx.host, "boheyun-1");
    }
  });

  test("volume-missing:docker getVolume 抛 404", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([{ host_name: "self", container_id: "111" }]),
      docker: makeDocker404(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.equal(r.reason, "volume-missing");
      assert.equal(r.logCtx.volume, "oc-v3-data-u42");
    }
  });

  test("daemon-error:pg query 抛错", async () => {
    const resolve = createUserMediaResolver({
      pool: makeThrowingPool(new Error("pg conn dropped")),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.equal(r.reason, "daemon-error");
      assert.equal(r.logCtx.stage, "pg-query");
      assert.ok(String(r.logCtx.err).includes("pg conn dropped"));
    }
  });

  test("daemon-error:docker inspect 抛非 404", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([{ host_name: "self", container_id: "111" }]),
      docker: makeDocker500(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") {
      assert.equal(r.reason, "daemon-error");
      assert.equal(r.logCtx.stage, "docker-inspect");
      assert.equal(r.logCtx.volume, "oc-v3-data-u42");
    }
  });

  test("ok:active+self+volume 存在 → kind:'ok' + uploads/generated 双 dir 一起返回", async () => {
    const resolve = createUserMediaResolver({
      pool: makePool([{ host_name: "self", container_id: "111" }]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") {
      assert.equal(r.uid, 42);
      assert.equal(r.uploads, "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads");
      assert.equal(r.generated, "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated");
    }
  });

  test("ok:单次 DB+docker 调用同时绑定两 dir(spy 验证)", async () => {
    // 关键不变量:一次请求一次 inspect。如果改成 per-kind 多次调用就会触发
    // 双 DB/docker 查询,这条测试会捕获该回归。
    let pgCalls = 0;
    let dockerCalls = 0;
    const pool: PoolLike = {
      async query() {
        pgCalls++;
        return { rows: [{ host_name: "self", container_id: "111" }] as never };
      },
    };
    const docker: DockerLike = {
      getVolume() {
        return {
          async inspect() {
            dockerCalls++;
            return {};
          },
        };
      },
    };
    const resolve = createUserMediaResolver({ pool, docker });
    await resolve("c:42");
    assert.equal(pgCalls, 1, "exactly one DB query per resolve()");
    assert.equal(dockerCalls, 1, "exactly one docker inspect per resolve()");
  });
});

// ── isUserVolumeMediaPath ────────────────────────────────────────────────

describe("isUserVolumeMediaPath", () => {
  test("接受 uploads 目录本身 + 目录下文件 (无尾斜杠)", () => {
    assert.ok(isUserVolumeMediaPath(
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads",
    ));
    assert.ok(isUserVolumeMediaPath(
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/d12367eb.png",
    ));
  });
  test("接受 generated 目录本身 + 目录下文件 (无尾斜杠)", () => {
    assert.ok(isUserVolumeMediaPath(
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated",
    ));
    assert.ok(isUserVolumeMediaPath(
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated/codex-thr-xx.png",
    ));
  });
  test("拒绝带尾斜杠的目录 (调用方必须先 realpathSync)", () => {
    // realpathSync 会剥掉尾斜杠;textual gate 是 last-line-of-defense,
    // 任何路径长得不符合 canonical 形态都得拒掉。
    assert.equal(
      isUserVolumeMediaPath(
        "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/",
      ),
      false,
    );
    assert.equal(
      isUserVolumeMediaPath(
        "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated/",
      ),
      false,
    );
  });
  test("拒绝相邻路径 / 其他 subdir", () => {
    assert.equal(
      isUserVolumeMediaPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/projects"),
      false,
    );
    assert.equal(
      isUserVolumeMediaPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads.bak"),
      false,
    );
    assert.equal(
      isUserVolumeMediaPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/generated.bak"),
      false,
    );
    // 不允许其他 subdir,如 logs / cache / ssh / ...
    assert.equal(
      isUserVolumeMediaPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/logs"),
      false,
    );
    assert.equal(
      isUserVolumeMediaPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/.ssh/id_rsa"),
      false,
    );
  });
  test("拒绝传统单租户路径", () => {
    assert.equal(
      isUserVolumeMediaPath("/root/.openclaude/uploads/d12367eb.png"),
      false,
    );
    assert.equal(
      isUserVolumeMediaPath("/root/.openclaude/generated/codex-thr-xx.png"),
      false,
    );
  });
  test("拒绝嵌套子目录", () => {
    assert.equal(
      isUserVolumeMediaPath(
        "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/sub/d.png",
      ),
      false,
    );
    assert.equal(
      isUserVolumeMediaPath(
        "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated/sub/d.png",
      ),
      false,
    );
  });
  test("拒绝 uid=0 / leading zero / 负数 / 超长 digits", () => {
    for (const kind of ["uploads", "generated"] as const) {
      assert.equal(
        isUserVolumeMediaPath(`/var/lib/docker/volumes/oc-v3-data-u0/_data/${kind}`),
        false,
      );
      assert.equal(
        isUserVolumeMediaPath(`/var/lib/docker/volumes/oc-v3-data-u01/_data/${kind}`),
        false,
      );
      assert.equal(
        isUserVolumeMediaPath(`/var/lib/docker/volumes/oc-v3-data-u-1/_data/${kind}`),
        false,
      );
      assert.equal(
        isUserVolumeMediaPath(
          `/var/lib/docker/volumes/oc-v3-data-u${"1".repeat(20)}/_data/${kind}`,
        ),
        false,
      );
    }
  });
  test("拒绝完全不相关路径", () => {
    assert.equal(isUserVolumeMediaPath("/etc/passwd"), false);
    assert.equal(isUserVolumeMediaPath("/tmp/foo"), false);
    assert.equal(isUserVolumeMediaPath(""), false);
  });
});

// ── 容器同物理路径契约 ─────────────────────────────────────────────────────

describe("master/container 物理路径契约", () => {
  test("master 端解析出的 dir 通过 docker volume mount 在容器侧表现为 /home/agent/.openclaude/(uploads|generated)", () => {
    // 这是个 documentation-as-test:确认 v3supervisor.ts 的 V3_VOLUME_MOUNT 期望
    // 把 oc-v3-data-u<uid> 挂载到容器内 /home/agent/.openclaude。所以
    //   master:  /var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/<file>
    //   container: /home/agent/.openclaude/uploads/<file>
    //   master:  /var/lib/docker/volumes/oc-v3-data-u42/_data/generated/<file>
    //   container: /home/agent/.openclaude/generated/<file>
    // 都是同一个 inode。任何后续重构改动 oc-v3-data-u 命名 / _data/(uploads|generated)
    // 子路径都必须同步改 v3supervisor 的 mount target,否则这俩视图会再次错位 ——
    // 该测试用契约形式锁住命名前缀。
    assert.match(
      buildUserMediaHostDir(42, "uploads"),
      /^\/var\/lib\/docker\/volumes\/oc-v3-data-u42\/_data\/uploads$/,
    );
    assert.match(
      buildUserMediaHostDir(42, "generated"),
      /^\/var\/lib\/docker\/volumes\/oc-v3-data-u42\/_data\/generated$/,
    );
    // 容器侧路径不在本模块里 hardcode,因为 V3_USER_LOCAL_MOUNT/V3_VOLUME_MOUNT 权威
    // 源在 agent-sandbox/v3supervisor.ts。这里只断言 master 端构造的子目录
    // 在 dataroot 树最末端,符合 v3supervisor mount 的 "_data 起作为根" 约定。
    assert.ok(buildUserMediaHostDir(1, "uploads").endsWith("/_data/uploads"));
    assert.ok(buildUserMediaHostDir(1, "generated").endsWith("/_data/generated"));
  });
});
