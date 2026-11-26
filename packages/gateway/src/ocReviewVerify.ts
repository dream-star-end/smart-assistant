/**
 * oc-review 科学深审验证引擎与捕获-重捕(Chao1)残余风险门禁(OCV5-895)。
 *
 * 独立兄弟模块,避免 ocReviewCli.ts 行数膨胀,提供四类确定性安全能力:
 *   1. `inferModelFamily` / `resolveModelFamily`: 严格按权威 `reviewer.model` 归类独立模型家族,
 *      绝不因自填/未知 `model_family` 标签伪造跨家族覆盖;
 *   2. `computeFindingDigest` / `computeSafeScriptSha256` / `computeSafeFileSha256`: 完整证据与稿件版本
 *      强加密绑定(包含 file/model/location/severity/priority/category/issue/topic/evidence/new_evidence/repro_script/inputDigest);
 *   3. `verifyWitnessesInDir`: 默认安全采集不执行(`exec_disabled_by_default`);`--exec` 在无内核强制只读/断网
 *      沙箱执行器时 fail-closed 退回只采集(`sandbox_unavailable_collect_only`);仅显式 `--unsafe-local-exec`
 *      在当前用户容器内执行经审计本地脚本(临时目录 + 脱敏环境 + 非阻塞有界流读取 + 全路径进程组 SIGKILL 回收,
 *      明确不声称 OS 级文件系统/网络隔离),强制要求 `exit 0` + 携带匹配 `finding_digest` 的 `OC_WITNESS_VERDICT`;
 *   4. `computeScientificMetrics`: 按实际参与评审文件 1 票/家族计独立覆盖,基于 Union-Find(规范化主题/问题 + 相交锚点)
 *      合并跨评审同一缺陷,计算 Chao1 残余估计与科学深审四态闸门。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const VERIFICATION_STATUSES = ['confirmed', 'refuted', 'unverified'] as const
export type MachineVerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const EXECUTION_MODES = ['collect_only', 'unsafe_local_exec'] as const
export type VerificationExecutionMode = (typeof EXECUTION_MODES)[number]

export const SCIENTIFIC_GATE_STATUSES = [
  'PASS_READY',
  'FIX_REQUIRED',
  'INSUFFICIENT_COVERAGE',
  'RESIDUAL_RISK_HIGH',
] as const
export type ScientificGateStatus = (typeof SCIENTIFIC_GATE_STATUSES)[number]

export const SCIENTIFIC_RISK_CATEGORIES: ReadonlySet<string> = new Set([
  'math_physics',
  'code_data_mismatch',
  'consistency',
])

export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000
export const MIN_VERIFY_TIMEOUT_MS = 1_000
export const MAX_VERIFY_TIMEOUT_MS = 120_000
export const DEFAULT_BATCH_TIMEOUT_MS = 180_000
export const MIN_BATCH_TIMEOUT_MS = 5_000
export const MAX_BATCH_TIMEOUT_MS = 600_000
export const MAX_WITNESS_SCRIPT_BYTES = 512 * 1024
export const MAX_MANUSCRIPT_HASH_BYTES = 64 * 1024 * 1024
export const MAX_VERDICT_FILE_BYTES = 64 * 1024
export const VERIFY_MAX_BUFFER = 256 * 1024
export const MAX_OUTPUT_PREVIEW_CHARS = 500
export const WITNESS_VERDICT_PREFIX = 'OC_WITNESS_VERDICT:'
const ALLOWED_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.py', '.m'])
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/**
 * 同步子进程看门狗(用于 `--unsafe-local-exec`):
 *   - 以独立进程组(`start_new_session=True`)拉起目标解释器;
 *   - 使用 `selectors.DefaultSelector` + 非阻塞 FD 有界读取 stdout/stderr(内存严格 O(max_bytes),
 *     禁止 `proc.communicate()` 无限蓄水;总流超 4×max_bytes 立即终止返回 `output_limit`);
 *   - `finally` 在**所有退出路径**(正常退出/异常退出/超时/超流量)一律 `os.killpg(pgid, SIGKILL)` + `wait()`,
 *     防止正常退出后后台孙进程逃逸残留。
 */
const WATCHDOG_PY = `
import json, os, selectors, signal, subprocess, sys, time

timeout_s = float(sys.argv[1])
max_bytes = int(sys.argv[2])
max_drain = max_bytes * 4
cmd = sys.argv[3:]

try:
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
except FileNotFoundError:
    print(json.dumps({"kind": "enoent", "cmd": cmd[0]}))
    sys.exit(0)
except OSError as exc:
    print(json.dumps({"kind": "spawn_error", "error": str(exc)}))
    sys.exit(0)

out_buf = bytearray()
err_buf = bytearray()
out_trunc = False
err_trunc = False
total_seen = 0
timed_out = False
output_limit = False

sel = selectors.DefaultSelector()
try:
    for tag, stream in (("out", proc.stdout), ("err", proc.stderr)):
        if stream is not None:
            os.set_blocking(stream.fileno(), False)
            sel.register(stream, selectors.EVENT_READ, tag)
    deadline = time.monotonic() + timeout_s
    while sel.get_map() or proc.poll() is None:
        rem = deadline - time.monotonic()
        if rem <= 0:
            timed_out = True
            break
        if sel.get_map():
            events = sel.select(timeout=min(0.05, rem))
            for key, _ in events:
                stream = key.fileobj
                tag = key.data
                try:
                    chunk = os.read(stream.fileno(), 8192)
                except BlockingIOError:
                    continue
                except OSError:
                    chunk = b""
                if not chunk:
                    sel.unregister(stream)
                    try:
                        stream.close()
                    except Exception:
                        pass
                    continue
                total_seen += len(chunk)
                if tag == "out":
                    if len(out_buf) < max_bytes:
                        take = min(len(chunk), max_bytes - len(out_buf))
                        out_buf.extend(chunk[:take])
                        if take < len(chunk):
                            out_trunc = True
                    else:
                        out_trunc = True
                else:
                    if len(err_buf) < max_bytes:
                        take = min(len(chunk), max_bytes - len(err_buf))
                        err_buf.extend(chunk[:take])
                        if take < len(chunk):
                            err_trunc = True
                    else:
                        err_trunc = True
                if total_seen > max_drain:
                    output_limit = True
                    break
            if output_limit:
                break
        else:
            time.sleep(min(0.02, max(0.0, rem)))
finally:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        proc.wait(timeout=3)
    except Exception:
        pass
    try:
        for key in list(sel.get_map().values()):
            sel.unregister(key.fileobj)
            try:
                key.fileobj.close()
            except Exception:
                pass
        sel.close()
    except Exception:
        pass

if timed_out:
    kind = "timeout"
elif output_limit:
    kind = "output_limit"
else:
    kind = "exited"

print(json.dumps({
    "kind": kind,
    "returncode": proc.returncode,
    "stdout": bytes(out_buf).decode("utf-8", "replace"),
    "stderr": bytes(err_buf).decode("utf-8", "replace"),
    "stdout_truncated": out_trunc,
    "stderr_truncated": err_trunc,
}))
`.trim()

