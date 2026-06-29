/**
 * 容器内科研 CLI(oc-lit / oc-cite / oc-ingest / oc-litrag)共享 master 调用层。
 *
 * 与 oc-market 同款薄 CLI 传输:读容器身份 bearer(OPENCLAUDE_V3_CONTAINER_TOKEN)
 * + master base(OPENCLAUDE_V3_MASTER_BASE_URL),POST master 的 /v3/research/*。
 * 平台 token/key 全留 master,容器只带自己的身份 bearer。
 */
import { readFileSync } from "node:fs";

export function fail(tool: string, msg: string): never {
  process.stderr.write(`${tool}: ${msg}\n`);
  process.exit(1);
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
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim();
  if (!base) fail(tool, "not in a commercial container (no master base url)");
  const token = readContainerToken(tool);
  const url = `${base.replace(/\/+$/, "")}/v3/research/${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
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
