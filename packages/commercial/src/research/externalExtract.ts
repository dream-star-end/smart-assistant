/**
 * oc-ingest 外部 PDF 解析客户端(MinerU / Mistral OCR / 通用 HTTP endpoint)。
 *
 * 设计红线:
 *   - 仅处理 PDF 输入(普通 txt/md/html 走进程内 local 抽取,不增加外部网络开销)。
 *   - 受控超时(AbortController)、输入/响应字节上限(防 master OOM / 慢速连接耗尽资源)。
 *   - 惰性解密 API key(mineruApiKey / mistralApiKey),绝不进容器或日志。
 *   - 任何外部错误(超时 / 5xx / 4xx / 响应超限 / 空文本)结构化返回 NeedsOcr 信号,
 *     绝不未捕获上抛导致 ingest 崩溃,由调用方优雅回落 pdf-parse 并保留 needs_ocr 信号。
 */

import type { ResearchConfigPublic, ResearchSecrets } from "../admin/researchConfig.js";
import type { ExtractResult } from "./ingest.js";
import type { FetchLike } from "./sources.js";

export const DEFAULT_EXTERNAL_EXTRACT_TIMEOUT_MS = 30_000;
export const MAX_EXTERNAL_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_EXTERNAL_RESPONSE_BYTES = 10 * 1024 * 1024;

export type ExternalEngineName = "mineru" | "mistral";

export interface ExternalExtractOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxResponseBytes?: number;
  log?: (level: "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export type ExternalPdfExtractor = (
  bytes: Buffer,
  mime: string,
  engine: ExternalEngineName,
  filename?: string,
) => Promise<ExtractResult>;

/** 判断输入字节是否为真实 PDF(要求文件头前 1024 字节内含 %PDF- 魔数,防误命名 HTML/文本外发)。 */
export function isPdfLike(bytes: Buffer, _mime: string, _filename?: string): boolean {
  if (bytes.length < 5) return false;
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  return head.indexOf("%PDF-") !== -1;
}

function resolveConfiguredTarget(
  ingest: ResearchConfigPublic["config"]["ingest"],
  requestedEngine?: ExternalEngineName,
): { engine: ExternalEngineName; endpoint: string } | null {
  if (ingest.engine === "local") return null;
  const mineru = ingest.mineruEndpoint?.trim() || "";
  const mistral = ingest.mistralEndpoint?.trim() || "";

  if (ingest.engine === "mineru" || requestedEngine === "mineru") {
    if (mineru) return { engine: "mineru", endpoint: mineru };
    if (ingest.engine === "auto" && mistral) return { engine: "mistral", endpoint: mistral };
    return null;
  }
  if (ingest.engine === "mistral" || requestedEngine === "mistral") {
    if (mistral) return { engine: "mistral", endpoint: mistral };
    if (ingest.engine === "auto" && mineru) return { engine: "mineru", endpoint: mineru };
    return null;
  }
  if (mineru) return { engine: "mineru", endpoint: mineru };
  if (mistral) return { engine: "mistral", endpoint: mistral };
  return null;
}

async function cancelResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore cancel errors
  }
}

async function readBoundedResponseText(res: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(res);
    throw new Error("external_response_too_large");
  }
  if (!res.body) {
    const txt = await res.text();
    if (Buffer.byteLength(txt, "utf8") > maxBytes) {
      throw new Error("external_response_too_large");
    }
    return txt;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("external_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function parseMediaType(contentTypeHeader: string | null): string {
  return (contentTypeHeader ?? "").split(";")[0]!.trim().toLowerCase();
}

function isHtmlLikeDocument(text: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text);
}

function extractTextFromJsonPayload(payload: unknown): { text: string; title?: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined;

  // Mistral OCR format: { pages: [{ markdown: "..." }] }
  if (Array.isArray(obj.pages)) {
    const pageTexts = obj.pages
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const rec = p as Record<string, unknown>;
        if (typeof rec.markdown === "string") return rec.markdown.trim();
        if (typeof rec.text === "string") return rec.text.trim();
        return "";
      })
      .filter(Boolean);
    if (pageTexts.length > 0) {
      return { text: pageTexts.join("\n\n"), title };
    }
  }

  for (const key of ["markdown", "text", "content", "md_content"]) {
    if (typeof obj[key] === "string" && obj[key].trim()) {
      return { text: obj[key].trim(), title };
    }
  }

  // Nested MinerU / generic envelope: { data: { markdown | text | content | md_content } }
  if (obj.data && typeof obj.data === "object") {
    const nested = extractTextFromJsonPayload(obj.data);
    if (nested) return { text: nested.text, title: nested.title ?? title };
  }
  if (obj.result && typeof obj.result === "object") {
    const nested = extractTextFromJsonPayload(obj.result);
    if (nested) return { text: nested.text, title: nested.title ?? title };
  }
  return null;
}

