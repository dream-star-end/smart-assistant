/**
 * codex 引擎内建 MCP 资源清单卡(list_mcp_resources / list_mcp_resource_templates)。
 *
 * 输出是 JSON:`{"resources":[...]}` 或 `{"resourceTemplates":[...]}`。空数组 → 友好空态
 * (不裸露 `{"resources":[]}`);非空 → 逐条资源行卡(name / uri / description)。
 * 解析失败返回 null,调用方回退 <OutputBlock>。
 */
import { Boxes } from "lucide-react";
import type { ReactNode } from "react";
import { asStr } from "./format";

interface McpResource {
  name: string;
  uri?: string;
  description?: string;
}
interface McpResourceParse {
  kind: "resources" | "templates";
  items: McpResource[];
}

function normalize(rows: unknown[]): McpResource[] {
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
    .map((r) => ({
      name: asStr(r.name) || asStr(r.title) || asStr(r.uri) || asStr(r.uriTemplate),
      uri: asStr(r.uri) || asStr(r.uriTemplate) || undefined,
      description: asStr(r.description) || undefined,
    }))
    .filter((r) => r.name || r.uri || r.description);
}

export function parseMcpResources(output?: string | null): McpResourceParse | null {
  const text = String(output || "").trim();
  if (!text || !/^[[{]/.test(text)) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.resources)) return { kind: "resources", items: normalize(obj.resources) };
  if (Array.isArray(obj.resourceTemplates)) return { kind: "templates", items: normalize(obj.resourceTemplates) };
  return null;
}

function ResourceRow({ item }: { item: McpResource }) {
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="break-words text-[13px] font-medium text-fg">{item.name}</div>
      {item.uri && <div className="mt-0.5 break-all font-mono text-[11.5px] text-faint">{item.uri}</div>}
      {item.description && <div className="mt-0.5 break-words text-[12px] text-muted">{item.description}</div>}
    </li>
  );
}

export function renderMcpResourcesCard(output?: string | null): ReactNode | null {
  const parse = parseMcpResources(output);
  if (!parse) return null;
  const emptyText = parse.kind === "templates" ? "没有可用的 MCP 资源模板" : "没有已注册的 MCP 资源";
  if (parse.items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-elevated px-3 py-4 text-center">
        <Boxes size={18} className="mx-auto text-faint" />
        <div className="mt-1 text-[13px] font-medium text-fg">{emptyText}</div>
      </div>
    );
  }
  return (
    <ul className="mt-1.5 flex flex-col gap-2">
      {parse.items.map((item, i) => (
        <ResourceRow key={`${i}-${item.name}`} item={item} />
      ))}
    </ul>
  );
}
