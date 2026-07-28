import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  destroyAuthSession,
  loadAuthSession,
  writeAuthSession,
} from "./auth-session.mjs";

const helper = new URL("./reprovision.mjs", import.meta.url).pathname;
const helperRev = createHash("sha256").update(readFileSync(helper)).digest("hex");
const basePersona = "base persona\n";
const basePersonaRev = createHash("sha256").update(basePersona).digest("hex");
const promptRev = "9".repeat(64);
const runtimeTuple = {
  image: "runtime:test",
  image_id: `sha256:${"8".repeat(64)}`,
  runtime_release: "rel-test",
  platform_bundle: "bundle-test",
};

async function startAuthServer() {
  const calls = { login: 0, refresh: 0, persona: 0 };
  const server = createServer((request, response) => {
    if (request.url === "/api/auth/login" && request.method === "POST") {
      calls.login += 1;
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "oc_rt=refresh-login; Path=/api/auth; HttpOnly");
      response.end(JSON.stringify({
        access_token: "access-login",
        access_exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      return;
    }
    if (request.url === "/api/auth/refresh" && request.method === "POST") {
      calls.refresh += 1;
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "oc_rt=refresh-next; Path=/api/auth; HttpOnly");
      response.end(JSON.stringify({
        access_token: "access-refresh",
        access_exp: Math.floor(Date.now() / 1000) + 3600,
      }));
      return;
    }
    if (request.url === "/api/agents/main/persona" && request.method === "GET") {
      calls.persona += 1;
      if (!request.headers.authorization?.startsWith("Bearer access-")) {
        response.statusCode = 401;
        response.end("unauthorized");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: basePersona }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeHarness({
  manifestHelperRev = helperRev,
  existingSession = false,
  expiredSession = false,
  target = { user_id: 247, container: "oc-v5-u247" },
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "v5-reprovision-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const sshCount = join(root, "ssh-count");
  writeFileSync(sshCount, "0\n");
  const startedAt = new Date().toISOString();
  const old0 = "a".repeat(64);
  const new1 = "b".repeat(64);
  const new2 = "c".repeat(64);
  const fakeSsh = join(bin, "ssh");
  writeFileSync(fakeSsh, `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
count=$(cat "$SSH_COUNT")
printf '%s\\n' "$((count + 1))" >"$SSH_COUNT"
case "$count" in
  0)
    printf '%s\\n' '${JSON.stringify({
      old_id: old0,
      generation: "95",
      slot: "B",
      active_release: "/release/stable",
    })}'
    ;;
  1)
    printf '%s\\n' '${JSON.stringify({
      id: new1,
      created_at: startedAt,
      started_at: startedAt,
      restart_count: 0,
      runtime_tuple: runtimeTuple,
      persona: basePersonaRev,
      prompt: promptRev,
      fresh: { dispatches: 0, usage_rows: 0, active: 0 },
    })}'
    ;;
  2)
    printf '%s\\n' '${JSON.stringify({
      old_id: new1,
      generation: "95",
      slot: "B",
      active_release: "/release/stable",
    })}'
    ;;
  3)
    printf '%s\\n' '${JSON.stringify({
      id: new2,
      created_at: startedAt,
      started_at: startedAt,
      restart_count: 0,
      runtime_tuple: runtimeTuple,
      persona: basePersonaRev,
      prompt: promptRev,
      fresh: { dispatches: 0, usage_rows: 0, active: 0 },
    })}'
    ;;
  *)
    exit 90
    ;;
esac
`, { mode: 0o700 });
  chmodSync(fakeSsh, 0o700);

  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    engines: { ccb: { model: "qwen3.7-max" } },
    targets: { ccb: target },
    max_container_age_before_pair_ms: 300_000,
    baseline_lane: {
      generation: "95",
      active_slot: "B",
      active_release: "/release/stable",
    },
    baseline_runtime_tuple: runtimeTuple,
    policy: {
      reprovision_rev: manifestHelperRev,
      baseline_prompt_rev: promptRev,
      personas: {
        ccb: { base_persona_rev: basePersonaRev },
      },
    },
  }, null, 2)}\n`);
  const passwordPath = join(root, "password");
  writeFileSync(passwordPath, "password\n", { mode: 0o600 });
  const authDir = mkdtempSync("/tmp/v5-parallel-auth.");
  chmodSync(authDir, 0o700);
  const authPath = join(authDir, "session.json");
  if (existingSession || expiredSession) {
    writeAuthSession(authPath, {
      access_token: expiredSession ? "access-expired" : "access-existing",
      access_exp: expiredSession ? 1 : Math.floor(Date.now() / 1000) + 3600,
      refresh_cookie: "refresh-old",
    });
  }
  return {
    authDir,
    authPath,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SSH_COUNT: sshCount,
      V5_EVAL_MANIFEST: manifestPath,
      V5_EVAL_ENGINE: "ccb",
      V5_EVAL_PAIR_STEP: "1",
      V5_EVAL_EMAIL: "eval@example.test",
      V5_EVAL_PASSWORD_FILE: passwordPath,
      V5_EVAL_AUTH_SESSION_FILE: authPath,
    },
    sshCount,
  };
}

async function run(env) {
  const child = spawn(process.execPath, [helper], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stdout, stderr };
}

function cleanupAuth(test) {
  if (existsSync(test.authDir)) destroyAuthSession(test.authPath);
}

describe("v5 per-arm reprovision", () => {
  it("logs in only once while reprovisioning two fresh arm containers", async () => {
    const server = await startAuthServer();
    const test = makeHarness();
    test.env.V5_EVAL_BASE = server.base;
    try {
      const first = await run(test.env);
      assert.equal(first.code, 0, first.stderr);
      test.env.V5_EVAL_PAIR_STEP = "2";
      const second = await run(test.env);
      assert.equal(second.code, 0, second.stderr);
      const firstResult = JSON.parse(first.stdout);
      const secondResult = JSON.parse(second.stdout);
      assert.equal(firstResult.id, "b".repeat(64));
      assert.equal(secondResult.id, "c".repeat(64));
      assert.equal(firstResult.helper_rev, helperRev);
      assert.equal(secondResult.helper_rev, helperRev);
      assert.deepEqual(server.calls, { login: 1, refresh: 0, persona: 2 });
      assert.equal(readFileSync(test.sshCount, "utf8").trim(), "4");
      assert.equal(loadAuthSession(test.authPath).access_token, "access-login");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });

  it("refreshes an existing expired pair session without another login", async () => {
    const server = await startAuthServer();
    const test = makeHarness({ expiredSession: true });
    test.env.V5_EVAL_BASE = server.base;
    test.env.V5_EVAL_PAIR_STEP = "2";
    try {
      const result = await run(test.env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(server.calls, { login: 0, refresh: 1, persona: 1 });
      assert.equal(loadAuthSession(test.authPath).access_token, "access-refresh");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });

  it("rejects step 2 without the pair session instead of logging in", async () => {
    const server = await startAuthServer();
    const test = makeHarness();
    test.env.V5_EVAL_BASE = server.base;
    test.env.V5_EVAL_PAIR_STEP = "2";
    try {
      const result = await run(test.env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /pair step 2 requires the existing pair auth session/);
      assert.deepEqual(server.calls, { login: 0, refresh: 0, persona: 0 });
      assert.equal(readFileSync(test.sshCount, "utf8").trim(), "0");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });

  it("requires the pair step to be exactly 1 or 2", async () => {
    const server = await startAuthServer();
    const test = makeHarness();
    test.env.V5_EVAL_BASE = server.base;
    test.env.V5_EVAL_PAIR_STEP = "01";
    try {
      const result = await run(test.env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /V5_EVAL_PAIR_STEP must be exactly 1 or 2/);
      assert.deepEqual(server.calls, { login: 0, refresh: 0, persona: 0 });
      assert.equal(readFileSync(test.sshCount, "utf8").trim(), "0");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });

  it("rejects a preexisting session on step 1 before auth or restart", async () => {
    const server = await startAuthServer();
    const test = makeHarness({ existingSession: true });
    test.env.V5_EVAL_BASE = server.base;
    try {
      const result = await run(test.env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /pair step 1 requires an absent auth session/);
      assert.deepEqual(server.calls, { login: 0, refresh: 0, persona: 0 });
      assert.equal(readFileSync(test.sshCount, "utf8").trim(), "0");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });

  it("rejects a malicious manifest target before auth or SSH", async () => {
    const server = await startAuthServer();
    const test = makeHarness({
      target: { user_id: 247, container: "oc-v5-u247;touch /tmp/pwned" },
    });
    test.env.V5_EVAL_BASE = server.base;
    try {
      const result = await run(test.env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /manifest reprovision target is invalid/);
      assert.deepEqual(server.calls, { login: 0, refresh: 0, persona: 0 });
      assert.equal(readFileSync(test.sshCount, "utf8").trim(), "0");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });

  it("rejects an unbound helper before authentication or remote restart", async () => {
    const server = await startAuthServer();
    const test = makeHarness({ manifestHelperRev: "0".repeat(64) });
    test.env.V5_EVAL_BASE = server.base;
    try {
      const result = await run(test.env);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /reprovision helper rev .* differs from manifest/);
      assert.deepEqual(server.calls, { login: 0, refresh: 0, persona: 0 });
      assert.equal(readFileSync(test.sshCount, "utf8").trim(), "0");
    } finally {
      cleanupAuth(test);
      await server.close();
    }
  });
});
