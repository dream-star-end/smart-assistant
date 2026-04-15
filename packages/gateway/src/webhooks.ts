/**
 * Webhook Automation — let external events drive agents.
 *
 * Webhooks are defined in ~/.openclaude/webhooks.yaml:
 *
 *   webhooks:
 *     - id: github-push
 *       secret: "whsec_xxx"          # HMAC-SHA256 验证 (可选)
 *       agent: main
 *       prompt: |
 *         收到 GitHub push 事件:
 *         仓库: {{repository.full_name}}
 *         分支: {{ref}}
 *         提交数: {{commits.length}}
 *         请简要总结这次推送。
 *       deliver: webchat
 *       enabled: true
 *
 * Endpoint: POST /api/webhooks/:id
 * The raw JSON payload is available as template variables via dot-path.
 */
import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from '@openclaude/storage'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { eventBus, createEvent } from './eventBus.js'

export interface WebhookDef {
  id: string
  secret?: string // HMAC-SHA256 secret for signature verification
  agent: string
  prompt: string // template with {{dot.path}} placeholders
  deliver?: 'local' | 'webchat' | 'telegram'
  enabled?: boolean
  // Recent execution log (in-memory only, not persisted)
  lastFiredAt?: number
  lastStatus?: 'ok' | 'error'
}

export interface WebhookFile {
  webhooks: WebhookDef[]
}

const WEBHOOK_FILE = `${paths.home}/webhooks.yaml`

async function ensureWebhookFile(): Promise<WebhookFile> {
  try {
    if (existsSync(WEBHOOK_FILE)) {
      const raw = await readFile(WEBHOOK_FILE, 'utf-8')
      return (parseYaml(raw) as WebhookFile) || { webhooks: [] }
    }
  } catch {}
  const file: WebhookFile = { webhooks: [] }
  await mkdir(dirname(WEBHOOK_FILE), { recursive: true })
  await writeFile(WEBHOOK_FILE, stringifyYaml(file))
  return file
}

/**
 * Resolve {{dot.path}} template variables against a JSON payload.
 * Supports nested paths like {{repository.owner.login}} and {{commits.length}}.
 */
export function resolveTemplate(template: string, payload: unknown): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const parts = path.trim().split('.')
    let val: any = payload
    for (const p of parts) {
      if (val == null) return `{{${path}}}`
      val = val[p]
    }
    if (val === undefined || val === null) return `{{${path}}}`
    if (typeof val === 'object') return JSON.stringify(val)
    return String(val)
  })
}

/**
 * Verify HMAC-SHA256 signature (GitHub-style: `sha256=<hex>`).
 */
function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  // Constant-time comparison
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

export class WebhookRouter {
  private webhooks: WebhookDef[] = []

  async load(): Promise<void> {
    const file = await ensureWebhookFile()
    this.webhooks = file.webhooks ?? []
  }

  /** Find a webhook by ID, returns null if not found or disabled. */
  find(id: string): WebhookDef | null {
    const wh = this.webhooks.find((w) => w.id === id)
    if (!wh || wh.enabled === false) return null
    return wh
  }

  /**
   * Process an incoming webhook request.
   * Returns { ok, error? } — the actual agent execution is async.
   */
  async process(
    webhook: WebhookDef,
    rawBody: string,
    signatureHeader?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // Signature verification
    if (webhook.secret) {
      if (!signatureHeader) return { ok: false, error: 'missing signature' }
      if (!verifySignature(webhook.secret, rawBody, signatureHeader)) {
        return { ok: false, error: 'invalid signature' }
      }
    }

    // Parse payload
    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      payload = { raw: rawBody }
    }

    // Resolve template
    const resolvedPrompt = resolveTemplate(webhook.prompt, payload)

    // Emit event (server.ts listens and routes to agent)
    eventBus.emit('webhook.received', createEvent('webhook.received', webhook.agent, {
      webhookId: webhook.id,
      payload: { resolvedPrompt, rawPayload: payload },
    }))

    webhook.lastFiredAt = Date.now()
    webhook.lastStatus = 'ok'

    return { ok: true }
  }

  /** List all webhooks with status info. */
  list(): Array<WebhookDef & { endpoint: string }> {
    return this.webhooks.map((w) => ({
      ...w,
      endpoint: `/api/webhooks/${w.id}`,
    }))
  }

  /** Add or replace a webhook. */
  async add(webhook: WebhookDef): Promise<void> {
    this.webhooks = this.webhooks.filter((w) => w.id !== webhook.id)
    this.webhooks.push(webhook)
    await this._save()
  }

  /** Remove a webhook by ID. */
  async remove(id: string): Promise<boolean> {
    const before = this.webhooks.length
    this.webhooks = this.webhooks.filter((w) => w.id !== id)
    if (this.webhooks.length === before) return false
    await this._save()
    return true
  }

  private async _save(): Promise<void> {
    // Strip runtime fields before saving
    const clean = this.webhooks.map(({ lastFiredAt, lastStatus, ...rest }) => rest)
    await writeFile(WEBHOOK_FILE, stringifyYaml({ webhooks: clean }))
  }
}