export function isMachineVerificationStatus(v: unknown): v is MachineVerificationStatus {
  return typeof v === 'string' && (VERIFICATION_STATUSES as readonly string[]).includes(v)
}

export function isVerificationExecutionMode(v: unknown): v is VerificationExecutionMode {
  return typeof v === 'string' && (EXECUTION_MODES as readonly string[]).includes(v)
}

/**
 * 探测当前运行环境是否存在内核强制只读输入/断网/进程树隔离沙箱执行器。
 * 当前非特权用户容器无 CAP_SYS_ADMIN / bwrap / userns 隔离能力,恒返回 false,
 * 保证 `--exec` 严格 fail-closed 退回只采集,绝不把普通进程执行伪装成隔离沙箱。
 */
export function hasEnforcedSandboxExecutor(): boolean {
  return false
}

/** 确定性归类模型家族(归一常见简写与大小写);未命中已知家族时退回归一小写 model slug。 */
export function inferModelFamily(model: string): string {
  const raw = model.trim().toLowerCase()
  if (!raw) return 'unknown'
  if (/cleanroom|sympy|octave|deterministic-verifier/.test(raw)) return 'cleanroom'
  if (/claude|anthropic/.test(raw)) return 'anthropic'
  if (/gemini|gemma|palm|google/.test(raw)) return 'google'
  if (/grok|xai|x-ai/.test(raw)) return 'xai'
  if (/deepseek/.test(raw)) return 'deepseek'
  if (/kimi|moonshot|(?:^|[-_/:])k\d+(?:\.\d+)?(?:$|[-_/:])/.test(raw)) return 'moonshot'
  if (/qwen|tongyi|qwq/.test(raw)) return 'qwen'
  if (/glm|zhipu|chatglm/.test(raw)) return 'zhipu'
  if (/minimax|abab/.test(raw)) return 'minimax'
  if (/stepfun|(?:^|[-_/:])step(?:$|[-_/:.\d])/.test(raw)) return 'step'
  if (/openai|codex|chatgpt|(?:^|[-_/:])gpt(?:$|[-_/:.\d])|(?:^|[-_/:])o[134](?:$|[-_/:.])/.test(raw)) {
    return 'openai'
  }
  return raw
}

/**
 * 权威解析评审员独立模型家族(B6):
 * 严格以可核实的实际来源 `reviewer.model` 为准,绝不因评审 JSON 自填的 `model_family`
 * (如冲突标签或自定义角色名 `review-team-B`)把同一模型拆成多个"独立家族"提升覆盖率。
 */
export function resolveModelFamily(model: string, _explicitFamily?: string): string {
  return inferModelFamily(model)
}

export type FindingDigestInput = {
  location: string
  severity: string
  issue: string
  priority?: string
  category?: string
  topic?: string
  evidence?: string
  new_evidence?: boolean
  repro_script?: string
}

/**
 * 确定性计算单条 finding 的强加密摘要(SHA-256 hex, B4):
 * 涵盖所有影响证据与裁决的字段(file/model/location/severity/priority/category/issue/topic/
 * evidence/new_evidence/repro_script)以及可选冻结稿件/输入版本 `inputDigest`,
 * 防止只改证据、升级 P2→P0、标记 new_evidence 或更新稿件版本时被旧 `refuted` 静默折叠。
 */
