/**
 * 容器内科研 CLI(oc-lit / oc-cite / oc-ingest / oc-litrag)共享 master 调用层。
 *
 * 与 oc-market 同款薄 CLI 传输:读容器身份 bearer(OPENCLAUDE_V3_CONTAINER_TOKEN)
 * + master base(OPENCLAUDE_V3_MASTER_BASE_URL),POST master 的 /v3/research/*。
 * 平台 token/key 全留 master,容器只带自己的身份 bearer。
 */
import { readFileSync } from "node:fs";
import {
  CONNECTOR_NO_CONTAINER_TOKEN,
  CONNECTOR_NO_MASTER_BASE,
  ConnectorError,
  resolveConnectorEndpoint,
} from "./ocConnectorsClient.js";

function resolveResearchEndpoint(tool: string): {
  masterBaseUrl: string;
  containerToken: string;
} {
  try {
    return resolveConnectorEndpoint();
  } catch (err) {
    if (err instanceof ConnectorError) {
      if (err.code === CONNECTOR_NO_MASTER_BASE) {
        fail(tool, "not in a commercial container (no master base url)");
      }
      if (err.code === CONNECTOR_NO_CONTAINER_TOKEN) {
        fail(tool, "not in a commercial container (no container token)");
      }
    }
    throw err;
  }
}

export function fail(tool: string, msg: string, exitCode = 1): never {
  process.stderr.write(`${tool}: ${msg}\n`);
  process.exit(exitCode);
}

export const RESEARCH_WORKSPACE_FLAG = "OC_RESEARCH_WORKSPACE";
export const RESEARCH_PROJECT_ENV = "OC_RESEARCH_PROJECT";

export function isResearchWorkspaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[RESEARCH_WORKSPACE_FLAG] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function resolveCliResearchProjectId(
  flags: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromFlag = flags.project?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = env[RESEARCH_PROJECT_ENV]?.trim();
  return fromEnv || undefined;
}

/** 用户本机路径(macOS / Windows / 非 agent home),容器读不到。 */
export function looksLikeHostUserPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/Users/")) return true;
  if (/^[A-Za-z]:\//.test(normalized)) return true;
  if (normalized.startsWith("/Documents/")) return true;
  const home = normalized.match(/^\/home\/([^/]+)\//);
  if (home && home[1] !== "agent") return true;
  return false;
}

export const HOST_PATH_UPLOAD_HINT =
  "这是用户电脑上的路径，容器里读不到。请让用户在对话框上传文件或 zip（会落到 /home/agent/.openclaude/uploads/），或把文件拷到该目录后再 oc-ingest parse。";

const HELP_ARGS = new Set(["help", "--help", "-h"]);

/** Empty argv is not help — missing-arg probes still fail with usage on stderr. */
export function isCliHelpArg(arg: string | undefined): boolean {
  return !!arg && HELP_ARGS.has(arg);
}

/** Print usage to stdout and exit 0. Call before any network or heavy import work. */
export function exitWithCliHelp(usage: string): never {
  process.stdout.write(usage.endsWith("\n") ? usage : `${usage}\n`);
  process.exit(0);
}

export function readContainerToken(tool: string): string {
  const tok = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim();
  if (tok) return tok;
  const file = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      fail(tool, "container token file unreadable");
    }
  }
  fail(tool, "not in a commercial container (no container token)");
}

export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[(i += 1)] : "true";
      flags[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** POST /v3/research/<path> 并返回 JSON;非 2xx → fail。 */
export async function callResearch(tool: string, path: string, body: unknown): Promise<any> {
  const endpoint = resolveResearchEndpoint(tool);
  const url = `${endpoint.masterBaseUrl}/v3/research/${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.containerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const e = json?.error;
      fail(tool, `${res.status} ${e?.code ?? ""} ${e?.message ?? text}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function out(o: unknown): void {
  process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
}

/** 上传文件原始字节到 master /v3/research/blob,返回 { blobId, sha256, sizeBytes }。 */
export async function uploadBlob(tool: string, filePath: string): Promise<any> {
  if (looksLikeHostUserPath(filePath)) {
    fail(tool, HOST_PATH_UPLOAD_HINT, 2);
  }
  const endpoint = resolveResearchEndpoint(tool);
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    fail(tool, `cannot read file: ${filePath}`);
  }
  const mime = guessMime(filePath);
  const url = `${endpoint.masterBaseUrl}/v3/research/blob`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.containerToken}`,
        "content-type": mime,
      },
      // Buffer → Uint8Array(BodyInit/BufferSource);fetch 类型不直接收 Buffer
      body: new Uint8Array(bytes),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const e = json?.error;
      fail(tool, `${res.status} ${e?.code ?? ""} ${e?.message ?? text}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function guessMime(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "application/pdf";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "txt") return "text/plain";
  return "application/octet-stream";
}
