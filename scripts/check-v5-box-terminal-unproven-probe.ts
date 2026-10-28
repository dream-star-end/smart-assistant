/**
 * Deploy-gate probe for a keeper whose terminal proof cannot be read.
 *
 * Runs the product liveness script (the PROBE inside makeBoxRunLiveness)
 * against this machine's /proc. A stop.ready that is not the keeper's
 * handshake, and a terminal.json that can only be stat'd, must not skip
 * that scan and must not be reported as a terminal proof. worker_complete
 * stays with the proof reader. This process does not open a journal,
 * settle billing, or replay a request.
 *
 * deploy-v5.sh runs it from the pinned candidate archive, beside the other
 * Box gates, with no database.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeBoxRunLiveness, parseBoxRunLiveness } from "../packages/commercial/src/http/proxy/boxRunLiveness.js";

export const BOX_TERMINAL_UNPROVEN_PROBE_PASS =
  "[inc-20261028-box-terminal-unproven-probe] PASS — a stat-only terminal.json and a bad stop.ready do not skip the real process scan, and a live process stays alive";

function fail(message: string): never {
  throw new Error(`[box-terminal-unproven-probe] ${message}`);
}

function look(nonce: string): { state: "alive" | "absent"; boot: string } {
  const request = makeBoxRunLiveness(nonce);
  const out = spawnSync(request.command, request.args, {
    cwd: request.cwd,
    env: request.environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (out.status !== 0) {
    fail(`probe exit ${String(out.status)} stdout=${JSON.stringify(out.stdout)} stderr=${JSON.stringify(out.stderr)}`);
  }
  if (out.stdout.startsWith("terminal ")) fail("stat-only terminal.json was treated as a proof");
  const parsed = parseBoxRunLiveness(out.stdout);
  if (!parsed || parsed.state === "terminal") fail(`unusable stdout ${JSON.stringify(out.stdout)}`);
  return parsed;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
}

async function main(): Promise<void> {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const nonce = randomBytes(12).toString("hex");
  const run = `/tmp/ocv5-289-run-${nonce}`;
  const proof = `/tmp/ocv5-289-proof-${nonce}`;
  mkdirSync(run, { mode: 0o700 });
  mkdirSync(proof, { mode: 0o700 });
  const keeper = spawn("/usr/bin/python3", ["-I", "-c", "import time\nwhile True:time.sleep(.1)",
    "--proof-dir", proof], { cwd: "/tmp", stdio: "ignore" });
  try {
    writeFileSync(`${proof}/terminal.json`, "{}\n", { mode: 0o644 });
    writeFileSync(`${proof}/stop.ready`, "not json\n", { mode: 0o600 });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const alive = look(nonce);
    if (alive.state !== "alive" || alive.boot !== boot) {
      fail(`expected alive ${boot}, got ${alive.state} ${alive.boot}`);
    }
    keeper.kill("SIGKILL");
    await exited(keeper);
    const gone = look(nonce);
    if (gone.state !== "absent" || gone.boot !== boot) {
      fail(`expected absent ${boot}, got ${gone.state} ${gone.boot}`);
    }
    // This body used to SystemExit(125) before the scan.
    writeFileSync(`${proof}/stop.ready`,
      `${JSON.stringify({ runNonce: "c".repeat(24), cliPid: "4242" })}\n`, { mode: 0o600 });
    const still = look(nonce);
    if (still.state !== "absent" || still.boot !== boot) {
      fail(`bad handshake blocked the scan: ${still.state} ${still.boot}`);
    }
  } finally {
    if (keeper.exitCode === null) keeper.kill("SIGKILL");
    rmSync(run, { recursive: true, force: true });
    rmSync(proof, { recursive: true, force: true });
  }
  const missing = look(nonce);
  if (missing.state !== "absent" || missing.boot !== boot) {
    fail(`gone directories: ${missing.state} ${missing.boot}`);
  }
  process.stdout.write(`${BOX_TERMINAL_UNPROVEN_PROBE_PASS}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error(`[gate-failure] ${message.split("\n")[0]}`);
  process.exit(1);
});