export function computeFindingDigest(
  fileName: string,
  reviewerModel: string,
  finding: FindingDigestInput,
  inputDigest?: string,
): string {
  const canonical = JSON.stringify({
    file: fileName,
    model: reviewerModel.trim(),
    location: finding.location,
    severity: finding.severity,
    priority: finding.priority ?? '',
    category: finding.category ?? '',
    issue: finding.issue,
    topic: finding.topic ?? '',
    evidence: finding.evidence ?? '',
    new_evidence: finding.new_evidence === true,
    repro_script: finding.repro_script ?? '',
    input_digest: inputDigest?.trim() ?? '',
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function normalizeDefectText(raw?: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function normalizeDefectIssue(raw?: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 64)
    .trim()
}

/** 为 Chao1 捕获矩阵生成每条 finding 的基础规范缺陷键(供单条标识及无 anchors 场景兼容)。 */
export function computeDefectIdentityKey(
  anchors: readonly string[],
  location: string,
  topic?: string,
  issue?: string,
): string {
  const primaryAnchor =
    anchors[0] ?? `raw:${location.trim().toLowerCase().replace(/\s+/g, ' ')}`
  const normTopic = normalizeDefectText(topic)
  if (normTopic !== '') {
    return `${primaryAnchor}::topic:${normTopic}`
  }
  const normIssue = normalizeDefectIssue(issue)
  if (normIssue !== '') {
    return `${primaryAnchor}::issue:${normIssue}`
  }
  return primaryAnchor
}

export type VerificationEntry = {
  file: string
  reviewer: string
  findingIndex: number
  findingDigest: string
  location: string
  reproScript: string
  scriptSha256?: string
  status: MachineVerificationStatus
  summary?: string
  exitCode: number | null
  outputPreview: string
  reason?: string
}

export type VerificationReport = {
  schemaVersion: 1
  scriptRoot: string
  executionMode?: VerificationExecutionMode
  inputDigest?: string
  entries: VerificationEntry[]
}

export type ParsedWitnessReview = {
  reviewer: { model: string }
  findings: Array<{
    location: string
    severity: string
    issue: string
    priority?: string
    category?: string
    topic?: string
    evidence?: string
    new_evidence?: boolean
    repro_script?: string
  }>
}

export type VerifyWitnessesOptions = {
  dir: string
  scriptRoot?: string
  /**
   * 仅在存在内核强制只读/断网沙箱执行器时启用执行;当前容器无此类执行器时 fail-closed 退回只采集
   * (`reason: 'sandbox_unavailable_collect_only'`),绝不伪装隔离。
   */
  exec?: boolean
  /**
   * 显式声明在当前用户容器直接执行经人工/净室审计的本地脚本(无内核文件系统/网络隔离,
   * 仅提供临时工作目录、脱敏环境、有界流读取与全路径进程组 SIGKILL 回收)。
   */
  unsafeLocalExec?: boolean
  /** 可选冻结稿件/数据输入版本摘要(SHA-256 或版本标签),纳入 findingDigest 绑定。 */
  inputDigest?: string
  timeoutMs?: number
  batchTimeoutMs?: number
  parseReview?: (text: string, filename: string) => ParsedWitnessReview
}

export class VerificationFormatError extends Error {}

function truncateOutput(raw: string, maxLen = MAX_OUTPUT_PREVIEW_CHARS): string {
  const cleaned = raw.trim()
  if (cleaned.length <= maxLen) return cleaned
  return `${cleaned.slice(0, maxLen - 3)}...`
}

function combineStreams(stdout?: string, stderr?: string): string {
  return truncateOutput([stdout?.trim() ?? '', stderr?.trim() ?? ''].filter(Boolean).join('\n'))
}

function isStrictlyInside(realRoot: string, targetPath: string): boolean {
  const rel = relative(realRoot, targetPath)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  return targetPath.startsWith(prefix)
}

function clampTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.min(MAX_VERIFY_TIMEOUT_MS, Math.max(MIN_VERIFY_TIMEOUT_MS, Math.round(timeoutMs)))
}

function clampBatchTimeoutMs(batchTimeoutMs?: number): number {
  if (batchTimeoutMs === undefined || !Number.isFinite(batchTimeoutMs)) return DEFAULT_BATCH_TIMEOUT_MS
  return Math.min(
    MAX_BATCH_TIMEOUT_MS,
    Math.max(MIN_BATCH_TIMEOUT_MS, Math.round(batchTimeoutMs)),
  )
}

function safeNonBlockingOpenFlags(): number {
  return (
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
    (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
  )
}

/** 有界读取普通文件 FD(防 FIFO 阻塞与超限文件耗尽内存)。 */
function readBoundedFd(fd: number, maxBytes: number): { ok: true; data: Buffer } | { ok: false; reason: string } {
  const chunks: Buffer[] = []
  let total = 0
  const buf = Buffer.allocUnsafe(16 * 1024)
  for (;;) {
    let n: number
    try {
      n = readSync(fd, buf, 0, buf.length, null)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        return { ok: false, reason: 'non_regular_or_blocking_file' }
      }
      throw err
    }
    if (n === 0) break
    total += n
    if (total > maxBytes) {
      return { ok: false, reason: `file exceeds max size (${maxBytes} bytes)` }
    }
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return { ok: true, data: Buffer.concat(chunks, total) }
}

/** 安全计算单个冻结输入文件(如待审稿件/代码归档)的 SHA-256(防 FIFO 阻塞与超限)。 */
export function computeSafeFileSha256(filePath: string, maxBytes = MAX_MANUSCRIPT_HASH_BYTES): string {
  const resolved = realpathSync(resolve(filePath))
  const lst = lstatSync(resolved)
  if (!lst.isFile()) {
    throw new Error(`input file is not a regular file: ${filePath}`)
  }
  if (lst.size > maxBytes) {
    throw new Error(`input file exceeds max hash size (${maxBytes} bytes): ${filePath}`)
  }
  let fd: number | null = null
  try {
    fd = openSync(resolved, safeNonBlockingOpenFlags())
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino) {
      throw new Error(`input file changed or is not a regular file: ${filePath}`)
    }
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      total += n
      if (total > maxBytes) {
        throw new Error(`input file exceeds max hash size (${maxBytes} bytes): ${filePath}`)
      }
      hash.update(buf.subarray(0, n))
    }
    return hash.digest('hex')
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

type SafeScriptReadResult =
  | { ok: true; ext: '.py' | '.m'; content: Buffer; scriptSha256: string }
  | { ok: false; reason: string }

/** 单次安全读取脚本字节(先 lstat + O_NOFOLLOW|O_NONBLOCK 防 FIFO 阻塞/TOCTOU/路径逃逸/符号链接/超限)。 */
function readSafeWitnessScript(realRoot: string, rawScript: string): SafeScriptReadResult {
  const trimmed = rawScript.trim()
  if (!trimmed || trimmed.includes('\0')) {
    return { ok: false, reason: 'repro_script must be a non-empty safe path' }
  }
  const candidate = resolve(realRoot, trimmed)
  if (!isStrictlyInside(realRoot, candidate)) {
    return { ok: false, reason: 'repro_script path escapes scriptRoot' }
  }
  const candExt = extname(candidate).toLowerCase()
  if (!ALLOWED_SCRIPT_EXTENSIONS.has(candExt)) {
    return {
      ok: false,
      reason: `unsupported script extension '${candExt || '(none)'}' (only .py and .m allowed)`,
    }
  }

  let realScript: string
  try {
    realScript = realpathSync(candidate)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      reason:
        code === 'ENOENT'
          ? 'repro_script not found'
          : `cannot resolve repro_script: ${(err as Error).message}`,
    }
  }

  if (!isStrictlyInside(realRoot, realScript)) {
    return { ok: false, reason: 'repro_script symlink escapes scriptRoot' }
  }
  const realExt = extname(realScript).toLowerCase()
  if (!ALLOWED_SCRIPT_EXTENSIONS.has(realExt)) {
    return {
      ok: false,
      reason: `resolved script extension '${realExt || '(none)'}' not allowed (only .py and .m allowed)`,
    }
  }

  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(realScript)
  } catch (err) {
    return { ok: false, reason: `cannot stat repro_script: ${(err as Error).message}` }
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { ok: false, reason: 'repro_script is not a regular file' }
  }
  if (lst.size > MAX_WITNESS_SCRIPT_BYTES) {
    return {
      ok: false,
      reason: `repro_script exceeds max size (${MAX_WITNESS_SCRIPT_BYTES} bytes)`,
    }
  }

  let fd: number | null = null
  try {
    fd = openSync(realScript, safeNonBlockingOpenFlags())
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== lst.dev || st.ino !== lst.ino) {
      return { ok: false, reason: 'repro_script is not a regular file' }
    }
    if (st.size > MAX_WITNESS_SCRIPT_BYTES) {
      return {
        ok: false,
        reason: `repro_script exceeds max size (${MAX_WITNESS_SCRIPT_BYTES} bytes)`,
      }
    }
    const bounded = readBoundedFd(fd, MAX_WITNESS_SCRIPT_BYTES)
    if (!bounded.ok) {
      return {
        ok: false,
        reason: bounded.reason.startsWith('file exceeds')
          ? `repro_script exceeds max size (${MAX_WITNESS_SCRIPT_BYTES} bytes)`
          : 'repro_script is not a regular file',
      }
    }
    const scriptSha256 = createHash('sha256').update(bounded.data).digest('hex')
    return { ok: true, ext: realExt as '.py' | '.m', content: bounded.data, scriptSha256 }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ELOOP') {
      return { ok: false, reason: 'repro_script symlink rejected on open' }
    }
    return { ok: false, reason: `cannot read repro_script: ${(err as Error).message}` }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** 校核实时磁盘脚本 SHA-256(供 collate 检测脚本在 verify 之后是否被修改或删除)。 */
export function computeSafeScriptSha256(scriptRoot: string, rawScript: string): string | null {
  let realRoot: string
  try {
    realRoot = realpathSync(resolve(scriptRoot))
    if (!statSync(realRoot).isDirectory()) return null
  } catch {
    return null
  }
  const res = readSafeWitnessScript(realRoot, rawScript)
  return res.ok ? res.scriptSha256 : null
}

type ParsedVerdictOutcome =
  | { ok: true; status: 'confirmed' | 'refuted'; summary: string }
  | { ok: false; reason: string }

/**
 * 严格解析结构化见证裁决(B3 + B4):
 * 必须提供合法 `status` (`confirmed` | `refuted`)、非空 `summary`,
 * 且**必填** `finding_digest` 并与当前 `expectedDigest` 严格相等!
 */
function parseStructuredVerdictJson(
  rawText: string,
  expectedDigest: string,
): ParsedVerdictOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return { ok: false, reason: 'invalid_witness_verdict_json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_witness_verdict_shape' }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.status !== 'confirmed' && obj.status !== 'refuted') {
    const got = typeof obj.status === 'string' ? obj.status : String(obj.status)
    return { ok: false, reason: `invalid_witness_verdict_status:${got}` }
  }
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    return { ok: false, reason: 'missing_witness_verdict_summary' }
  }
  if (typeof obj.finding_digest !== 'string' || obj.finding_digest.trim() === '') {
    return { ok: false, reason: 'missing_witness_verdict_digest' }
  }
  if (obj.finding_digest.trim() !== expectedDigest) {
    return { ok: false, reason: 'witness_verdict_digest_mismatch' }
  }
  return { ok: true, status: obj.status, summary: obj.summary.trim() }
}

