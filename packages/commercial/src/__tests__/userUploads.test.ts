/**
 * V3 multi-tenant `/api/uploads` 路径解析器单测。
 *
 * 这一类测试是 2026-05-12 attachment "媒体不存在或不可读" 回归的护栏 —— bug 根因
 * 是 handleUpload 写到 master 的 paths.uploadsDir,而容器侧 dispatchInbound 读
 * 容器自己的 paths.uploadsDir,两者在多租户下指向不同物理路径。修复方案是把存储
 * 权威源搬到用户 docker volume 的宿主路径,这里测试该路径的所有解析分支 fail-closed。
 *
 * 覆盖:
 *   - buildUserUploadsHostDir
 *       · 合法 uid → "/var/lib/docker/volumes/oc-v3-data-u<uid>/_data/uploads"
 *       · 非法 uid → 抛(委托给 v3VolumeNameFor)
 *   - parseCommercialUid
 *       · 合法 c:<digits>(1-19 位)→ number
 *       · "default" / 非 c: 前缀 / c:0 / c:001 / c:-1 / c:42/.. / 控制字符 / 空 → null
 *   - createUserUploadsResolver
 *       · invalid-uid:userId 非 c:<digits> 形态
 *       · not-ready:DB 查无 active 容器
 *       · ambiguous:DB 查到 ≥2 active 容器
 *       · remote-host:host_name !== 'self'
 *       · volume-missing:docker getVolume 404
 *       · daemon-error:pg 查询 throw / docker inspect 抛非 404
 *       · ok:active+self+volume 存在 → kind:'ok',dir 为 USER_VOLUME_UPLOADS_HOST_PREFIX/…
 *   - isUserVolumeUploadsPath
 *       · 接受目录本身、目录下文件
 *       · 拒绝相邻路径、缺斜杠、传统 paths.uploadsDir、嵌套子目录
 *       · 拒绝 leading zero / uid=0 / 负数 / 超长 digits
 *   - 容器同物理路径契约:
 *       · resolver 在 master 端返回的 dir 在容器侧通过 docker mount 表现为
 *         `/home/agent/.openclaude/uploads`(纯路径契约,不实际拉容器)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildUserUploadsHostDir,
  createUserUploadsResolver,
  isUserVolumeUploadsPath,
  parseCommercialUid,
  USER_VOLUME_UPLOADS_HOST_PREFIX,
  USER_VOLUME_UPLOADS_SUBPATH,
  type DockerLike,
  type PoolLike,
} from "../agent-sandbox/userUploads.js";

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

// ── buildUserUploadsHostDir ──────────────────────────────────────────────

describe("buildUserUploadsHostDir", () => {
  test("合法 uid → 规范化目录路径", () => {
    assert.equal(
      buildUserUploadsHostDir(42),
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads",
    );
    assert.equal(
      buildUserUploadsHostDir(1),
      "/var/lib/docker/volumes/oc-v3-data-u1/_data/uploads",
    );
  });
  test("非法 uid 0 / 负数 / 非整数 → 抛(委托 v3VolumeNameFor)", () => {
    assert.throws(() => buildUserUploadsHostDir(0));
    assert.throws(() => buildUserUploadsHostDir(-1));
    assert.throws(() => buildUserUploadsHostDir(1.5));
  });
  test("常量自洽", () => {
    assert.equal(USER_VOLUME_UPLOADS_HOST_PREFIX, "/var/lib/docker/volumes");
    assert.equal(USER_VOLUME_UPLOADS_SUBPATH, "_data/uploads");
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

// ── createUserUploadsResolver — invalid-uid ─────────────────────────────

describe("createUserUploadsResolver — invalid-uid 分支", () => {
  test("'default' → invalid-uid (不走 legacy fallback;gateway 上游已先做 default 拦截)", async () => {
    const resolve = createUserUploadsResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    const r = await resolve("default");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") assert.equal(r.reason, "invalid-uid");
  });
  test("'c:0' → invalid-uid", async () => {
    const resolve = createUserUploadsResolver({
      pool: makePool([]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:0");
    assert.equal(r.kind, "fail");
    if (r.kind === "fail") assert.equal(r.reason, "invalid-uid");
  });
  test("奇怪 prefix → invalid-uid", async () => {
    const resolve = createUserUploadsResolver({
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
    const resolve = createUserUploadsResolver({
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

// ── createUserUploadsResolver — DB / docker 分支 ────────────────────────

describe("createUserUploadsResolver — DB/docker 分支", () => {
  test("not-ready:无 active 容器", async () => {
    const resolve = createUserUploadsResolver({
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
    const resolve = createUserUploadsResolver({
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
    const resolve = createUserUploadsResolver({
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
    const resolve = createUserUploadsResolver({
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
    const resolve = createUserUploadsResolver({
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
    const resolve = createUserUploadsResolver({
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

  test("ok:active+self+volume 存在 → kind:'ok'", async () => {
    const resolve = createUserUploadsResolver({
      pool: makePool([{ host_name: "self", container_id: "111" }]),
      docker: makeDockerOk(),
    });
    const r = await resolve("c:42");
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") {
      assert.equal(r.uid, 42);
      assert.equal(r.dir, "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads");
    }
  });
});

// ── isUserVolumeUploadsPath ──────────────────────────────────────────────

describe("isUserVolumeUploadsPath", () => {
  test("接受目录本身 + 目录下文件 (无尾斜杠 — 调用方应先 realpathSync)", () => {
    assert.ok(isUserVolumeUploadsPath(
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads",
    ));
    assert.ok(isUserVolumeUploadsPath(
      "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/d12367eb.png",
    ));
  });
  test("拒绝带尾斜杠的目录 (调用方必须先 realpathSync)", () => {
    // realpathSync 会剥掉尾斜杠;textual gate 是 last-line-of-defense,
    // 任何路径长得不符合 canonical 形态都得拒掉。
    assert.equal(
      isUserVolumeUploadsPath(
        "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/",
      ),
      false,
    );
  });
  test("拒绝相邻路径", () => {
    assert.equal(
      isUserVolumeUploadsPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/projects"),
      false,
    );
    assert.equal(
      isUserVolumeUploadsPath("/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads.bak"),
      false,
    );
  });
  test("拒绝传统单租户路径", () => {
    assert.equal(
      isUserVolumeUploadsPath("/root/.openclaude/uploads/d12367eb.png"),
      false,
    );
  });
  test("拒绝嵌套子目录", () => {
    assert.equal(
      isUserVolumeUploadsPath(
        "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/sub/d.png",
      ),
      false,
    );
  });
  test("拒绝 uid=0 / leading zero / 负数 / 超长 digits", () => {
    assert.equal(
      isUserVolumeUploadsPath("/var/lib/docker/volumes/oc-v3-data-u0/_data/uploads"),
      false,
    );
    assert.equal(
      isUserVolumeUploadsPath("/var/lib/docker/volumes/oc-v3-data-u01/_data/uploads"),
      false,
    );
    assert.equal(
      isUserVolumeUploadsPath("/var/lib/docker/volumes/oc-v3-data-u-1/_data/uploads"),
      false,
    );
    assert.equal(
      isUserVolumeUploadsPath(
        "/var/lib/docker/volumes/oc-v3-data-u" + "1".repeat(20) + "/_data/uploads",
      ),
      false,
    );
  });
  test("拒绝完全不相关路径", () => {
    assert.equal(isUserVolumeUploadsPath("/etc/passwd"), false);
    assert.equal(isUserVolumeUploadsPath("/tmp/foo"), false);
    assert.equal(isUserVolumeUploadsPath(""), false);
  });
});

// ── 容器同物理路径契约 ─────────────────────────────────────────────────────

describe("master/container 物理路径契约", () => {
  test("master 端解析出的 dir 通过 docker volume mount 在容器侧表现为 /home/agent/.openclaude/uploads", () => {
    // 这是个 documentation-as-test:确认 v3supervisor.ts 的 V3_VOLUME_MOUNT 期望
    // 把 oc-v3-data-u<uid> 挂载到容器内 /home/agent/.openclaude。所以
    //   master:  /var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/<digest>.<ext>
    //   container: /home/agent/.openclaude/uploads/<digest>.<ext>
    // 是同一个 inode。任何后续重构改动 oc-v3-data-u 命名 / _data/uploads 子路径
    // 都必须同步改 v3supervisor 的 mount target,否则这俩视图会再次错位 ——
    // 该测试用契约形式锁住命名前缀。
    const masterDir = buildUserUploadsHostDir(42);
    assert.match(masterDir, /^\/var\/lib\/docker\/volumes\/oc-v3-data-u42\/_data\/uploads$/);
    // 容器侧路径不在本模块里 hardcode,因为 V3_USER_LOCAL_MOUNT/V3_VOLUME_MOUNT 权威
    // 源在 agent-sandbox/v3supervisor.ts。这里只断言 master 端构造的 /uploads
    // 子路径在 dataroot 树最末端,符合 v3supervisor mount 的 "_data 起作为根" 约定。
    assert.ok(masterDir.endsWith("/_data/uploads"));
  });
});
