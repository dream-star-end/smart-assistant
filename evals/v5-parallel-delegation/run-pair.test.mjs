import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeAuthSession } from "./auth-session.mjs";

const runner = new URL("./run-pair.sh", import.meta.url).pathname;

function harness(mode, { auth = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "v5-run-pair-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const state = join(root, "persona-state");
  writeFileSync(state, "base\n");
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  -)
    cat >/dev/null
    printf '%s\\n' A_FIRST qwen3.7-max '' \\
      '${"1".repeat(64)}' '${"2".repeat(64)}' '${"3".repeat(64)}' '${"4".repeat(64)}' oc-v5-u247
    ;;
  *persona-variant.mjs)
    case "\${2:-}" in
      apply)
        printf 'candidate\\n' >"$PAIR_STATE"
        [[ "$PAIR_MODE" == partial_apply ]] && exit 42
        exit 0
        ;;
      restore)
        [[ "$PAIR_MODE" == restore_fail ]] && exit 43
        printf 'base\\n' >"$PAIR_STATE"
        exit 0
        ;;
    esac
    ;;
  *capture.mjs)
    [[ "$PAIR_MODE" == capture_fail && "\${V5_EVAL_ARM:-}" == B ]] && exit 44
    exit 0
    ;;
  *auth-session.mjs)
    if [[ "\${2:-}" == logout && "$PAIR_MODE" == logout_fail ]]; then
      exit 45
    fi
    exec "$REAL_NODE" "$@"
    ;;
  *)
    exec "$REAL_NODE" "$@"
    ;;
esac
`, { mode: 0o700 });
  chmodSync(fakeNode, 0o700);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
    PAIR_MODE: mode,
    PAIR_STATE: state,
    V5_EVAL_BASE: "https://example.test",
    V5_EVAL_MANIFEST: join(root, "manifest.json"),
    V5_EVAL_FIXTURES: join(root, "fixtures"),
    V5_EVAL_SCENARIO: "simple",
    V5_EVAL_PAIR_ID: "01",
    V5_EVAL_ENGINE: "ccb",
    V5_EVAL_RUNS_DIR: join(root, "runs"),
    V5_EVAL_PERSONA_BASE_FILE: join(root, "base.txt"),
    V5_EVAL_RULE_FILE: join(root, "rule.md"),
    V5_EVAL_PERSONA_PATH: "/persona",
    V5_EVAL_PROBE_PATH: "/probe",
    V5_EVAL_PAIR_EXECUTION_ID: "pair-execution-test",
  };
  let authDir = null;
  if (auth) {
    authDir = mkdtempSync("/tmp/v5-parallel-auth.");
    chmodSync(authDir, 0o700);
    env.V5_EVAL_AUTH_SESSION_FILE = join(authDir, "session.json");
    writeAuthSession(env.V5_EVAL_AUTH_SESSION_FILE, {
      access_token: "access",
      access_exp: 2_000_000_000,
      refresh_cookie: "refresh",
    });
  }
  return { root, state, env, authDir };
}

async function run(env) {
  const child = spawn("bash", [runner], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, stderr };
}

describe("v5 isolated pair cleanup", () => {
  it("restores base after apply changed persona but failed before verification", async () => {
    const test = harness("partial_apply");
    const result = await run(test.env);
    assert.equal(result.code, 42, result.stderr);
    assert.equal(readFileSync(test.state, "utf8"), "base\n");
  });

  it("preserves an original capture failure after restoring base", async () => {
    const test = harness("capture_fail");
    const result = await run(test.env);
    assert.equal(result.code, 44, result.stderr);
    assert.equal(readFileSync(test.state, "utf8"), "base\n");
  });

  it("makes a restore failure fail the pair", async () => {
    const test = harness("restore_fail");
    const result = await run(test.env);
    assert.notEqual(result.code, 0, result.stderr);
    assert.equal(readFileSync(test.state, "utf8"), "candidate\n");
  });

  it("ignores logout failure but securely deletes the valid pair auth directory", async () => {
    const test = harness("logout_fail", { auth: true });
    const result = await run(test.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(test.state, "utf8"), "base\n");
    assert.equal(existsSync(test.authDir), false);
  });
});