function readVerdictFileSafe(verdictFile: string): { found: boolean; text?: string; reason?: string } {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(verdictFile)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return { found: false }
    return { found: true, reason: 'unreadable_witness_verdict_file' }
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { found: true, reason: 'invalid_witness_verdict_file_type' }
  }
  if (st.size > MAX_VERDICT_FILE_BYTES) {
    return { found: true, reason: 'witness_verdict_file_too_large' }
  }
  let fd: number | null = null
  try {
    fd = openSync(verdictFile, safeNonBlockingOpenFlags())
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
      return { found: true, reason: 'witness_verdict_file_changed' }
    }
    const bounded = readBoundedFd(fd, MAX_VERDICT_FILE_BYTES)
    if (!bounded.ok) {
      return { found: true, reason: 'witness_verdict_file_too_large' }
    }
    return { found: true, text: bounded.data.toString('utf8') }
  } catch {
    return { found: true, reason: 'unreadable_witness_verdict_file' }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function extractStdoutVerdictJson(stdout: string): string | null {
  let lastPayload: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith(WITNESS_VERDICT_PREFIX)) {
      lastPayload = trimmed.slice(WITNESS_VERDICT_PREFIX.length).trim()
    }
  }
  return lastPayload
}

type WatchdogResponse =
  | { kind: 'enoent'; cmd: string }
  | { kind: 'spawn_error'; error: string }
  | {
      kind: 'timeout' | 'output_limit' | 'exited'
      returncode: number | null
      stdout: string
      stderr: string
      stdout_truncated?: boolean
      stderr_truncated?: boolean
    }

type ScriptExecOutcome = {
  status: MachineVerificationStatus
  summary?: string
  exitCode: number | null
  outputPreview: string
  reason?: string
}

/**
 * 仅在显式 `--unsafe-local-exec` 下运行经审计本地脚本:
 * 提供临时工作目录、脱敏环境、有界流读取与全路径进程组 SIGKILL 回收;
 * 不提供也不声称内核级文件系统只读或断网沙箱隔离。
 */
