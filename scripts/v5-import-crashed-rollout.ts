#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { closePool, getPool } from "../packages/commercial/src/db/index.js";
import { importRolloutLiveFrames } from "../packages/commercial/src/db/liveTurnFrames.js";

type Json = Record<string, unknown>;

export interface ImportManifest {
  uid: string;
  sessionId: string;
  clientMessageId: string;
  dispatchId: string;
  attemptNo: number;
  resumeMapKey: string;
  threadId: string;
  rolloutPath: string;
  resumeMapPath: string;
  rolloutSha256: string;
  rolloutBytes: number;
  firstTimestamp: string;
  lastTimestamp: string;
  targetUserTimestamp: string;
  targetUserMessage: string;
  payloadCount: number;
  payloadSha256: string;
  requiredText: string;
  workspaceFiles?: Array<{ path: string; sha256: string }>;
}

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : null;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function stringsAtKnownTextFields(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) stringsAtKnownTextFields(item, out);
    return out;
  }
  const object = asObject(value);
  if (!object) return out;
  for (const [key, child] of Object.entries(object)) {
    if (
      typeof child === "string" &&
      (key === "text" || key === "message" || key === "output" || key === "arguments")
    ) {
      out.push(child);
    } else if (typeof child === "object" && child !== null) {
      stringsAtKnownTextFields(child, out);
    }
  }
  return out;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function translatedBlock(
  record: Json,
  ordinal: number,
  toolNames: Map<string, string>,
): Json | null {
  if (record.type !== "response_item") return null;
  const payload = asObject(record.payload);
  if (!payload || typeof payload.type !== "string") {
    throw new Error(`response_item ${ordinal} has no typed payload`);
  }
  const payloadType = payload.type;
  const id = typeof payload.call_id === "string"
    ? payload.call_id
    : typeof payload.id === "string"
      ? payload.id
      : `rollout-${ordinal}`;

  if (payloadType === "reasoning" || payloadType === "agent_reasoning") {
    const texts = stringsAtKnownTextFields(payload);
    return texts.length > 0 ? { kind: "thinking", text: texts.join("\n") } : null;
  }
  if (payloadType === "message") {
    if (payload.role !== "assistant") {
      throw new Error(`unexpected ${String(payload.role)} response message after target turn boundary`);
    }
    const texts = stringsAtKnownTextFields(payload);
    return texts.length > 0 ? { kind: "text", text: texts.join("\n") } : null;
  }
  if (payloadType === "function_call") {
    const toolName = typeof payload.name === "string"
      ? payload.name
      : typeof payload.tool === "string"
        ? payload.tool
        : payloadType;
    toolNames.set(id, toolName);
    return {
      kind: "tool_use",
      blockId: id,
      toolName,
      inputJson: parseMaybeJson(payload.arguments ?? payload.input ?? {}),
      partial: false,
    };
  }
  if (payloadType === "function_call_output") {
    const output = payload.output ?? payload.result ?? "";
    return {
      kind: "tool_result",
      blockId: `result-${id}`,
      toolUseBlockId: id,
      toolName: typeof payload.name === "string" ? payload.name : toolNames.get(id) ?? "tool",
      isError: payload.is_error === true || payload.isError === true,
      ...(typeof output === "string"
        ? { output }
        : { outputJson: output, output: JSON.stringify(output) }),
    };
  }
  throw new Error(`unsupported response_item payload type after target turn boundary: ${payloadType}`);
}