/**
 * 按 research_config.ingest 构建外部 PDF 解析回调。
 * 未配置有效 endpoint 或 engine === 'local' 时返回 undefined(走纯本地 pdf-parse)。
 */
export function buildExternalPdfExtractor(
  cfg: ResearchConfigPublic,
  readSecrets: () => Promise<ResearchSecrets>,
  opts: ExternalExtractOptions = {},
): ExternalPdfExtractor | undefined {
  const initialTarget = resolveConfiguredTarget(cfg.config.ingest);
  if (!initialTarget) return undefined;

  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = Math.max(50, opts.timeoutMs ?? DEFAULT_EXTERNAL_EXTRACT_TIMEOUT_MS);
  const maxInputBytes = opts.maxInputBytes ?? MAX_EXTERNAL_PDF_BYTES;
  const maxResponseBytes = opts.maxResponseBytes ?? MAX_EXTERNAL_RESPONSE_BYTES;
  const log = opts.log ?? (() => {});

  return async (bytes, mime, requestedEngine, filename): Promise<ExtractResult> => {
    const target = resolveConfiguredTarget(cfg.config.ingest, requestedEngine) ?? initialTarget;
    if (!isPdfLike(bytes, mime, filename)) {
      return {
        needsOcr: true,
        reason: `external ${target.engine} skipped: non-pdf input`,
      };
    }
    if (bytes.length > maxInputBytes) {
      return {
        needsOcr: true,
        reason: `external ${target.engine} skipped: input exceeds ${maxInputBytes} bytes`,
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(target.endpoint);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return {
          needsOcr: true,
          reason: `external ${target.engine} endpoint protocol rejected`,
        };
      }
    } catch {
      return {
        needsOcr: true,
        reason: `external ${target.engine} endpoint invalid URL`,
      };
    }

    const secrets = await readSecrets().catch(() => ({} as ResearchSecrets));
    const apiKey = target.engine === "mistral" ? secrets.mistralApiKey : secrets.mineruApiKey;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      Accept: "application/json, text/plain;q=0.9",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const base64 = bytes.toString("base64");
    const requestPayload =
      target.engine === "mistral"
        ? {
            model: "mistral-ocr-latest",
            document: {
              type: "document_url",
              document_url: `data:application/pdf;base64,${base64}`,
            },
          }
        : {
            filename: filename || "document.pdf",
            mime: mime || "application/pdf",
            contentBase64: base64,
          };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(parsedUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        await cancelResponseBody(res);
        log("warn", "external_pdf_extract_http_error", {
          engine: target.engine,
          status: res.status,
        });
        return {
          needsOcr: true,
          reason: `external ${target.engine} HTTP ${res.status}`,
        };
      }
      const mediaType = parseMediaType(res.headers.get("content-type"));
      const isJsonType = mediaType === "application/json" || mediaType.endsWith("+json");
      const isPlainOrMdType =
        mediaType === "text/plain" || mediaType === "text/markdown" || mediaType === "text/x-markdown";
      if (mediaType !== "" && !isJsonType && !isPlainOrMdType) {
        await cancelResponseBody(res);
        log("warn", "external_pdf_extract_unsupported_content_type", {
          engine: target.engine,
          mediaType,
        });
        return {
          needsOcr: true,
          reason: `external ${target.engine} rejected unsupported content-type ${mediaType}`,
        };
      }
      const rawBody = await readBoundedResponseText(res, maxResponseBytes);
      let extracted: { text: string; title?: string } | null = null;
      if (isJsonType || mediaType === "") {
        try {
          extracted = extractTextFromJsonPayload(JSON.parse(rawBody));
        } catch {
          extracted = null;
        }
      } else if (isPlainOrMdType && rawBody.trim() && !isHtmlLikeDocument(rawBody)) {
        extracted = { text: rawBody.trim() };
      }
      if (!extracted || !extracted.text.trim()) {
        log("warn", "external_pdf_extract_empty", { engine: target.engine, mediaType });
        return {
          needsOcr: true,
          reason: `external ${target.engine} returned empty or invalid payload`,
        };
      }
      const heading = extracted.text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      return {
        text: extracted.text,
        title: extracted.title ?? heading,
      };
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") || ctrl.signal.aborted;
      const reason = isAbort
        ? `external ${target.engine} timeout after ${timeoutMs}ms`
        : err instanceof Error && err.message === "external_response_too_large"
          ? `external ${target.engine} response exceeds ${maxResponseBytes} bytes`
          : `external ${target.engine} request failed`;
      log("warn", "external_pdf_extract_failed", {
        engine: target.engine,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
      return { needsOcr: true, reason };
    } finally {
      clearTimeout(timer);
    }
  };
}