function executeUnsafeLocalWitness(
  script: { ext: '.py' | '.m'; content: Buffer },
  findingDigest: string,
  timeoutMs: number,
  hitBatchBudgetOnTimeout: boolean,
): ScriptExecOutcome {
  const workDir = mkdtempSync(join(tmpdir(), 'oc-review-witness-'))
  try {
    const witnessPath = join(workDir, `witness${script.ext}`)
    writeFileSync(witnessPath, script.content)
    chmodSync(witnessPath, 0o444)
    const verdictFile = join(workDir, 'verdict.json')

    // 最小白名单脱敏环境:绝不继承调用方密钥/token/代理,亦不直读 process.env(防 R3-env)
    const sanitizedEnv: Record<string, string> = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: workDir,
      TMPDIR: workDir,
      LC_ALL: 'C.UTF-8',
      PYTHONDONTWRITEBYTECODE: '1',
      OC_WITNESS_VERDICT_FILE: verdictFile,
      OC_WITNESS_FINDING_DIGEST: findingDigest,
    }

    const targetCmd =
      script.ext === '.py'
        ? ['python3', '-B', witnessPath]
        : ['octave', '--no-gui', '--quiet', witnessPath]
    const timeoutSec = Math.max(0.1, timeoutMs / 1000).toFixed(3)

    let rawWatchdogOut: string
    try {
      rawWatchdogOut = execFileSync(
        'python3',
        ['-B', '-c', WATCHDOG_PY, timeoutSec, String(VERIFY_MAX_BUFFER), ...targetCmd],
        {
          cwd: workDir,
          env: sanitizedEnv,
          timeout: timeoutMs + 10_000,
          maxBuffer: VERIFY_MAX_BUFFER * 3,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        },
      )
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer }
      if (e.code === 'ENOENT') {
        return {
          status: 'unverified',
          exitCode: null,
          outputPreview: '',
          reason: 'interpreter not found: python3',
        }
      }
      const out = typeof e.stdout === 'string' ? e.stdout : Buffer.isBuffer(e.stdout) ? e.stdout.toString('utf8') : ''
      const errTxt = typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : ''
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: combineStreams(out, errTxt),
        reason: e.code === 'ETIMEDOUT' ? `execution timed out after ${timeoutMs}ms` : `watchdog failed: ${e.message}`,
      }
    }

    let wd: WatchdogResponse
    try {
      wd = JSON.parse(rawWatchdogOut.trim()) as WatchdogResponse
    } catch {
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: truncateOutput(rawWatchdogOut),
        reason: 'watchdog_protocol_error',
      }
    }

    if (wd.kind === 'enoent') {
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: '',
        reason: `interpreter not found: ${wd.cmd}`,
      }
    }
    if (wd.kind === 'spawn_error') {
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: '',
        reason: `spawn_error: ${wd.error}`,
      }
    }
    if (wd.kind === 'timeout') {
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: combineStreams(wd.stdout, wd.stderr),
        reason: hitBatchBudgetOnTimeout
          ? 'batch_timeout_exceeded'
          : `execution timed out after ${timeoutMs}ms`,
      }
    }
    if (wd.kind === 'output_limit') {
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: combineStreams(wd.stdout, wd.stderr),
        reason: 'output_limit_exceeded',
      }
    }

    const preview = combineStreams(wd.stdout, wd.stderr)
    if (wd.returncode === null || wd.returncode < 0) {
      return {
        status: 'unverified',
        exitCode: null,
        outputPreview: preview,
        reason: wd.returncode !== null ? `terminated_by_signal_${-wd.returncode}` : 'unknown_termination',
      }
    }
    // B3 核心红线:任何非零退出码(ImportError/SyntaxError/AssertionError/exit 1)一律保持 unverified,绝不判 refuted!
    if (wd.returncode !== 0) {
      return {
        status: 'unverified',
        exitCode: wd.returncode,
        outputPreview: preview,
        reason: `script_error_exit_${wd.returncode}`,
      }
    }

    // exitCode === 0: 优先解析 OC_WITNESS_VERDICT_FILE(必含匹配 finding_digest)
    const fileRes = readVerdictFileSafe(verdictFile)
    if (fileRes.found) {
      if (fileRes.reason !== undefined || fileRes.text === undefined) {
        return {
          status: 'unverified',
          exitCode: 0,
          outputPreview: preview,
          reason: fileRes.reason ?? 'unreadable_witness_verdict_file',
        }
      }
      const parsed = parseStructuredVerdictJson(fileRes.text, findingDigest)
      if (!parsed.ok) {
        return {
          status: 'unverified',
          exitCode: 0,
          outputPreview: preview,
          reason: parsed.reason,
        }
      }
      return {
        status: parsed.status,
        summary: parsed.summary,
        exitCode: 0,
        outputPreview: preview || truncateOutput(parsed.summary),
      }
    }

    // stdout 回退通道:若 stdout 发生截断则拒绝把前缀里的伪造/过期标记当成最终裁决(B3)
    if (wd.stdout_truncated === true) {
      return {
        status: 'unverified',
        exitCode: 0,
        outputPreview: preview,
        reason: 'stdout_truncated_untrusted_verdict',
      }
    }
    const stdoutJson = extractStdoutVerdictJson(wd.stdout)
    if (stdoutJson === null) {
      return {
        status: 'unverified',
        exitCode: 0,
        outputPreview: preview,
        reason: 'missing_witness_verdict',
      }
    }
    const parsed = parseStructuredVerdictJson(stdoutJson, findingDigest)
    if (!parsed.ok) {
      return {
        status: 'unverified',
        exitCode: 0,
        outputPreview: preview,
        reason: parsed.reason,
      }
    }
    return {
      status: parsed.status,
      summary: parsed.summary,
      exitCode: 0,
      outputPreview: preview || truncateOutput(parsed.summary),
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function defaultParseWitnessReview(text: string): ParsedWitnessReview | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.reviewer !== 'object' || obj.reviewer === null || Array.isArray(obj.reviewer)) {
    return null
  }
  const rev = obj.reviewer as Record<string, unknown>
  if (typeof rev.model !== 'string' || rev.model.trim() === '' || !Array.isArray(obj.findings)) {
    return null
  }
  const findings: ParsedWitnessReview['findings'] = []
  for (const item of obj.findings) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const f = item as Record<string, unknown>
    if (
      typeof f.location !== 'string' ||
      f.location.trim() === '' ||
      typeof f.severity !== 'string' ||
      typeof f.issue !== 'string' ||
      f.issue.trim() === ''
    ) {
      return null
    }
    if (f.priority !== undefined && typeof f.priority !== 'string') return null
    if (f.category !== undefined && typeof f.category !== 'string') return null
    if (f.topic !== undefined && typeof f.topic !== 'string') return null
    if (f.evidence !== undefined && typeof f.evidence !== 'string') return null
    if (f.new_evidence !== undefined && typeof f.new_evidence !== 'boolean') return null
    if (f.repro_script !== undefined && typeof f.repro_script !== 'string') return null
    const parsed: ParsedWitnessReview['findings'][number] = {
      location: f.location,
      severity: f.severity,
      issue: f.issue,
    }
    if (f.priority !== undefined) parsed.priority = f.priority
    if (f.category !== undefined) parsed.category = f.category
    if (f.topic !== undefined) parsed.topic = f.topic
    if (f.evidence !== undefined) parsed.evidence = f.evidence
    if (f.new_evidence !== undefined) parsed.new_evidence = f.new_evidence
    if (f.repro_script !== undefined) parsed.repro_script = f.repro_script
    findings.push(parsed)
  }
  return { reviewer: { model: rev.model.trim() }, findings }
}

