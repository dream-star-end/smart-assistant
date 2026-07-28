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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeAuthSession } from "./auth-session.mjs";

const runner = new URL("./run-pair.sh", import.meta.url).pathname;
const reprovision = new URL("./reprovision.mjs", import.meta.url).pathname;
const reprovisionRev = createHash("sha256").update(readFileSync(reprovision)).digest("hex");

function harness(mode, {
  auth = false,
  order = "A_FIRST",
  boundReprovisionRev = reprovisionRev,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "v5-run-pair-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const state = join(root, "persona-state");
  const events = join(root, "events");
  writeFileSync(state, "base\n");
  writeFileSync(events, "");
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  -)
    cat >/dev/null
    printf '%s\\n' "$PAIR_ORDER" qwen3.7-max '' \\
      '${"1".repeat(64)}' '${"2".repeat(64)}' '${"3".repeat(64)}' '${"4".repeat(64)}' oc-v5-u247
    printf '%s\\n' "$PAIR_REPROVISION_REV"
    ;;
  *reprovision.mjs)
    printf 'reprovision:%s:%s:%s\\n' \\
      "\${V5_EVAL_ARM:-}" "\${V5_EVAL_PAIR_STEP:-}" "$(cat "$PAIR_STATE")" >>"$PAIR_EVENTS"
    if [[ "$PAIR_MODE" == first_reprovision_fail && "\${V5_EVAL_PAIR_STEP:-}" == 1 ]]; then
      exit 47
    fi
    if [[ "$PAIR_MODE" == second_reprovision_fail && "\${V5_EVAL_PAIR_STEP:-}" == 2 ]]; then
      exit 46
    fi
    if [[ ! -f "$V5_EVAL_AUTH_SESSION_FILE" ]]; then
      printf '%s\\n' \\
        '{"access_token":"access","access_exp":2000000000,"refresh_cookie":"refresh"}' \\
        >"$V5_EVAL_AUTH_SESSION_FILE"
      chmod 600 "$V5_EVAL_AUTH_SESSION_FILE"
    fi
    if [[ "\${V5_EVAL_PAIR_STEP:-}" == 1 ]]; then
      printf '%s\\n' \\
        '{"id":"${"a".repeat(64)}","started_at":"2026-07-28T20:00:00.000Z"}'
    else
      printf '%s\\n' \\
        '{"id":"${"b".repeat(64)}","started_at":"2026-07-28T20:01:00.000Z"}'
    fi
    ;;
  *persona-variant.mjs)
    case "\${2:-}" in
      apply)
        printf 'apply:%s:%s\\n' "\${V5_EVAL_ARM:-}" "\${V5_EVAL_PAIR_STEP:-}" >>"$PAIR_EVENTS"
        printf 'candidate\\n' >"$PAIR_STATE"
        [[ "$PAIR_MODE" == partial_apply ]] && exit 42
        exit 0
        ;;
      restore)
        printf 'restore:%s:%s\\n' "\${V5_EVAL_ARM:-}" "\${V5_EVAL_PAIR_STEP:-}" >>"$PAIR_EVENTS"
        [[ "$PAIR_MODE" == restore_fail ]] && exit 43
        printf 'base\\n' >"$PAIR_STATE"
        exit 0
        ;;
    esac
    ;;
  *capture.mjs)
    printf 'capture:%s:%s:%s\\n' \\
      "\${V5_EVAL_ARM:-}" "\${V5_EVAL_PAIR_STEP:-}" \\
      "\${V5_EVAL_REPROVISION_CONTAINER_ID:-}" >>"$PAIR_EVENTS"
    [[ "$PAIR_MODE" == capture_fail && "\${V5_EVAL_ARM:-}" == B ]] && exit 44
    exit 0
    ;;
  *auth-session.mjs)
    if [[ "\${2:-}" == logout ]]; then
      [[ "$PAIR_MODE" == logout_fail ]] && exit 45
      exit 0
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
    PAIR_EVENTS: events,
    PAIR_ORDER: order,
    PAIR_REPROVISION_REV: boundReprovisionRev,
    V5_EVAL_BASE: "https://example.test",
    V5_EVAL_EMAIL: "eval@example.test",
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
    V5_EVAL_PASSWORD_FILE: join(root, "password"),
  };
  writeFileSync(env.V5_EVAL_PASSWORD_FILE, "password\n", { mode: 0o600 });
  const authDir = mkdtempSync("/tmp/v5-parallel-auth.");
  chmodSync(authDir, 0o700);
  env.V5_EVAL_AUTH_SESSION_FILE = join(authDir, "session.json");
  if (auth) {
    writeAuthSession(env.V5_EVAL_AUTH_SESSION_FILE, {
      access_token: "access",
      access_exp: 2_000_000_000,
      refresh_cookie: "refresh",
    });
  }
  return { root, state, events, env, authDir };
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
    const test = harness("restore_fail", { order: "B_FIRST" });
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

  it("uses a different fresh reprovision for each arm with base restored between them", async () => {
    const test = harness("ok");
    const result = await run(test.env);
    assert.equal(result.code, 0, result.stderr);
    const events = readFileSync(test.events, "utf8").trim().split("\n");
    assert.deepEqual(events.slice(0, 6), [
      "reprovision:A:1:base",
      `capture:A:1:${"a".repeat(64)}`,
      "restore:A:1",
      "reprovision:B:2:base",
      "apply:B:2",
      `capture:B:2:${"b".repeat(64)}`,
    ]);
    assert.equal(readFileSync(test.state, "utf8"), "base\n");
  });

  it("fails the whole pair when the second arm cannot be reprovisioned", async () => {
    const test = harness("second_reprovision_fail");
    const result = await run(test.env);
    assert.equal(result.code, 46, result.stderr);
    assert.equal(readFileSync(test.state, "utf8"), "base\n");
    assert.match(readFileSync(test.events, "utf8"), /reprovision:B:2:base/);
    assert.equal(existsSync(test.authDir), false);
  });

  it("securely cleans an empty auth directory when the first reprovision fails", async () => {
    const test = harness("first_reprovision_fail");
    const result = await run(test.env);
    assert.equal(result.code, 47, result.stderr);
    assert.equal(readFileSync(test.state, "utf8"), "base\n");
    assert.equal(existsSync(test.authDir), false);
  });

  it("refuses a reprovision helper that differs from the manifest binding", async () => {
    const test = harness("ok", { boundReprovisionRev: "0".repeat(64) });
    const result = await run(test.env);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /canonical reprovision helper differs/);
    assert.equal(readFileSync(test.events, "utf8"), "");
    assert.equal(existsSync(test.authDir), false);
  });
});