export function prepareRolloutImport(
  raw: Buffer,
  manifest: ImportManifest,
): { payloads: string[]; provenance: Record<string, unknown> } {
  if (raw.length !== manifest.rolloutBytes) {
    throw new Error(`rollout byte mismatch: ${raw.length} != ${manifest.rolloutBytes}`);
  }
  const digest = sha256(raw);
  if (digest !== manifest.rolloutSha256) {
    throw new Error(`rollout sha256 mismatch: ${digest}`);
  }
  const lines = raw.toString("utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const records = lines.map((line, index) => {
    const parsed = JSON.parse(line);
    const object = asObject(parsed);
    if (!object) throw new Error(`rollout line ${index + 1} is not an object`);
    return object;
  });
  const firstTimestamp = records[0]?.timestamp;
  const lastTimestamp = records[records.length - 1]?.timestamp;
  if (firstTimestamp !== manifest.firstTimestamp || lastTimestamp !== manifest.lastTimestamp) {
    throw new Error("rollout timestamp boundary mismatch");
  }

  if (!raw.toString("utf8").includes(manifest.requiredText)) {
    throw new Error("rollout required text is absent");
  }

  const targetBoundaries = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => {
      if (record.timestamp !== manifest.targetUserTimestamp || record.type !== "event_msg") return false;
      const payload = asObject(record.payload);
      return payload?.type === "user_message" && payload.message === manifest.targetUserMessage;
    });
  if (targetBoundaries.length !== 1) {
    throw new Error(`target user turn boundary count is ${targetBoundaries.length}, expected 1`);
  }
  const targetRecords = records.slice(targetBoundaries[0]!.index + 1);
  if (targetRecords.some((record) => {
    if (record.type !== "event_msg") return false;
    const payload = asObject(record.payload);
    return payload?.type === "user_message";
  })) {
    throw new Error("rollout contains a later user turn after the target boundary");
  }

  const payloads: string[] = [];
  const toolNames = new Map<string, string>();
  for (let index = 0; index < targetRecords.length; index++) {
    const block = translatedBlock(targetRecords[index]!, index + 1, toolNames);
    if (!block) continue;
    const timestamp = Date.parse(String(targetRecords[index]!.timestamp ?? ""));
    const importOrdinal = payloads.length + 1;
    payloads.push(JSON.stringify({
      type: "outbound.message",
      sessionKey: `rollout:${manifest.rolloutSha256}`,
      channel: "webchat",
      peer: { id: manifest.sessionId, kind: "dm" },
      clientMessageId: manifest.clientMessageId,
      blocks: [block],
      isFinal: false,
      ts: Number.isFinite(timestamp) ? timestamp : importOrdinal,
      durableSource: "rollout_import",
      importOrdinal,
    }));
  }
  if (payloads.length === 0) throw new Error("rollout contains no renderable records");
  if (payloads.length !== manifest.payloadCount) {
    throw new Error(`rollout payload count mismatch: ${payloads.length} != ${manifest.payloadCount}`);
  }
  const payloadSha256 = sha256(Buffer.from(payloads.join("\n"), "utf8"));
  if (payloadSha256 !== manifest.payloadSha256) {
    throw new Error(`translated payload sha256 mismatch: ${payloadSha256}`);
  }
  return {
    payloads,
    provenance: {
      resumeMapKey: manifest.resumeMapKey,
      threadId: manifest.threadId,
      rolloutFile: basename(manifest.rolloutPath),
      rolloutBytes: manifest.rolloutBytes,
      firstTimestamp: manifest.firstTimestamp,
      lastTimestamp: manifest.lastTimestamp,
      targetUserTimestamp: manifest.targetUserTimestamp,
      targetUserMessage: manifest.targetUserMessage,
      payloadCount: manifest.payloadCount,
      payloadSha256: manifest.payloadSha256,
      requiredText: manifest.requiredText,
      workspaceFiles: manifest.workspaceFiles ?? [],
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifestIndex = args.indexOf("--manifest");
  const apply = args.includes("--apply");
  if (manifestIndex < 0 || !args[manifestIndex + 1]) {
    throw new Error("usage: v5-import-crashed-rollout --manifest <json> [--apply]");
  }
  const manifest = JSON.parse(
    await readFile(args[manifestIndex + 1]!, "utf8"),
  ) as ImportManifest;
  if (!/^[1-9][0-9]*$/.test(manifest.uid)) throw new Error("invalid manifest uid");

  const [raw, resumeRaw] = await Promise.all([
    readFile(manifest.rolloutPath),
    readFile(manifest.resumeMapPath, "utf8"),
  ]);
  const resumeMap = asObject(JSON.parse(resumeRaw));
  const resumeEntry = resumeMap ? asObject(resumeMap[manifest.resumeMapKey]) : null;
  if (resumeEntry?.id !== manifest.threadId || resumeEntry.provider !== "codex") {
    throw new Error("resume-map does not bind the expected session key to thread id");
  }
  for (const file of manifest.workspaceFiles ?? []) {
    const bytes = await readFile(file.path);
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`workspace file sha256 mismatch: ${file.path}`);
    }
  }
  const prepared = prepareRolloutImport(raw, manifest);
  if (!apply) {
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun: true,
      rolloutSha256: manifest.rolloutSha256,
      payloadCount: prepared.payloads.length,
      provenance: prepared.provenance,
    }, null, 2) + "\n");
    return;
  }
  const result = await importRolloutLiveFrames(getPool(), {
    uid: BigInt(manifest.uid),
    sessionId: manifest.sessionId,
    clientMessageId: manifest.clientMessageId,
    dispatchId: manifest.dispatchId,
    attemptNo: manifest.attemptNo,
    rolloutSha256: manifest.rolloutSha256,
    provenance: prepared.provenance,
    payloads: prepared.payloads,
  });
  process.stdout.write(JSON.stringify({ ok: true, dryRun: false, ...result }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().finally(() => closePool()).catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