/**
 * 扫描 `<dir>/reviews-*.json` 中的结构化 `repro_script`:
 *   - 默认(无 `--unsafe-local-exec`): 安全只采集,计算 `findingDigest` 与 `scriptSha256`,绝不执行外部脚本;
 *   - 传 `--exec` 但环境无内核强制只读/断网沙箱执行器: fail-closed 退回只采集(`sandbox_unavailable_collect_only`);
 *   - 仅显式 `unsafeLocalExec === true`: 执行经人工/净室审计的本地 `.py`/`.m` 脚本,强制 `exit 0` +
 *     携带匹配 `finding_digest` 的 `OC_WITNESS_VERDICT`。
 */
export function verifyWitnessesInDir(opts: VerifyWitnessesOptions): VerificationReport {
  const dir = resolve(opts.dir)
  const rawRoot = resolve(opts.scriptRoot ?? opts.dir)
  const realRoot = realpathSync(rawRoot)
  if (!statSync(realRoot).isDirectory()) {
    throw new Error(`scriptRoot is not a directory: ${rawRoot}`)
  }
  const sandboxAvailable = hasEnforcedSandboxExecutor()
  const runUnsafeLocal = opts.unsafeLocalExec === true
  const execRequestedWithoutSandbox = opts.exec === true && !runUnsafeLocal && !sandboxAvailable
  const executionMode: VerificationExecutionMode = runUnsafeLocal
    ? 'unsafe_local_exec'
    : 'collect_only'
  const inputDigest = opts.inputDigest?.trim() || undefined
  const timeoutMs = clampTimeoutMs(opts.timeoutMs)
  const batchTimeoutMs = clampBatchTimeoutMs(opts.batchTimeoutMs)
  const batchDeadline = Date.now() + batchTimeoutMs

  const names = readdirSync(dir)
    .filter((n) => /^reviews-.*\.json$/.test(n))
    .sort()

  const entries: VerificationEntry[] = []
  for (const name of names) {
    let text: string
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    let parsed: ParsedWitnessReview | null = null
    if (opts.parseReview) {
      try {
        parsed = opts.parseReview(text, name)
      } catch {
        continue
      }
    } else {
      parsed = defaultParseWitnessReview(text)
    }
    if (!parsed) continue

    for (let i = 0; i < parsed.findings.length; i++) {
      const f = parsed.findings[i]!
      if (f.repro_script === undefined) continue
      const findingDigest = computeFindingDigest(name, parsed.reviewer.model, f, inputDigest)

      // 批截止时间在读取脚本前即生效,覆盖采集与执行全过程
      const remainingBatchMs = batchDeadline - Date.now()
      if (remainingBatchMs <= 0) {
        entries.push({
          file: name,
          reviewer: parsed.reviewer.model,
          findingIndex: i,
          findingDigest,
          location: f.location,
          reproScript: f.repro_script,
          status: 'unverified',
          exitCode: null,
          outputPreview: '',
          reason: 'batch_timeout_exceeded',
        })
        continue
      }

      const safeRead = readSafeWitnessScript(realRoot, f.repro_script)
      if (!safeRead.ok) {
        entries.push({
          file: name,
          reviewer: parsed.reviewer.model,
          findingIndex: i,
          findingDigest,
          location: f.location,
          reproScript: f.repro_script,
          status: 'unverified',
          exitCode: null,
          outputPreview: '',
          reason: safeRead.reason,
        })
        continue
      }

      if (!runUnsafeLocal) {
        entries.push({
          file: name,
          reviewer: parsed.reviewer.model,
          findingIndex: i,
          findingDigest,
          location: f.location,
          reproScript: f.repro_script,
          scriptSha256: safeRead.scriptSha256,
          status: 'unverified',
          exitCode: null,
          outputPreview: '',
          reason: execRequestedWithoutSandbox
            ? 'sandbox_unavailable_collect_only'
            : 'exec_disabled_by_default',
        })
        continue
      }

      const afterReadRem = batchDeadline - Date.now()
      if (afterReadRem <= 0) {
        entries.push({
          file: name,
          reviewer: parsed.reviewer.model,
          findingIndex: i,
          findingDigest,
          location: f.location,
          reproScript: f.repro_script,
          scriptSha256: safeRead.scriptSha256,
          status: 'unverified',
          exitCode: null,
          outputPreview: '',
          reason: 'batch_timeout_exceeded',
        })
        continue
      }

      const effectiveTimeoutMs = Math.min(timeoutMs, afterReadRem)
      const hitBatchBudgetOnTimeout = afterReadRem < timeoutMs
      const outcome = executeUnsafeLocalWitness(
        safeRead,
        findingDigest,
        effectiveTimeoutMs,
        hitBatchBudgetOnTimeout,
      )
      const entry: VerificationEntry = {
        file: name,
        reviewer: parsed.reviewer.model,
        findingIndex: i,
        findingDigest,
        location: f.location,
        reproScript: f.repro_script,
        scriptSha256: safeRead.scriptSha256,
        status: outcome.status,
        exitCode: outcome.exitCode,
        outputPreview: outcome.outputPreview,
      }
      if (outcome.summary !== undefined) entry.summary = outcome.summary
      if (outcome.reason !== undefined) entry.reason = outcome.reason
      entries.push(entry)
    }
  }

  entries.sort((a, b) => a.file.localeCompare(b.file) || a.findingIndex - b.findingIndex)
  const report: VerificationReport = { schemaVersion: 1, scriptRoot: realRoot, executionMode, entries }
  if (inputDigest !== undefined) report.inputDigest = inputDigest
  return report
}

