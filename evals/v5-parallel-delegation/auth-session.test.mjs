import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  authorizedFetch,
  destroyAuthSession,
  ensureAuthSession,
  loadAuthSession,
  loginAuthSession,
  logoutAuthSession,
  updateAuthSessionFromBrowserCookies,
  writeAuthSession,
} from "./auth-session.mjs";

function securePath(tag) {
  const root = mkdtempSync(join(tmpdir(), `v5-auth-${tag}-`));
  chmodSync(root, 0o700);
  return join(root, "session.json");
}

function response(body, refreshCookie, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(refreshCookie ? { "set-cookie": `oc_rt=${refreshCookie}; Path=/api/auth; HttpOnly` } : {}),
    },
  });
}

const first = {
  access_token: "access-one",
  access_exp: 2_000_000_000,
  refresh_cookie: "refresh-one",
};

async function spawnPersona(env, args) {
  const child = spawn(
    process.execPath,
    [new URL("./persona-variant.mjs", import.meta.url).pathname, ...args],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stderr };
}

async function runPersona(env, args) {
  const { code, stderr } = await spawnPersona(env, args);
  assert.equal(code, 0, stderr);
}

describe("v5 eval shared auth session", () => {
  it("atomically stores a complete session in a current-user 0600 regular file", () => {
    const path = securePath("write");
    writeAuthSession(path, first);
    assert.deepEqual(loadAuthSession(path), first);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(first)}\n`);
  });

  it("fails closed on insecure parent/file modes and symlinks", () => {
    const insecureDir = mkdtempSync(join(tmpdir(), "v5-auth-insecure-"));
    chmodSync(insecureDir, 0o755);
    assert.throws(
      () => writeAuthSession(join(insecureDir, "session.json"), first),
      /mode 0700/,
    );
    chmodSync(insecureDir, 0o500);
    assert.throws(
      () => writeAuthSession(join(insecureDir, "session.json"), first),
      /mode 0700/,
    );

    const path = securePath("file-mode");
    writeAuthSession(path, first);
    chmodSync(path, 0o644);
    assert.throws(() => loadAuthSession(path), /mode 0600/);
    chmodSync(path, 0o400);
    assert.throws(() => loadAuthSession(path), /mode 0600/);
    chmodSync(path, 0o700);
    assert.throws(() => loadAuthSession(path), /mode 0600/);

    const symlinkDir = mkdtempSync(join(tmpdir(), "v5-auth-symlink-"));
    chmodSync(symlinkDir, 0o700);
    const target = join(symlinkDir, "target.json");
    writeAuthSession(target, first);
    const link = join(symlinkDir, "session.json");
    symlinkSync(target, link);
    assert.throws(() => loadAuthSession(link), /regular file/);
  });

  it("only destroys an exact direct mktemp auth directory and rejects traversal", () => {
    const validDir = mkdtempSync("/tmp/v5-parallel-auth.");
    chmodSync(validDir, 0o700);
    const valid = join(validDir, "session.json");
    writeAuthSession(valid, first);
    destroyAuthSession(valid);
    assert.equal(existsSync(validDir), false);

    const victim = mkdtempSync(join(tmpdir(), "v5-auth-victim-"));
    chmodSync(victim, 0o700);
    const victimSession = join(victim, "session.json");
    writeAuthSession(victimSession, first);
    const prefix = mkdtempSync("/tmp/v5-parallel-auth.");
    chmodSync(prefix, 0o700);
    const traversal = `${prefix}/../${victim.slice("/tmp/".length)}/session.json`;
    assert.throws(() => destroyAuthSession(traversal), /canonical/);
    assert.equal(existsSync(victimSession), true);

    const nested = join(prefix, "nested");
    mkdirSync(nested, { mode: 0o700 });
    const nestedSession = join(nested, "session.json");
    writeAuthSession(nestedSession, first);
    assert.throws(() => destroyAuthSession(nestedSession), /direct mktemp child/);
    assert.equal(existsSync(nestedSession), true);

    const symlinkTarget = mkdtempSync(join(tmpdir(), "v5-auth-symlink-target-"));
    chmodSync(symlinkTarget, 0o700);
    const link = mkdtempSync("/tmp/v5-parallel-auth.");
    rmdirSync(link);
    symlinkSync(symlinkTarget, link);
    assert.throws(
      () => destroyAuthSession(join(link, "session.json")),
      /real directory/,
    );
    assert.equal(existsSync(symlinkTarget), true);
  });

  it("captures login access/expiry/cookie and refreshes an expiring session", async () => {
    const login = await loginAuthSession(
      "https://example.test",
      "eval@example.test",
      "secret",
      async (url, init) => {
        assert.equal(url, "https://example.test/api/auth/login");
        assert.equal(JSON.parse(init.body).email, "eval@example.test");
        return response({
          access_token: "login-access",
          access_exp: 1234,
        }, "login-refresh");
      },
    );
    assert.deepEqual(login, {
      access_token: "login-access",
      access_exp: 1234,
      refresh_cookie: "login-refresh",
    });

    const path = securePath("refresh");
    writeAuthSession(path, {
      access_token: "expired",
      access_exp: 1,
      refresh_cookie: "old-refresh",
    });
    const refreshed = await ensureAuthSession(
      "https://example.test",
      path,
      async (url, init) => {
        assert.equal(url, "https://example.test/api/auth/refresh");
        assert.equal(init.headers.Cookie, "oc_rt=old-refresh");
        return response({
          access_token: "new-access",
          access_exp: 2_000_000_000,
        }, "new-refresh");
      },
      1_000_000,
    );
    assert.equal(refreshed.access_token, "new-access");
    assert.equal(loadAuthSession(path).refresh_cookie, "new-refresh");
  });

  it("retries one bearer 401 through refresh and persists browser cookie rotation", async () => {
    const path = securePath("retry");
    writeAuthSession(path, first);
    const calls = [];
    const result = await authorizedFetch(
      "https://example.test",
      path,
      "https://example.test/api/agents/main/persona",
      { method: "GET" },
      async (url, init) => {
        calls.push([url, new Headers(init.headers)]);
        if (url.endsWith("/persona") && calls.length === 1) {
          return new Response("", { status: 401 });
        }
        if (url.endsWith("/refresh")) {
          return response({
            access_token: "refreshed-access",
            access_exp: 2_100_000_000,
          }, "rotated-refresh");
        }
        return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
      },
    );
    assert.equal(result.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[0][1].get("authorization"), "Bearer access-one");
    assert.equal(calls[2][1].get("authorization"), "Bearer refreshed-access");
    updateAuthSessionFromBrowserCookies(path, [
      { name: "other", value: "ignored" },
      { name: "oc_rt", value: "browser-rotated-refresh" },
    ]);
    assert.equal(loadAuthSession(path).refresh_cookie, "browser-rotated-refresh");
    await logoutAuthSession("https://example.test", path, async (url, init) => {
      assert.equal(url, "https://example.test/api/auth/logout");
      assert.equal(init.headers.Cookie, "oc_rt=browser-rotated-refresh");
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    });
  });

  it("lets persona operations use the bundle with zero login and preserves fallback login", async () => {
    let loginCalls = 0;
    const authorizations = [];
    const server = createServer(async (request, response_) => {
      if (request.url === "/api/auth/login") {
        loginCalls += 1;
        response_.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "oc_rt=fallback-refresh; Path=/api/auth; HttpOnly",
        });
        response_.end(JSON.stringify({
          access_token: "fallback-access",
          access_exp: 2_000_000_000,
        }));
        return;
      }
      if (request.url === "/api/agents/main/persona" && request.method === "GET") {
        authorizations.push(request.headers.authorization);
        response_.writeHead(200, { "content-type": "application/json" });
        response_.end(JSON.stringify({ text: "base persona\n", path: "/persona" }));
        return;
      }
      response_.writeHead(404);
      response_.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const bundle = securePath("persona-bundle");
      writeAuthSession(bundle, first);
      const firstOut = join(tmpdir(), `v5-persona-auth-${process.pid}.txt`);
      await runPersona({
        V5_EVAL_BASE: base,
        V5_EVAL_EMAIL: "eval@example.test",
        V5_EVAL_AUTH_SESSION_FILE: bundle,
        V5_EVAL_PASSWORD_FILE: "",
      }, ["snapshot", "--out", firstOut]);
      assert.equal(loginCalls, 0);
      assert.equal(authorizations[0], "Bearer access-one");

      const fallbackDir = mkdtempSync(join(tmpdir(), "v5-persona-fallback-"));
      chmodSync(fallbackDir, 0o700);
      const password = join(fallbackDir, "password");
      writeFileSync(password, "secret\n", { mode: 0o600 });
      const secondOut = join(fallbackDir, "persona.txt");
      await runPersona({
        V5_EVAL_BASE: base,
        V5_EVAL_EMAIL: "eval@example.test",
        V5_EVAL_AUTH_SESSION_FILE: "",
        V5_EVAL_PASSWORD_FILE: password,
      }, ["snapshot", "--out", secondOut]);
      assert.equal(loginCalls, 1);
      assert.equal(authorizations[1], "Bearer fallback-access");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reconciles a candidate persona after PUT succeeded but apply verification failed", async () => {
    let persona = "base persona\n";
    let failCandidateVerification = true;
    const server = createServer(async (request, response_) => {
      if (request.url !== "/api/agents/main/persona") {
        response_.writeHead(404);
        response_.end();
        return;
      }
      if (request.method === "PUT") {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        persona = JSON.parse(raw).text;
        response_.writeHead(200, { "content-type": "application/json" });
        response_.end(JSON.stringify({ text: persona, path: "/persona" }));
        return;
      }
      if (persona.includes("candidate rule") && failCandidateVerification) {
        failCandidateVerification = false;
        response_.writeHead(503);
        response_.end("verification unavailable");
        return;
      }
      response_.writeHead(200, { "content-type": "application/json" });
      response_.end(JSON.stringify({ text: persona, path: "/persona" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const dir = mkdtempSync(join(tmpdir(), "v5-persona-reconcile-"));
    chmodSync(dir, 0o700);
    const bundle = join(dir, "session.json");
    writeAuthSession(bundle, first);
    const baseFile = join(dir, "base.txt");
    const ruleFile = join(dir, "rule.md");
    writeFileSync(baseFile, "base persona\n", { mode: 0o600 });
    writeFileSync(ruleFile, "candidate rule\n", { mode: 0o600 });
    const env = {
      V5_EVAL_BASE: baseUrl,
      V5_EVAL_EMAIL: "eval@example.test",
      V5_EVAL_AUTH_SESSION_FILE: bundle,
      V5_EVAL_PASSWORD_FILE: "",
    };
    try {
      const applied = await spawnPersona(env, [
        "apply", "--base", baseFile, "--rule", ruleFile,
      ]);
      assert.notEqual(applied.code, 0);
      assert.equal(persona, "base persona\n\ncandidate rule\n");
      await runPersona(env, [
        "restore", "--base", baseFile, "--rule", ruleFile,
      ]);
      assert.equal(persona, "base persona\n");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("wires capture cookie rotation and pair auth cleanup", () => {
    const capture = readFileSync(
      new URL("./capture.mjs", import.meta.url),
      "utf8",
    );
    assert.match(capture, /authorizedFetch\(BASE, AUTH_SESSION_FILE/);
    assert.match(capture, /await cleanupContext\.cookies\(\)/);
    assert.match(capture, /updateAuthSessionFromBrowserCookies/);
    const runner = readFileSync(
      new URL("./run-pair.sh", import.meta.url),
      "utf8",
    );
    assert.match(runner, /auth-session\.mjs" logout/);
    assert.match(runner, /auth-session\.mjs" cleanup/);
    assert.match(runner, /trap cleanup_pair EXIT/);
  });
});
