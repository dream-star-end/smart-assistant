#!/usr/bin/env node
/**
 * Artifact-backed extension for one already captured V5 synthetic A/B pair.
 *
 * The exact-pair authority remains v5-synthetic-eval-pair.mjs.  This wrapper
 * reconstructs one preregistered artifact from each arm's immutable workspace
 * capture, verifies its bytes, runs oc-artifact-qa, and keeps blinded renders.
 * It never connects to or mutates production.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregatePair } from "./v5-synthetic-eval-pair.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_QA = join(
  REPO_ROOT,
  "packages/commercial/agent-sandbox/platform-runtime/bin/oc-artifact-qa.py",
);
const SHA256_RE = /^[0-9a-f]{64}$/;
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ARTIFACT_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const KINDS = new Set(["pdf", "pptx", "xlsx"]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function normalizedAbsolute(value, label) {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || resolve(value) !== value
    || value.includes("\0")
  ) {
    fail(`${label} must be an absolute normalized path`);
  }
  return value;
}

function regularFile(path, label, { strict0600 = false } = {}) {
  normalizedAbsolute(path, label);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(path) !== path) {
    fail(`${label} must be a canonical regular file`);
  }
  if (
    stat.uid !== 0
    || (stat.mode & 0o022) !== 0
    || (strict0600 && (stat.mode & 0o777) !== 0o600)
  ) {
    fail(`${label} has unsafe mode`);
  }
}

function secureDirectory(path, label) {
  normalizedAbsolute(path, label);
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(path) !== path
    || stat.uid !== 0
    || (stat.mode & 0o777) !== 0o700
  ) {
    fail(`${label} must be a canonical root-owned directory with mode 0700`);
  }
}

function takeValue(args, index, option) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return args[index + 1];
}

export function parseArgs(args) {
  if (args.length === 0 || ["help", "-h", "--help"].includes(args[0])) {
    return { command: "help" };
  }
  const options = { command: "pair", apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--apply") {
      options.apply = true;
      continue;
    }
    const value = takeValue(args, index, option);
    index += 1;
    if (option === "--arm-a") options.armA = value;
    else if (option === "--arm-b") options.armB = value;
    else if (option === "--spec") options.spec = value;
    else if (option === "--artifact-dir") options.artifactDir = value;
    else if (option === "--output") options.output = value;
    else fail(`unknown option: ${option}`);
  }
  for (const [field, label] of [
    ["armA", "arm A evidence"],
    ["armB", "arm B evidence"],
    ["spec", "artifact spec"],
    ["artifactDir", "artifact directory"],
    ["output", "output"],
  ]) {
    options[field] = normalizedAbsolute(options[field], label);
  }
  if (options.armA === options.armB) fail("arm evidence paths must differ");
  if (options.output === options.armA || options.output === options.armB) {
    fail("output and arm evidence paths must differ");
  }
  return options;
}

export function parseArtifactSpec(value) {
  const spec = record(value, "artifact spec");
  if (spec.schemaVersion !== 1) fail("artifact spec schemaVersion must be 1");
  if (typeof spec.caseId !== "string" || !CASE_ID_RE.test(spec.caseId)) {
    fail("artifact spec caseId is invalid");
  }
  if (typeof spec.kind !== "string" || !KINDS.has(spec.kind)) {
    fail("artifact spec kind must be pdf, pptx or xlsx");
  }
  if (
    typeof spec.artifactPath !== "string"
    || !ARTIFACT_PATH_RE.test(spec.artifactPath)
    || spec.artifactPath.split("/").includes("..")
    || extname(spec.artifactPath).toLowerCase() !== `.${spec.kind}`
  ) {
    fail("artifact spec artifactPath is invalid or differs from kind");
  }
  const expect = spec.expect === undefined ? {} : record(spec.expect, "artifact spec expect");
  if (expect.kind !== undefined && expect.kind !== spec.kind) {
    fail("artifact spec expect.kind differs from kind");
  }
  return {
    schemaVersion: 1,
    caseId: spec.caseId,
    kind: spec.kind,
    artifactPath: spec.artifactPath,
    expect: { ...expect, kind: spec.kind },
  };
}

export function extractCapturedArtifact(documentValue, spec) {
  const document = record(documentValue, "workspace capture");
  if (!Array.isArray(document.entries)) fail("workspace capture entries must be an array");
  const matches = document.entries.filter(
    (entry) => entry && entry.type === "file" && entry.path === spec.artifactPath,
  );
  if (matches.length !== 1) {
    fail(`expected exactly one captured artifact at ${spec.artifactPath}, got ${matches.length}`);
  }
  const entry = matches[0];
  if (
    !Number.isSafeInteger(entry.bytes)
    || entry.bytes < 1
    || typeof entry.contentBase64 !== "string"
    || typeof entry.sha256 !== "string"
    || !SHA256_RE.test(entry.sha256)
  ) {
    fail("captured artifact entry shape is invalid");
  }
  const bytes = Buffer.from(entry.contentBase64, "base64");
  if (
    bytes.toString("base64") !== entry.contentBase64
    || bytes.length !== entry.bytes
    || sha256(bytes) !== entry.sha256
  ) {
    fail("captured artifact bytes differ from the capture manifest");
  }
  return { bytes, sha256: entry.sha256, relativePath: entry.path };
}

function readJson(path, label, options) {
  regularFile(path, label, options);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function capturedDocument(armEvidencePath, spec, arm) {
  const evidence = record(readJson(armEvidencePath, `${arm} evidence`, { strict0600: true }), `${arm} evidence`);
  const evaluationCase = record(evidence.evaluationCase, `${arm}.evaluationCase`);
  if (evaluationCase.id !== spec.caseId) {
    fail(`${arm} evaluation case differs from artifact spec`);
  }
  const workspaceArtifact = record(evidence.workspaceArtifact, `${arm}.workspaceArtifact`);
  const capturedPath = normalizedAbsolute(
    workspaceArtifact.capturedPath,
    `${arm}.workspaceArtifact.capturedPath`,
  );
  regularFile(capturedPath, `${arm} captured workspace`, { strict0600: true });
  const bytes = readFileSync(capturedPath);
  if (
    bytes.length !== workspaceArtifact.bytes
    || sha256(bytes) !== workspaceArtifact.sha256
  ) {
    fail(`${arm} captured workspace differs from arm evidence`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${arm} captured workspace is not valid JSON`);
  }
  return extractCapturedArtifact(document, spec);
}

function writeExclusive(path, bytes, mode = 0o600) {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

function runQa(artifact, spec, target) {
  mkdirSync(target, { mode: 0o700 });
  const extension = `.${spec.kind}`;
  const artifactPath = join(target, `artifact${extension}`);
  const expectPath = join(target, "expect.json");
  const qaDir = join(target, "qa");
  writeExclusive(artifactPath, artifact.bytes);
  writeExclusive(expectPath, Buffer.from(`${JSON.stringify(spec.expect, null, 2)}\n`));
  const qa = process.env.OC_ARTIFACT_QA_BIN || DEFAULT_QA;
  const argv = [
    qa,
    "inspect",
    "--input",
    artifactPath,
    "--out-dir",
    qaDir,
    "--expect",
    expectPath,
  ];
  const command = qa.endsWith(".py") ? process.env.PYTHON || "python3" : qa;
  const commandArgs = qa.endsWith(".py") ? argv : argv.slice(1);
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const reportPath = join(qaDir, "report.json");
  if (!existsSync(reportPath)) {
    fail(`artifact QA did not write report.json: ${result.stderr || result.stdout}`);
  }
  const report = readJson(reportPath, "artifact QA report");
  if (
    report.schemaVersion !== 1
    || report.input?.kind !== spec.kind
    || report.input?.sha256 !== artifact.sha256
    || typeof report.passed !== "boolean"
    || !Array.isArray(report.renderedPages)
    || !Array.isArray(report.contactSheets)
  ) {
    fail("artifact QA report identity differs from captured artifact");
  }
  if (!Number.isInteger(result.status) || report.passed !== (result.status === 0)) {
    fail("artifact QA exit status differs from report result");
  }
  return {
    sourceRelativePath: artifact.relativePath,
    sha256: artifact.sha256,
    bytes: artifact.bytes.length,
    qaExitCode: result.status,
    hardGatePassed: report.passed,
    reportPath,
    reportSha256: sha256(readFileSync(reportPath)),
    renderedPages: report.renderedPages,
    contactSheets: report.contactSheets,
    failureCount: Array.isArray(report.failures) ? report.failures.length : null,
    warningCount: Array.isArray(report.warnings) ? report.warnings.length : null,
  };
}

function blindLabels(pairIdentityHash, specSha) {
  const flip = Number.parseInt(sha256(Buffer.from(`${pairIdentityHash}:${specSha}`)).slice(0, 2), 16) % 2 === 1;
  return flip ? { A: "right", B: "left" } : { A: "left", B: "right" };
}

function dryRunSummary(result) {
  const { blindEvidenceDirectory: _ephemeralDirectory, arms, ...pair } = result;
  return {
    applied: false,
    evidencePersisted: false,
    ...pair,
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, arm]) => {
        const {
          reportPath: _ephemeralReport,
          renderedPages,
          contactSheets,
          ...summary
        } = arm;
        return [
          name,
          {
            ...summary,
            renderedPageCount: renderedPages.length,
            contactSheetCount: contactSheets.length,
          },
        ];
      }),
    ),
  };
}

export function usage() {
  return `Usage:
  node scripts/v5-document-artifact-pair.mjs \\
    --arm-a </secure/A.json> --arm-b </secure/B.json> \\
    --spec </case/artifact.json> --artifact-dir </new/render-dir> \\
    --output </new/result.json> [--apply]

The existing synthetic runner captures each arm immediately in a separate
workspace. This offline step verifies the captured bytes and renders blinded
left/right evidence. It never calls production.`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  regularFile(options.spec, "artifact spec", { strict0600: true });
  const specBytes = readFileSync(options.spec);
  const spec = parseArtifactSpec(JSON.parse(specBytes.toString("utf8")));
  const pair = aggregatePair(options.armA, options.armB);
  const artifacts = {
    A: capturedDocument(options.armA, spec, "A"),
    B: capturedDocument(options.armB, spec, "B"),
  };
  if (existsSync(options.artifactDir)) fail("artifact directory must not already exist");
  if (existsSync(options.output)) fail("output must not already exist");
  const parent = dirname(options.artifactDir);
  secureDirectory(parent, "artifact directory parent");
  secureDirectory(dirname(options.output), "output parent");
  const staging = options.apply
    ? `${options.artifactDir}.staging-${process.pid}`
    : mkdtempSync(join(tmpdir(), "oc-artifact-pair-"));
  if (existsSync(staging) && options.apply) fail("artifact staging directory already exists");
  if (options.apply) mkdirSync(staging, { mode: 0o700 });
  const specSha = sha256(specBytes);
  const labels = blindLabels(pair.pairIdentityHash, specSha);
  let result;
  try {
    const byArm = {};
    for (const arm of ["A", "B"]) {
      byArm[arm] = {
        blindLabel: labels[arm],
        ...runQa(artifacts[arm], spec, join(staging, labels[arm])),
      };
    }
    result = {
      schemaVersion: 1,
      validPair: true,
      pairIdentityHash: pair.pairIdentityHash,
      specSha256: specSha,
      caseId: spec.caseId,
      kind: spec.kind,
      artifactPath: spec.artifactPath,
      blindEvidenceDirectory: options.apply ? options.artifactDir : staging,
      arms: byArm,
      efficiencyRaw: pair.efficiencyRaw,
    };
    if (options.apply) {
      renameSync(staging, options.artifactDir);
      for (const arm of ["A", "B"]) {
        const label = result.arms[arm].blindLabel;
        const oldPrefix = join(staging, label);
        const newPrefix = join(options.artifactDir, label);
        result.arms[arm].reportPath = result.arms[arm].reportPath.replace(oldPrefix, newPrefix);
        result.arms[arm].renderedPages = result.arms[arm].renderedPages.map((path) => path.replace(oldPrefix, newPrefix));
        result.arms[arm].contactSheets = result.arms[arm].contactSheets.map((path) => path.replace(oldPrefix, newPrefix));
      }
      writeExclusive(options.output, Buffer.from(`${JSON.stringify(result, null, 2)}\n`));
      process.stdout.write(`${options.output}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(dryRunSummary(result))}\n`);
    }
  } finally {
    if (!options.apply) rmSync(staging, { recursive: true, force: true });
    else if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `v5-document-artifact-pair: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