/** 严格校验 `verification-report.json`(fail-loud,强校验 findingDigest 与 scriptSha256 64-hex)。 */
export function parseVerificationReport(text: string, label: string): VerificationReport {
  function bad(msg: string): never {
    throw new VerificationFormatError(`${label}: ${msg}`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    bad('invalid JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    bad('verification report top-level must be an object')
  }
  const obj = data as Record<string, unknown>
  if (obj.schemaVersion !== 1) {
    bad('verification report schemaVersion must be 1')
  }
  if (typeof obj.scriptRoot !== 'string' || obj.scriptRoot.trim() === '') {
    bad('verification report scriptRoot must be a non-empty string')
  }
  if (obj.executionMode !== undefined && !isVerificationExecutionMode(obj.executionMode)) {
    bad(`verification report executionMode must be one of ${EXECUTION_MODES.join('|')}`)
  }
  if (obj.inputDigest !== undefined && (typeof obj.inputDigest !== 'string' || obj.inputDigest.trim() === '')) {
    bad('verification report inputDigest must be a non-empty string when present')
  }
  if (!Array.isArray(obj.entries)) {
    bad('verification report entries must be an array')
  }
  const entries: VerificationEntry[] = obj.entries.map((raw, i) => {
    const where = `entries[${i}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      bad(`${where} must be an object`)
    }
    const e = raw as Record<string, unknown>
    if (typeof e.file !== 'string' || e.file.trim() === '') {
      bad(`${where}.file must be a non-empty string`)
    }
    if (typeof e.reviewer !== 'string' || e.reviewer.trim() === '') {
      bad(`${where}.reviewer must be a non-empty string`)
    }
    if (typeof e.findingIndex !== 'number' || !Number.isInteger(e.findingIndex) || e.findingIndex < 0) {
      bad(`${where}.findingIndex must be a non-negative integer`)
    }
    if (typeof e.findingDigest !== 'string' || !SHA256_HEX_RE.test(e.findingDigest)) {
      bad(`${where}.findingDigest must be a 64-char lowercase hex sha256`)
    }
    if (typeof e.location !== 'string' || e.location.trim() === '') {
      bad(`${where}.location must be a non-empty string`)
    }
    if (typeof e.reproScript !== 'string') {
      bad(`${where}.reproScript must be a string`)
    }
    if (e.scriptSha256 !== undefined && (typeof e.scriptSha256 !== 'string' || !SHA256_HEX_RE.test(e.scriptSha256))) {
      bad(`${where}.scriptSha256 must be a 64-char lowercase hex sha256 when present`)
    }
    if (!isMachineVerificationStatus(e.status)) {
      bad(`${where}.status must be one of ${VERIFICATION_STATUSES.join('|')}`)
    }
    if (e.summary !== undefined && typeof e.summary !== 'string') {
      bad(`${where}.summary must be a string when present`)
    }
    if (e.exitCode !== null && (typeof e.exitCode !== 'number' || !Number.isInteger(e.exitCode))) {
      bad(`${where}.exitCode must be an integer or null`)
    }
    if (typeof e.outputPreview !== 'string') {
      bad(`${where}.outputPreview must be a string`)
    }
    if (e.reason !== undefined && typeof e.reason !== 'string') {
      bad(`${where}.reason must be a string when present`)
    }
    const entry: VerificationEntry = {
      file: e.file,
      reviewer: e.reviewer,
      findingIndex: e.findingIndex,
      findingDigest: e.findingDigest,
      location: e.location,
      reproScript: e.reproScript,
      status: e.status,
      exitCode: e.exitCode,
      outputPreview: e.outputPreview,
    }
    if (e.scriptSha256 !== undefined) entry.scriptSha256 = e.scriptSha256
    if (e.summary !== undefined) entry.summary = e.summary
    if (e.reason !== undefined) entry.reason = e.reason
    return entry
  })

  entries.sort((a, b) => a.file.localeCompare(b.file) || a.findingIndex - b.findingIndex)
  const report: VerificationReport = { schemaVersion: 1, scriptRoot: obj.scriptRoot, entries }
  if (obj.executionMode !== undefined) report.executionMode = obj.executionMode
  if (typeof obj.inputDigest === 'string') report.inputDigest = obj.inputDigest.trim()
  return report
}

export function formatVerifySummaryLine(report: VerificationReport): string {
  let confirmed = 0
  let refuted = 0
  let unverified = 0
  for (const e of report.entries) {
    if (e.status === 'confirmed') confirmed += 1
    else if (e.status === 'refuted') refuted += 1
    else unverified += 1
  }
  return `VERIFY: confirmed=${confirmed} refuted=${refuted} unverified=${unverified}`
}

export type ScientificMetricsReviewInput = {
  reviewer: { model: string; model_family?: string }
}

export type ScientificMetricsActiveFinding = {
  reviewer: string
  /** 权威模型家族(由 `reviewer.model` 归类,绝不使用 finding 或 reviewer 自报未知标签)。 */
  modelFamily: string
  /** 基础缺陷身份键(兼容直接传入 defectKey 的调用)。 */
  defectKey: string
  /** 该 finding 解析出的全部位置锚点集合(用于跨评审相交锚点 + 主题/问题等价合并)。 */
  anchors?: readonly string[]
  /** 规范化显式 topic(空串表示未提供)。 */
  normalizedTopic?: string
  /** 规范化 issue 摘要(无显式 topic 时的相交锚点匹配依据)。 */
  normalizedIssue?: string
  resolvedPriority: 'P0' | 'P1' | 'P2'
  category?: string
  /** 仅取经加密绑定的权威 `--verification` 状态(绝不使用作者自填字段)。 */
  verifiedByMachine?: MachineVerificationStatus
}

export type ScientificMetricsRefutedFinding = {
  resolvedPriority: 'P0' | 'P1' | 'P2'
}

export type ComputeScientificMetricsInput = {
  files: ScientificMetricsReviewInput[]
  activeFindings: ScientificMetricsActiveFinding[]
  machineRefuted: ScientificMetricsRefutedFinding[]
  minFamilies?: number
  maxResidual?: number
}

export type ScientificMetrics = {
  distinctFamilies: string[]
  familyCount: number
  minFamilies: number
  f1: number
  f2: number
  observedDefectBuckets: number
  chao1Residual: number
  maxResidual: number
  confirmedP0: number
  refutedP0: number
  unverifiedP0: number
  totalMachineRefuted: number
  scientificGateStatus: ScientificGateStatus
}

function anchorsIntersect(a?: readonly string[], b?: readonly string[]): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false
  for (const x of a) {
    if (b.includes(x)) return true
  }
  return false
}

/**
 * 判断两条高危 finding 是否指代同一缺陷(B6 跨评审等价消歧):
 *   1. `defectKey` 完全相等 → 合并;
 *   2. 锚点集合相交(如 `Fig. 4` 与 `Fig. 4 / §2` 共享 `fig:4`)且:
 *      - 双方均提供非空 `normalizedTopic`: 仅当 topic 严格相等才合并(保同节异 topic 独立计数);
 *      - 至少一方未提供 `normalizedTopic`: 当双方 `normalizedIssue` 非空且相等时合并。
 */
function isSameScientificDefect(
  a: ScientificMetricsActiveFinding,
  b: ScientificMetricsActiveFinding,
): boolean {
  if (a.defectKey === b.defectKey) return true
  if (!anchorsIntersect(a.anchors, b.anchors)) return false
  const topicA = a.normalizedTopic ?? ''
  const topicB = b.normalizedTopic ?? ''
  if (topicA !== '' && topicB !== '') {
    return topicA === topicB
  }
  const issueA = a.normalizedIssue ?? ''
  const issueB = b.normalizedIssue ?? ''
  return issueA !== '' && issueA === issueB
}

/**
 * 捕获-重捕(Chao1)残余 P0 风险估算与科学深审四态闸门:
 *   - `distinctFamilies` 仅按实际参与评审的 `ReviewFile` 集合的 `reviewer.model` 1 票/文件归类(B6);
 *   - Chao1 缺陷矩阵按 Union-Find 合并跨评审等价缺陷(规范化主题/问题 + 相交锚点),
 *     避免一方补写章节号(如 `Fig. 4` → `Fig. 4 / §2`)把双家族重合拆成两个 f1 桶;
 *   - `FIX_REQUIRED`: `confirmedP0 > 0 || unverifiedP0 > 0`;
 *   - `INSUFFICIENT_COVERAGE`: 活跃 P0=0 但 `familyCount < minFamilies`(默认 2);
 *   - `RESIDUAL_RISK_HIGH`: 活跃 P0=0 且家族达标,但 `chao1Residual >= maxResidual`(默认 0.5);
 *   - `PASS_READY`: 全部满足。
 */
export function computeScientificMetrics(input: ComputeScientificMetricsInput): ScientificMetrics {
  const minFamilies =
    input.minFamilies !== undefined && Number.isInteger(input.minFamilies) && input.minFamilies >= 1
      ? input.minFamilies
      : 2
  const maxResidual =
    input.maxResidual !== undefined && Number.isFinite(input.maxResidual) && input.maxResidual >= 0
      ? input.maxResidual
      : 0.5

  // B6: 独立家族严格只由实际参与评审的 ReviewFile.reviewer.model 决定,忽略自报 model_family
  const familySet = new Set<string>()
  for (const file of input.files) {
    familySet.add(resolveModelFamily(file.reviewer.model))
  }

  const distinctFamilies = [...familySet].sort()
  const familyCount = distinctFamilies.length

  let confirmedP0 = 0
  let unverifiedP0 = 0
  const highRisk: ScientificMetricsActiveFinding[] = []

  for (const af of input.activeFindings) {
    if (af.resolvedPriority === 'P0') {
      if (af.verifiedByMachine === 'confirmed') confirmedP0 += 1
      else unverifiedP0 += 1
    }
    const isHighRisk =
      af.resolvedPriority === 'P0' ||
      (af.category !== undefined && SCIENTIFIC_RISK_CATEGORIES.has(af.category))
    if (isHighRisk) highRisk.push(af)
  }

  // Union-Find 合并跨评审同一缺陷(确定性、与输入顺序无关)
  const parent = highRisk.map((_, idx) => idx)
  const find = (x: number): number => {
    let cur = x
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]!]!
      cur = parent[cur]!
    }
    return cur
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  for (let i = 0; i < highRisk.length; i++) {
    for (let j = i + 1; j < highRisk.length; j++) {
      if (isSameScientificDefect(highRisk[i]!, highRisk[j]!)) {
        union(i, j)
      }
    }
  }

  const bucketFamilies = new Map<number, Set<string>>()
  for (let i = 0; i < highRisk.length; i++) {
    const root = find(i)
    const af = highRisk[i]!
    const fam = resolveModelFamily(af.reviewer || af.modelFamily)
    let set = bucketFamilies.get(root)
    if (!set) {
      set = new Set<string>()
      bucketFamilies.set(root, set)
    }
    set.add(fam)
  }

  let f1 = 0
  let f2 = 0
  for (const famSet of bucketFamilies.values()) {
    if (famSet.size === 1) f1 += 1
    else if (famSet.size === 2) f2 += 1
  }

  const chao1Residual = Number(((f1 * Math.max(0, f1 - 1)) / (2 * (f2 + 1))).toFixed(3))
  const totalMachineRefuted = input.machineRefuted.length
  const refutedP0 = input.machineRefuted.filter((x) => x.resolvedPriority === 'P0').length

  let scientificGateStatus: ScientificGateStatus
  if (confirmedP0 > 0 || unverifiedP0 > 0) {
    scientificGateStatus = 'FIX_REQUIRED'
  } else if (familyCount < minFamilies) {
    scientificGateStatus = 'INSUFFICIENT_COVERAGE'
  } else if (chao1Residual >= maxResidual) {
    scientificGateStatus = 'RESIDUAL_RISK_HIGH'
  } else {
    scientificGateStatus = 'PASS_READY'
  }

  return {
    distinctFamilies,
    familyCount,
    minFamilies,
    f1,
    f2,
    observedDefectBuckets: bucketFamilies.size,
    chao1Residual,
    maxResidual,
    confirmedP0,
    refutedP0,
    unverifiedP0,
    totalMachineRefuted,
    scientificGateStatus,
  }
}

export function formatScientificGateMessage(m: ScientificMetrics): string {
  switch (m.scientificGateStatus) {
    case 'FIX_REQUIRED':
      return `仍有 ${m.confirmedP0} 条机器确认 P0 与 ${m.unverifiedP0} 条未核验 P0 待处理，暂不可放行`
    case 'INSUFFICIENT_COVERAGE':
      return `活跃 P0 已归零，但仅覆盖 ${m.familyCount} 个独立模型家族（要求 ≥ ${m.minFamilies}），跨家族盲审覆盖不足`
    case 'RESIDUAL_RISK_HIGH':
      return `活跃 P0 已归零且覆盖 ${m.familyCount} 个独立家族，但 Chao1 残余估计 ${m.chao1Residual} ≥ 阈值 ${m.maxResidual}（f1=${m.f1}, f2=${m.f2}），建议追加异构复审`
    case 'PASS_READY':
      return `机器确认/未核验 P0 均已归零，覆盖 ${m.familyCount} 个独立家族（≥ ${m.minFamilies}），Chao1 残余估计 ${m.chao1Residual} < ${m.maxResidual}，达到科学深审放行线`
  }
}
