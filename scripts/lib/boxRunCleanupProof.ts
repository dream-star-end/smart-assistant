// OCV5-645 Box incident proof, kept out of scripts/check-v5-box-incident-proofs.ts to keep it inside the
// file-size ratchet (same split as scripts/lib/boxGptWebCitationProof.ts). It runs the candidate's own cleanup
// worker, and the cleanup script that worker sends to the Box is executed for real against a scratch tree.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

/** INC-20261027-BOX-RUN-CLEANUP-TOOL-RESULTS (OCV5-645, from the #a9f49bcf static walk): a long Box task whose
 * final answer was settled by the cleanup worker's recovery has no native pointer, so its privacy cleanup always
 * runs with keep=0. Once the run had one tool result over 50k characters or one image, Claude Code had written
 * <project>/<session>/tool-results/, the cleanup script refused it with 126 (BOX_RUN_CLEANUP_UNPROVEN) and the
 * worker retried it forever. That tree is now cleaned with the native GC's rules; anything else under the
 * session folder stays refused and untouched. */
export async function proveRunCleanupToolResults(candidate: string): Promise<string> {
  const { BoxRemoteCleanupWorker } = await import(pathToFileURL(join(candidate,
    "packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts")).href);
  const nonce = randomBytes(12).toString("hex");
  const run = `/tmp/ocv5-289-run-${nonce}`;
  const root = `/tmp/ocv5-645-projects-${randomBytes(8).toString("hex")}`;
  const project = `${root}/${run.replaceAll("/", "-")}`;
  const sid = "12345678-1234-4123-8123-123456789abc";
  const tree = `${project}/${sid}/tool-results`;
  const stage = (extra?: () => void) => {
    rmSync(run, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    mkdirSync(run, { mode: 0o700 });
    writeFileSync(`${run}/stdout.jsonl`, "private model output", { mode: 0o600 });
    writeFileSync(`${run}/stderr.log`, "private stderr", { mode: 0o600 });
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(`${project}/${sid}.jsonl`, "private history\n", { mode: 0o600 });
    // the exact tree Claude Code 2.1.288 writes for a large or image tool result
    mkdirSync(tree, { recursive: true, mode: 0o755 });
    writeFileSync(`${tree}/mcp-image-1.png`, "png", { mode: 0o644 });
    writeFileSync(`${tree}/toolu_large.txt`, "private 50k tool result", { mode: 0o644 });
    extra?.();
  };
  const sweep = async () => {
    let cleaned = 0;
    const exec = { run: async (request: { command: string; args: string[]; cwd: string }) => {
      const script = request.args[2]!.replace("/home/box/.claude/projects/", `${root}/`);
      const done = spawnSync(request.command, [...request.args.slice(0, 2), script, ...request.args.slice(3)],
        { cwd: request.cwd, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 10_000 });
      if (done.status !== 0) throw new Error("BOX_EXEC_REMOTE_EXIT");
      return { stdout: done.stdout, stderrBytes: done.stderr.length, exitCode: 0 as const };
    } };
    // a recovered run's cleanup candidate: terminal proof present, no native pointer
    const row = { requestId: "box-ocv5-645", uid: 3n, accountId: 20n, runNonce: nonce, leaseEpoch: "b".repeat(32),
      proof: { runNonce: nonce, leaseEpoch: "b".repeat(32), keeperPid: 101, cliPid: 102,
        reason: "worker_complete", revision: 1 } };
    const worker = new BoxRemoteCleanupWorker({
      journal: { listRemoteCleanupCandidates: async () => [row], claimRemoteCleanup: async () => true,
        markRemoteCleaned: async () => { cleaned++; } },
      resolver: { resolve: async () => ({ accountId: 20n, exec, dispose: async () => {} }) },
    });
    const result: { cleaned: number; pending: number } = await worker.reconcileBatch();
    return { ...result, marked: cleaned };
  };
  try {
    stage();
    const first = await sweep();
    if (first.cleaned !== 1 || first.pending !== 0 || first.marked !== 1) {
      fail(`RUN_CLEANUP_TOOL_RESULTS_PENDING_${JSON.stringify(first)}`);
    }
    if (existsSync(`${project}/${sid}`) || existsSync(`${project}/${sid}.jsonl`)) fail("RUN_CLEANUP_TOOL_RESULTS_LEFT");
    // a sibling of tool-results or a folder inside it is not the CLI's: still refused, nothing removed
    for (const [name, extra] of [["SIBLING", () => mkdirSync(`${project}/${sid}/other`)],
      ["NESTED", () => mkdirSync(`${tree}/nested`)]] as const) {
      stage(extra);
      const refused = await sweep();
      if (refused.cleaned !== 0 || refused.pending !== 1 || refused.marked !== 0) {
        fail(`RUN_CLEANUP_${name}_NOT_REFUSED_${JSON.stringify(refused)}`);
      }
      if (!existsSync(`${tree}/mcp-image-1.png`) || !existsSync(`${project}/${sid}.jsonl`)) {
        fail(`RUN_CLEANUP_${name}_TOUCHED`);
      }
    }
  } finally {
    rmSync(run, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  return "[ocv5-645-run-cleanup-tool-results] PASS — a recovered run whose CLI wrote a session tool-results tree finishes its privacy cleanup instead of retrying it forever, and any other folder there stays refused";
}
