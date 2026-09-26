/** Small, privacy-safe pointer to a completed Claude native transcript.
 * The authenticated OpenClaude request remains history authority. The pointer
 * is valid only with its owner journal row and a fresh remote file hash check. */
export interface BoxNativePointer {
  readonly version: 1;
  readonly accountId: string;
  readonly upstreamModel: string;
  readonly cliVersion: "2.1.280";
  readonly nativeSessionId: string;
  /** The original private run cwd becomes the stable Claude project key. */
  readonly cliCwd: string;
  readonly transcriptSha256: string;
  readonly contextHashBeforeFinal: string;
  readonly assistantContentHash: string;
  readonly catalogHash: string | null;
  readonly expiresAtMs: number;
}

const HEX64 = /^[a-f0-9]{64}$/;
const CWD = /^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseBoxNativePointer(value: unknown, nowMs = Date.now()): BoxNativePointer | null {
  if (!Number.isFinite(nowMs)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== ["accountId", "assistantContentHash",
    "catalogHash", "cliCwd", "cliVersion", "contextHashBeforeFinal", "expiresAtMs",
    "nativeSessionId", "transcriptSha256", "upstreamModel", "version"].join(",")) return null;
  if (item.version !== 1 || item.cliVersion !== "2.1.280"
    || typeof item.accountId !== "string" || !/^[1-9][0-9]{0,18}$/.test(item.accountId)
    || typeof item.upstreamModel !== "string"
    || !/^claude-[a-z0-9-]{3,64}$/.test(item.upstreamModel)
    || typeof item.nativeSessionId !== "string" || !UUID.test(item.nativeSessionId)
    || typeof item.cliCwd !== "string" || !CWD.test(item.cliCwd)
    || typeof item.transcriptSha256 !== "string" || !HEX64.test(item.transcriptSha256)
    || typeof item.contextHashBeforeFinal !== "string" || !HEX64.test(item.contextHashBeforeFinal)
    || typeof item.assistantContentHash !== "string" || !HEX64.test(item.assistantContentHash)
    || item.catalogHash !== null && (typeof item.catalogHash !== "string"
      || !HEX64.test(item.catalogHash))
    || !Number.isSafeInteger(item.expiresAtMs)
    || Number(item.expiresAtMs) <= nowMs
    || Number(item.expiresAtMs) > nowMs + 30 * 24 * 60 * 60 * 1000) return null;
  return item as unknown as BoxNativePointer;
}

export function boxNativeTranscriptPath(pointer: BoxNativePointer): string {
  return `/home/box/.claude/projects/${pointer.cliCwd.replaceAll("/", "-")}/${pointer.nativeSessionId}.jsonl`;
}
