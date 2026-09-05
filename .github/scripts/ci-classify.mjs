#!/usr/bin/env node
/**
 * Observe-only CI classifier (OCV5-119 / R8' phase 1).
 *
 * Never invents signatures: missing TAP / vitest FAIL / logs → "unknown".
 * Does not change publish gates. The workflow job that calls this is not a
 * required check.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_VERSION = 1;

export const INFRA_STEP_EXACT = new Set([
  "Install dependencies",
  "Setup Node",
  "Wait for test fixtures",
  "Wait for test fixture",
  "Checkout",
]);

export const INFRA_LOG_RE =
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|The runner has received a shutdown signal|No space left on device|docker: Error response/;

const SELF_JOB = "ci-classify";

export function isInfraStepName(name) {
  if (!name) return false;
  if (INFRA_STEP_EXACT.has(name)) return true;
  if (name.startsWith("Upload ")) return true;
  return false;
}

export function firstFailedStep(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const step of steps) {
    if (step?.conclusion === "failure") return String(step.name ?? "");
  }
  return null;
}

export function extractTapFirstNotOk(text) {
  if (!text) return null;
  const m = String(text).match(/^not ok \d+ - (.+)$/m);
  return m ? m[1].trim() : null;
}

export function extractVitestFirstFail(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const failFile = line.match(/^\s*FAIL\s+(\S+\.(?:test|spec)\.\w+)(?:\s+>\s+(.+))?/);
    if (failFile) {
      const file = failFile[1];
      const rest = (failFile[2] || "").trim();
      if (rest) return `${file}::${rest.replace(/\s+>\s+/g, "::")}`;
      return file;
    }
    const times = line.match(/^\s*[×x✘]\s+(.+?)\s+\d+(?:\.\d+)?m?s\s*$/);
    if (times) return times[1].trim();
  }
  return null;
}

export function collectTapFiles(artifactsDir) {
  const out = [];
  if (!artifactsDir || !existsSync(artifactsDir)) return out;
  const walk = (dir) => {
    let ents;
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = join(dir, ent);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && ent.endsWith(".tap")) out.push(p);
    }
  };
  walk(artifactsDir);
  return out;
}

export function tapTextForJob(jobName, artifactsDir) {
  const files = collectTapFiles(artifactsDir);
  if (files.length === 0) return null;
  const name = String(jobName || "");
  const shard = name.match(/commercial-integ \(([^)]+)\)/);
  if (shard) {
    const want = `commercial-integ-${shard[1]}.tap`;
    const hit = files.find((f) => basename(f) === want);
    if (hit) return readFileSync(hit, "utf8");
  }
  if (name.startsWith("commercial-unit")) {
    const hit = files.find((f) => basename(f) === "commercial-unit.tap");
    if (hit) return readFileSync(hit, "utf8");
  }
  return null;
}

export function logsForJob(jobName, logsText) {
  if (!logsText) return "";
  const text = String(logsText);
  const name = String(jobName || "");
  // gh run view --log-failed prefixes blocks with "JOB NAME\tSTEP NAME"
  const parts = text.split(/\n(?=\S[^\n]*\t)/);
  const chunks = [];
  for (const part of parts) {
    if (part.startsWith(name + "\t") || part.includes(`\n${name}\t`)) chunks.push(part);
    else if (part.split("\t", 1)[0] === name) chunks.push(part);
  }
  if (chunks.length > 0) return chunks.join("\n");
  if (text.includes(name)) return text;
  return "";
}

export function buildSignature(jobName, failedStep, tapText, logText) {
  const fromTap = extractTapFirstNotOk(tapText);
  const fromVitest = extractVitestFirstFail(logText) || extractVitestFirstFail(tapText);
  const detail = fromTap || fromVitest || "unknown";
  const step = failedStep || "unknown";
  return `${jobName}::${step}::${detail}`;
}

function isFailureConclusion(c) {
  return c === "failure" || c === "timed_out";
}

function isOkConclusion(c) {
  return c === "success" || c === "skipped" || c === "neutral" || c === "cancelled" || !c;
}

export function classifyJobs(jobs, opts = {}) {
  const artifactsDir = opts.artifactsDir || null;
  const logsText = opts.logsText || "";
  const rows = [];
  let anyNonInfraFail = false;
  let anyInfraFail = false;
  let anyFail = false;

  for (const job of jobs || []) {
    const name = String(job?.name || job?.id || "unknown");
    if (name === SELF_JOB) continue;
    const conclusion = job?.conclusion ?? "";
    const failedStep = isFailureConclusion(conclusion) ? firstFailedStep(job) : null;
    let signature = null;
    let infra = false;

    if (isFailureConclusion(conclusion)) {
      anyFail = true;
      const tapText = tapTextForJob(name, artifactsDir);
      const jobLogs = logsForJob(name, logsText);
      infra = isInfraStepName(failedStep) || INFRA_LOG_RE.test(jobLogs) || INFRA_LOG_RE.test(tapText || "");
      signature = buildSignature(name, failedStep, tapText, jobLogs);
      if (infra) anyInfraFail = true;
      else anyNonInfraFail = true;
    }

    rows.push({
      name,
      conclusion: conclusion || "unknown",
      failed_step: failedStep,
      signature,
    });
  }

  let klass = "passed";
  if (anyNonInfraFail) klass = "failed";
  else if (anyInfraFail || anyFail) klass = "infra-error";

  return { class: klass, jobs: rows };
}

export function classifyRun(input) {
  const runAttempt = Number(input.runAttempt || 1);
  const firstPass = runAttempt === 1;
  const classified = classifyJobs(input.jobs, {
    artifactsDir: input.artifactsDir,
    logsText: input.logsText || "",
  });
  const rerunGreen = !firstPass && classified.class === "passed";
  return {
    schemaVersion: SCHEMA_VERSION,
    sha: String(input.sha || ""),
    run_id: Number(input.runId || 0),
    run_attempt: runAttempt,
    event: String(input.event || ""),
    class: classified.class,
    first_pass: firstPass,
    rerun_green: rerunGreen,
    jobs: classified.jobs,
  };
}

export function renderSummary(result) {
  const lines = [
    `## CI classification (observe-only)`,
    ``,
    `- class: **${result.class}**`,
    `- first_pass: ${result.first_pass}`,
    `- rerun_green: ${result.rerun_green}`,
    `- sha: \`${result.sha}\``,
    `- run: ${result.run_id} attempt ${result.run_attempt} (${result.event})`,
    ``,
    `| Job | Conclusion | Failed step | Signature |`,
    `| --- | --- | --- | --- |`,
  ];
  for (const j of result.jobs) {
    const step = j.failed_step ? j.failed_step.replace(/\|/g, "\\|") : "";
    const sig = j.signature ? j.signature.replace(/\|/g, "\\|") : "";
    lines.push(`| ${j.name.replace(/\|/g, "\\|")} | ${j.conclusion} | ${step} | ${sig} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
    out[key] = val;
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.jobs || !args.out) {
    console.error("usage: ci-classify.mjs --jobs jobs.json --out ci-classification.json [--sha --run-id --run-attempt --event --artifacts-dir --logs --summary]");
    return 2;
  }
  const payload = JSON.parse(readFileSync(args.jobs, "utf8"));
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  let logsText = "";
  if (args.logs && existsSync(args.logs)) {
    try {
      logsText = readFileSync(args.logs, "utf8");
    } catch {
      logsText = "";
    }
  }
  const result = classifyRun({
    jobs,
    artifactsDir: args["artifacts-dir"] || null,
    logsText,
    sha: args.sha || "",
    runId: args["run-id"] || 0,
    runAttempt: args["run-attempt"] || 1,
    event: args.event || "",
  });
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  if (args.summary) {
    try {
      writeFileSync(args.summary, renderSummary(result), { flag: "a" });
    } catch (err) {
      console.error(`warning: could not write step summary: ${err.message}`);
    }
  }
  console.log(`ci-classify: class=${result.class} jobs=${result.jobs.length} first_pass=${result.first_pass} rerun_green=${result.rerun_green}`);
  return 0;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) process.exit(main());
